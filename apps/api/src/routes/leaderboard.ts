import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { VoteDimensionSchema } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { ratings, papers, reviewSystems } from "../db/schema.js";
import { LeaderboardResponseSchema } from "./schemas.js";
import type { Config } from "../config.js";
// Circular with votes.ts (which imports invalidateLeaderboardCache from
// here); safe because neither side touches the other's bindings at module
// evaluation time.
import { countEligibleVotes } from "./votes.js";

// The only board served. Online Elo rows are no longer written (see
// votes.ts snapshotLeaderboard); rows from before that change still sit in
// `ratings` under method=ELO and are simply never read here. The thesis
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
        ? eq(ratings.dimension, dimension)
        : isNull(ratings.dimension);

      // The newest snapshot for this board, and only that one. A snapshot is
      // the batch of rows one snapshotLeaderboard call inserts — a single
      // INSERT, so every row in it carries the same computed_at (now() is
      // fixed per transaction). Taking the latest row per system across all
      // time instead would keep showing a stale rating for a system that
      // dropped out of the newest fit; here such a system has no row and so
      // lands in `unranked` below. The max is taken in SQL so computed_at's
      // microseconds never round-trip through a JS Date.
      const r2 = alias(ratings, "ratings_latest");
      const r2DimCondition = dimension ? eq(r2.dimension, dimension) : isNull(r2.dimension);
      const latestComputedAt = db
        .select({ at: sql`max(${r2.computedAt})` })
        .from(r2)
        .where(and(r2DimCondition, eq(r2.method, method)));
      const latest = await db
        .select({
          reviewSystemId: ratings.reviewSystemId,
          rating: ratings.rating,
          ratingCiLow: ratings.ratingCiLow,
          ratingCiHigh: ratings.ratingCiHigh,
          voteCount: ratings.voteCount,
          anchor: ratings.anchor,
          slug: reviewSystems.slug,
          name: reviewSystems.name,
        })
        .from(ratings)
        .innerJoin(reviewSystems, eq(reviewSystems.id, ratings.reviewSystemId))
        .where(
          and(
            dimCondition,
            eq(ratings.method, method),
            sql`${ratings.computedAt} = (${latestComputedAt})`,
          ),
        );

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
      // Votes that count toward the ratings, under the same eligibility rule
      // as the fit (votes.ts eligibleVoteWhere) — not every row in `votes`,
      // which would include quality-flagged, dry-run and failed-review votes.
      const totalVotes = await countEligibleVotes(db);

      const result = LeaderboardResponseSchema.parse({
        dimension,
        method,
        totalPapers: paperCountRow?.c ?? 0,
        totalVotes,
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
