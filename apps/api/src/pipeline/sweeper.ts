/**
 * Stuck-review sweeper.
 *
 * A review row enters GENERATING when a stream starts and leaves it only if
 * that same process finishes the stream. A crash, hard shutdown, or wedged
 * Python service can strand rows in GENERATING forever — and /pair treats
 * GENERATING as eligible, so voters get pairs that can never complete. This
 * sweeps such rows to FAILED so the UI shows a retriable error instead of an
 * eternal spinner.
 *
 * 15 minutes matches the stream route's absolute watchdog: any row still
 * GENERATING that long has no live stream attached to it.
 */
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { reviews } from "../db/schema.js";
import { logger } from "../logger.js";

const STALE_AFTER_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const swept = await db
    .update(reviews)
    .set({
      status: "FAILED",
      errorMessage: "Generation stalled and was cleaned up — retry this paper.",
      updatedAt: new Date(),
    })
    .where(and(eq(reviews.status, "GENERATING"), lt(reviews.updatedAt, cutoff)))
    .returning({ id: reviews.id });
  if (swept.length > 0) {
    logger.warn({ count: swept.length, ids: swept.map((r) => r.id) }, "stuck_reviews_swept");
  }

  // Same idea for the pairwise judge claim: RUNNING is held only while a
  // live scorePairIfReady run owns the pair. A crash mid-judge strands it,
  // which would block any future claim of that pair forever.
  const judgeSwept = await db
    .update(reviews)
    .set({ judgeStatus: "FAILED", updatedAt: new Date() })
    .where(and(eq(reviews.judgeStatus, "RUNNING"), lt(reviews.updatedAt, cutoff)))
    .returning({ id: reviews.id });
  if (judgeSwept.length > 0) {
    logger.warn(
      { count: judgeSwept.length, ids: judgeSwept.map((r) => r.id) },
      "stuck_judge_claims_swept",
    );
  }
}

export function startStuckReviewSweeper(): () => void {
  // Run once at boot (catches rows stranded by the previous process), then
  // on an interval. unref() so the timer never holds the process open.
  void sweepOnce().catch((err) => logger.error({ err }, "sweeper_failed"));
  const timer = setInterval(() => {
    void sweepOnce().catch((err) => logger.error({ err }, "sweeper_failed"));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
