import { Router } from "express";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { judgeVerdicts, votes, type MetricScore } from "../db/schema.js";
import { RevealResponseSchema } from "./schemas.js";

// GET /reveal/:voteId — LLM-judge scores (overall + per-dimension) for both
// reviews. Populated by /admin/papers/:id/score (Checkpoint 7) — nulls if
// scoring hasn't run yet.

export function revealRouter(): Router {
  const router = Router();

  router.get("/reveal/:voteId", async (req, res, next) => {
    try {
      const { voteId } = req.params;
      const vote = await db.query.votes.findFirst({
        where: eq(votes.id, voteId),
        with: {
          reviewA: {
            with: { reviewSystem: true, metricScores: true },
          },
          reviewB: {
            with: { reviewSystem: true, metricScores: true },
          },
        },
      });
      if (!vote) {
        res.status(404).json({ error: "NotFound", message: voteId });
        return;
      }

      type ReviewSide = NonNullable<typeof vote>["reviewA"];
      const pack = (review: ReviewSide) => {
        const overallRow = review.metricScores.find(
          (m: MetricScore) => m.kind === "LLM_JUDGE_OVERALL",
        );
        const dimensionScores =
          (overallRow?.meta as { dimension_scores?: Record<string, number> } | null)
            ?.dimension_scores ?? null;
        return {
          reviewId: review.id,
          systemName: review.reviewSystem.name,
          judgeOverall: overallRow?.value ?? null,
          judgeDimensions: dimensionScores,
        };
      };

      // Pairwise verdict, if judged. The judge_verdicts row stores A/B
      // relative to its own (review_a_id, review_b_id) ordering, which is
      // independent of this vote's blinded coin flip — remap when swapped.
      const verdictRow = await db.query.judgeVerdicts.findFirst({
        where: or(
          and(
            eq(judgeVerdicts.reviewAId, vote.reviewAId),
            eq(judgeVerdicts.reviewBId, vote.reviewBId),
          ),
          and(
            eq(judgeVerdicts.reviewAId, vote.reviewBId),
            eq(judgeVerdicts.reviewBId, vote.reviewAId),
          ),
        ),
      });
      let judgeVerdict = null;
      if (verdictRow) {
        const swapped = verdictRow.reviewAId !== vote.reviewAId;
        const map = (p: string) =>
          p === "TIE" ? "TIE" : swapped ? (p === "A" ? "B" : "A") : p;
        const dims = verdictRow.dimensionPreferences as Record<string, string>;
        judgeVerdict = {
          overall: map(verdictRow.overallPreference),
          dimensions: Object.fromEntries(
            Object.entries(dims).map(([dim, p]) => [dim, map(p)]),
          ),
          passesUsed:
            (verdictRow.meta as { passes_used?: number } | null)?.passes_used ?? 2,
        };
      }

      const payload = {
        reviewA: pack(vote.reviewA),
        reviewB: pack(vote.reviewB),
        judgeVerdict,
      };
      const validated = RevealResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
