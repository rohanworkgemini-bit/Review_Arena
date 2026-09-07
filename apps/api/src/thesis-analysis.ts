/**
 * One-off thesis analysis: pulls the live vote + judge-panel data and
 * prints the RQ1/RQ2 result tables (markdown).
 *
 * The judge is a PANEL of the six study systems, each of which judges every
 * study pair — including pairs it wrote a side of. Every judge table is
 * therefore reported in three variants:
 *   all     — every panel member's verdict / score
 *   noSelf  — excluding rows where the judge generated one of the reviews
 *             (the primary variant: no self-enhancement bias)
 *   per judge — one column per panel member
 * The Judge × System matrix makes self-enhancement itself visible (diagonal
 * vs. off-diagonal).
 *
 * Run:  pnpm --filter @reviewarena/api exec tsx src/thesis-analysis.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

const { db } = await import("./db/client.js");
const { computeElo, bootstrapEloCI } = await import("./elo/elo.js");
const { computeBT, bootstrapBTCI } = await import("./elo/bt.js");
const { asc, eq } = await import("drizzle-orm");
const schema = await import("./db/schema.js");
const { votes, dimensionVotes, reviews, reviewSystems, metricScores, judgeVerdicts, papers } =
  schema;

type Battle = { a: string; b: string; outcome: 0 | 0.5 | 1 };
type Pref = "A" | "B" | "TIE";

// ── Load raw data ──────────────────────────────────────────────────────────

const systems = await db.select().from(reviewSystems);
const sysById = new Map(systems.map((s) => [s.id, s]));

const allReviews = await db
  .select({ id: reviews.id, systemId: reviews.reviewSystemId, paperId: reviews.paperId })
  .from(reviews);
const reviewSys = new Map(allReviews.map((r) => [r.id, sysById.get(r.systemId)?.slug ?? "?"]));

const allVotes = await db.select().from(votes).orderBy(asc(votes.createdAt));
const cleanVotes = allVotes.filter((v) => !v.qualityFlagged);

const allDimVotes = await db.select().from(dimensionVotes);
const dimsByVote = new Map<string, typeof allDimVotes>();
for (const dv of allDimVotes) {
  const arr = dimsByVote.get(dv.voteId) ?? [];
  arr.push(dv);
  dimsByVote.set(dv.voteId, arr);
}

// One metric row per (review, judge); one verdict row per (pair, judge).
const judgeRows = await db
  .select()
  .from(metricScores)
  .where(eq(metricScores.kind, "LLM_JUDGE_OVERALL"));
const verdictRows = await db.select().from(judgeVerdicts);

const paperRows = await db.select({ id: papers.id }).from(papers);

// Must match RATING_BASELINE_SLUG in config.ts, or the numbers here will not
// line up with the live board.
const BASELINE_SLUG = process.env.RATING_BASELINE_SLUG ?? "claude-sonnet-5";

// ── Judge variants ─────────────────────────────────────────────────────────

type ScoreRow = (typeof judgeRows)[number];
type VerdictRow = (typeof verdictRows)[number];

const isSelfScore = (m: ScoreRow) => m.judgeModel === reviewSys.get(m.reviewId);
const isSelfVerdict = (v: VerdictRow) =>
  v.judgeModel === reviewSys.get(v.reviewAId) || v.judgeModel === reviewSys.get(v.reviewBId);

const judgeSlugs = [...new Set(judgeRows.map((m) => m.judgeModel))].sort();
const systemSlugs = [...new Set([...reviewSys.values()])].filter((s) => s !== "?").sort();

type Variant = { name: string; score: (m: ScoreRow) => boolean; verdict: (v: VerdictRow) => boolean };
const VARIANTS: Variant[] = [
  { name: "all", score: () => true, verdict: () => true },
  { name: "noSelf", score: (m) => !isSelfScore(m), verdict: (v) => !isSelfVerdict(v) },
  ...judgeSlugs.map((j) => ({
    name: `judge:${j}`,
    score: (m: ScoreRow) => m.judgeModel === j,
    verdict: (v: VerdictRow) => v.judgeModel === j,
  })),
];
const PRIMARY = VARIANTS[1]!; // noSelf

// ── RQ1: ratings (overall + per dimension), Bradley-Terry and Elo ─────────

const overallBattles: Battle[] = cleanVotes.map((v) => ({
  a: reviewSys.get(v.reviewAId)!,
  b: reviewSys.get(v.reviewBId)!,
  outcome: v.winner === "A" ? 1 : v.winner === "B" ? 0 : 0.5,
}));

const DIMS = schema.voteDimensionEnum.enumValues as readonly string[];
const dimBattles = new Map<string, Battle[]>(DIMS.map((d) => [d, []]));
for (const v of cleanVotes) {
  for (const dv of dimsByVote.get(v.id) ?? []) {
    dimBattles.get(dv.dimension)!.push({
      a: reviewSys.get(v.reviewAId)!,
      b: reviewSys.get(v.reviewBId)!,
      // dimension value: -1 = A better, +1 = B better, 0 = tie
      outcome: dv.value === -1 ? 1 : dv.value === 1 ? 0 : 0.5,
    });
  }
}

function eloTable(battles: Battle[]) {
  const ci = bootstrapEloCI(battles, 100);
  const point = computeElo(battles);
  return [...ci.entries()]
    .map(([slug, b]) => ({ ...b, slug, rating: point.get(slug) ?? 1000 }))
    .sort((x, y) => y.rating - x.rating);
}

/**
 * Bradley-Terry counterpart of eloTable. `rating` is the MLE point estimate;
 * the interval is the bootstrap percentile. Systems the connectivity guard
 * could not place are returned separately rather than given a number.
 */
function btTable(battles: Battle[]) {
  const ci = bootstrapBTCI(battles, 100, { baselineSlug: BASELINE_SLUG });
  const { ratings, unranked, anchor } = computeBT(battles, { baselineSlug: BASELINE_SLUG });
  const rows = [...ci.entries()]
    .filter(([slug]) => ratings.has(slug))
    .map(([slug, b]) => ({ ...b, slug, rating: ratings.get(slug)! }))
    .sort((x, y) => y.rating - x.rating);
  return { rows, unranked, anchor };
}

/** Rank displacement between two orderings of the same systems. */
function maxRankShift(a: string[], b: string[]): number {
  const rankB = new Map(b.map((slug, i) => [slug, i]));
  let worst = 0;
  a.forEach((slug, i) => {
    const j = rankB.get(slug);
    if (j !== undefined) worst = Math.max(worst, Math.abs(i - j));
  });
  return worst;
}

// ── Judge means per system (overall + per dimension), per variant ─────────

type JudgeAgg = { n: number; sum: number; dims: Map<string, { n: number; sum: number }> };

function aggregateScores(filter: (m: ScoreRow) => boolean): Map<string, JudgeAgg> {
  const agg = new Map<string, JudgeAgg>();
  for (const m of judgeRows) {
    if (!filter(m)) continue;
    const slug = reviewSys.get(m.reviewId);
    if (!slug) continue;
    const a = agg.get(slug) ?? { n: 0, sum: 0, dims: new Map() };
    a.n++;
    a.sum += m.value;
    const dimsObj = (m.meta as { dimension_scores?: Record<string, number> } | null)
      ?.dimension_scores;
    for (const [k, val] of Object.entries(dimsObj ?? {})) {
      if (typeof val !== "number") continue;
      const d = a.dims.get(k) ?? { n: 0, sum: 0 };
      d.n++;
      d.sum += val;
      a.dims.set(k, d);
    }
    agg.set(slug, a);
  }
  return agg;
}

const aggByVariant = new Map(VARIANTS.map((v) => [v.name, aggregateScores(v.score)]));
const meanOf = (agg: Map<string, JudgeAgg>, slug: string) => {
  const a = agg.get(slug);
  return a && a.n > 0 ? a.sum / a.n : undefined;
};
const dimMeanOf = (agg: Map<string, JudgeAgg>, slug: string, dim: string) => {
  const d = agg.get(slug)?.dims.get(dim);
  return d && d.n > 0 ? d.sum / d.n : undefined;
};

// ── Verdicts per pair, per variant ─────────────────────────────────────────

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const verdictsByPair = new Map<string, VerdictRow[]>();
for (const v of verdictRows) {
  const k = pairKey(v.reviewAId, v.reviewBId);
  const arr = verdictsByPair.get(k) ?? [];
  arr.push(v);
  verdictsByPair.set(k, arr);
}

/** A verdict row's overall preference expressed relative to (sideA, sideB). */
function prefFor(v: VerdictRow, sideA: string): Pref {
  const p = v.overallPreference as Pref;
  if (p === "TIE" || v.reviewAId === sideA) return p;
  return p === "A" ? "B" : "A";
}

/** Panel majority for a pair relative to (sideA, sideB); null if no rows. */
function panelMajority(sideA: string, sideB: string, filter: (v: VerdictRow) => boolean) {
  const rows = (verdictsByPair.get(pairKey(sideA, sideB)) ?? []).filter(filter);
  if (rows.length === 0) return null;
  const counts = { A: 0, B: 0, TIE: 0 };
  for (const v of rows) counts[prefFor(v, sideA)]++;
  const overall: Pref = counts.A > counts.B ? "A" : counts.B > counts.A ? "B" : "TIE";
  return { overall, counts, n: rows.length };
}

// ── Correlation helpers ────────────────────────────────────────────────────

function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}

function spearman(x: number[], y: number[]): number {
  return pearson(ranks(x), ranks(y));
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

function kendall(x: number[], y: number[]): number {
  let concordant = 0, discordant = 0;
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++) {
      const s = Math.sign(x[i]! - x[j]!) * Math.sign(y[i]! - y[j]!);
      if (s > 0) concordant++;
      else if (s < 0) discordant++;
    }
  const pairs = (x.length * (x.length - 1)) / 2;
  return pairs ? (concordant - discordant) / pairs : NaN;
}

/** Correlate a per-system rating map with a per-system judge mean; n = overlap. */
function corrRow(rating: Map<string, number>, judgeMean: (slug: string) => number | undefined) {
  const pts: Array<[number, number]> = [];
  for (const [slug, r] of rating) {
    const j = judgeMean(slug);
    if (j !== undefined) pts.push([r, j]);
  }
  if (pts.length < 3) return { n: pts.length, rho: NaN, tau: NaN, r: NaN };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { n: pts.length, rho: spearman(xs, ys), tau: kendall(xs, ys), r: pearson(xs, ys) };
}

// ── Print ──────────────────────────────────────────────────────────────────

const f = (n: number) => n.toFixed(1);
const f3 = (n: number) => (Number.isNaN(n) ? "n/a" : n.toFixed(3));
const f2 = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(2));
const out: string[] = [];

const selfVerdicts = verdictRows.filter(isSelfVerdict).length;
out.push(`# ReviewArena — thesis data snapshot`);
out.push(``);
out.push(
  `Papers: ${paperRows.length} · Votes: ${allVotes.length} (${cleanVotes.length} clean, ${allVotes.length - cleanVotes.length} quality-flagged) · Dimension votes: ${allDimVotes.length}`,
);
out.push(
  `Judge panel: ${judgeSlugs.length} judges (${judgeSlugs.join(", ")}) · judged pairs: ${verdictsByPair.size} · verdict rows: ${verdictRows.length} (${selfVerdicts} self-judging) · score rows: ${judgeRows.length}`,
);
out.push(``);

const bt = btTable(overallBattles);
const btOverall = bt.rows;
out.push(
  `## RQ1a — Overall human leaderboard (Bradley-Terry MLE, 100-round bootstrap 95% CI)`,
);
out.push(``);
out.push(
  bt.anchor === "BASELINE"
    ? `Anchored: \`${BASELINE_SLUG}\` pinned at 1000.`
    : `Mean-centred at 1000 (\`${BASELINE_SLUG}\` has no battles in this set).`,
);
out.push(``);
out.push(`| Rank | System | BT | 95% CI | Battles |`);
out.push(`|---|---|---|---|---|`);
btOverall.forEach((e, i) =>
  out.push(`| ${i + 1} | ${e.slug} | ${f(e.rating)} | [${f(e.ciLow)}, ${f(e.ciHigh)}] | ${e.voteCount} |`),
);
if (bt.unranked.length > 0) {
  out.push(``);
  out.push(
    `Unranked (not connected to the field by wins and losses): ${bt.unranked.join(", ")}`,
  );
}
out.push(``);

out.push(`## RQ1a-ii — Same battles under online Elo (K=4, 100-round bootstrap 95% CI)`);
out.push(``);
out.push(`| Rank | System | Elo | 95% CI | Battles |`);
out.push(`|---|---|---|---|---|`);
const overall = eloTable(overallBattles);
overall.forEach((e, i) =>
  out.push(`| ${i + 1} | ${e.slug} | ${f(e.rating)} | [${f(e.ciLow)}, ${f(e.ciHigh)}] | ${e.voteCount} |`),
);
out.push(``);

// How much the choice of rating system actually changes the answer. Elo is
// order-dependent and BT is not, so this is the headline robustness check.
const btRating = new Map(btOverall.map((e) => [e.slug, e.rating]));
const eloRating = new Map(overall.map((e) => [e.slug, e.rating]));
{
  const btRanked = btOverall.map((e) => e.slug);
  const eloRanked = overall.map((e) => e.slug).filter((slug) => btRating.has(slug));
  const shared = btRanked.filter((slug) => eloRating.has(slug));
  out.push(`## RQ1a-iii — Bradley-Terry vs Elo agreement (n=${shared.length} systems)`);
  out.push(``);
  if (shared.length >= 3) {
    const bx = shared.map((slug) => btRating.get(slug)!);
    const ex = shared.map((slug) => eloRating.get(slug)!);
    out.push(`| Statistic | Value |`);
    out.push(`|---|---|`);
    out.push(`| Spearman ρ (BT vs Elo ranking) | ${f3(spearman(bx, ex))} |`);
    out.push(`| Kendall τ | ${f3(kendall(bx, ex))} |`);
    out.push(`| Pearson r (rating scales) | ${f3(pearson(bx, ex))} |`);
    out.push(`| Max rank displacement | ${maxRankShift(btRanked, eloRanked)} |`);
  } else {
    out.push(`Not enough systems on both boards (${shared.length}).`);
  }
  out.push(``);
}

out.push(`## RQ1b — Per-dimension Bradley-Terry (rank per dimension)`);
out.push(``);
out.push(`"—" = the dimension's votes do not place that system (no votes, or not connected to the field).`);
out.push(``);
const slugs = btOverall.map((e) => e.slug);
out.push(`| Dimension | ${slugs.join(" | ")} |`);
out.push(`|---|${slugs.map(() => "---").join("|")}|`);
const dimEloBySlug = new Map<string, Map<string, number>>();
const dimBTBySlug = new Map<string, Map<string, number>>();
for (const d of DIMS) {
  const dimBt = btTable(dimBattles.get(d)!);
  dimBTBySlug.set(d, new Map(dimBt.rows.map((e) => [e.slug, e.rating])));
  dimEloBySlug.set(d, new Map(eloTable(dimBattles.get(d)!).map((e) => [e.slug, e.rating])));
  const rankOf = new Map(dimBt.rows.map((e, i) => [e.slug, i + 1]));
  out.push(
    `| ${d} | ${slugs
      .map((s) => {
        const r = rankOf.get(s);
        const rating = dimBTBySlug.get(d)!.get(s);
        return r ? `#${r} (${f(rating!)})` : "—";
      })
      .join(" | ")} |`,
  );
}
out.push(``);

// ── Judge panel descriptives ───────────────────────────────────────────────

out.push(`## Judge × System — mean overall score (LLM_JUDGE_OVERALL, 0–10)`);
out.push(``);
out.push(`Rows = judge, columns = system judged. The diagonal is self-judging; compare it with the row's off-diagonal to read self-enhancement.`);
out.push(``);
out.push(`| Judge ↓ / System → | ${systemSlugs.join(" | ")} | off-diag mean | self − off-diag |`);
out.push(`|---|${systemSlugs.map(() => "---").join("|")}|---|---|`);
for (const j of judgeSlugs) {
  const agg = aggByVariant.get(`judge:${j}`)!;
  const cells = systemSlugs.map((s) => meanOf(agg, s));
  const off = systemSlugs
    .map((s, i) => (s === j ? undefined : cells[i]))
    .filter((x): x is number => x !== undefined);
  const offMean = off.length ? off.reduce((a, b) => a + b, 0) / off.length : undefined;
  const self = meanOf(agg, j);
  const delta = self !== undefined && offMean !== undefined ? self - offMean : undefined;
  out.push(
    `| ${j} | ${cells.map(f2).join(" | ")} | ${f2(offMean)} | ${delta === undefined ? "—" : (delta >= 0 ? "+" : "") + delta.toFixed(2)} |`,
  );
}
out.push(``);

out.push(`## Panel mean per system (all judges vs. self-excluded)`);
out.push(``);
out.push(`| System | n rows (all) | Mean (all) | n rows (noSelf) | Mean (noSelf) |`);
out.push(`|---|---|---|---|---|`);
const aggAll = aggByVariant.get("all")!;
const aggNoSelf = aggByVariant.get("noSelf")!;
for (const s of [...systemSlugs].sort(
  (x, y) => (meanOf(aggNoSelf, y) ?? -1) - (meanOf(aggNoSelf, x) ?? -1),
)) {
  out.push(
    `| ${s} | ${aggAll.get(s)?.n ?? 0} | ${f2(meanOf(aggAll, s))} | ${aggNoSelf.get(s)?.n ?? 0} | ${f2(meanOf(aggNoSelf, s))} |`,
  );
}
out.push(``);

// Inter-judge agreement on the overall preference, pair by pair.
{
  out.push(`## Inter-judge agreement (overall preference, per judged pair)`);
  out.push(``);
  const agree = new Map<string, { same: number; n: number }>();
  const vsMajority = new Map<string, { same: number; n: number }>();
  for (const [, rows] of verdictsByPair) {
    const sideA = rows[0]!.reviewAId;
    const byJudge = new Map(rows.map((v) => [v.judgeModel, prefFor(v, sideA)]));
    const js = [...byJudge.keys()].sort();
    for (let i = 0; i < js.length; i++)
      for (let k = i + 1; k < js.length; k++) {
        const key = `${js[i]} × ${js[k]}`;
        const a = agree.get(key) ?? { same: 0, n: 0 };
        a.n++;
        if (byJudge.get(js[i]!) === byJudge.get(js[k]!)) a.same++;
        agree.set(key, a);
      }
    // Majority of the OTHER judges (leave-one-out, self-excluded), so a
    // judge is never compared against a majority it helped form.
    for (const j of js) {
      const others = rows.filter((v) => v.judgeModel !== j && !isSelfVerdict(v));
      if (others.length === 0) continue;
      const counts = { A: 0, B: 0, TIE: 0 };
      for (const v of others) counts[prefFor(v, sideA)]++;
      const maj: Pref = counts.A > counts.B ? "A" : counts.B > counts.A ? "B" : "TIE";
      const a = vsMajority.get(j) ?? { same: 0, n: 0 };
      a.n++;
      if (byJudge.get(j) === maj) a.same++;
      vsMajority.set(j, a);
    }
  }
  out.push(`| Judge pair | Agreement | n pairs |`);
  out.push(`|---|---|---|`);
  for (const [key, a] of [...agree].sort()) {
    out.push(`| ${key} | ${a.n ? ((100 * a.same) / a.n).toFixed(1) + "%" : "n/a"} | ${a.n} |`);
  }
  out.push(``);
  out.push(`| Judge | Agreement with leave-one-out majority (noSelf) | n pairs |`);
  out.push(`|---|---|---|`);
  for (const [j, a] of [...vsMajority].sort()) {
    out.push(`| ${j} | ${a.n ? ((100 * a.same) / a.n).toFixed(1) + "%" : "n/a"} | ${a.n} |`);
  }
  out.push(``);
}

// ── RQ2a — system-level ranking correlation ────────────────────────────────

out.push(`## RQ2a — System-level correlation: human rating vs. mean judge score`);
out.push(``);
out.push(`Primary row is **noSelf** (panel mean excluding self-judgements). Per-judge rows show how much each member alone would recover the human ranking.`);
out.push(``);
out.push(`| Judge variant | n systems | Spearman ρ (BT) | Kendall τ (BT) | Pearson r (BT) | Spearman ρ (Elo) | Kendall τ (Elo) |`);
out.push(`|---|---|---|---|---|---|---|`);
for (const v of VARIANTS) {
  const agg = aggByVariant.get(v.name)!;
  const btC = corrRow(btRating, (s) => meanOf(agg, s));
  const eloC = corrRow(eloRating, (s) => meanOf(agg, s));
  const bold = v.name === PRIMARY.name ? "**" : "";
  out.push(
    `| ${bold}${v.name}${bold} | ${btC.n} | ${bold}${f3(btC.rho)}${bold} | ${f3(btC.tau)} | ${f3(btC.r)} | ${f3(eloC.rho)} | ${f3(eloC.tau)} |`,
  );
}
out.push(``);

// ── RQ2b — battle-level agreement ──────────────────────────────────────────

// Primary: the panel's majority verdict vs the human winner — the same
// construct on both sides, no tie band needed. Secondary: the score-delta
// method on panel means, kept for comparability with the pointwise era.
out.push(`## RQ2b — Battle-level human–judge agreement`);
out.push(``);
out.push(`### Panel majority vs. human winner`);
out.push(``);
out.push(`| Variant | Agree | Disagree | Panel tie (excluded) | Human tie (excluded) | No verdict | **Agreement rate** |`);
out.push(`|---|---|---|---|---|---|---|`);
for (const v of VARIANTS) {
  let agree = 0, disagree = 0, panelTie = 0, humanTie = 0, missing = 0;
  for (const vote of cleanVotes) {
    const m = panelMajority(vote.reviewAId, vote.reviewBId, v.verdict);
    if (!m) { missing++; continue; }
    if (vote.winner === "TIE") { humanTie++; continue; }
    if (m.overall === "TIE") { panelTie++; continue; }
    if (m.overall === vote.winner) agree++;
    else disagree++;
  }
  const decisive = agree + disagree;
  const bold = v.name === PRIMARY.name ? "**" : "";
  out.push(
    `| ${bold}${v.name}${bold} | ${agree} | ${disagree} | ${panelTie} | ${humanTie} | ${missing} | ${bold}${decisive ? ((100 * agree) / decisive).toFixed(1) + "%" : "n/a"} (${agree}/${decisive})${bold} |`,
  );
}
out.push(``);

{
  const TIE_BAND = 0.5;
  out.push(`### Score-delta method on panel means (noSelf, tie band |Δ| < ${TIE_BAND})`);
  out.push(``);
  // Mean judge score per review over the noSelf rows.
  const meanByReview = new Map<string, { n: number; sum: number }>();
  for (const m of judgeRows) {
    if (!PRIMARY.score(m)) continue;
    const a = meanByReview.get(m.reviewId) ?? { n: 0, sum: 0 };
    a.n++;
    a.sum += m.value;
    meanByReview.set(m.reviewId, a);
  }
  const scoreOf = (id: string) => {
    const a = meanByReview.get(id);
    return a && a.n > 0 ? a.sum / a.n : undefined;
  };
  let agree = 0, disagree = 0, judgeTie = 0, humanTie = 0, missing = 0;
  for (const v of cleanVotes) {
    const ja = scoreOf(v.reviewAId);
    const jb = scoreOf(v.reviewBId);
    if (ja === undefined || jb === undefined) { missing++; continue; }
    if (v.winner === "TIE") { humanTie++; continue; }
    const d = ja - jb;
    if (Math.abs(d) < TIE_BAND) { judgeTie++; continue; }
    if ((d > 0 ? "A" : "B") === v.winner) agree++;
    else disagree++;
  }
  const decisive = agree + disagree;
  out.push(`| Category | Count |`);
  out.push(`|---|---|`);
  out.push(`| Agree | ${agree} |`);
  out.push(`| Disagree | ${disagree} |`);
  out.push(`| Judge tie (|Δ| < ${TIE_BAND}) on decisive human vote | ${judgeTie} |`);
  out.push(`| Human tie (excluded) | ${humanTie} |`);
  out.push(`| Missing judge score (excluded) | ${missing} |`);
  out.push(`| **Agreement rate (decisive both sides)** | **${decisive ? ((100 * agree) / decisive).toFixed(1) + "%" : "n/a"} (${agree}/${decisive})** |`);
  out.push(``);
}

// ── RQ2c — per-dimension correlation ───────────────────────────────────────

out.push(`## RQ2c — Per-dimension correlation (human dimension rating vs. mean judge dimension score)`);
out.push(``);
out.push(`Panel-mean columns use noSelf; per-judge columns use that judge's rows alone. Spearman ρ against the BT dimension rating; "ins." = fewer than 3 systems with both signals.`);
out.push(``);
const perJudge = judgeSlugs.map((j) => `ρ ${j}`);
out.push(`| Dimension | n | ρ BT (noSelf) | ρ Elo (noSelf) | ${perJudge.join(" | ")} |`);
out.push(`|---|---|---|---|${perJudge.map(() => "---").join("|")}|`);
for (const d of DIMS) {
  const btDim = dimBTBySlug.get(d)!;
  const eloDim = dimEloBySlug.get(d)!;
  const primary = corrRow(btDim, (s) => dimMeanOf(aggNoSelf, s, d));
  const primaryElo = corrRow(eloDim, (s) => dimMeanOf(aggNoSelf, s, d));
  const cells = judgeSlugs.map((j) => {
    const c = corrRow(btDim, (s) => dimMeanOf(aggByVariant.get(`judge:${j}`)!, s, d));
    return c.n >= 3 ? f3(c.rho) : "ins.";
  });
  out.push(
    `| ${d} | ${primary.n} | ${primary.n >= 3 ? f3(primary.rho) : "ins."} | ${primaryElo.n >= 3 ? f3(primaryElo.rho) : "ins."} | ${cells.join(" | ")} |`,
  );
}
out.push(``);

console.log(out.join("\n"));
process.exit(0);
