// One-shot: TRUNCATE the data tables, keep schema + review_systems intact.
//
// Use when you want a "clean slate" for a study run — wipes papers,
// reviews, votes, dimension_votes, ratings, metric_scores.
// Leaves review_systems (reviewer registry) so the app is immediately
// functional — no db:seed needed afterwards.
//
// SAFER than db:nuke because the schema, enums, indexes, and the 10
// reviewer-system rows survive. RESTART IDENTITY resets any sequence
// counters; CASCADE walks FKs so we don't have to order the truncates.
//
// Participants are NOT wiped by default: the codes are handed out on paper
// and in person, so dropping them silently would invalidate a sheet someone
// is already holding. Pass --participants to clear the pool as well, which
// is what you want when re-minting a study from scratch:
//
//   pnpm --filter @reviewarena/api db:wipe-data -- --participants
//
// Run: pnpm --filter @reviewarena/api db:wipe-data

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/wipe-data.ts → repo-root .env is 4 dirs up.
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { Pool } from "pg";

const DATA_TABLES = [
  "judge_verdicts",
  "study_comparisons",
  "metric_scores",
  "ratings",
  "dimension_votes",
  "votes",
  "reviews",
  "papers",
] as const;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const wipeParticipants = process.argv.includes("--participants");
  // papers.participant_id and votes.participant_id reference it, and both
  // are in the truncate set above, so participants can join the same
  // statement without an ordering problem.
  const tables = wipeParticipants ? [...DATA_TABLES, "participants"] : [...DATA_TABLES];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Snapshot counts BEFORE so the report is meaningful.
  const before: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${t}"`,
    );
    before[t] = Number(rows[0]?.count ?? 0);
  }
  const { rows: rsRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_systems`,
  );
  const reviewSystemsBefore = Number(rsRows[0]?.count ?? 0);

  // Atomic truncate so an FK or trigger error never leaves us half-wiped.
  console.log(`Wiping ${tables.length} data tables (keeping ${reviewSystemsBefore} review_systems rows)…`);
  await pool.query("BEGIN");
  try {
    await pool.query(
      `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    );
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }

  // Verify.
  const after: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${t}"`,
    );
    after[t] = Number(rows[0]?.count ?? 0);
  }
  const { rows: rsAfter } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_systems`,
  );

  console.log("\nResults:");
  for (const t of tables) {
    console.log(`  ${t.padEnd(20)}  ${String(before[t]).padStart(6)}  →  ${after[t]}`);
  }
  console.log(`  ${"review_systems".padEnd(20)}  ${String(reviewSystemsBefore).padStart(6)}  →  ${Number(rsAfter[0]?.count ?? 0)}  (preserved)`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
