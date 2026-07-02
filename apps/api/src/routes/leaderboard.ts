import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { VoteDimensionSchema } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { eloSnapshots, papers, reviewSystems, votes } from "../db/schema.js";

// In-memory cache for leaderboard results. Invalidated on each vote.
// Key: "overall" | dimension name, Value: { result, expiresAt }
const leaderboardCache = new Map<
  string,
  {
    result: unknown;
    expiresAt: number;
  }
>();

const CACHE_TTL_MS = 5000; // 5 second TTL

function getCacheKey(dimension: string | null): string {
  return dimension ?? "overall";
}

export function invalidateLeaderboardCache(dimension: string | null = null): void {
  if (dimension === null) {
    // Invalidate all caches on vote
    leaderboardCache.clear();
  } else {
    leaderboardCache.delete(getCacheKey(dimension));
  }
}

export function leaderboardRouter(): Router {
  const router = Router();

  router.get("/leaderboard", async (req, res, next) => {
    try {
      const dimParse = VoteDimensionSchema.safeParse(req.query.dimension);
      const dimension = dimParse.success ? dimParse.data : null;
      const cacheKey = getCacheKey(dimension);

      // Check cache first
      const cached = leaderboardCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.result);
        return;
      }

      const dimCondition = dimension
        ? eq(eloSnapshots.dimension, dimension)
        : isNull(eloSnapshots.dimension);

      // Latest snapshot per system via DISTINCT ON.
      const latest = await db
        .selectDistinctOn([eloSnapshots.reviewSystemId], {
          reviewSystemId: eloSnapshots.reviewSystemId,
          rating: eloSnapshots.rating,
          ratingCiLow: eloSnapshots.ratingCiLow,
          ratingCiHigh: eloSnapshots.ratingCiHigh,
          voteCount: eloSnapshots.voteCount,
          slug: reviewSystems.slug,
          name: reviewSystems.name,
        })
        .from(eloSnapshots)
        .innerJoin(reviewSystems, eq(reviewSystems.id, eloSnapshots.reviewSystemId))
        .where(and(dimCondition))
        .orderBy(eloSnapshots.reviewSystemId, desc(eloSnapshots.computedAt));

      const entries = [...latest]
        .sort((a, b) => b.rating - a.rating)
        .map((s, i) => ({
          rank: i + 1,
          systemSlug: s.slug,
          systemName: s.name,
          rating: s.rating,
          ratingCiLow: s.ratingCiLow,
          ratingCiHigh: s.ratingCiHigh,
          voteCount: s.voteCount,
        }));

      const [paperCountRow] = await db.select({ c: sql<number>`count(*)::int` }).from(papers);
      const [voteCountRow] = await db.select({ c: sql<number>`count(*)::int` }).from(votes);

      const result = {
        dimension,
        totalPapers: paperCountRow?.c ?? 0,
        totalVotes: voteCountRow?.c ?? 0,
        entries,
        computedAt: new Date().toISOString(),
      };

      // Cache the result
      leaderboardCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
