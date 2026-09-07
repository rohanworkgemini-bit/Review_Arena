// One-shot: HARD-DELETE a review system and everything that references it.
//
// The normal retirement path is `enabled=false` (see seed.ts RETIRED_SLUGS)
// so history survives. This script is for the rare case where a system is
// removed from the study lineup before any data worth keeping exists —
// e.g. kimi-k3 → deepseek-v4-flash, 2026-09 — and the row itself must go
// (the admin DELETE route is FK-guarded and refuses while reviews exist).
//
// Deletes, in one transaction: dimension_votes + votes on the system's
// reviews, the reviews themselves (cascading metric_scores, judge_verdicts
// and study_comparisons), the system's elo_snapshots, then the
// review_systems row. Snapshots and study_comparisons that merely point at
// a deleted vote are un-linked, not deleted.
//
// Run: pnpm --filter @reviewarena/api db:retire-system <slug> --yes

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/retire-system.ts → repo-root .env is 4 dirs up.
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { Pool } from "pg";

async function count(pool: Pool, sqlText: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(sqlText, params);
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  const [slug, flag] = process.argv.slice(2);
  if (!slug) {
    console.error("usage: tsx scripts/retire-system.ts <slug> --yes");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: sysRows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM review_systems WHERE slug = $1`,
    [slug],
  );
  const system = sysRows[0];
  if (!system) {
    console.log(`No review_systems row with slug ${slug} — nothing to do.`);
    await pool.end();
    return;
  }

  const before = {
    reviews: await count(pool, `SELECT COUNT(*)::text AS count FROM reviews WHERE review_system_id = $1`, [system.id]),
    votes: await count(
      pool,
      `SELECT COUNT(*)::text AS count FROM votes v
       WHERE v.review_a_id IN (SELECT id FROM reviews WHERE review_system_id = $1)
          OR v.review_b_id IN (SELECT id FROM reviews WHERE review_system_id = $1)`,
      [system.id],
    ),
    eloSnapshots: await count(pool, `SELECT COUNT(*)::text AS count FROM elo_snapshots WHERE review_system_id = $1`, [system.id]),
  };
  console.log(`Retiring ${slug} (${system.name}, ${system.id}):`);
  console.log(`  reviews        ${before.reviews}`);
  console.log(`  votes          ${before.votes}  (with their dimension_votes)`);
  console.log(`  elo_snapshots  ${before.eloSnapshots}`);
  console.log(`  + cascaded metric_scores / judge_verdicts / study_comparisons rows`);

  if (flag !== "--yes") {
    console.log("\nDry run. Re-run with --yes to delete. This is irreversible.");
    await pool.end();
    return;
  }

  await pool.query("BEGIN");
  try {
    const { rows: reviewRows } = await pool.query<{ id: string }>(
      `SELECT id FROM reviews WHERE review_system_id = $1`,
      [system.id],
    );
    const reviewIds = reviewRows.map((r) => r.id);
    const { rows: voteRows } = await pool.query<{ id: string }>(
      `SELECT id FROM votes WHERE review_a_id = ANY($1) OR review_b_id = ANY($1)`,
      [reviewIds],
    );
    const voteIds = voteRows.map((v) => v.id);

    // FKs without ON DELETE CASCADE: un-link, then delete.
    await pool.query(`UPDATE elo_snapshots SET trigger_vote_id = NULL WHERE trigger_vote_id = ANY($1)`, [voteIds]);
    await pool.query(`UPDATE study_comparisons SET vote_id = NULL WHERE vote_id = ANY($1)`, [voteIds]);
    await pool.query(`DELETE FROM dimension_votes WHERE vote_id = ANY($1)`, [voteIds]);
    await pool.query(`DELETE FROM votes WHERE id = ANY($1)`, [voteIds]);
    // Cascades metric_scores, judge_verdicts, study_comparisons.
    await pool.query(`DELETE FROM reviews WHERE id = ANY($1)`, [reviewIds]);
    await pool.query(`DELETE FROM elo_snapshots WHERE review_system_id = $1`, [system.id]);
    await pool.query(`DELETE FROM review_systems WHERE id = $1`, [system.id]);
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }

  const remaining = await count(pool, `SELECT COUNT(*)::text AS count FROM review_systems WHERE slug = $1`, [slug]);
  console.log(`\nDone. review_systems rows with slug ${slug}: ${remaining}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
