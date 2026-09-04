// Seed the controlled study's 20 participants (P01..P20) with secret
// entry codes, and print the handout table. Idempotent: existing
// participants keep their codes; only missing ones are created.
//
// Run: pnpm --filter @reviewarena/api tsx scripts/seed-participants.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { randomInt } from "node:crypto";
import { db, closeDbPool } from "../src/db/client.js";
import { participants } from "../src/db/schema.js";
import {
  NUM_PARTICIPANTS,
  rotationsForParticipant,
} from "../src/study/rotation.js";

// Memorable but unguessable enough for a supervised study: word + 4 digits
// (≈ 200k combinations per word list entry; codes are capability tokens
// handed out in person, not internet-facing secrets).
const WORDS = [
  "maple", "cedar", "birch", "aspen", "alder", "hazel", "rowan", "olive",
  "pine", "oak", "elm", "fir", "ash", "yew", "beech", "larch",
  "linden", "spruce", "walnut", "willow",
];

async function main() {
  const existing = await db.query.participants.findMany();
  const byId = new Map(existing.map((p) => [p.id, p]));
  const usedCodes = new Set(existing.map((p) => p.code));

  for (let i = 1; i <= NUM_PARTICIPANTS; i++) {
    const id = `P${String(i).padStart(2, "0")}`;
    if (byId.has(id)) continue;
    let code: string;
    do {
      code = `${WORDS[i - 1]}-${randomInt(1000, 10000)}`;
    } while (usedCodes.has(code));
    usedCodes.add(code);
    await db.insert(participants).values({ id, code });
    byId.set(id, { id, code, createdAt: new Date() });
  }

  console.log("participant | code         | paper1 | paper2");
  console.log("------------|--------------|--------|-------");
  for (let i = 1; i <= NUM_PARTICIPANTS; i++) {
    const id = `P${String(i).padStart(2, "0")}`;
    const [r1, r2] = rotationsForParticipant(i);
    console.log(
      `${id}         | ${byId.get(id)!.code.padEnd(12)} | R${r1}     | R${r2}`,
    );
  }
  await closeDbPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
