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
//
// --test mints DRY-RUN codes instead: T01, T02, … flagged is_test, for
// walking the flow ourselves. They run the identical path — real rotations,
// real reviews, real judging — and are filtered back out at read time
// (the Bradley-Terry fit and the admin exports), so a rehearsal never
// reaches the leaderboard or the analysis:
//
//   … seed-participants.ts --test --count 10   # T01..T10

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
// Real participants are P-numbered, dry runs T-numbered, and the two
// sequences are counted separately so minting ten test codes does not push
// the next real participant to P31 — the handout sheet reads P01..P20 and
// a gap in it is a support question during a session.
function nextIdNumber(existingIds: Iterable<string>, prefix: string): number {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function idFor(n: number, prefix: string): string {
  return `${prefix}${String(n).padStart(2, "0")}`;
}

function newCode(): string {
  return `${WORDS[randomInt(WORDS.length)]}-${randomInt(1000, 10000)}`;
}

function parseArgs(argv: string[]): { count: number | null; list: boolean; test: boolean } {
  const list = argv.includes("--list");
  const test = argv.includes("--test");
  const i = argv.indexOf("--count");
  if (i === -1) return { count: null, list, test };
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error(`--count needs a whole number between 1 and 500, got: ${argv[i + 1]}`);
  }
  return { count: n, list, test };
}

async function main() {
  const { count, list, test } = parseArgs(process.argv.slice(2));
  const prefix = test ? "T" : "P";

  const existing = await db.query.participants.findMany();
  const usedIds = new Set(existing.map((p) => p.id));
  const usedCodes = new Set(existing.map((p) => p.code));

  let minted = 0;
  if (!list) {
    // "Already exist" is per sequence: the first --test run should mint its
    // ten without --count even though twenty real participants are already
    // on the table.
    const sameKind = existing.filter((p) => p.isTest === test);
    if (count === null && sameKind.length > 0) {
      console.error(
        `${sameKind.length} ${test ? "test " : ""}participant(s) already exist. ` +
          `Minting is additive, so\n` +
          `say how many MORE you want: --count N (or --list to just print them).`,
      );
      await closeDbPool();
      process.exit(1);
    }
    minted = count ?? DEFAULT_COUNT;
    let n = nextIdNumber(usedIds, prefix);
    for (let i = 0; i < minted; i++) {
      // Skip any number already taken — a table holding other id shapes,
      // or a gap left by a deleted row, must not produce a collision.
      let id: string;
      do { id = idFor(n++, prefix); } while (usedIds.has(id));
      let code: string;
      do { code = newCode(); } while (usedCodes.has(code));
      usedIds.add(id);
      usedCodes.add(code);
      await db.insert(participants).values({ id, code, isTest: test });
      existing.push({ id, code, isTest: test, createdAt: new Date() });
    }
  }

  // Real first, then dry runs — the handout sheet is printed from the top
  // of this table and the T-codes are not on it.
  const ordered = [...existing].sort((a, b) =>
    a.isTest === b.isTest ? a.id.localeCompare(b.id) : a.isTest ? 1 : -1,
  );
  console.log("participant  | code         | kind");
  console.log("-------------|--------------|------");
  for (const p of ordered) {
    console.log(`${p.id.padEnd(12)} | ${p.code.padEnd(12)} | ${p.isTest ? "test" : "real"}`);
  }
  const real = existing.filter((p) => !p.isTest).length;
  const tests = existing.length - real;
  console.log(
    `\n${real} real + ${tests} test participant(s)` +
      (minted ? `, ${minted} newly minted as ${test ? "test" : "real"}` : "") +
      `. Rotations are assigned per paper at upload, not here.`,
  );
  if (tests > 0) {
    console.log(
      `Test codes run the full pipeline; their votes and papers are excluded\n` +
        `from the leaderboard fit and from the admin exports.`,
    );
  }
  await closeDbPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
