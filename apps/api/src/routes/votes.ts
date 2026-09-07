import { Router } from "express";
import { and, asc, eq, or, sql } from "drizzle-orm";
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
  voteDimensionEnum,
  votes,
} from "../db/schema.js";
import { verifyPairToken } from "./pair.js";
import {
  computeElo,
  bootstrapEloCI,
  incrementalEloUpdate,
  DEFAULT_ELO,
  type Battle,
  type BootstrapInterval,
  type Outcome,
} from "../elo/elo.js";
import { computeBT, bootstrapBTCI } from "../elo/bt.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { invalidateLeaderboardCache } from "./leaderboard.js";

// Postgres advisory-lock key for serialising vote+snapshot writes.
// Any constant int8 works; 0xE10E10 = "eloelo" mnemonic, no clash.
const ELO_WRITER_LOCK = 0xe10e10;

// Resamples per snapshot, shared by both rating systems so their intervals
// are comparable. FastChat uses 100 for the public board.
const BOOTSTRAP_ROUNDS = 100;

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

      // BT has no incremental update — it refits from the whole log — so the
      // reveal delta is a genuine before/after refit rather than Elo's
      // one-battle approximation. Both are point MLEs, which drift a little
      // from the bootstrap medians the leaderboard stores; same caveat that
      // already applies to the Elo numbers here.
      //
      // The battle only enters the "after" fit if it would survive
      // loadBattles' filters, so a flagged or failed comparison correctly
      // shows no movement.
      const countsTowardBoard =
        reviewA.status === "COMPLETED" &&
        reviewB.status === "COMPLETED" &&
        reviewA.judgeStatus !== "FAILED" &&
        reviewB.judgeStatus !== "FAILED" &&
        !qualityFlagged;
      const afterBattles: Battle[] = countsTowardBoard
        ? [
            ...beforeBattles,
            { a: reviewA.reviewSystem.slug, b: reviewB.reviewSystem.slug, outcome },
          ]
        : beforeBattles;
      const btOpts = { baselineSlug: config.RATING_BASELINE_SLUG };
      const btBeforeRatings = computeBT(beforeBattles, btOpts).ratings;
      const btAfterRatings = computeBT(afterBattles, btOpts).ratings;
      // null = this system is not on the BT board yet: too few comparisons to
      // connect it to the rest of the field (see bt.ts, Ford's condition).
      const btBeforeA = btBeforeRatings.get(reviewA.reviewSystem.slug) ?? null;
      const btBeforeB = btBeforeRatings.get(reviewB.reviewSystem.slug) ?? null;
      const btAfterA = btAfterRatings.get(reviewA.reviewSystem.slug) ?? null;
      const btAfterB = btAfterRatings.get(reviewB.reviewSystem.slug) ?? null;

      logger.info(
        {
          votePayload: { winner: body.winner, decisionMs: body.decisionMs },
          systems: { A: reviewA.reviewSystem.slug, B: reviewB.reviewSystem.slug },
          btAfterA,
          btAfterB,
          eloBeforeA: ratingABefore,
          eloBeforeB: ratingBBefore,
          eloAfterA: ratingAAfter,
          eloAfterB: ratingBAfter,
          battleCount: beforeBattles.length,
        },
        "vote_submitted: before snapshot",
      );

      // The transaction is deliberately insert-only. Snapshot recompute
      // (9 boards x 200 bootstrap rounds) used to run in here behind a
      // global advisory lock, which serialised every voter behind seconds
      // of synchronous compute at scale — each waiter pinning a pool
      // connection. Votes now commit immediately; ratings are recomputed
      // by the coalescing worker below, and the leaderboard's own 5s cache
      // means nobody can tell the difference.
      let voteId: string;
      try {
        voteId = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(votes)
            .values({
              paperId: payload.paperId,
              reviewAId: payload.reviewAId,
              reviewBId: payload.reviewBId,
              winner: body.winner,
              note: body.note?.trim() ? body.note.trim() : null,
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
              note: d.note?.trim() ? d.note.trim() : null,
            })),
          );

          logger.info({ voteId: newId, paperId: payload.paperId }, "vote_persisted");
          return newId;
        });
      } catch (err) {
        // votes_session_pair_sig_uk catches replays — same session voting
        // on the same canonical pair twice (pairSig collapses A/B coin
        // flips so a swapped pair still matches). Return 409 so the
        // browser knows this token has already been spent rather than
        // surfacing a generic 500.
        if (isUniqueViolation(err, "votes_session_pair_sig_uk")) {
          // A student whose first submit's RESPONSE was lost (network blip
          // after commit) retries and lands here. Without the voteId +
          // reveal payload they own a recorded vote they can never reach —
          // so return everything the success path would have.
          const existing = await db.query.votes.findFirst({
            where: and(
              eq(votes.sessionId, req.sessionId),
              or(
                and(eq(votes.reviewAId, payload.reviewAId), eq(votes.reviewBId, payload.reviewBId)),
                and(eq(votes.reviewAId, payload.reviewBId), eq(votes.reviewBId, payload.reviewAId)),
              ),
            ),
          });
          res.status(409).json({
            error: "Conflict",
            message: "This pair has already been voted on for this session.",
            voteId: existing?.id ?? null,
            reveal: existing
              ? {
                  reviewA: {
                    reviewId: reviewA.id,
                    systemSlug: reviewA.reviewSystem.slug,
                    systemName: reviewA.reviewSystem.name,
                    eloBefore: ratingABefore,
                    eloAfter: ratingAAfter,
                    btBefore: btBeforeA,
                    btAfter: btAfterA,
                  },
                  reviewB: {
                    reviewId: reviewB.id,
                    systemSlug: reviewB.reviewSystem.slug,
                    systemName: reviewB.reviewSystem.name,
                    eloBefore: ratingBBefore,
                    eloAfter: ratingBAfter,
                    btBefore: btBeforeB,
                    btAfter: btAfterB,
                  },
                }
              : null,
          });
          return;
        }
        throw err;
      }

      // Recompute all boards off the request path (coalesced under the
      // advisory lock) and drop the read cache once fresh rows land.
      scheduleSnapshotRecompute(voteId, config.RATING_BASELINE_SLUG);

      res.status(201).json({
        voteId,
        reveal: {
          reviewA: {
            reviewId: reviewA.id,
            systemSlug: reviewA.reviewSystem.slug,
            systemName: reviewA.reviewSystem.name,
            eloBefore: ratingABefore,
            eloAfter: ratingAAfter,
            btBefore: btBeforeA,
            btAfter: btAfterA,
          },
          reviewB: {
            reviewId: reviewB.id,
            systemSlug: reviewB.reviewSystem.slug,
            systemName: reviewB.reviewSystem.name,
            eloBefore: ratingBBefore,
            eloAfter: ratingBAfter,
            btBefore: btBeforeB,
            btAfter: btAfterB,
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
  // Also exclude judge_status FAILED (no panel member scored the pair) so a
  // silent judge failure can't corrupt the human-vs-judge analysis. PARTIAL
  // (some panel members returned) still counts; per-judge strictness lives
  // in the offline analysis, not the leaderboard.
  // FAIRNESS B4 — exclude votes flagged for low quality (e.g., decision time
  // < 3s) to detect potential botting or inattentive votes.
  return rows
    .filter(
      (v) =>
        v.reviewA.status === "COMPLETED" &&
        v.reviewB.status === "COMPLETED" &&
        // Judge FAILED = we could not score this review; exclude it so a
        // silent judge failure can't corrupt the human-vs-judge analysis.
        // PENDING (not yet judged) still counts — the human vote is valid
        // regardless of whether the judge has caught up.
        v.reviewA.judgeStatus !== "FAILED" &&
        v.reviewB.judgeStatus !== "FAILED" &&
        !v.qualityFlagged,
    )
    .map((v) => ({
      a: v.reviewA.reviewSystem.slug,
      b: v.reviewB.reviewSystem.slug,
      outcome: v.winner === "A" ? 1 : v.winner === "B" ? 0 : 0.5,
    }));
}

// ─── Snapshot worker ──────────────────────────────────────────────────────
// One recompute at a time per process; a vote landing mid-recompute is
// coalesced into exactly one follow-up run (its snapshot includes every vote
// committed by then — the recompute always reads the full history). The
// advisory lock still serialises across processes.
let snapshotWorkerRunning = false;
let pendingSnapshotTrigger: { voteId: string; baselineSlug: string } | null = null;

export function scheduleSnapshotRecompute(voteId: string, baselineSlug: string): void {
  pendingSnapshotTrigger = { voteId, baselineSlug };
  if (snapshotWorkerRunning) return;
  snapshotWorkerRunning = true;
  void (async () => {
    while (pendingSnapshotTrigger) {
      const trigger = pendingSnapshotTrigger;
      pendingSnapshotTrigger = null;
      const started = Date.now();
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ELO_WRITER_LOCK})`);
          await snapshotLeaderboard(tx, trigger.voteId, null, trigger.baselineSlug);
          for (const d of voteDimensionEnum.enumValues) {
            await snapshotLeaderboard(tx, trigger.voteId, d, trigger.baselineSlug);
          }
        });
        invalidateLeaderboardCache();
        logger.info(
          { voteId: trigger.voteId, elapsedMs: Date.now() - started },
          "leaderboard_snapshots_recomputed",
        );
      } catch (err) {
        // The vote itself is committed; a failed recompute is repaired by
        // the next vote's run. Never let this reject unhandled.
        logger.error({ err, voteId: trigger.voteId }, "snapshot_recompute_failed");
      }
    }
    snapshotWorkerRunning = false;
  })();
}

async function snapshotLeaderboard(
  executor: DbExecutor,
  triggerVoteId: string,
  dimension: VoteDimension | null,
  baselineSlug: string,
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

  // Both systems, same battle set, same number of resamples — so the two
  // boards are always reading the same evidence and can be compared directly.
  const eloCI = bootstrapEloCI(battles, BOOTSTRAP_ROUNDS);
  const btCI = bootstrapBTCI(battles, BOOTSTRAP_ROUNDS, { baselineSlug });
  // BT is anchored on the baseline only where the baseline actually appears
  // on this board; sparse per-dimension boards fall back to mean-centring.
  const btAnchor = btCI.has(baselineSlug) ? "BASELINE" : "MEAN";

  const allSystems = await executor.query.reviewSystems.findMany();
  const slugToId = new Map(allSystems.map((s) => [s.slug, s.id]));

  const toRows = (
    ci: Map<string, BootstrapInterval>,
    method: "ELO" | "BT",
    anchor: string | null,
  ) =>
    [...ci.entries()]
      .map(([slug, iv]) => {
        const systemId = slugToId.get(slug);
        if (!systemId) return null;
        return {
          reviewSystemId: systemId,
          dimension,
          method,
          anchor,
          rating: iv.rating,
          ratingCiLow: iv.ciLow,
          ratingCiHigh: iv.ciHigh,
          voteCount: iv.voteCount,
          triggerVoteId,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

  // Systems BT could not place (outside the connected component) simply get
  // no BT row — the leaderboard reports them as unranked rather than
  // inventing a number for them.
  const rows = [...toRows(eloCI, "ELO", null), ...toRows(btCI, "BT", btAnchor)];

  if (rows.length > 0) await executor.insert(eloSnapshots).values(rows);
}
