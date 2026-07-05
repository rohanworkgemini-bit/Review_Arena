import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { votes, type MetricScore } from "../db/schema.js";
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

      const payload = { reviewA: pack(vote.reviewA), reviewB: pack(vote.reviewB) };
      const validated = RevealResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
