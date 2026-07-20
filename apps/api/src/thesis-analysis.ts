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

// ── RQ2: Elo (overall + per dimension) ────────────────────────────────────

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

out.push(`## RQ2a — Overall human leaderboard (Elo, K=4, 100-round bootstrap 95% CI)`);
out.push(``);
out.push(`| Rank | System | Elo | 95% CI | Battles |`);
out.push(`|---|---|---|---|---|`);
const overall = eloTable(overallBattles);
overall.forEach((e, i) =>
  out.push(`| ${i + 1} | ${e.slug} | ${f(e.rating)} | [${f(e.ciLow)}, ${f(e.ciHigh)}] | ${e.voteCount} |`),
);
out.push(``);

out.push(`## RQ2b — Per-dimension Elo (rank per dimension)`);
out.push(``);
const slugs = overall.map((e) => e.slug);
out.push(`| Dimension | ${slugs.join(" | ")} |`);
out.push(`|---|${slugs.map(() => "---").join("|")}|`);
const dimEloBySlug = new Map<string, Map<string, number>>();
for (const d of DIMS) {
  const t = eloTable(dimBattles.get(d)!);
  dimEloBySlug.set(d, new Map(t.map((e) => [e.slug, e.rating])));
  const rankOf = new Map(t.map((e, i) => [e.slug, i + 1]));
  out.push(
    `| ${d} | ${slugs
      .map((s) => {
        const r = rankOf.get(s);
        const elo = dimEloBySlug.get(d)!.get(s);
        return r ? `#${r} (${f(elo!)})` : "—";
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
  out.push(`| Spearman ρ (human Elo vs mean judge score) | ${spearman(hx, jx).toFixed(3)} |`);
  out.push(`| Kendall τ | ${kendall(hx, jx).toFixed(3)} |`);
  out.push(`| Pearson r | ${pearson(hx, jx).toFixed(3)} |`);
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
out.push(`## RQ1c — Per-dimension correlation (human dimension-Elo vs mean judge dimension score)`);
out.push(``);
out.push(`| Dimension | n systems | Spearman ρ |`);
out.push(`|---|---|---|`);
for (const d of DIMS) {
  const dimElo = dimEloBySlug.get(d)!;
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
    pts.push([elo, jd.sum / jd.n]);
  }
  if (pts.length >= 3) {
    out.push(`| ${d} | ${pts.length} | ${spearman(pts.map((p) => p[0]), pts.map((p) => p[1])).toFixed(3)} |`);
  } else {
    out.push(`| ${d} | ${pts.length} | insufficient |`);
  }
}
out.push(``);

console.log(out.join("\n"));
process.exit(0);
