// Mint study participants: an opaque id and a secret entry code each, and
// print the handout table. Participants are an open pool — there is no
// fixed roster and no numbered slot, because the rotation is drawn per
// paper at upload time (src/study/rotation.ts), not from an identity.
//
// Minting is additive, not idempotent: every --count creates that many NEW
// participants. To guard against a re-run silently doubling the pool, the
// flag is required once any exist.
//
//   pnpm --filter @reviewarena/api tsx scripts/seed-participants.ts            # first 20
//   pnpm --filter @reviewarena/api tsx scripts/seed-participants.ts --count 5  # 5 more
//   pnpm --filter @reviewarena/api tsx scripts/seed-participants.ts --list     # print, mint nothing

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { randomInt } from "node:crypto";
import { db, closeDbPool } from "../src/db/client.js";
import { participants } from "../src/db/schema.js";

const DEFAULT_COUNT = 20;

// Memorable but unguessable enough for a supervised study: word + 4 digits
// (≈ 200k combinations per word list entry; codes are capability tokens
// handed out in person, not internet-facing secrets).
const WORDS = [
  "maple", "cedar", "birch", "aspen", "alder", "hazel", "rowan", "olive",
  "pine", "oak", "elm", "fir", "ash", "yew", "beech", "larch",
  "linden", "spruce", "walnut", "willow",
];

// Ids are P01, P02, ... — a LABEL ONLY, continuing from the highest that
// already exists. Until 2026-09 the number doubled as a schedule (P01 meant
// rotations R1 then R2), which is what capped the study at twenty slots;
// nextRotationId() draws per paper at upload now, so it encodes nothing.
// Sequential purely because it is read aloud, ticked off a handout sheet and
// pasted into status queries. Kept in sync with deploy/mint-participants.sql.
function nextIdNumber(existingIds: Iterable<string>): number {
  let max = 0;
  for (const id of existingIds) {
    const m = /^P(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function idFor(n: number): string {
  return `P${String(n).padStart(2, "0")}`;
}

function newCode(): string {
  return `${WORDS[randomInt(WORDS.length)]}-${randomInt(1000, 10000)}`;
}

function parseArgs(argv: string[]): { count: number | null; list: boolean } {
  const list = argv.includes("--list");
  const i = argv.indexOf("--count");
  if (i === -1) return { count: null, list };
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error(`--count needs a whole number between 1 and 500, got: ${argv[i + 1]}`);
  }
  return { count: n, list };
}

async function main() {
  const { count, list } = parseArgs(process.argv.slice(2));

  const existing = await db.query.participants.findMany();
  const usedIds = new Set(existing.map((p) => p.id));
  const usedCodes = new Set(existing.map((p) => p.code));

  let minted = 0;
  if (!list) {
    if (count === null && existing.length > 0) {
      console.error(
        `${existing.length} participant(s) already exist. Minting is additive, so\n` +
          `say how many MORE you want: --count N (or --list to just print them).`,
      );
      await closeDbPool();
      process.exit(1);
    }
    minted = count ?? DEFAULT_COUNT;
    let n = nextIdNumber(usedIds);
    for (let i = 0; i < minted; i++) {
      // Skip any number already taken — a table holding other id shapes,
      // or a gap left by a deleted row, must not produce a collision.
      let id: string;
      do { id = idFor(n++); } while (usedIds.has(id));
      let code: string;
      do { code = newCode(); } while (usedCodes.has(code));
      usedIds.add(id);
      usedCodes.add(code);
      await db.insert(participants).values({ id, code });
      existing.push({ id, code, createdAt: new Date() });
    }
  }

  console.log("participant  | code");
  console.log("-------------|-------------");
  for (const p of existing) {
    console.log(`${p.id.padEnd(12)} | ${p.code}`);
  }
  console.log(
    `\n${existing.length} participant(s)` +
      (minted ? `, ${minted} newly minted` : "") +
      `. Rotations are assigned per paper at upload, not here.`,
  );
  await closeDbPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
