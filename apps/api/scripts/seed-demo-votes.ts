// Fill the leaderboard with synthetic comparisons, to see the board and the
// intervals behave at a realistic vote count before any real data exists.
//
// Everything it writes is marked and removable: papers get a "[demo]" title
// prefix and a demo- content hash, and --clear deletes exactly those and
// everything hanging off them. Nothing else is touched.
//
//   pnpm --filter @reviewarena/api demo:votes                     # 1000 votes
//
// With flags, call the script directly — `pnpm run` does not forward them
// reliably through the filter:
//   pnpm --filter @reviewarena/api exec tsx scripts/seed-demo-votes.ts -n 250
//   pnpm --filter @reviewarena/api exec tsx scripts/seed-demo-votes.ts --clear
//
// NOT research data. Votes are drawn from a planted Bradley-Terry ordering,
// so the board they produce says nothing about the systems — it exercises
// the estimator, the bootstrap and the connectivity guard. Clear it before
// collecting anything real: there is no flag distinguishing a synthetic
// vote from a human one once it is in the votes table, which is exactly
// why the papers carry a marker and this script owns the cleanup.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { createId } from "@paralleldrive/cuid2";
import { inArray, like } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import {
  dimensionVotes,
  ratings,
  papers,
  reviews,
  reviewSystems,
  votes,
} from "../src/db/schema.js";
import { VOTE_DIMENSIONS } from "@reviewarena/shared-types";
import { snapshotLeaderboard } from "../src/routes/votes.js";

const TITLE_PREFIX = "[demo] ";
const HASH_PREFIX = "demo-";

const args = process.argv.slice(2);
const CLEAR = args.includes("--clear");
const N = (() => {
  const i = args.indexOf("-n");
  const raw = i !== -1 ? Number(args[i + 1]) : 1000;
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
})();

// Planted strengths on the Bradley-Terry scale. Deliberately spread wider
// than six frontier models would really be, so the ordering is visible at a
// glance rather than buried in overlapping intervals — the point is to see
// the board work, not to predict anything.
const TRUE_STRENGTH: Record<string, number> = {
  "gpt-5.6-terra": 1120,
  "claude-sonnet-5": 1080,
  "gemini-3.8-flash": 1030,
  "deepseek-v4-flash": 980,
  "glm-5.2": 950,
  "mistral-medium-3.5": 900,
};

// Deterministic RNG: the same invocation produces the same board, so a
// surprising result can be looked at twice.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// Postgres caps a statement at 65535 bound parameters, so rows go in
// chunks. One statement per row is fine at 1000 votes and roughly 30k
// round trips at 10000 — this turns the whole seed into a few dozen.
const CHUNK = 500;

async function insertMany<T>(
  table: Parameters<typeof db.insert>[0],
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(table).values(rows.slice(i, i + CHUNK) as never);
  }
}

async function clear(): Promise<void> {
  const demo = await db.query.papers.findMany({
    where: like(papers.contentHash, `${HASH_PREFIX}%`),
    columns: { id: true },
  });
  if (demo.length === 0) {
    console.log("No demo papers found — nothing to clear.");
    return;
  }
  const paperIds = demo.map((p) => p.id);
  const voteRows = await db.query.votes.findMany({
    where: inArray(votes.paperId, paperIds),
    columns: { id: true },
  });
  const voteIds = voteRows.map((v) => v.id);

  // Order matters: votes.paper_id and ratings.trigger_vote_id are
  // plain references, not cascades, so the rows pointing at what we are
  // deleting have to be dealt with first. Reviews DO cascade to
  // metric_scores and judge_verdicts, so those come free.
  await db.transaction(async (tx) => {
    if (voteIds.length) {
      await tx
        .update(ratings)
        .set({ triggerVoteId: null })
        .where(inArray(ratings.triggerVoteId, voteIds));
      await tx.delete(dimensionVotes).where(inArray(dimensionVotes.voteId, voteIds));
      await tx.delete(votes).where(inArray(votes.id, voteIds));
    }
    await tx.delete(reviews).where(inArray(reviews.paperId, paperIds));
    await tx.delete(papers).where(inArray(papers.id, paperIds));
  });

  console.log(`Cleared ${demo.length} demo paper(s) and ${voteIds.length} vote(s).`);

  // The board caches from `ratings`, whose rows were fitted over the
  // synthetic votes. Refit on what is left so the leaderboard reflects
  // reality again rather than a field that no longer exists.
  const remaining = await db.query.votes.findFirst({ columns: { id: true } });
  const baselineSlug = process.env.RATING_BASELINE_SLUG ?? "claude-sonnet-5";
  if (remaining) {
    console.log("Recomputing snapshots over the remaining votes…");
    await snapshotLeaderboard(db, remaining.id, null, baselineSlug);
    for (const d of VOTE_DIMENSIONS) await snapshotLeaderboard(db, remaining.id, d, baselineSlug);
  } else {
    // No votes left at all: stale snapshots would keep a phantom board on
    // screen with nothing behind it.
    await db.delete(ratings);
    console.log("No votes remain — dropped the snapshots too.");
  }
}

async function seed(): Promise<void> {
  const systems = (await db.query.reviewSystems.findMany()).filter((s) => s.enabled);
  if (systems.length < 2) {
    console.error(`Need at least 2 enabled systems, found ${systems.length}. Run db:seed.`);
    process.exit(1);
  }
  const unknown = systems.filter((s) => TRUE_STRENGTH[s.slug] === undefined);
  if (unknown.length)
    console.log(
      `note: ${unknown.map((s) => s.slug).join(", ")} not in the planted ordering — using 1000.`,
    );

  const rand = rng(20260908);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

  // One paper per ~6 votes, so the board has a plausible papers:votes ratio
  // and the per-paper dedupe in any later analysis has something to chew on.
  const paperCount = Math.max(1, Math.ceil(N / 6));
  console.log(`Seeding ${N} votes across ${paperCount} demo papers…`);

  const paperIds: string[] = [];
  const paperRows = [];
  for (let i = 0; i < paperCount; i++) {
    const id = createId();
    paperIds.push(id);
    paperRows.push({
      id,
      contentHash: `${HASH_PREFIX}${id}`,
      userTitle: `${TITLE_PREFIX}synthetic paper ${i + 1}`,
      status: "PARSED" as const,
      conference: "iclr",
      // Consent is a real column with real meaning; a synthetic paper has
      // no uploader to have given it, so it stays null.
    });
  }
  await insertMany(papers, paperRows);

  // A review per (paper, system). Reviews carry no text: nothing renders
  // them, and writing 6000 fake reviews would make the table meaningless
  // for anyone inspecting real output.
  const reviewByPaperSystem = new Map<string, string>();
  const reviewRows = [];
  for (const paperId of paperIds) {
    for (const sys of systems) {
      const id = createId();
      reviewByPaperSystem.set(`${paperId}:${sys.id}`, id);
      reviewRows.push({
        id,
        paperId,
        reviewSystemId: sys.id,
        status: "COMPLETED" as const,
        // PENDING, like an arena review: it counts, and it is honest —
        // no panel ever looked at this.
        judgeStatus: "PENDING" as const,
      });
    }
  }
  await insertMany(reviews, reviewRows);

  // votes_session_pair_sig_uk is unique on (session, paper, pairSig): a
  // session may not vote twice on the same pair of the same paper. Rather
  // than draw at random and retry on collision, each session is walked
  // across consecutive papers, so it never revisits one and the constraint
  // cannot fire. Six votes per session is also roughly what a real visitor
  // does, which keeps the session clustering realistic for anything that
  // later resamples by session.
  const VOTES_PER_SESSION = 6;
  const voteRows = [];
  const dimRows = [];
  for (let i = 0; i < N; i++) {
    const paperId = paperIds[i % paperIds.length]!;
    const a = pick(systems);
    let b = pick(systems);
    while (b.id === a.id) b = pick(systems);

    const sa = TRUE_STRENGTH[a.slug] ?? 1000;
    const sb = TRUE_STRENGTH[b.slug] ?? 1000;
    // Bradley-Terry win probability on the 400-point logistic scale the
    // ratings are expressed in — the same curve the estimator inverts.
    const pA = 1 / (1 + 10 ** ((sb - sa) / 400));
    const r = rand();
    // A tie band, because real raters use it heavily and a board fitted
    // without ties behaves differently.
    const winner = r < pA * 0.85 ? "A" : r < pA * 0.85 + 0.15 ? "TIE" : "B";

    const voteId = createId();
    voteRows.push({
      id: voteId,
      paperId,
      reviewAId: reviewByPaperSystem.get(`${paperId}:${a.id}`)!,
      reviewBId: reviewByPaperSystem.get(`${paperId}:${b.id}`)!,
      winner: winner as "A" | "B" | "TIE",
      mode: "ARENA" as const,
      // Plausible reading times, above the 3s quality-flag threshold.
      decisionMs: 20_000 + Math.floor(rand() * 90_000),
      sessionId: `demo-s${Math.floor(i / VOTES_PER_SESSION)}`,
    });

    // Per-dimension picks, correlated with the overall verdict but not
    // identical to it — a board where every dimension agrees perfectly
    // would hide exactly the disagreement the per-dimension boards exist
    // to show.
    dimRows.push(
      ...VOTE_DIMENSIONS.map((dimension) => {
        const agree = rand() < 0.7;
        const dimWinner = agree
          ? winner
          : (["A", "TIE", "B"] as const)[Math.floor(rand() * 3)]!;
        return { id: createId(), voteId, dimension, winner: dimWinner };
      }),
    );
  }

  await insertMany(votes, voteRows);
  await insertMany(dimensionVotes, dimRows);
  const written = voteRows.length;

  // The board renders from `ratings`, which the API writes as each vote
  // lands. Writing votes straight to the database bypasses that, so the
  // rows have to be refreshed here or the leaderboard shows the old
  // ratings under the new vote count.
  const baselineSlug = process.env.RATING_BASELINE_SLUG ?? "claude-sonnet-5";
  const lastVote = await db.query.votes.findFirst({
    where: inArray(votes.paperId, paperIds),
    columns: { id: true },
  });
  if (lastVote) {
    console.log("\nRecomputing leaderboard snapshots (overall + 8 dimensions)…");
    await snapshotLeaderboard(db, lastVote.id, null, baselineSlug);
    for (const d of VOTE_DIMENSIONS) {
      await snapshotLeaderboard(db, lastVote.id, d, baselineSlug);
    }
  }

  console.log(`\nWrote ${written} votes across ${paperIds.length} papers.`);
  console.log("Planted ordering (best first):");
  for (const [slug, s] of Object.entries(TRUE_STRENGTH).sort((x, y) => y[1] - x[1]))
    console.log(`  ${String(s).padStart(5)}  ${slug}`);
  console.log(
    "\nRemove it all with:\n" +
      "  pnpm --filter @reviewarena/api exec tsx scripts/seed-demo-votes.ts --clear",
  );
}

async function main(): Promise<void> {
  if (CLEAR) {
    // Deleting synthetic data is always allowed, including in production —
    // it is the safe direction, and refusing would strand demo rows on the
    // one deployment where they matter most.
    await clear();
  } else {
    if (process.env.NODE_ENV === "production" && !args.includes("--yes")) {
      console.error(
        "Refusing to write synthetic votes with NODE_ENV=production. Pass --yes if you are sure.",
      );
      process.exit(1);
    }
    await seed();
  }
  await closeDbPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
