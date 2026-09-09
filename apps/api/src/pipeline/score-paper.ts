import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import {
  judgeVerdicts,
  metricScores,
  papers,
  reviewSystems,
  reviews,
  studyComparisons,
} from "../db/schema.js";
import type { JudgeClient, PairJudgeResult } from "../clients/judge-client.js";
import { STUDY_SLUGS } from "../study/rotation.js";
import {
  PANEL_CONCURRENCY,
  mapWithConcurrency,
  panelStatus,
  type PanelMember,
} from "./judge-panel.js";
import { logger } from "../logger.js";
import { getJudgeModels, isJudgeEnabled } from "../settings.js";

// Judge-panel pipeline (2026-09; study papers only).
//
// Every study pair is judged by a PANEL — each of the six study systems in
// turn reads the paper + BOTH reviews in one request and returns the same
// construct human raters give: an A/B/TIE preference per dimension plus
// per-review 1-10 scores. Two order-swapped passes per judge control
// position bias (Zheng et al. 2023). A system also judges pairs it wrote a
// side of; those rows are flagged self_judging so the analysis can report
// the panel with and without self-judgements.
//
// Arena papers are not judged at all: the judge signal only feeds the
// thesis' human-vs-judge analysis, which is run on the controlled study.
//
// Entry points:
//   scorePairIfReady() — fired whenever a review completes. Claims each
//                        ready rotation pair atomically (judge_status
//                        RUNNING) so racing completion events can't judge
//                        the same pair twice; the loser sees the claim and
//                        returns. No-ops until BOTH reviews are COMPLETED.
//   scorePaper()       — manual re-judge (admin endpoint / backfill):
//                        resets the paper's pairs to PENDING and re-runs
//                        only the panel members that have no verdict yet
//                        (all of them with force=true).
//
// Persisted per (pair, judge): one judge_verdicts row (preferences relative
// to its review_a_id/review_b_id) + one LLM_JUDGE_OVERALL metric row per
// review. Readers aggregate across judges (pipeline/judge-panel.ts).

interface ClaimedReview {
  id: string;
  systemId: string;
  structured: unknown;
}

/**
 * Atomically claim a specific review pair for judging. FOR UPDATE
 * serializes racing completion events: the winner flips both rows
 * PENDING → RUNNING and judges; every other caller sees non-PENDING
 * rows and returns null.
 */
async function claimPair(ids: [string, string]): Promise<ClaimedReview[] | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: reviews.id,
        systemId: reviews.reviewSystemId,
        status: reviews.status,
        judgeStatus: reviews.judgeStatus,
        structured: reviews.structured,
      })
      .from(reviews)
      .where(inArray(reviews.id, ids))
      .for("update");
    if (rows.length !== 2) return null;
    if (!rows.every((r) => r.status === "COMPLETED" && r.judgeStatus === "PENDING")) {
      return null;
    }
    await tx
      .update(reviews)
      .set({ judgeStatus: "RUNNING", updatedAt: new Date() })
      .where(inArray(reviews.id, ids));
    // Return in the caller's (A, B) order, not row order.
    return ids.map((id) => rows.find((r) => r.id === id)!);
  });
}

/**
 * Load a judge panel from a list of slugs. Derived from the DB rather than
 * a second hardcoded list so the backing model ids (e.g.
 * mistral-medium-3.5 → mistral-medium-2604) stay in one place. Disabled or
 * unknown slugs are dropped, and the caller decides whether the shortfall
 * matters.
 */
async function loadPanel(slugs: readonly string[]): Promise<PanelMember[]> {
  if (slugs.length === 0) return [];
  const rows = await db.query.reviewSystems.findMany({
    where: and(inArray(reviewSystems.slug, [...slugs]), eq(reviewSystems.enabled, true)),
    columns: { id: true, slug: true, config: true },
  });
  const members = rows.map((r) => ({
    slug: r.slug,
    systemId: r.id,
    model: typeof r.config.model === "string" ? r.config.model : r.slug,
  }));
  if (members.length !== slugs.length) {
    const missing = slugs.filter((s) => !members.some((m) => m.slug === s));
    logger.warn({ missing }, "judge_panel_incomplete");
  }
  return members.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Panel slugs for an arena pair: the admin selection, or the full
 * preregistered panel when no selection has been made. Study papers never
 * consult this — see getJudgeModels() for why.
 */
export async function arenaPanelSlugs(): Promise<string[]> {
  const chosen = await getJudgeModels();
  if (chosen === null) return [...STUDY_SLUGS];
  // Keep the preregistered order and drop anything not on the panel, so an
  // unknown slug in the setting cannot silently add a judge.
  return STUDY_SLUGS.filter((s) => chosen.includes(s));
}

/**
 * Judge whatever of the paper's rotation pairs is ready and unclaimed.
 *
 * Study papers (rows in study_comparisons) judge each of the three rotation
 * pairs as soon as both of its reviews are COMPLETED — pairs run
 * sequentially so the shared paper prefix stays warm in each provider's
 * context cache; the panel members of one pair run concurrently. Arena
 * papers are skipped. Silently returns when nothing is ready or another run
 * owns the claim. Throws only when a pair got no verdict at all (after
 * retries); callers log-and-swallow.
 */
export async function scorePairIfReady(
  paperId: string,
  judge: JudgeClient,
  paperTextArg?: string,
  force = false,
): Promise<void> {
  if (!(await isJudgeEnabled())) {
    logger.warn({ paperId }, "judge_disabled");
    return;
  }
  const comparisons = await db.query.studyComparisons.findMany({
    where: eq(studyComparisons.paperId, paperId),
    orderBy: asc(studyComparisons.pairIndex),
  });
  if (comparisons.length === 0) {
    await scoreArenaPair(paperId, judge, paperTextArg, force);
    return;
  }

  let panel: PanelMember[] | undefined;
  let paperText: string | undefined = paperTextArg;
  let lastErr: unknown = null;
  for (const c of comparisons) {
    const ids: [string, string] = [c.reviewAId, c.reviewBId];
    const claimed = await claimPair(ids);
    if (!claimed) continue;
    panel ??= await loadPanel(STUDY_SLUGS);
    paperText ??= await loadPaperText(paperId);
    try {
      await scoreClaimedPair(paperId, claimed, judge, paperText, panel, force);
    } catch (err) {
      // Keep judging the remaining ready pairs; rethrow the last failure
      // so callers still log it.
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
}

/**
 * Judge an arena paper's single pair.
 *
 * An arena paper carries exactly the two reviews the sampler chose, so the
 * pair is unambiguous and there is no rotation to consult. Papers with any
 * other number of completed reviews are skipped rather than guessed at:
 * with three or more there is no canonical pair, and judging an arbitrary
 * one would put verdicts in the table that no comparison corresponds to.
 *
 * Display order here is the reviews' stored order, not the coin flip the
 * voter saw — the voter may not even have arrived yet. That costs nothing,
 * because every pair is judged in both orders anyway and a judge that
 * disagrees with itself across the two is recorded as a tie.
 */
async function scoreArenaPair(
  paperId: string,
  judge: JudgeClient,
  paperTextArg: string | undefined,
  force: boolean,
): Promise<void> {
  const slugs = await arenaPanelSlugs();
  if (slugs.length === 0) {
    logger.debug({ paperId }, "judge_skipped_arena_no_panel");
    return;
  }

  const completed = await db.query.reviews.findMany({
    where: and(eq(reviews.paperId, paperId), eq(reviews.status, "COMPLETED")),
    columns: { id: true },
    orderBy: asc(reviews.id),
  });
  if (completed.length !== 2) {
    logger.debug(
      { paperId, completed: completed.length },
      "judge_skipped_arena_pair_not_ready",
    );
    return;
  }

  const ids: [string, string] = [completed[0]!.id, completed[1]!.id];
  const claimed = await claimPair(ids);
  if (!claimed) return;

  const panel = await loadPanel(slugs);
  if (panel.length === 0) {
    // Release the claim we just took: nothing is going to judge this pair.
    await db
      .update(reviews)
      .set({ judgeStatus: "PENDING", updatedAt: new Date() })
      .where(and(inArray(reviews.id, ids), eq(reviews.judgeStatus, "RUNNING")));
    logger.warn({ paperId, slugs }, "judge_arena_panel_empty_after_load");
    return;
  }

  const paperText = paperTextArg ?? (await loadPaperText(paperId));
  await scoreClaimedPair(paperId, claimed, judge, paperText, panel, force);
}

/** Slugs of panel members that already have a verdict for this pair (either order). */
async function existingJudges(a: string, b: string): Promise<Set<string>> {
  const rows = await db
    .select({ judgeModel: judgeVerdicts.judgeModel })
    .from(judgeVerdicts)
    .where(
      or(
        and(eq(judgeVerdicts.reviewAId, a), eq(judgeVerdicts.reviewBId, b)),
        and(eq(judgeVerdicts.reviewAId, b), eq(judgeVerdicts.reviewBId, a)),
      ),
    );
  return new Set(rows.map((r) => r.judgeModel));
}

async function scoreClaimedPair(
  paperId: string,
  claimed: ClaimedReview[],
  judge: JudgeClient,
  paperText: string,
  panel: PanelMember[],
  force: boolean,
): Promise<void> {
  const [a, b] = claimed as [ClaimedReview, ClaimedReview];
  const start = Date.now();

  const textA = renderReviewText(a.structured);
  const textB = renderReviewText(b.structured);

  const present = force ? new Set<string>() : await existingJudges(a.id, b.id);
  const members = panel.filter((m) => !present.has(m.slug));
  const alreadyPresent = panel.length - members.length;

  // Persist inside each worker so a crash mid-panel keeps every verdict that
  // did come back; a later re-judge only runs the missing members.
  const results = await mapWithConcurrency(members, PANEL_CONCURRENCY, async (member) => {
    const verdict = await judgePairWithRetry(judge, textA, textB, paperText, member.model);
    await persistJudgeVerdict(paperId, a, b, textA, textB, verdict, member, panel.length);
    return verdict;
  });

  const failedJudges = members
    .filter((_, i) => results[i]!.status === "rejected")
    .map((m) => m.slug);
  const returned = results.filter((r) => r.status === "fulfilled").length + alreadyPresent;
  const status = panelStatus(returned, panel.length);

  // Only over our own claim, never over a row another run already settled.
  await db
    .update(reviews)
    .set({ judgeStatus: status, updatedAt: new Date() })
    .where(and(inArray(reviews.id, [a.id, b.id]), eq(reviews.judgeStatus, "RUNNING")));

  const log = {
    paperId,
    reviewAId: a.id,
    reviewBId: b.id,
    status,
    returned,
    expected: panel.length,
    reused: alreadyPresent,
    failedJudges,
    elapsed_ms: Date.now() - start,
  };
  if (status === "FAILED") {
    logger.error(log, "judge_panel_failed");
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    throw first?.reason ?? new Error(`judge panel returned no verdict for pair ${a.id}/${b.id}`);
  }
  if (status === "PARTIAL") logger.warn(log, "judge_panel_partial");
  else logger.info(log, "judge_panel_complete");
}

async function persistJudgeVerdict(
  paperId: string,
  a: ClaimedReview,
  b: ClaimedReview,
  textA: string,
  textB: string,
  verdict: PairJudgeResult,
  member: PanelMember,
  panelSize: number,
): Promise<void> {
  // Per-review metric rows keep their historical shape (radar chart,
  // leaderboard filter and analysis read them), one row per judge, with
  // pairwise provenance in meta. review_chars / review_words stay recorded
  // for length-controlled analysis (AlpacaEval-style).
  const sides = [
    { review: a, text: textA, scores: verdict.review_a },
    { review: b, text: textB, scores: verdict.review_b },
  ];
  for (const side of sides) {
    const meta = {
      judge_model: member.slug,
      judge_model_id: member.model,
      self_judging: member.systemId === side.review.systemId,
      panel_size: panelSize,
      dimension_scores: side.scores.dimension_scores,
      review_chars: side.text.length,
      review_words: side.text.split(/\s+/).filter((w) => w.length > 0).length,
      pairwise: true,
      passes_used: verdict.passes_used,
    };
    await db
      .insert(metricScores)
      .values({
        reviewId: side.review.id,
        kind: "LLM_JUDGE_OVERALL",
        referenceType: "NONE",
        judgeModel: member.slug,
        value: side.scores.overall_score,
        meta,
      })
      .onConflictDoUpdate({
        target: [
          metricScores.reviewId,
          metricScores.kind,
          metricScores.referenceType,
          metricScores.judgeModel,
        ],
        set: { value: side.scores.overall_score, meta, computedAt: new Date() },
      });
  }

  // One verdict row per (pair, judge); a re-judge replaces it. Sides are
  // stored in the claimed (a, b) order for every judge of the pair.
  const verdictMeta = {
    passes_used: verdict.passes_used,
    raw_passes: verdict.raw_passes,
    judge_model_id: member.model,
    panel_size: panelSize,
    self_judging: member.systemId === a.systemId || member.systemId === b.systemId,
  };
  await db
    .insert(judgeVerdicts)
    .values({
      paperId,
      reviewAId: a.id,
      reviewBId: b.id,
      overallPreference: verdict.overall_preference,
      dimensionPreferences: verdict.dimension_preferences,
      meta: verdictMeta,
      judgeModel: member.slug,
    })
    .onConflictDoUpdate({
      target: [judgeVerdicts.reviewAId, judgeVerdicts.reviewBId, judgeVerdicts.judgeModel],
      set: {
        overallPreference: verdict.overall_preference,
        dimensionPreferences: verdict.dimension_preferences,
        meta: verdictMeta,
        computedAt: new Date(),
      },
    });
}

/**
 * Manual re-judge for a study paper (admin endpoint / backfill). Resets the
 * paper's pairs to PENDING and runs the panel again — only the members
 * without a verdict unless `force`. Arena papers are a logged no-op.
 */
export async function scorePaper(paperId: string, judge: JudgeClient, force = false): Promise<void> {
  if (!(await isJudgeEnabled())) {
    logger.warn({ paperId }, "judge_disabled");
    return;
  }
  const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId) });
  if (!paper || !paper.parsedStructure) {
    throw new Error(`paper ${paperId} not parsed yet`);
  }
  // Arena papers are judged too (their single pair), so this no longer
  // returns early for them — scorePairIfReady dispatches on whether the
  // paper has rotation comparisons.
  const parsed = paper.parsedStructure as unknown as ParsedPaper;

  await db
    .update(reviews)
    .set({ judgeStatus: "PENDING", updatedAt: new Date() })
    .where(and(eq(reviews.paperId, paperId), eq(reviews.status, "COMPLETED")));

  await scorePairIfReady(paperId, judge, renderPaperText(parsed), force);
}

async function loadPaperText(paperId: string): Promise<string> {
  const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId) });
  if (!paper?.parsedStructure) throw new Error(`paper ${paperId} not parsed yet`);
  return renderPaperText(paper.parsedStructure as unknown as ParsedPaper);
}

// The judge is a remote LLM call; transient failures (rate limits, timeouts,
// the occasional non-JSON response) are the common reason a pair silently
// ends up unjudged. The Python side already retries each pass itself —
// this layer retries the *Python service* for network-level failures
// (review-gen restart, bridge timeout, transient 5xx). Backoff:
// 500ms, 1s, 2s, 4s = ~7.5s total before giving up.
async function judgePairWithRetry(
  judge: JudgeClient,
  reviewA: string,
  reviewB: string,
  paperText: string,
  model: string,
  attempts = 4,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await judge.judgePair(reviewA, reviewB, paperText, model);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

export function renderPaperText(parsed: ParsedPaper): string {
  const parts: string[] = [];
  if (parsed.title) parts.push(`# ${parsed.title}`);
  if (parsed.abstract) parts.push(`Abstract: ${parsed.abstract}`);
  for (const s of parsed.sections) parts.push(`## ${s.heading}\n${s.text}`);
  return parts.join("\n\n");
}

// The judge reads the normalized review content (summary + bullets),
// deliberately NOT the raw form: the raw output carries the model's
// self-assigned Rating/Confidence numbers, and feeding those to the judge
// would let a generously self-scoring model anchor its own grade.
function renderReviewText(structured: unknown): string {
  const r = structured as {
    summary?: string;
    strengths?: string[];
    weaknesses?: string[];
    questions?: string[];
  };
  return [
    r.summary,
    ...(r.strengths ?? []).map((s) => `Strength: ${s}`),
    ...(r.weaknesses ?? []).map((w) => `Weakness: ${w}`),
    ...(r.questions ?? []).map((q) => `Question: ${q}`),
  ]
    .filter(Boolean)
    .join("\n");
}
