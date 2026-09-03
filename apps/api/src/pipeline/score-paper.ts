import { and, eq, ne } from "drizzle-orm";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { metricScores, papers, reviews } from "../db/schema.js";
import { DEFAULT_JUDGE_MODEL, JudgeClient } from "../clients/judge-client.js";
import { logger } from "../logger.js";

// Backfill MetricScore rows (LLM-judge overall + per-dimension). Two entry
// points:
//
//   scoreOneReview()  — called by the orchestrator the moment a single review
//                       is marked COMPLETED, so judging runs concurrently with
//                       the remaining adapters instead of after them.
//   scorePaper()      — paper-wide re-score, used by the admin endpoint when
//                       a manual re-judge is requested.
//
// Both upsert MetricScores; they're safe to run repeatedly on the same review.

/**
 * Judge one review and persist its MetricScores. Throws on judge failure
 * (after retry); callers decide whether to swallow + log.
 */
export async function scoreOneReview(
  reviewId: string,
  structured: unknown,
  paperText: string,
  judge: JudgeClient,
): Promise<void> {
  const start = Date.now();
  // Idempotence guard: SSE reconnects can fire scoreOneReview twice for the
  // same review. A second run would double the judge cost, and its failure
  // used to stamp FAILED over a review that already had valid scores
  // (observed live 2026-09-04). Judged means judged.
  const existing = await db.query.reviews.findFirst({
    where: eq(reviews.id, reviewId),
    columns: { judgeStatus: true },
  });
  if (existing?.judgeStatus === "COMPLETE") return;
  const text = renderReviewText(structured);
  let judged;
  try {
    judged = await judgeWithRetry(judge, text, paperText);
  } catch (err) {
    // Record the failure on the review row: the fairness filter excludes
    // judge-FAILED comparisons from the leaderboard, which only works if
    // failures are actually written down. Never clobber a COMPLETE row —
    // a concurrent duplicate run's failure must not erase real scores.
    await db
      .update(reviews)
      .set({ judgeStatus: "FAILED", updatedAt: new Date() })
      .where(and(eq(reviews.id, reviewId), ne(reviews.judgeStatus, "COMPLETE")))
      .catch(() => {/* best effort */});
    throw err;
  }
  const elapsed = Date.now() - start;
  logger.info(
    { reviewId, overallScore: judged.overall_score, elapsed_ms: elapsed },
    "judge_scoring_complete",
  );

  // Metrics upsert via insert + ON CONFLICT DO UPDATE. The 8 per-dimension
  // judge scores live in meta on the LLM_JUDGE_OVERALL row rather than as
  // separate metric_kind enum values — the reveal page only ever needs them
  // alongside the overall score, so one jsonb payload is the right grain.
  //
  // review_chars / review_words are recorded so post-hoc analysis can do
  // length-controlled scoring (AlpacaEval-style logistic regression on
  // length to factor out verbosity bias). Free to capture, makes the
  // dataset defensible against "did longer reviews win?" critique.
  const reviewChars = text.length;
  const reviewWords = text.split(/\s+/).filter((w) => w.length > 0).length;

  await db
    .insert(metricScores)
    .values({
      reviewId,
      kind: "LLM_JUDGE_OVERALL",
      referenceType: "NONE",
      value: judged.overall_score,
      meta: {
        judge_model: DEFAULT_JUDGE_MODEL,
        dimension_scores: judged.dimension_scores,
        review_chars: reviewChars,
        review_words: reviewWords,
      },
    })
    .onConflictDoUpdate({
      target: [metricScores.reviewId, metricScores.kind, metricScores.referenceType],
      set: {
        value: judged.overall_score,
        meta: {
          judge_model: DEFAULT_JUDGE_MODEL,
          dimension_scores: judged.dimension_scores,
          review_chars: reviewChars,
          review_words: reviewWords,
        },
        computedAt: new Date(),
      },
    });

  await db
    .update(reviews)
    .set({ judgeStatus: "COMPLETE", updatedAt: new Date() })
    .where(eq(reviews.id, reviewId));
}

/**
 * Paper-wide re-score. Iterates every COMPLETED review and judges each one.
 * Per-review failures are logged and skipped; the batch keeps going.
 */
export async function scorePaper(paperId: string, judge: JudgeClient): Promise<void> {
  const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId) });
  if (!paper || !paper.parsedStructure) {
    throw new Error(`paper ${paperId} not parsed yet`);
  }
  const parsed = paper.parsedStructure as unknown as ParsedPaper;
  const paperText = renderPaperText(parsed);

  const completed = await db.query.reviews.findMany({
    where: and(eq(reviews.paperId, paperId), eq(reviews.status, "COMPLETED")),
  });

  for (const review of completed) {
    try {
      await scoreOneReview(review.id, review.structured, paperText, judge);
    } catch (err) {
      logger.warn(
        { err, reviewId: review.id, paperId },
        "judge failed after retry; review left without judge scores",
      );
    }
  }
}

// The judge is a remote LLM call; transient failures (rate limits, timeouts,
// the occasional non-JSON response) are the common reason a single review
// silently ends up with no judge scores. The Python side already retries
// itself JUDGE_RETRY_MAX times — this layer retries the *Python service*
// for network-level failures (review-gen restart, bridge timeout, transient
// 5xx). Exponential backoff: 500ms, 1s, 2s, 4s = ~7.5s total before giving up.
async function judgeWithRetry(
  judge: JudgeClient,
  reviewText: string,
  paperText: string,
  attempts = 4,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await judge.judge(reviewText, paperText);
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
