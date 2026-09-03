/**
 * One-off thesis analysis: pulls the live vote + judge data and prints
 * the RQ1/RQ2 result tables (markdown).
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
const { votes, dimensionVotes, reviews, reviewSystems, metricScores, papers } = schema;

type Battle = { a: string; b: string; outcome: 0 | 0.5 | 1 };

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

const judgeRows = await db
  .select()
  .from(metricScores)
  .where(eq(metricScores.kind, "LLM_JUDGE_OVERALL"));
const judgeByReview = new Map(judgeRows.map((m) => [m.reviewId, m]));

const paperRows = await db.select({ id: papers.id }).from(papers);

// Must match RATING_BASELINE_SLUG in config.ts, or the numbers here will not
// line up with the live board.
const BASELINE_SLUG = process.env.RATING_BASELINE_SLUG ?? "claude-sonnet-5";

// ── RQ2: ratings (overall + per dimension), Bradley-Terry and Elo ─────────

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

// ── Judge means per system (overall + per dimension from meta) ────────────

type JudgeAgg = { n: number; sum: number; dims: Map<string, { n: number; sum: number }> };
const judgeAgg = new Map<string, JudgeAgg>();
let sampleMeta: unknown = null;
for (const m of judgeRows) {
  const slug = reviewSys.get(m.reviewId);
  if (!slug) continue;
  const agg = judgeAgg.get(slug) ?? { n: 0, sum: 0, dims: new Map() };
  agg.n++;
  agg.sum += m.value;
  const meta = m.meta as Record<string, unknown> | null;
  if (!sampleMeta && meta) sampleMeta = meta;
  const dimsObj = meta?.dimension_scores as Record<string, number> | undefined;
  if (dimsObj) {
    for (const [k, val] of Object.entries(dimsObj)) {
      if (typeof val !== "number") continue;
      const d = agg.dims.get(k) ?? { n: 0, sum: 0 };
      d.n++;
      d.sum += val;
      agg.dims.set(k, d);
    }
  }
  judgeAgg.set(slug, agg);
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

// ── Print ──────────────────────────────────────────────────────────────────

const f = (n: number) => n.toFixed(1);
const out: string[] = [];

out.push(`# ReviewArena — thesis data snapshot`);
out.push(``);
out.push(
  `Papers: ${paperRows.length} · Votes: ${allVotes.length} (${cleanVotes.length} clean, ${allVotes.length - cleanVotes.length} quality-flagged) · Dimension votes: ${allDimVotes.length} · Judge-scored reviews: ${judgeRows.length}`,
);
out.push(``);

const bt = btTable(overallBattles);
const btOverall = bt.rows;
out.push(
  `## RQ2a — Overall human leaderboard (Bradley-Terry MLE, 100-round bootstrap 95% CI)`,
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

out.push(`## RQ2a-ii — Same battles under online Elo (K=4, 100-round bootstrap 95% CI)`);
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
{
  const btRanked = btOverall.map((e) => e.slug);
  const eloRanked = overall.map((e) => e.slug).filter((slug) => btOverall.some((b) => b.slug === slug));
  const btRating = new Map(btOverall.map((e) => [e.slug, e.rating]));
  const eloRating = new Map(overall.map((e) => [e.slug, e.rating]));
  const shared = btRanked.filter((slug) => eloRating.has(slug));
  out.push(`## RQ2a-iii — Bradley-Terry vs Elo agreement (n=${shared.length} systems)`);
  out.push(``);
  if (shared.length >= 3) {
    const bx = shared.map((slug) => btRating.get(slug)!);
    const ex = shared.map((slug) => eloRating.get(slug)!);
    out.push(`| Statistic | Value |`);
    out.push(`|---|---|`);
    out.push(`| Spearman ρ (BT vs Elo ranking) | ${spearman(bx, ex).toFixed(3)} |`);
    out.push(`| Kendall τ | ${kendall(bx, ex).toFixed(3)} |`);
    out.push(`| Pearson r (rating scales) | ${pearson(bx, ex).toFixed(3)} |`);
    out.push(`| Max rank displacement | ${maxRankShift(btRanked, eloRanked)} |`);
  } else {
    out.push(`Not enough systems on both boards (${shared.length}).`);
  }
  out.push(``);
}

out.push(`## RQ2b — Per-dimension Bradley-Terry (rank per dimension)`);
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

out.push(`## Judge scores per system (LLM_JUDGE_OVERALL, mean over reviews)`);
out.push(``);
out.push(`| System | n reviews | Mean judge overall (0–10) |`);
out.push(`|---|---|---|`);
const judgeMean = new Map<string, number>();
for (const [slug, a] of [...judgeAgg.entries()].sort((x, y) => y[1].sum / y[1].n - x[1].sum / x[1].n)) {
  judgeMean.set(slug, a.sum / a.n);
  out.push(`| ${slug} | ${a.n} | ${(a.sum / a.n).toFixed(2)} |`);
}
out.push(``);
if (sampleMeta) out.push(`<!-- sample judge meta keys: ${Object.keys(sampleMeta as object).join(", ")} -->`);
out.push(``);

// RQ1 level 1: system-level correlation (systems present in both rankings)
const common = overall.filter((e) => judgeMean.has(e.slug));
if (common.length >= 3) {
  const hx = common.map((e) => e.rating);
  const jx = common.map((e) => judgeMean.get(e.slug)!);
  out.push(`## RQ1a — System-level ranking correlation (n=${common.length} systems)`);
  out.push(``);
  out.push(`| Statistic | Value |`);
  out.push(`|---|---|`);
  const btCommon = common.map((e) => btOverall.find((b) => b.slug === e.slug)?.rating);
  const bothRated = btCommon.every((r) => r !== undefined);
  if (bothRated) {
    const bx = btCommon as number[];
    out.push(`| **Spearman ρ (human BT vs mean judge score)** | **${spearman(bx, jx).toFixed(3)}** |`);
    out.push(`| Kendall τ (BT) | ${kendall(bx, jx).toFixed(3)} |`);
    out.push(`| Pearson r (BT) | ${pearson(bx, jx).toFixed(3)} |`);
  }
  out.push(`| Spearman ρ (human Elo vs mean judge score) | ${spearman(hx, jx).toFixed(3)} |`);
  out.push(`| Kendall τ (Elo) | ${kendall(hx, jx).toFixed(3)} |`);
  out.push(`| Pearson r (Elo) | ${pearson(hx, jx).toFixed(3)} |`);
  out.push(``);
} else {
  out.push(`## RQ1a — system-level correlation: not enough systems with both signals (${common.length})`);
  out.push(``);
}

// RQ1 level 2: battle-level agreement
let agree = 0, disagree = 0, judgeTie = 0, humanTie = 0, missing = 0;
const TIE_BAND = 0.5;
for (const v of cleanVotes) {
  const ja = judgeByReview.get(v.reviewAId)?.value;
  const jb = judgeByReview.get(v.reviewBId)?.value;
  if (ja === undefined || jb === undefined) { missing++; continue; }
  if (v.winner === "TIE") { humanTie++; continue; }
  const d = ja - jb;
  if (Math.abs(d) < TIE_BAND) { judgeTie++; continue; }
  const judgeWinner = d > 0 ? "A" : "B";
  if (judgeWinner === v.winner) agree++;
  else disagree++;
}
out.push(`## RQ1b — Battle-level human–judge agreement (tie band |Δ| < ${TIE_BAND})`);
out.push(``);
out.push(`| Category | Count |`);
out.push(`|---|---|`);
out.push(`| Agree (judge picks same winner) | ${agree} |`);
out.push(`| Disagree | ${disagree} |`);
out.push(`| Judge tie (|Δ| < ${TIE_BAND}) on decisive human vote | ${judgeTie} |`);
out.push(`| Human tie (excluded) | ${humanTie} |`);
out.push(`| Missing judge score (excluded) | ${missing} |`);
const decisive = agree + disagree;
out.push(`| **Agreement rate (decisive both sides)** | **${decisive ? ((100 * agree) / decisive).toFixed(1) + "%" : "n/a"} (${agree}/${decisive})** |`);
out.push(``);

// RQ1 level 3: per-dimension correlation
out.push(`## RQ1c — Per-dimension correlation (human dimension rating vs mean judge dimension score)`);
out.push(``);
out.push(`| Dimension | n systems | Spearman ρ (BT) | Spearman ρ (Elo) |`);
out.push(`|---|---|---|---|`);
for (const d of DIMS) {
  const dimElo = dimEloBySlug.get(d)!;
  const dimBT = dimBTBySlug.get(d)!;
  const btPts: Array<[number, number]> = [];
  const pts: Array<[number, number]> = [];
  for (const [slug, elo] of dimElo) {
    // judge meta dimension keys may be lowercase or various case; try both
    const agg = judgeAgg.get(slug);
    if (!agg) continue;
    const jd =
      agg.dims.get(d) ??
      agg.dims.get(d.toLowerCase()) ??
      agg.dims.get(d.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase()));
    if (!jd) continue;
    const judgeMeanForDim = jd.sum / jd.n;
    pts.push([elo, judgeMeanForDim]);
    const btRating = dimBT.get(slug);
    if (btRating !== undefined) btPts.push([btRating, judgeMeanForDim]);
  }
  const rho = (ps: Array<[number, number]>) =>
    ps.length >= 3 ? spearman(ps.map((q) => q[0]), ps.map((q) => q[1])).toFixed(3) : "insufficient";
  out.push(`| ${d} | ${pts.length} | ${rho(btPts)} | ${rho(pts)} |`);
}
out.push(``);

console.log(out.join("\n"));
process.exit(0);
