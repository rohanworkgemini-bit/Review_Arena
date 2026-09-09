// Draw pairs from the real system table and print how often each matchup
// comes up — the cheap way to see what the arena sampler is doing without
// spending an LLM call per upload.
//
//   LOG_LEVEL=warn pnpm --filter @reviewarena/api pair:check
//   pnpm --filter @reviewarena/api exec tsx scripts/check-sampling.ts -n 5000
//
// The sampler is a uniform draw over eligible pairs, so with k eligible
// systems every one of the k(k-1)/2 matchups should come up equally often,
// within sampling error. A matchup that is missing entirely is being
// filtered out — outage, sampleWeight 0, or anon-vs-anon — which is what
// this script is for: those filters are easy to set and invisible until
// you count.
//
// Read-only. It calls the same selectUploadPair() the upload route calls,
// so what you see here is what a real upload would have picked; it just
// never writes a paper or generates a review.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { closeDbPool } from "../src/db/client.js";
import { selectUploadPair } from "../src/pair/select-upload-pair.js";

const args = process.argv.slice(2);
const nFlag = args.indexOf("-n");
const N = nFlag >= 0 ? Number(args[nFlag + 1]) : 2000;

if (!Number.isFinite(N) || N < 1) {
  console.error("-n must be a positive number");
  process.exit(1);
}

// Unordered key: the sampler coin-flips sides, so A-vs-B and B-vs-A are the
// same matchup and counting them apart would just measure the coin.
const key = (a: string, b: string) => [a, b].sort().join("  vs  ");

const counts = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const pair = await selectUploadPair();
  if (!pair) throw new Error("selectUploadPair returned null — fewer than 2 enabled systems?");
  const k = key(pair.slugA, pair.slugB);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

const matchups = [...counts.keys()].sort();
const width = Math.max(...matchups.map((m) => m.length));
console.log(`${N} draws\n`);
console.log(`${"matchup".padEnd(width)}    share`);
console.log("-".repeat(width + 11));
for (const m of matchups) {
  const share = ((counts.get(m)! / N) * 100).toFixed(1);
  console.log(`${m.padEnd(width)}  ${`${share}%`.padStart(7)}`);
}
console.log(
  `\n${matchups.length} distinct matchups drawn` +
    (matchups.length ? `, so uniform is ${(100 / matchups.length).toFixed(1)}% each` : "") +
    `. A pair that never appears is filtered out, not unlucky: ` +
    `outage, sampleWeight 0, or anon-vs-anon.`,
);

await closeDbPool();
