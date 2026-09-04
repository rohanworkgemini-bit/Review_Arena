import { and, asc, eq, inArray } from "drizzle-orm";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { judgeVerdicts, metricScores, papers, reviews, studyComparisons } from "../db/schema.js";
import { DEFAULT_JUDGE_MODEL, JudgeClient } from "../clients/judge-client.js";
import type { PairJudgeResult } from "../clients/judge-client.js";
import { logger } from "../logger.js";

// Pairwise LLM-judge pipeline (2026-09-04, replacing per-review pointwise
// scoring; changed pre-study so all collected data is one judging regime).
//
// The judge reads the paper + BOTH reviews in one request and returns the
// same construct human raters give — an A/B/TIE preference per dimension —
// plus per-review 1-10 scores from the same call. Two order-swapped passes
// control position bias (Zheng et al. 2023); the paper is sent twice per
// pair instead of four times, halving judge input cost.
//
// Entry points:
//   scorePairIfReady() — fired whenever a review completes. Claims the
//                        paper's pair atomically (judge_status RUNNING) so
//                        the two completion events racing each other can't
//                        judge the same pair twice; the loser sees the
//                        claim and returns. No-ops until BOTH reviews of
//                        the pair are COMPLETED.
//   scorePaper()       — manual re-judge (admin endpoint / backfill):
//                        resets the pair's judge status and re-runs.
//
// Persisted per pair: one judge_verdicts row (preferences relative to its
// review_a_id/review_b_id) + the familiar per-review LLM_JUDGE_OVERALL
// metric rows, so the reveal radar and the fairness filter are unchanged.

interface ClaimedReview {
  id: string;
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
 * Judge whatever of the paper's pair(s) is ready and unclaimed.
 *
 * Study papers (rows in study_comparisons) judge each of the three
 * rotation pairs as soon as both of its reviews are COMPLETED — pairs are
 * judged sequentially so the shared paper prefix stays warm in the
 * provider's context cache. Arena papers judge the newest two completed
 * reviews. Silently returns when nothing is ready or another run owns the
 * claim. Throws on judge failure (after retries); callers log-and-swallow.
 */
export async function scorePairIfReady(
  paperId: string,
  judge: JudgeClient,
  paperTextArg?: string,
): Promise<void> {
  const comparisons = await db.query.studyComparisons.findMany({
    where: eq(studyComparisons.paperId, paperId),
    orderBy: asc(studyComparisons.pairIndex),
  });

  const pairs: Array<[string, string]> = comparisons.length
    ? comparisons.map((c) => [c.reviewAId, c.reviewBId])
    : [await latestArenaPair(paperId)].filter((p): p is [string, string] => p !== null);

  let paperText: string | undefined = paperTextArg;
  let lastErr: unknown = null;
  for (const ids of pairs) {
    const claimed = await claimPair(ids);
    if (!claimed) continue;
    paperText ??= await loadPaperText(paperId);
    try {
      await scoreClaimedPair(paperId, claimed, judge, paperText);
    } catch (err) {
      // Keep judging the remaining ready pairs; rethrow the last failure
      // so callers still log it.
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
}

/** Arena papers: the newest two COMPLETED reviews are the live pair. */
async function latestArenaPair(paperId: string): Promise<[string, string] | null> {
  const rows = await db.query.reviews.findMany({
    where: and(eq(reviews.paperId, paperId), eq(reviews.status, "COMPLETED")),
    columns: { id: true, createdAt: true },
  });
  const pair = rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-2);
  return pair.length === 2 ? [pair[0]!.id, pair[1]!.id] : null;
}

async function scoreClaimedPair(
  paperId: string,
  claimed: ClaimedReview[],
  judge: JudgeClient,
  paperText: string,
): Promise<void> {
  const [a, b] = claimed as [ClaimedReview, ClaimedReview];
  const start = Date.now();

  const textA = renderReviewText(a.structured);
  const textB = renderReviewText(b.structured);

  let verdict: PairJudgeResult;
  try {
    verdict = await judgePairWithRetry(judge, textA, textB, paperText);
  } catch (err) {
    // Written down so the fairness filter can exclude the comparison —
    // but only over our own claim, never over a COMPLETE row.
    await db
      .update(reviews)
      .set({ judgeStatus: "FAILED", updatedAt: new Date() })
      .where(
        and(
          inArray(reviews.id, [a.id, b.id]),
          eq(reviews.judgeStatus, "RUNNING"),
        ),
      )
      .catch(() => {/* best effort */});
    throw err;
  }

  logger.info(
    {
      paperId,
      overallPreference: verdict.overall_preference,
      passesUsed: verdict.passes_used,
      elapsed_ms: Date.now() - start,
    },
    "judge_pair_complete",
  );

  await persistPairVerdict(paperId, a.id, b.id, textA, textB, verdict);
}

async function persistPairVerdict(
  paperId: string,
  reviewAId: string,
  reviewBId: string,
  textA: string,
  textB: string,
  verdict: PairJudgeResult,
): Promise<void> {
  // Per-review metric rows keep their historical shape (radar chart,
  // leaderboard filter and analysis all read them unchanged), with
  // pairwise provenance added to meta. review_chars / review_words stay
  // recorded for length-controlled analysis (AlpacaEval-style).
  const sides = [
    { reviewId: reviewAId, text: textA, scores: verdict.review_a },
    { reviewId: reviewBId, text: textB, scores: verdict.review_b },
  ];
  for (const side of sides) {
    const meta = {
      judge_model: DEFAULT_JUDGE_MODEL,
      dimension_scores: side.scores.dimension_scores,
      review_chars: side.text.length,
      review_words: side.text.split(/\s+/).filter((w) => w.length > 0).length,
      pairwise: true,
      passes_used: verdict.passes_used,
    };
    await db
      .insert(metricScores)
      .values({
        reviewId: side.reviewId,
        kind: "LLM_JUDGE_OVERALL",
        referenceType: "NONE",
        value: side.scores.overall_score,
        meta,
      })
      .onConflictDoUpdate({
        target: [metricScores.reviewId, metricScores.kind, metricScores.referenceType],
        set: { value: side.scores.overall_score, meta, computedAt: new Date() },
      });
  }

  // One verdict row per pair; a re-judge replaces it.
  await db
    .insert(judgeVerdicts)
    .values({
      paperId,
      reviewAId,
      reviewBId,
      overallPreference: verdict.overall_preference,
      dimensionPreferences: verdict.dimension_preferences,
      meta: { passes_used: verdict.passes_used, raw_passes: verdict.raw_passes },
      judgeModel: DEFAULT_JUDGE_MODEL,
    })
    .onConflictDoUpdate({
      target: [judgeVerdicts.reviewAId, judgeVerdicts.reviewBId],
      set: {
        overallPreference: verdict.overall_preference,
        dimensionPreferences: verdict.dimension_preferences,
        meta: { passes_used: verdict.passes_used, raw_passes: verdict.raw_passes },
        judgeModel: DEFAULT_JUDGE_MODEL,
        computedAt: new Date(),
      },
    });

  await db
    .update(reviews)
    .set({ judgeStatus: "COMPLETE", updatedAt: new Date() })
    .where(inArray(reviews.id, [reviewAId, reviewBId]));
}

/**
 * Manual re-judge for a paper (admin endpoint / backfill). Resets the
 * pair's judge status to PENDING and runs the pairwise judge again.
 */
export async function scorePaper(paperId: string, judge: JudgeClient): Promise<void> {
  const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId) });
  if (!paper || !paper.parsedStructure) {
    throw new Error(`paper ${paperId} not parsed yet`);
  }
  const parsed = paper.parsedStructure as unknown as ParsedPaper;

  await db
    .update(reviews)
    .set({ judgeStatus: "PENDING", updatedAt: new Date() })
    .where(and(eq(reviews.paperId, paperId), eq(reviews.status, "COMPLETED")));

  await scorePairIfReady(paperId, judge, renderPaperText(parsed));
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
  attempts = 4,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await judge.judgePair(reviewA, reviewB, paperText);
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
