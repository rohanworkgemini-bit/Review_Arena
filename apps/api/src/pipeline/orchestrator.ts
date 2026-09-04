import { eq } from "drizzle-orm";
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
  try {
    const result = await client.generate(
      system.adapterKey,
      parsed,
      system.config ?? {},
      paper.conference,
    );
    await db
      .update(reviews)
      .set({
        status: "COMPLETED",
        structured: result.review as unknown as object,
        rawOutput: result.rawOutput,
        generationMs: result.generationMs,
        // FAIRNESS A4 — per-generation token accounting.
        inputTokensSent: result.metrics?.inputTokens ?? null,
        inputTokensConsumed: result.metrics?.inputTokens ?? null,
        contextWindow: result.metrics?.contextWindow ?? null,
        outputTokens: result.metrics?.outputTokens ?? null,
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, reviewId));

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
    await db
      .update(reviews)
      .set({ status: "FAILED", errorMessage: message, updatedAt: new Date() })
      .where(eq(reviews.id, reviewId));
    // Don't rethrow — one failing adapter shouldn't abort the others.
  }
}
