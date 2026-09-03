// One-off backfill: run the pairwise judge for every paper whose
// completed review pair has no judge_verdicts row yet. Safe to re-run;
// judged pairs are skipped.
//
// Run: pnpm --filter @reviewarena/api tsx scripts/rescore-missing.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { sql } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { JudgeClient } from "../src/clients/judge-client.js";
import { scorePaper } from "../src/pipeline/score-paper.js";

async function main() {
  const config = loadConfig();
  const judge = new JudgeClient(config.REVIEW_GEN_URL, config.REVIEW_GEN_API_KEY);

  const missing = await db.execute(sql`
    select p.id
    from papers p
    where (select count(*) from reviews r
           where r.paper_id = p.id and r.status = 'COMPLETED') >= 2
      and not exists (select 1 from judge_verdicts v where v.paper_id = p.id)
  `);
  const paperIds = (missing.rows as Array<{ id: string }>).map((r) => r.id);
  console.log(`${paperIds.length} paper(s) need a pairwise judge verdict`);

  for (const paperId of paperIds) {
    process.stdout.write(`judging pair for paper ${paperId} ... `);
    const t0 = Date.now();
    try {
      await scorePaper(paperId, judge);
      console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  }

  const left = await db.execute(sql`
    select count(*)::int as n from papers p
    where (select count(*) from reviews r
           where r.paper_id = p.id and r.status = 'COMPLETED') >= 2
      and not exists (select 1 from judge_verdicts v where v.paper_id = p.id)
  `);
  console.log(`papers still without a verdict: ${(left.rows[0] as { n: number }).n}`);
  await closeDbPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
