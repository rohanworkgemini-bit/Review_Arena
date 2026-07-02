import { Router } from "express";
import { asc, eq, sql } from "drizzle-orm";
import {
  SubmitVoteRequestSchema,
  type VoteDimension,
} from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import {
  dimensionVotes,
  eloSnapshots,
  reviewSystems,
  reviews,
  votes,
} from "../db/schema.js";
import { verifyPairToken } from "./pair.js";
import {
  computeElo,
  bootstrapEloCI,
  incrementalEloUpdate,
  DEFAULT_ELO,
  type Battle,
  type Outcome,
} from "../elo/elo.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { invalidateLeaderboardCache } from "./leaderboard.js";

// Postgres advisory-lock key for serialising vote+snapshot writes.
// Any constant int8 works; 0xE10E10 = "eloelo" mnemonic, no clash.
const ELO_WRITER_LOCK = 0xe10e10;

/** Detect Postgres unique-violation errors thrown through node-postgres /
 *  Drizzle. Matches by SQLSTATE 23505 and (optionally) the constraint name
 *  so we don't accidentally swallow a different unique-index conflict. */
function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== "23505") return false;
  if (!constraintName) return true;
  return e.constraint === constraintName || e.constraint_name === constraintName;
}

export function votesRouter(config: Config): Router {
  const router = Router();

  router.post("/votes", async (req, res, next) => {
    try {
      const parse = SubmitVoteRequestSchema.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({
          error: "BadRequest",
          message: "Invalid request body.",
          details: parse.error.flatten(),
        });
        return;
      }
      const body = parse.data;

      const payload = verifyPairToken(body.pairToken, config.PAIR_TOKEN_SECRET);
      if (!payload || payload.sessionId !== req.sessionId) {
        logger.warn(
          {
            reason: !payload ? "invalid_token" : "session_mismatch",
            tokenLength: body.pairToken?.length,
            sessionId: req.sessionId,
            tokenSessionId: payload?.sessionId,
          },
          "vote_authorization_failed",
        );
        res.status(401).json({
          error: "Unauthorized",
          message: "Invalid or expired pairToken.",
        });
        return;
      }

      const [reviewA, reviewB] = await Promise.all([
        db.query.reviews.findFirst({
          where: eq(reviews.id, payload.reviewAId),
          with: { reviewSystem: true },
        }),
        db.query.reviews.findFirst({
          where: eq(reviews.id, payload.reviewBId),
          with: { reviewSystem: true },
        }),
      ]);
      if (!reviewA || !reviewB) {
        res.status(400).json({ error: "BadRequest", message: "Referenced reviews do not exist." });
        return;
      }

      const outcome: Outcome = body.winner === "A" ? 1 : body.winner === "B" ? 0 : 0.5;

      // Quality flagging: votes with decision time < 3s flagged for potential
      // botting. Flagged votes recorded but excluded from Elo (fairness B4).
      const DECISION_TIME_FLOOR_MS = 3000;
      const qualityFlagged = (body.decisionMs ?? Infinity) < DECISION_TIME_FLOOR_MS;
      if (qualityFlagged) {
        logger.info(
          { decisionMs: body.decisionMs, sessionId: req.sessionId },
          "vote_flagged: decision time below floor",
        );
      }

      // eloBefore on the pre-vote history; eloAfter via incremental update
      // for the reveal screen's delta.
      const beforeBattles = await loadBattles(db);
      const beforeRatings = computeElo(beforeBattles);
      const ratingABefore = beforeRatings.get(reviewA.reviewSystem.slug) ?? DEFAULT_ELO.INIT_RATING;
      const ratingBBefore = beforeRatings.get(reviewB.reviewSystem.slug) ?? DEFAULT_ELO.INIT_RATING;
      const { ratingA: ratingAAfter, ratingB: ratingBAfter } = incrementalEloUpdate(
        ratingABefore,
        ratingBBefore,
        outcome,
      );

      logger.info(
        {
          votePayload: { winner: body.winner, decisionMs: body.decisionMs },
          systems: { A: reviewA.reviewSystem.slug, B: reviewB.reviewSystem.slug },
          eloBeforeA: ratingABefore,
          eloBeforeB: ratingBBefore,
          eloAfterA: ratingAAfter,
          eloAfterB: ratingBAfter,
          battleCount: beforeBattles.length,
        },
        "vote_submitted: before snapshot",
      );

      // Single transaction wraps:
      //   1. advisory xact-lock (serialises with other writers so
      //      bootstrap CI / snapshot rows don't race),
      //   2. insert vote row + dimension votes,
      //   3. recompute + write the overall + per-dimension snapshots.
      // If anything throws after the vote insert, the whole tx rolls
      // back: no orphaned snapshot rows, no half-applied state.
      let voteId: string;
      try {
        voteId = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ELO_WRITER_LOCK})`);

          const [created] = await tx
            .insert(votes)
            .values({
              paperId: payload.paperId,
              reviewAId: payload.reviewAId,
              reviewBId: payload.reviewBId,
              winner: body.winner,
              sessionId: req.sessionId,
              userAgent: req.headers["user-agent"] ?? null,
              decisionMs: body.decisionMs ?? null,
              qualityFlagged,
            })
            .returning({ id: votes.id });
          const newId = created!.id;
          // Schema guarantees all 8 dimensions are present.
          await tx.insert(dimensionVotes).values(
            body.dimensions.map((d) => ({
              voteId: newId,
              dimension: d.dimension,
              value: d.value,
            })),
          );

          await snapshotLeaderboard(tx, newId, null);
          for (const d of body.dimensions) {
            await snapshotLeaderboard(tx, newId, d.dimension);
          }
          logger.info({ voteId: newId, paperId: payload.paperId }, "vote_persisted_and_snapshotted");
          return newId;
        });
      } catch (err) {
        // votes_session_pair_sig_uk catches replays — same session voting
        // on the same canonical pair twice (pairSig collapses A/B coin
        // flips so a swapped pair still matches). Return 409 so the
        // browser knows this token has already been spent rather than
        // surfacing a generic 500.
        if (isUniqueViolation(err, "votes_session_pair_sig_uk")) {
          res.status(409).json({
            error: "Conflict",
            message: "This pair has already been voted on for this session.",
          });
          return;
        }
        throw err;
      }

      // Invalidate leaderboard cache for all dimensions since Elo changed
      invalidateLeaderboardCache();

      res.status(201).json({
        voteId,
        reveal: {
          reviewA: {
            reviewId: reviewA.id,
            systemSlug: reviewA.reviewSystem.slug,
            systemName: reviewA.reviewSystem.name,
            eloBefore: ratingABefore,
            eloAfter: ratingAAfter,
          },
          reviewB: {
            reviewId: reviewB.id,
            systemSlug: reviewB.reviewSystem.slug,
            systemName: reviewB.reviewSystem.name,
            eloBefore: ratingBBefore,
            eloAfter: ratingBAfter,
          },
        },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Drizzle's transaction callback is typed as `tx: PgTransaction<...>`; we
// type the parameter loosely here so the snapshot helper can run inside
// either an active tx or a top-level db (caller currently always passes
// a tx, but we don't want to over-constrain).
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadBattles(executor: DbExecutor): Promise<Battle[]> {
  const rows = await executor.query.votes.findMany({
    orderBy: asc(votes.createdAt),
    with: {
      reviewA: { with: { reviewSystem: true } },
      reviewB: { with: { reviewSystem: true } },
    },
  });
  // FAIRNESS B1 — a comparison where either side did not COMPLETE is an
  // infra failure (cold-start, loop, empty stream), not low review
  // quality. Exclude those from the quality Elo so the leaderboard ranks
  // reviewing, not uptime. (Reliability is reported separately.)
  // Also exclude judge_status !== COMPLETE to avoid silent judge failures
  // corrupting the leaderboard.
  // FAIRNESS B4 — exclude votes flagged for low quality (e.g., decision time
  // < 3s) to detect potential botting or inattentive votes.
  return rows
    .filter(
      (v) =>
        v.reviewA.status === "COMPLETED" &&
        v.reviewB.status === "COMPLETED" &&
        v.reviewA.judgeStatus === "COMPLETE" &&
        v.reviewB.judgeStatus === "COMPLETE" &&
        !v.qualityFlagged,
    )
    .map((v) => ({
      a: v.reviewA.reviewSystem.slug,
      b: v.reviewB.reviewSystem.slug,
      outcome: v.winner === "A" ? 1 : v.winner === "B" ? 0 : 0.5,
    }));
}

async function snapshotLeaderboard(
  executor: DbExecutor,
  triggerVoteId: string,
  dimension: VoteDimension | null,
): Promise<void> {
  let battles: Battle[];
  if (dimension === null) {
    battles = await loadBattles(executor);
  } else {
    const rows = await executor.query.dimensionVotes.findMany({
      where: eq(dimensionVotes.dimension, dimension),
      with: {
        vote: {
          with: {
            reviewA: { with: { reviewSystem: true } },
            reviewB: { with: { reviewSystem: true } },
          },
        },
      },
      orderBy: asc(dimensionVotes.createdAt),
    });
    // FAIRNESS B1 — exclude dimension votes on failed comparisons too.
    // FAIRNESS B4 — exclude votes flagged for low quality.
    battles = rows
      .filter(
        (dv) =>
          dv.vote.reviewA.status === "COMPLETED" &&
          dv.vote.reviewB.status === "COMPLETED" &&
          !dv.vote.qualityFlagged,
      )
      .map((dv) => ({
        a: dv.vote.reviewA.reviewSystem.slug,
        b: dv.vote.reviewB.reviewSystem.slug,
        outcome: dv.value < 0 ? 1 : dv.value > 0 ? 0 : 0.5,
      }));
  }

  if (battles.length === 0) return;
  const ci = bootstrapEloCI(battles, 100);

  const allSystems = await executor.query.reviewSystems.findMany();
  const slugToId = new Map(allSystems.map((s) => [s.slug, s.id]));

  const rows = [...ci.entries()]
    .map(([slug, iv]) => {
      const systemId = slugToId.get(slug);
      if (!systemId) return null;
      return {
        reviewSystemId: systemId,
        dimension,
        rating: iv.rating,
        ratingCiLow: iv.ciLow,
        ratingCiHigh: iv.ciHigh,
        voteCount: iv.voteCount,
        triggerVoteId,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length > 0) await executor.insert(eloSnapshots).values(rows);
}

void reviewSystems;
