import { Router } from "express";
import { and, asc, count, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  SubmitVoteRequestSchema,
  type VoteDimension,
} from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import {
  dimensionVotes,
  participants,
  ratings,
  reviewSystems,
  reviews,
  voteDimensionEnum,
  votes,
} from "../db/schema.js";
import { verifyPairToken } from "./pair.js";
import {
  computeBT,
  leaderboardBT,
  outcomeOf,
  type Battle,
  type BootstrapInterval,
  type Winner,
} from "../rating/bt.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { invalidateLeaderboardCache } from "./leaderboard.js";

// Postgres advisory-lock key for serialising vote+snapshot writes.
// Any constant int8 works; 0xE10E10 = "eloelo" mnemonic, no clash.
const ELO_WRITER_LOCK = 0xe10e10;

// Resamples per Bradley-Terry snapshot. (Online Elo is no longer computed here — see snapshotLeaderboard.)
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

/** Votes decided faster than this are flagged as potential botting:
 *  recorded, but excluded from every board (B4). A missing decision time is
 *  not flagged. Shared with study votes so both modes filter identically. */
export const DECISION_TIME_FLOOR_MS = 3000;

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

      const outcome = outcomeOf(body.winner);

      // Quality flagging (B4): see DECISION_TIME_FLOOR_MS.
      const qualityFlagged = (body.decisionMs ?? Infinity) < DECISION_TIME_FLOOR_MS;
      if (qualityFlagged) {
        logger.info(
          { decisionMs: body.decisionMs, sessionId: req.sessionId },
          "vote_flagged: decision time below floor",
        );
      }

      // The reveal's before/after is a genuine Bradley-Terry refit on the
      // pre-vote log and again with this vote appended — BT has no
      // incremental update. (Online Elo, which used to supply a one-battle
      // approximation here, is no longer computed at runtime; the thesis
      // analysis replays it offline to compare against BT.) Both fits are
      // point MLEs, which drift a little from the bootstrap medians the
      // leaderboard stores.
      //
      // The log is read once per request (slugs + verdicts only, through the
      // shared eligibility rule) and both fits run off that one read. It is
      // not handed on to the snapshot worker: that runs later, coalesced
      // across votes, and must see every vote committed by then — a log read
      // before this insert would miss concurrent ones.
      const log = await loadVoteLog(db);
      // The battle only enters the "after" fit if it would survive the
      // board's eligibility rule (eligibleVoteWhere), so a flagged or failed
      // comparison correctly shows no movement. This is that rule evaluated
      // on the vote about to be written; the test-participant clause cannot
      // apply because arena votes never carry a participantId.
      const countsTowardBoard =
        reviewA.status === "COMPLETED" &&
        reviewB.status === "COMPLETED" &&
        reviewA.judgeStatus !== "FAILED" &&
        reviewB.judgeStatus !== "FAILED" &&
        !qualityFlagged;
      const btOpts = { baselineSlug: config.RATING_BASELINE_SLUG };
      const slugA = reviewA.reviewSystem.slug;
      const slugB = reviewB.reviewSystem.slug;

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
              winner: d.winner,
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
          let reveal: ReturnType<typeof revealFor> | null = null;
          if (existing) {
            // The stored vote is already in the log (if it counts), so
            // "before" is the log without it and "after" the log with it
            // exactly once — not the log plus a second copy, which would
            // show a delta nobody's vote caused. A unique violation means
            // the original committed, but possibly after our read above
            // (a concurrent double-submit), so re-read in that rare case.
            const entries = log.some((e) => e.voteId === existing.id)
              ? log
              : await loadVoteLog(db);
            const { before, own } = splitOwnVote(entries, existing.id);
            reveal = revealFor(before, own, slugA, slugB, btOpts);
          }
          res.status(409).json({
            error: "Conflict",
            message: "This pair has already been voted on for this session.",
            voteId: existing?.id ?? null,
            reveal:
              existing && reveal
                ? {
                    // The verdict already on record, not the retried body —
                    // they should agree, but the stored one is the truth.
                    winner: existing.winner,
                    reviewA: {
                      reviewId: reviewA.id,
                      systemSlug: slugA,
                      systemName: reviewA.reviewSystem.name,
                      btBefore: reveal.btBeforeA,
                      btAfter: reveal.btAfterA,
                    },
                    reviewB: {
                      reviewId: reviewB.id,
                      systemSlug: slugB,
                      systemName: reviewB.reviewSystem.name,
                      btBefore: reveal.btBeforeB,
                      btAfter: reveal.btAfterB,
                    },
                  }
                : null,
          });
          return;
        }
        throw err;
      }

      const { btBeforeA, btBeforeB, btAfterA, btAfterB } = revealFor(
        log.map((e) => e.battle),
        countsTowardBoard ? { a: slugA, b: slugB, outcome } : null,
        slugA,
        slugB,
        btOpts,
      );

      logger.info(
        {
          voteId,
          votePayload: { winner: body.winner, decisionMs: body.decisionMs },
          systems: { A: slugA, B: slugB },
          btBeforeA,
          btBeforeB,
          btAfterA,
          btAfterB,
          battleCount: log.length,
        },
        "vote_submitted: before snapshot",
      );

      // Recompute all boards off the request path (coalesced under the
      // advisory lock) and drop the read cache once fresh rows land.
      scheduleSnapshotRecompute(voteId, config.RATING_BASELINE_SLUG);

      res.status(201).json({
        voteId,
        reveal: {
          winner: body.winner,
          reviewA: {
            reviewId: reviewA.id,
            systemSlug: slugA,
            systemName: reviewA.reviewSystem.name,
            btBefore: btBeforeA,
            btAfter: btAfterA,
          },
          reviewB: {
            reviewId: reviewB.id,
            systemSlug: slugB,
            systemName: reviewB.reviewSystem.name,
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

// ─── Vote eligibility ─────────────────────────────────────────────────────
// ONE rule decides which votes count, for all nine boards (overall + eight
// dimensions) and for the leaderboard's totalVotes. It is a SQL predicate
// over `votes` joined to its two reviews under the aliases below; every
// reader (loadVoteLog, loadBoardRows, countEligibleVotes) applies it, so the boards
// cannot drift apart again (the dimension boards once kept test-participant
// and judge-FAILED votes the overall board dropped).
//
// FAIRNESS B1 — a comparison where either side did not COMPLETE is an
// infra failure (cold-start, loop, empty stream), not low review quality.
// Exclude those so the leaderboard ranks reviewing, not uptime.
// (Reliability is reported separately.)
// Judge FAILED (no panel member scored the pair) is excluded so a silent
// judge failure can't corrupt the human-vs-judge analysis. PARTIAL (some
// panel members returned) and PENDING (not yet judged) still count — the
// human vote is valid regardless; per-judge strictness lives in the offline
// analysis, not the leaderboard.
// FAIRNESS B4 — exclude votes flagged for low quality (e.g., decision time
// < 3s) to detect potential botting or inattentive votes.
// Dry runs — a vote cast under a T-code is a real vote through the real
// path, deliberately so, but it is us walking the flow rather than a
// participant judging reviews. participantId is null on arena votes, so
// this only ever touches study rows. Evaluated in the query rather than
// memoised: a stale set would silently put a dry run on the public board.
const eligReviewA = alias(reviews, "elig_review_a");
const eligReviewB = alias(reviews, "elig_review_b");
const eligSystemA = alias(reviewSystems, "elig_system_a");
const eligSystemB = alias(reviewSystems, "elig_system_b");

function eligibleVoteWhere(): SQL {
  return and(
    eq(eligReviewA.status, "COMPLETED"),
    eq(eligReviewB.status, "COMPLETED"),
    ne(eligReviewA.judgeStatus, "FAILED"),
    ne(eligReviewB.judgeStatus, "FAILED"),
    eq(votes.qualityFlagged, false),
    sql`NOT EXISTS (SELECT 1 FROM ${participants} WHERE ${participants.id} = ${votes.participantId} AND ${participants.isTest})`,
  )!;
}

/** Number of votes that count toward the boards — the same rule the fit
 *  uses. Exported for the leaderboard's totalVotes. */
export async function countEligibleVotes(executor: DbExecutor = db): Promise<number> {
  const [row] = await executor
    .select({ c: count() })
    .from(votes)
    .innerJoin(eligReviewA, eq(eligReviewA.id, votes.reviewAId))
    .innerJoin(eligReviewB, eq(eligReviewB.id, votes.reviewBId))
    .where(eligibleVoteWhere());
  return row?.c ?? 0;
}

/** One eligible overall verdict, keyed by its vote. */
export interface VoteLogEntry {
  voteId: string;
  battle: Battle;
}

/** The overall board's battle log, oldest first: slugs and verdicts only. */
async function loadVoteLog(executor: DbExecutor): Promise<VoteLogEntry[]> {
  const rows = await executor
    .select({
      voteId: votes.id,
      a: eligSystemA.slug,
      b: eligSystemB.slug,
      winner: votes.winner,
    })
    .from(votes)
    .innerJoin(eligReviewA, eq(eligReviewA.id, votes.reviewAId))
    .innerJoin(eligReviewB, eq(eligReviewB.id, votes.reviewBId))
    .innerJoin(eligSystemA, eq(eligSystemA.id, eligReviewA.reviewSystemId))
    .innerJoin(eligSystemB, eq(eligSystemB.id, eligReviewB.reviewSystemId))
    .where(eligibleVoteWhere())
    .orderBy(asc(votes.createdAt), asc(votes.id));
  return rows.map((r) => ({
    voteId: r.voteId,
    battle: { a: r.a, b: r.b, outcome: outcomeOf(r.winner) },
  }));
}

/** One row per (eligible vote, dimension verdict); dimension fields are null
 *  for a vote with no dimension rows (left join). */
export interface BoardRow {
  voteId: string;
  a: string;
  b: string;
  winner: Winner;
  dimension: VoteDimension | null;
  dimensionWinner: Winner | null;
}

/** Every eligible vote with its systems and dimension verdicts, in one
 *  query, oldest vote first. */
async function loadBoardRows(executor: DbExecutor): Promise<BoardRow[]> {
  return executor
    .select({
      voteId: votes.id,
      a: eligSystemA.slug,
      b: eligSystemB.slug,
      winner: votes.winner,
      dimension: dimensionVotes.dimension,
      dimensionWinner: dimensionVotes.winner,
    })
    .from(votes)
    .innerJoin(eligReviewA, eq(eligReviewA.id, votes.reviewAId))
    .innerJoin(eligReviewB, eq(eligReviewB.id, votes.reviewBId))
    .innerJoin(eligSystemA, eq(eligSystemA.id, eligReviewA.reviewSystemId))
    .innerJoin(eligSystemB, eq(eligSystemB.id, eligReviewB.reviewSystemId))
    .leftJoin(dimensionVotes, eq(dimensionVotes.voteId, votes.id))
    .where(eligibleVoteWhere())
    .orderBy(asc(votes.createdAt), asc(votes.id), asc(dimensionVotes.createdAt));
}

/** All nine battle lists from one pass over the joined rows. Rows must be
 *  grouped by vote (as loadBoardRows orders them); each vote enters the
 *  overall board once however many dimension rows it carries. Every board
 *  is built from the same eligible votes — there is no per-board filter. */
export function partitionBoards(rows: readonly BoardRow[]): {
  overall: Battle[];
  byDimension: Map<VoteDimension, Battle[]>;
} {
  const overall: Battle[] = [];
  const byDimension = new Map<VoteDimension, Battle[]>(
    voteDimensionEnum.enumValues.map((d) => [d, []]),
  );
  let lastVoteId: string | null = null;
  for (const r of rows) {
    if (r.voteId !== lastVoteId) {
      overall.push({ a: r.a, b: r.b, outcome: outcomeOf(r.winner) });
      lastVoteId = r.voteId;
    }
    if (r.dimension !== null && r.dimensionWinner !== null) {
      // Same converter as the overall board — that is the point of storing
      // both verdicts in one encoding.
      byDimension.get(r.dimension)!.push({ a: r.a, b: r.b, outcome: outcomeOf(r.dimensionWinner) });
    }
  }
  return { overall, byDimension };
}

/** For a replayed vote: the log without it, and its own battle (null when
 *  it does not count toward the board). */
export function splitOwnVote(
  entries: readonly VoteLogEntry[],
  voteId: string,
): { before: Battle[]; own: Battle | null } {
  const before: Battle[] = [];
  let own: Battle | null = null;
  for (const e of entries) {
    if (e.voteId === voteId) own = e.battle;
    else before.push(e.battle);
  }
  return { before, own };
}

/** Reveal numbers: BT on `before`, and on `before` + `added` (the same fit
 *  reused when the vote does not count). null = not on the BT board yet: too
 *  few comparisons to connect it to the field (see bt.ts, Ford's condition). */
export function revealFor(
  before: readonly Battle[],
  added: Battle | null,
  slugA: string,
  slugB: string,
  opts: { baselineSlug: string },
): { btBeforeA: number | null; btBeforeB: number | null; btAfterA: number | null; btAfterB: number | null } {
  const beforeRatings = computeBT(before, opts).ratings;
  const afterRatings = added ? computeBT([...before, added], opts).ratings : beforeRatings;
  return {
    btBeforeA: beforeRatings.get(slugA) ?? null,
    btBeforeB: beforeRatings.get(slugB) ?? null,
    btAfterA: afterRatings.get(slugA) ?? null,
    btAfterB: afterRatings.get(slugB) ?? null,
  };
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
        await recomputeAllLeaderboards(trigger.voteId, trigger.baselineSlug);
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

/** All nine boards in one transaction, under the writer lock. Exported for
 *  scripts/recompute-leaderboard.ts, which refreshes the snapshots after a
 *  change to the rating method without waiting for a new vote.
 *
 *  One query reads every eligible vote with its systems and dimension
 *  verdicts; the nine battle lists are partitioned in memory. All nine
 *  inserts share the transaction's now(), so they form one snapshot batch. */
export async function recomputeAllLeaderboards(triggerVoteId: string, baselineSlug: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ELO_WRITER_LOCK})`);
    const boards = partitionBoards(await loadBoardRows(tx));
    await snapshotLeaderboard(tx, triggerVoteId, null, baselineSlug, boards.overall);
    for (const d of voteDimensionEnum.enumValues) {
      await snapshotLeaderboard(tx, triggerVoteId, d, baselineSlug, boards.byDimension.get(d) ?? []);
    }
  });
}

/** Exported for scripts/seed-demo-votes.ts, which writes votes straight to
 *  the database and so must refresh the snapshots the board reads from.
 *  `battles` lets recomputeAllLeaderboards pass a pre-partitioned board;
 *  without it the board is loaded here under the same eligibility rule.
 *
 *  A snapshot is the set of rows one call inserts (one INSERT, so one
 *  computed_at); the leaderboard reads only the newest such set per board. */
export async function snapshotLeaderboard(
  executor: DbExecutor,
  triggerVoteId: string,
  dimension: VoteDimension | null,
  baselineSlug: string,
  battles?: readonly Battle[],
): Promise<void> {
  if (battles === undefined) {
    const boards = partitionBoards(await loadBoardRows(executor));
    battles = dimension === null ? boards.overall : (boards.byDimension.get(dimension) ?? []);
  }

  // Bradley-Terry only. Online Elo rows are no longer written: the thesis
  // analysis recomputes Elo offline from the vote log to compare against BT,
  // and rows written under method=ELO before this change stay in the table
  // unread.
  // The rating is the full-data fit, the interval comes from
  // the bootstrap. BT is anchored on the baseline only where the baseline
  // actually appears on this board; sparse boards fall back to mean-centring.
  const { rows: btCI, anchor: btAnchor } = leaderboardBT(battles, BOOTSTRAP_ROUNDS, { baselineSlug });

  const allSystems = await executor.query.reviewSystems.findMany();
  const slugToId = new Map(allSystems.map((s) => [s.slug, s.id]));

  const toRows = (
    ci: Map<string, BootstrapInterval>,
    method: "BT",
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
  // no row — the leaderboard reports them as unranked rather than inventing
  // a number for them.
  const rows = toRows(btCI, "BT", btAnchor);

  if (rows.length > 0) {
    await executor.insert(ratings).values(rows);
  } else {
    // Nothing on this board can be ranked (no eligible battles left, or no
    // connected pair). An empty snapshot has no row to carry its
    // computed_at, so the only way to stop the leaderboard serving the
    // previous snapshot as current is to remove this board's BT rows —
    // the same choice scripts/seed-demo-votes.ts makes when no votes remain.
    await executor
      .delete(ratings)
      .where(
        and(
          dimension === null ? isNull(ratings.dimension) : eq(ratings.dimension, dimension),
          eq(ratings.method, "BT"),
        ),
      );
  }
}
