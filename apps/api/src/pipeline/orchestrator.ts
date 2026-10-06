import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { reviews, reviewSystems, type Paper, type ReviewSystem } from "../db/schema.js";
import { ReviewGenClient } from "../clients/review-gen-client.js";
import { JudgeClient } from "../clients/judge-client.js";
import { renderPaperText, scorePairIfReady } from "./score-paper.js";
import { logger } from "../logger.js";

// Fan out review generation to every enabled ReviewSystem for a given paper.
// NOT idempotent — each call inserts fresh review rows. We deliberately
// dropped the (paperId, reviewSystemId) unique constraint so the same
// paper can be re-uploaded and get a fresh review pair each time.

export interface Orchestrator {
  generateAllReviews(paper: Paper, parsed: ParsedPaper): Promise<void>;
  /**
   * For the streaming path: insert pending review rows for the chosen
   * systems WITHOUT calling the model. The browser will trigger each
   * generation by opening an SSE stream to /reviews/stream/:reviewId,
   * which lets us stream tokens straight to the UI as they arrive.
   * Returns the review IDs in the same order as `slugs`.
   */
  precreateReviews(
    paper: Paper,
    slugs: readonly string[],
  ): Promise<Array<{ slug: string; reviewId: string }>>;
}

export function makeOrchestrator(
  client: ReviewGenClient,
  judge?: JudgeClient,
): Orchestrator {
  return {
    async generateAllReviews(paper, parsed) {
      const systems = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
      });
      // Compute the paper text once and pass it to every generateOne so the
      // judge call inside has it ready without re-rendering N times.
      const paperText = judge ? renderPaperText(parsed) : undefined;

      // Parallel: each adapter is a remote LLM call (independent rate limits)
      // and we want the user's wait time to be max(call) not sum(call). If
      // a local-GPU adapter joins later, gate it behind a concurrency limit
      // here. Each generateOne also fires its own judge call the moment its
      // review is COMPLETED (fire-and-forget), so judging runs concurrently
      // with the remaining adapters instead of waiting for the full batch.
      await Promise.all(
        systems.map((s) => generateOne(paper, parsed, s, client, judge, paperText)),
      );
    },

    async precreateReviews(paper, slugs) {
      // Streaming path: insert review rows in GENERATING status so the
      // browser can open SSE streams keyed by reviewId. Always inserts
      // fresh rows — every upload gets a new pair, no idempotency on
      // (paper, system). The user wants fresh reviews on every upload.
      // An empty list creates nothing (there is no "all systems"
      // fallback); callers must treat fewer than 2 rows as a failure.
      if (slugs.length === 0) return [];
      const enabled = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
      });
      const bySlug = new Map(enabled.map((s) => [s.slug, s]));
      const out: Array<{ slug: string; reviewId: string }> = [];
      for (const slug of slugs) {
        const system = bySlug.get(slug);
        if (!system) {
          logger.warn({ slug }, "precreateReviews: skipping unknown/disabled slug");
          continue;
        }
        const [created] = await db
          .insert(reviews)
          .values({
            paperId: paper.id,
            reviewSystemId: system.id,
            status: "GENERATING",
            // The judge hasn't seen this review yet; scoreOneReview flips it
            // to COMPLETE/FAILED. (The column default is COMPLETE only for
            // legacy rows that predate judge-status tracking.)
            judgeStatus: "PENDING",
          })
          .returning({ id: reviews.id });
        out.push({ slug, reviewId: created!.id });
      }
      return out;
    },
  };
}

/**
 * Start one generation run on a review row: (re)enter GENERATING and stamp
 * updatedAt with a fresh per-run marker, atomically and only if the row is
 * still startable (PENDING or GENERATING — never over a COMPLETED/FAILED
 * row). Returns the marker, or null when the row was not claimable.
 *
 * Two jobs:
 *  - The stuck-row sweeper ages GENERATING rows by updatedAt, so this stamp
 *    makes its 15-minute clock run from when generation actually started
 *    rather than from row creation (rows are precreated at upload time and
 *    may sit for a while before their stream opens).
 *  - The marker identifies THIS run. The final COMPLETED/FAILED write is
 *    guarded by `isCurrentRun` (status still GENERATING AND updatedAt still
 *    equal to our marker), so a run the sweeper already failed — and that
 *    was then retried, which re-stamps updatedAt — can no longer clobber
 *    the newer run's result when it eventually returns.
 * Nothing else writes updatedAt on a GENERATING row while a run is live
 * (judge claims only touch COMPLETED rows), so the marker is stable.
 */
export async function claimGeneration(reviewId: string): Promise<Date | null> {
  // JS Dates are millisecond-precision, which timestamptz round-trips
  // exactly, so equality on the stamp is reliable.
  const runStamp = new Date();
  const claimed = await db
    .update(reviews)
    .set({ status: "GENERATING", errorMessage: null, updatedAt: runStamp })
    .where(and(eq(reviews.id, reviewId), inArray(reviews.status, ["PENDING", "GENERATING"])))
    .returning({ id: reviews.id });
  return claimed.length > 0 ? runStamp : null;
}

/** WHERE clause for a run's terminal write: only if it is still the current run. */
export function isCurrentRun(reviewId: string, runStamp: Date): SQL {
  return and(
    eq(reviews.id, reviewId),
    eq(reviews.status, "GENERATING"),
    eq(reviews.updatedAt, runStamp),
  )!;
}

async function generateOne(
  paper: Paper,
  parsed: ParsedPaper,
  system: ReviewSystem,
  client: ReviewGenClient,
  judge?: JudgeClient,
  paperText?: string,
): Promise<void> {
  // Fresh-per-upload: always insert a new row. Each upload gets a
  // distinct review, even if the same (paper, system) pair was reviewed
  // before. Removes the cache-once invariant in favor of letting the
  // user re-test reviewers on the same paper without dedup.
  const [created] = await db
    .insert(reviews)
    .values({
      paperId: paper.id,
      reviewSystemId: system.id,
      status: "GENERATING",
      // Without this the column default (COMPLETE, a legacy-rows-only
      // accommodation) would make the pairwise judge skip the pair.
      judgeStatus: "PENDING",
    })
    .returning({ id: reviews.id });
  await generateIntoReview(created!.id, paper, parsed, system, client, judge, paperText);
}

/**
 * Run one adapter into an EXISTING review row (GENERATING → COMPLETED or
 * FAILED) and fire the pairwise judge on completion. The study flow
 * precreates its six rows (so the rotation's comparison pairs can be
 * fixed before generation starts) and dispatches them through here —
 * same generation + judging path as the arena, minus the SSE trigger.
 */
export async function generateIntoReview(
  reviewId: string,
  paper: Paper,
  parsed: ParsedPaper,
  system: ReviewSystem,
  client: ReviewGenClient,
  judge?: JudgeClient,
  paperText?: string,
): Promise<void> {
  let runStamp: Date | null = null;
  try {
    runStamp = await claimGeneration(reviewId);
    if (!runStamp) {
      logger.warn({ reviewId }, "generateIntoReview: row not startable (already terminal); skipping");
      return;
    }
    const result = await client.generate(
      system.adapterKey,
      parsed,
      system.config ?? {},
      paper.conference,
    );
    const written = await db
      .update(reviews)
      .set({
        status: "COMPLETED",
        structured: result.review as unknown as object,
        rawOutput: result.rawOutput,
        generationMs: result.generationMs,
        // FAIRNESS A4 — per-generation token accounting.
        inputTokensSent: result.metrics?.inputTokens ?? null,
        // review-gen reports only our own pre-send count, not the
        // provider's billed usage, so there is no honest value for this.
        inputTokensConsumed: null,
        contextWindow: result.metrics?.contextWindow ?? null,
        outputTokens: result.metrics?.outputTokens ?? null,
        updatedAt: new Date(),
      })
      .where(isCurrentRun(reviewId, runStamp))
      .returning({ id: reviews.id });
    if (written.length === 0) {
      // Swept to FAILED (and possibly retried) while we were generating.
      logger.warn({ reviewId }, "generation result discarded: run superseded");
      return;
    }

    // Fire pairwise judging now, in the background. The review is COMPLETED
    // in the DB so /pair can already serve it; the judge compares both
    // reviews in one run, so this no-ops until the pair's OTHER review also
    // completes — whichever completion event lands second wins the claim
    // and judges (the race is settled by scorePairIfReady's row lock).
    if (judge && paperText) {
      void scorePairIfReady(paper.id, judge, paperText).catch(
        (err) =>
          logger.warn(
            { err, reviewId, paperId: paper.id, adapter: system.adapterKey },
            "pairwise judge failed; reveal will show no judge verdict",
          ),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, reviewId, adapter: system.adapterKey }, "generation failed");
    // If the claim itself failed (no stamp), fall back to the unguarded
    // write so the row cannot be left GENERATING.
    await db
      .update(reviews)
      .set({ status: "FAILED", errorMessage: message, updatedAt: new Date() })
      .where(runStamp ? isCurrentRun(reviewId, runStamp) : eq(reviews.id, reviewId))
      .catch((e: unknown) => logger.error({ err: e, reviewId }, "failed to record generation failure"));
    // Don't rethrow — one failing adapter shouldn't abort the others.
  }
}
