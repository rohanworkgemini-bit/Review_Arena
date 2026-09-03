// One-off backfill: re-judge every COMPLETED review that has no metric
// scores. Written 2026-09-04 after the judge-client headersTimeout bug
// (30s deadline on a blocking endpoint) silently failed most judge runs.
//
// Run: pnpm --filter @reviewarena/api tsx scripts/rescore-missing.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { eq, sql } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import { reviews } from "../src/db/schema.js";
import { config } from "../src/config.js";
import { JudgeClient } from "../src/clients/judge-client.js";
import { scorePaper } from "../src/pipeline/score-paper.js";

async function main() {
  const judge = new JudgeClient(config.REVIEW_GEN_URL, config.REVIEW_GEN_API_KEY);

  // COMPLETED reviews with zero metric rows — regardless of what
  // judge_status claims (FAILED stamps and clobbered rows both qualify).
  const missing = await db.execute(sql`
    select distinct r.paper_id
    from reviews r
    where r.status = 'COMPLETED'
      and not exists (select 1 from metric_scores m where m.review_id = r.id)
  `);
  const paperIds = (missing.rows as Array<{ paper_id: string }>).map((r) => r.paper_id);
  console.log(`${paperIds.length} paper(s) have unscored completed reviews`);

  // Reset their score-less reviews to PENDING so the idempotence guard
  // doesn't skip rows my earlier judge_status flip mislabeled COMPLETE.
  await db.execute(sql`
    update reviews r set judge_status = 'PENDING'
    where r.status = 'COMPLETED'
      and not exists (select 1 from metric_scores m where m.review_id = r.id)
  `);

  for (const paperId of paperIds) {
    process.stdout.write(`scoring paper ${paperId} ... `);
    const t0 = Date.now();
    try {
      await scorePaper(paperId, judge);
      console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  }

  const left = await db.execute(sql`
    select count(*)::int as n from reviews r
    where r.status = 'COMPLETED'
      and not exists (select 1 from metric_scores m where m.review_id = r.id)
  `);
  console.log(`remaining unscored: ${(left.rows[0] as { n: number }).n}`);
  await closeDbPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
