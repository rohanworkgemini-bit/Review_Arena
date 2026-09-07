// One-off backfill: run the judge panel for every study paper with a
// completed rotation pair that is not fully judged (PENDING, PARTIAL or
// FAILED). Safe to re-run; panel members that already have a verdict for a
// pair are skipped, so a PARTIAL pair only re-runs its missing judges.
// Arena papers are never judged and are not touched.
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
import { STUDY_SLUGS } from "../src/study/rotation.js";

async function main() {
  const config = loadConfig();
  const judge = new JudgeClient(config.REVIEW_GEN_URL, config.REVIEW_GEN_API_KEY);

  const missing = await db.execute(sql`
    select distinct c.paper_id as id
    from study_comparisons c
    join reviews ra on ra.id = c.review_a_id
    join reviews rb on rb.id = c.review_b_id
    where ra.status = 'COMPLETED' and rb.status = 'COMPLETED'
      and (ra.judge_status in ('PENDING', 'PARTIAL', 'FAILED')
           or rb.judge_status in ('PENDING', 'PARTIAL', 'FAILED'))
  `);
  const paperIds = (missing.rows as Array<{ id: string }>).map((r) => r.id);
  console.log(`${paperIds.length} study paper(s) have a pair not fully judged`);

  for (const paperId of paperIds) {
    process.stdout.write(`judging panel for paper ${paperId} ... `);
    const t0 = Date.now();
    try {
      await scorePaper(paperId, judge);
      console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  }

  // Pairs whose verdict set is still short of the full panel.
  const left = await db.execute(sql`
    select count(*)::int as n
    from study_comparisons c
    join reviews ra on ra.id = c.review_a_id
    join reviews rb on rb.id = c.review_b_id
    where ra.status = 'COMPLETED' and rb.status = 'COMPLETED'
      and (select count(distinct v.judge_model) from judge_verdicts v
           where (v.review_a_id = c.review_a_id and v.review_b_id = c.review_b_id)
              or (v.review_a_id = c.review_b_id and v.review_b_id = c.review_a_id))
          < ${STUDY_SLUGS.length}
  `);
  console.log(`completed pairs still short of ${STUDY_SLUGS.length} judges: ${(left.rows[0] as { n: number }).n}`);
  await closeDbPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
