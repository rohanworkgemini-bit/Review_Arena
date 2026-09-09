import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { VoteDimensionSchema } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { eloSnapshots, papers, reviewSystems, votes } from "../db/schema.js";
import { LeaderboardResponseSchema } from "./schemas.js";
import type { Config } from "../config.js";

// The only board served. Online Elo rows are no longer written (see
// votes.ts snapshotLeaderboard); rows from before that change still sit in
// elo_snapshots under method=ELO and are simply never read here. The thesis
// analysis recomputes Elo offline from the vote log to compare against BT.
const METHOD = "BT" as const;

// In-memory cache for leaderboard results. Invalidated on each vote.
// Key: "<method>:<overall | dimension>", Value: { result, expiresAt }
const leaderboardCache = new Map<
  string,
  {
    result: unknown;
    expiresAt: number;
  }
>();

const CACHE_TTL_MS = 5000; // 5 second TTL

function getCacheKey(method: string, dimension: string | null): string {
  return `${method}:${dimension ?? "overall"}`;
}

export function invalidateLeaderboardCache(dimension: string | null = null): void {
  if (dimension === null) {
    // Invalidate all caches on vote
    leaderboardCache.clear();
  } else {
    leaderboardCache.delete(getCacheKey(METHOD, dimension));
  }
}

export function leaderboardRouter(config: Config): Router {
  const router = Router();

  router.get("/leaderboard", async (req, res, next) => {
    try {
      const dimParse = VoteDimensionSchema.safeParse(req.query.dimension);
      const dimension = dimParse.success ? dimParse.data : null;
      // Bradley-Terry only: order-independent, and what LMArena reports
      // publicly. A legacy ?method= query parameter is ignored.
      const method = METHOD;
      const cacheKey = getCacheKey(method, dimension);

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
          anchor: eloSnapshots.anchor,
          slug: reviewSystems.slug,
          name: reviewSystems.name,
        })
        .from(eloSnapshots)
        .innerJoin(reviewSystems, eq(reviewSystems.id, eloSnapshots.reviewSystemId))
        .where(and(dimCondition, eq(eloSnapshots.method, method)))
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

      // Every BT row on a board shares one anchoring rule, so the first row
      // speaks for the board.
      const anchor = latest[0]?.anchor ?? null;
      const anchorParse = LeaderboardResponseSchema.shape.anchor.safeParse(anchor);

      // Enabled systems with no row on this board: usually the connectivity
      // guard (too few comparisons to place them against the field), and
      // systems with no votes at all.
      const ranked = new Set(entries.map((e) => e.systemSlug));
      const enabled = await db
        .select({ slug: reviewSystems.slug, name: reviewSystems.name })
        .from(reviewSystems)
        .where(eq(reviewSystems.enabled, true));
      const unranked = enabled
        .filter((s) => !ranked.has(s.slug))
        .map((s) => ({ systemSlug: s.slug, systemName: s.name }));

      const [paperCountRow] = await db.select({ c: sql<number>`count(*)::int` }).from(papers);
      const [voteCountRow] = await db.select({ c: sql<number>`count(*)::int` }).from(votes);

      const result = LeaderboardResponseSchema.parse({
        dimension,
        method,
        totalPapers: paperCountRow?.c ?? 0,
        totalVotes: voteCountRow?.c ?? 0,
        entries,
        unranked,
        anchor: anchorParse.success ? anchorParse.data : null,
        baselineSlug:
          anchorParse.success && anchorParse.data === "BASELINE"
            ? config.RATING_BASELINE_SLUG
            : null,
        computedAt: new Date().toISOString(),
      });

      // Cache the validated result
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
