// Study progress and integrity. Run it after every session, and before
// you start analysing anything.
//
// The design only works if it stays balanced: twenty participants, two
// papers each, three comparisons per paper, and every one of the fifteen
// system pairs judged exactly eight times. A participant who leaves after
// four comparisons puts a hole in that, and nobody else can fill it — the
// pairs they were assigned are theirs. The sooner you know, the more
// likely you can still ask them back.
//
// Run: pnpm --filter @reviewarena/api study:status

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { sql } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import {
  NUM_PARTICIPANTS,
  PAIRS_PER_PAPER,
  PAPERS_PER_PARTICIPANT,
  STUDY_SLUGS,
} from "../src/study/rotation.js";

const COMPARISONS_PER_PARTICIPANT = PAPERS_PER_PARTICIPANT * PAIRS_PER_PAPER;
const TOTAL_TARGET = NUM_PARTICIPANTS * COMPARISONS_PER_PARTICIPANT;
const PANEL_SIZE = STUDY_SLUGS.length;
// 15 unordered pairs over 6 systems, each seen 8 times across the study.
const PAIR_TARGET = TOTAL_TARGET / ((PANEL_SIZE * (PANEL_SIZE - 1)) / 2);

interface ParticipantRow {
  id: string;
  papers: number;
  comparisons: number;
  voted: number;
}

async function main(): Promise<void> {
  // ─── Per-participant completion ──────────────────────────────────────────
  const perParticipant = await db.execute(sql`
    select
      p.id,
      count(distinct pa.id)::int                                as papers,
      count(distinct sc.id)::int                                as comparisons,
      count(distinct sc.id) filter (where sc.vote_id is not null)::int as voted
    from participants p
    left join papers pa            on pa.participant_id = p.id
    left join study_comparisons sc on sc.paper_id = pa.id
    group by p.id
    order by p.id`);

  const rows = perParticipant.rows as unknown as ParticipantRow[];
  const started = rows.filter((r) => r.papers > 0);
  const complete = rows.filter((r) => r.voted >= COMPARISONS_PER_PARTICIPANT);
  const partial = started.filter((r) => r.voted < COMPARISONS_PER_PARTICIPANT);

  console.log("\n═══ Participants ═══\n");
  console.log(
    `${"id".padEnd(6)}${"papers".padStart(8)}${"pairs".padStart(8)}` +
      `${"voted".padStart(8)}   status`,
  );
  for (const r of rows) {
    if (r.papers === 0) continue; // not started; summarised below.
    const done = r.voted >= COMPARISONS_PER_PARTICIPANT;
    const status = done
      ? "complete"
      : `INCOMPLETE — ${COMPARISONS_PER_PARTICIPANT - r.voted} comparison(s) missing`;
    console.log(
      `${r.id.padEnd(6)}${String(r.papers).padStart(8)}` +
        `${String(r.comparisons).padStart(8)}${String(r.voted).padStart(8)}   ${status}`,
    );
  }
  console.log(
    `\n${complete.length} complete · ${partial.length} partial · ` +
      `${NUM_PARTICIPANTS - started.length} not started`,
  );

  // ─── Overall progress ────────────────────────────────────────────────────
  const totals = await db.execute(sql`
    select
      count(*)::int                                        as pairs,
      count(*) filter (where vote_id is not null)::int     as voted
    from study_comparisons`);
  const t = totals.rows[0] as unknown as { pairs: number; voted: number };
  const pct = ((100 * t.voted) / TOTAL_TARGET).toFixed(0);
  console.log(
    `\n═══ Progress ═══\n\n${t.voted} of ${TOTAL_TARGET} comparisons voted (${pct}%)` +
      `, ${t.pairs} generated\n`,
  );

  // ─── Pair balance ────────────────────────────────────────────────────────
  // Every unordered system pair should end on PAIR_TARGET. Reported
  // unordered because A-vs-B and B-vs-A are the same comparison; which side
  // a system was shown on is a presentation detail the rotation randomises.
  const pairs = await db.execute(sql`
    select
      least(sa.slug, sb.slug)    as lo,
      greatest(sa.slug, sb.slug) as hi,
      count(*) filter (where sc.vote_id is not null)::int as voted
    from study_comparisons sc
    join reviews ra        on ra.id = sc.review_a_id
    join reviews rb        on rb.id = sc.review_b_id
    join review_systems sa on sa.id = ra.review_system_id
    join review_systems sb on sb.id = rb.review_system_id
    group by 1, 2
    order by 3 desc, 1, 2`);

  console.log(`═══ Pair balance (target ${PAIR_TARGET} each) ═══\n`);
  if (pairs.rows.length === 0) {
    console.log("  no comparisons yet\n");
  } else {
    for (const r of pairs.rows as unknown as { lo: string; hi: string; voted: number }[]) {
      const bar = "█".repeat(Math.min(r.voted, PAIR_TARGET)).padEnd(PAIR_TARGET, "·");
      console.log(`  ${r.lo.padEnd(19)} ${r.hi.padEnd(19)} ${bar} ${r.voted}`);
    }
    const seen = pairs.rows.length;
    const expectedPairs = (PANEL_SIZE * (PANEL_SIZE - 1)) / 2;
    console.log(`\n  ${seen} of ${expectedPairs} distinct pairs seen`);
    const over = (pairs.rows as unknown as { voted: number }[]).filter(
      (r) => r.voted > PAIR_TARGET,
    ).length;
    if (over)
      console.log(
        `  ${over} pair(s) above target — expected only if a session was re-run.`,
      );
  }

  // ─── Judge coverage ──────────────────────────────────────────────────────
  // Every voted comparison should carry PANEL_SIZE verdicts. Anything short
  // is what rescore-missing exists to repair.
  const judge = await db.execute(sql`
    select
      count(*)::int                                    as voted_pairs,
      count(*) filter (where v.n = ${PANEL_SIZE})::int as full_panel,
      count(*) filter (where v.n = 0)::int             as unjudged,
      coalesce(sum(${PANEL_SIZE} - v.n), 0)::int       as missing_verdicts
    from (
      select sc.id,
        (select count(distinct jv.judge_model)::int
           from judge_verdicts jv
          where (jv.review_a_id = sc.review_a_id and jv.review_b_id = sc.review_b_id)
             or (jv.review_a_id = sc.review_b_id and jv.review_b_id = sc.review_a_id)
        ) as n
      from study_comparisons sc
      where sc.vote_id is not null
    ) v`);
  const j = judge.rows[0] as unknown as {
    voted_pairs: number;
    full_panel: number;
    unjudged: number;
    missing_verdicts: number;
  };

  console.log(`\n═══ Judge coverage ═══\n`);
  console.log(`  voted comparisons     ${j.voted_pairs}`);
  console.log(`  full ${PANEL_SIZE}-judge panel   ${j.full_panel}`);
  console.log(`  no verdicts at all    ${j.unjudged}`);
  console.log(`  missing verdicts      ${j.missing_verdicts}`);
  if (j.missing_verdicts > 0)
    console.log(
      `\n  → Run scripts/rescore-missing.ts; it retries only the judges that are absent.`,
    );

  // ─── Data quality flags ──────────────────────────────────────────────────
  // Not automatic exclusions — things to look at. A fast vote can be a
  // genuine snap judgement; several from one person is a different signal.
  const quality = await db.execute(sql`
    select
      count(*) filter (where v.decision_ms is not null and v.decision_ms < 10000)::int as fast,
      count(*) filter (where v.note is null or btrim(v.note) = '')::int                as no_note,
      count(*)::int                                                                    as total
    from votes v
    join study_comparisons sc on sc.vote_id = v.id`);
  const q = quality.rows[0] as unknown as {
    fast: number;
    no_note: number;
    total: number;
  };
  if (q.total > 0) {
    console.log(`\n═══ Data quality ═══\n`);
    console.log(`  votes under 10s       ${q.fast} of ${q.total}`);
    console.log(`  without a note        ${q.no_note} of ${q.total}`);
    console.log(
      `\n  Flags for inspection, not exclusions — decide the rule before you look\n` +
        `  at who it removes, and state it in the thesis either way.`,
    );
  }

  console.log("");
  await closeDbPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
