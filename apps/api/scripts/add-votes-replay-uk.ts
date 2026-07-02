// DEPRECATED: This script created an old index structure.
// The schema now uses a pairSig-based index (drizzle/0003_vote_replay_protection.sql).
// DO NOT RUN THIS. It would create the wrong index.
//
// If you've already run this and need to clean up:
//   DROP INDEX IF EXISTS "votes_session_pair_uk";  -- old 4-column index
// The correct index (votes_session_pair_sig_uk) is created by drizzle migrations.
//
// This file is kept for historical reference only.
// Run via: pnpm --filter @reviewarena/api exec tsx scripts/add-votes-replay-uk.ts
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

console.error("DEPRECATED: This script is no longer used.");
console.error("The replay-protection index is managed by drizzle migrations.");
console.error("See drizzle/0003_vote_replay_protection.sql");
console.error("");
console.error("If you have the old 4-column index from a prior run, drop it:");
console.error("  psql $DATABASE_URL -c 'DROP INDEX IF EXISTS votes_session_pair_uk;'");
console.error("");
console.error("The correct index (votes_session_pair_sig_uk on 3 columns) will be");
console.error("created automatically by the next migration or fresh db:push.");

process.exit(0);
