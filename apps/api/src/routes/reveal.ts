import { Router } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { judgeVerdicts, reviewSystems, votes, type MetricScore } from "../db/schema.js";
import type { JudgePreference } from "../clients/judge-client.js";
import { aggregateVerdicts, meanScores, type VerdictRow } from "../pipeline/judge-panel.js";
import { STUDY_SLUGS } from "../study/rotation.js";
import { RevealResponseSchema } from "./schemas.js";

// GET /reveal/:voteId — judge-panel output for both reviews: per-side panel
// means (overall + per-dimension), the panel-majority verdict mapped onto
// this vote's blinded sides, and every member's own verdict. Only study
// pairs are judged; arena votes come back with judgeStatus PENDING, no
// scores and no verdict.

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
      const judgeRows = (review: ReviewSide) =>
        review.metricScores.filter((m: MetricScore) => m.kind === "LLM_JUDGE_OVERALL");
      const dimsOf = (m: MetricScore) =>
        (m.meta as { dimension_scores?: Record<string, number> } | null)?.dimension_scores ??
        null;
      const pack = (review: ReviewSide) => {
        const rows = judgeRows(review);
        const mean = meanScores(rows.map((m) => ({ value: m.value, dimensionScores: dimsOf(m) })));
        return {
          reviewId: review.id,
          systemName: review.reviewSystem.name,
          judgeOverall: mean.overall,
          judgeDimensions: mean.dimensions,
          judgeCount: rows.length,
        };
      };

      // Every panel member's verdict for this pair. A judge_verdicts row
      // stores A/B relative to its own (review_a_id, review_b_id) ordering,
      // which is independent of this vote's blinded coin flip — remap
      // swapped rows before taking the majority.
      const verdictRows = await db.query.judgeVerdicts.findMany({
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
      if (verdictRows.length > 0) {
        const nameBySlug = new Map(
          (
            await db
              .select({ slug: reviewSystems.slug, name: reviewSystems.name })
              .from(reviewSystems)
              .where(inArray(reviewSystems.slug, verdictRows.map((r) => r.judgeModel)))
          ).map((s) => [s.slug, s.name]),
        );
        const scoreBy = (review: ReviewSide, judge: string) =>
          judgeRows(review).find((m) => m.judgeModel === judge)?.value ?? null;
        const rows: VerdictRow[] = verdictRows.map((r) => ({
          judgeModel: r.judgeModel,
          overallPreference: r.overallPreference as JudgePreference,
          dimensionPreferences: r.dimensionPreferences as Record<string, JudgePreference>,
          swapped: r.reviewAId !== vote.reviewAId,
          passesUsed: (r.meta as { passes_used?: number } | null)?.passes_used ?? 2,
        }));
        const agg = aggregateVerdicts(rows);
        const judges = rows.map((row, i) => {
          const src = verdictRows[i]!;
          const flip = (p: JudgePreference) =>
            p === "TIE" || !row.swapped ? p : p === "A" ? "B" : "A";
          return {
            judge: row.judgeModel,
            judgeName: nameBySlug.get(row.judgeModel) ?? row.judgeModel,
            overall: flip(row.overallPreference),
            dimensions: Object.fromEntries(
              Object.entries(row.dimensionPreferences).map(([d, p]) => [d, flip(p)]),
            ),
            passesUsed: row.passesUsed,
            selfJudging:
              (src.meta as { self_judging?: boolean } | null)?.self_judging ??
              (row.judgeModel === vote.reviewA.reviewSystem.slug ||
                row.judgeModel === vote.reviewB.reviewSystem.slug),
            scoreA: scoreBy(vote.reviewA, row.judgeModel),
            scoreB: scoreBy(vote.reviewB, row.judgeModel),
          };
        });
        const panelSize = (verdictRows[0]!.meta as { panel_size?: number } | null)?.panel_size;
        judgeVerdict = {
          overall: agg.overall,
          dimensions: agg.dimensions,
          counts: agg.counts,
          judgesReturned: rows.length,
          judgesExpected: panelSize ?? STUDY_SLUGS.length,
          judges,
        };
      }

      const payload = {
        reviewA: pack(vote.reviewA),
        reviewB: pack(vote.reviewB),
        judgeVerdict,
        // Both sides of a pair are always set together.
        judgeStatus: vote.reviewA.judgeStatus,
      };
      const validated = RevealResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
