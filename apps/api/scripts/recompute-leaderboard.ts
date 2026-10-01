// Recompute all nine leaderboard snapshots from the full vote log, once.
//
// The board is normally refreshed after every vote. When the rating method
// itself changes (e.g. the switch to FastChat's full-data BT fit), the stored
// snapshots stay on the old method until the next vote — and with the study
// closed there may be none. This appends a fresh snapshot for every board,
// attributed to the most recent vote. Earlier snapshots are kept.
//
// Run: pnpm --filter @reviewarena/api leaderboard:recompute

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { desc } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import { votes } from "../src/db/schema.js";
import { recomputeAllLeaderboards } from "../src/routes/votes.js";

// Same default as config.ts; read directly so the script needs only DATABASE_URL.
const baselineSlug = process.env.RATING_BASELINE_SLUG ?? "claude-sonnet-5";
const [latest] = await db.select({ id: votes.id }).from(votes).orderBy(desc(votes.createdAt)).limit(1);
if (!latest) {
  console.log("No votes yet; nothing to recompute.");
} else {
  await recomputeAllLeaderboards(latest.id, baselineSlug);
  console.log(`Recomputed all leaderboards (baseline ${baselineSlug}, trigger vote ${latest.id}).`);
}
await closeDbPool();
