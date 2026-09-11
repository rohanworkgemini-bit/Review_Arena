// Study progress and integrity. Run it after every session, and before
// you start analysing anything.
//
// The design only works if it stays balanced: two papers per participant,
// three comparisons per paper, and every one of the fifteen system pairs
// judged the same number of times. A participant who leaves after four
// comparisons puts a hole in that — their paper's rotation is half
// measured, and the round-robin draw will not re-issue it until every
// other rotation has caught up. The sooner you know, the more likely you
// can still ask them back.
//
// Targets scale with however many codes are minted, since the participant
// pool is open: at 20 that is the familiar 120 comparisons and 8 per pair.
//
// Run: pnpm --filter @reviewarena/api study:status

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { sql } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import {
  PAIRS_PER_PAPER,
  PAPERS_PER_PARTICIPANT,
  ROTATION_IDS,
  STUDY_SLUGS,
} from "../src/study/rotation.js";

const COMPARISONS_PER_PARTICIPANT = PAPERS_PER_PARTICIPANT * PAIRS_PER_PAPER;
const PANEL_SIZE = STUDY_SLUGS.length;
const DISTINCT_PAIRS = (PANEL_SIZE * (PANEL_SIZE - 1)) / 2;

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

  // Targets follow the minted pool rather than a hard-coded roster size.
  const TOTAL_TARGET = rows.length * COMPARISONS_PER_PARTICIPANT;
  const PAIR_TARGET = TOTAL_TARGET / DISTINCT_PAIRS;
  const PAIR_BAR = Math.max(1, Math.round(PAIR_TARGET));
  const pairTargetLabel = Number.isInteger(PAIR_TARGET)
    ? String(PAIR_TARGET)
    : PAIR_TARGET.toFixed(1);

  console.log("\n═══ Participants ═══\n");
  console.log(
    `${"id".padEnd(13)}${"papers".padStart(8)}${"pairs".padStart(8)}` +
      `${"voted".padStart(8)}   status`,
  );
  for (const r of rows) {
    if (r.papers === 0) continue; // not started; summarised below.
    const done = r.voted >= COMPARISONS_PER_PARTICIPANT;
    const status = done
      ? "complete"
      : `INCOMPLETE — ${COMPARISONS_PER_PARTICIPANT - r.voted} comparison(s) missing`;
    console.log(
      `${r.id.padEnd(13)}${String(r.papers).padStart(8)}` +
        `${String(r.comparisons).padStart(8)}${String(r.voted).padStart(8)}   ${status}`,
    );
  }
  console.log(
    `\n${complete.length} complete · ${partial.length} partial · ` +
      `${rows.length - started.length} not started`,
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

  console.log(`═══ Pair balance (target ${pairTargetLabel} each) ═══\n`);
  if (pairs.rows.length === 0) {
    console.log("  no comparisons yet\n");
  } else {
    for (const r of pairs.rows as unknown as { lo: string; hi: string; voted: number }[]) {
      const bar = "█".repeat(Math.min(r.voted, PAIR_BAR)).padEnd(PAIR_BAR, "·");
      console.log(`  ${r.lo.padEnd(19)} ${r.hi.padEnd(19)} ${bar} ${r.voted}`);
    }
    const seen = pairs.rows.length;
    console.log(`\n  ${seen} of ${DISTINCT_PAIRS} distinct pairs seen`);
    const over = (pairs.rows as unknown as { voted: number }[]).filter(
      (r) => r.voted > PAIR_TARGET,
    ).length;
    if (over)
      console.log(
        `  ${over} pair(s) above target — expected only if a session was re-run.`,
      );
  }

  // ─── Rotation balance ────────────────────────────────────────────────────
  // The round-robin draw keeps these within one of each other. A spread
  // wider than that means papers were created outside beginStudyPaper, or
  // parse failures are being counted somewhere they should not be.
  const rotations = await db.execute(sql`
    select rotation_id, count(*)::int as papers
    from papers
    where rotation_id is not null and status <> 'PARSE_FAILED'
    group by rotation_id`);
  const byRotation = new Map(
    (rotations.rows as unknown as { rotation_id: number; papers: number }[]).map((r) => [
      Number(r.rotation_id),
      Number(r.papers),
    ]),
  );
  const counts = ROTATION_IDS.map((id) => byRotation.get(id) ?? 0);
  console.log(`\n═══ Rotation balance ═══\n`);
  console.log(
    `  ${ROTATION_IDS.map((id, i) => `R${id}:${counts[i]}`).join("  ")}` +
      `   (${counts.reduce((a, b) => a + b, 0)} papers)`,
  );
  const spread = Math.max(...counts) - Math.min(...counts);
  if (spread > 1)
    console.log(
      `\n  Spread of ${spread} — the draw allows at most 1. Check for papers\n` +
        `  inserted outside the study upload route.`,
    );

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
