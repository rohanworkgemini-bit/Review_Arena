/**
 * Planted-truth simulation of the controlled study.
 *
 * PURPOSE. Two jobs, both listed as build tasks in docs/THESIS_OUTLINE.md:
 *
 *   1. Power analysis (§5.6, Tab 11, Fig 12) — what does a study of N
 *      comparisons actually recover when the ground truth is known?
 *   2. A synthetic dataset with the exact shape of the real one, so the
 *      Results chapter can be drafted, the figures laid out, and the
 *      analysis code exercised end to end before any participant is
 *      recruited.
 *
 * WHAT IS SIMULATED. The real design, not a convenient approximation:
 *   - the K6 one-factorization rotation (15 pairs x 8 comparisons = 120);
 *   - 20 participants, each contributing 6 correlated comparisons, each
 *     with their own systematic bias toward longer reviews;
 *   - 8 dimensions, correlated with overall quality but with planted
 *     specialist deviations so the dimension analysis has something to find;
 *   - 6 judges, each with its own accuracy, self-preference boost, position
 *     instability, length bias, AND a shared error component that makes
 *     their mistakes correlated — the effect that Nine Judges, Two
 *     Effective Votes (arXiv:2605.29800) predicts will dominate.
 *
 * Ratings are computed with the SAME estimator the live analysis uses
 * (src/elo/bt.ts), so numbers produced here are directly comparable to
 * numbers produced from real votes.
 *
 * Run: pnpm --filter @reviewarena/api exec tsx scripts/simulate-study.ts
 *      pnpm --filter @reviewarena/api exec tsx scripts/simulate-study.ts --power
 */

import {
  computeBT,
  bootstrapBTByCluster,
  mulberry32,
  type ClusteredBattle,
} from "../src/elo/bt.js";
import { computeElo, bootstrapEloCI, type Battle, type Outcome } from "../src/elo/elo.js";
import { ROTATIONS, STUDY_SYSTEMS } from "../src/study/rotation.js";

// ─── Planted ground truth ──────────────────────────────────────────────────

// Frontier models under an identical prompt and review form are CLOSE. A
// simulation that plants a 400-point spread would make the study look far
// more decisive than it can be. These span ~110 points ≈ a 65:35 win rate
// between best and worst, which is the regime the power analysis is about.
const TRUE_BT: Record<string, number> = {
  "claude-sonnet-5": 1055,
  "deepseek-v4-flash": 975,
  "gemini-3.8-flash": 1020,
  "glm-5.2": 950,
  "gpt-5.6-terra": 1040,
  "mistral-medium-3.5": 960,
};

// Mean review length in words per system — the style confound. GLM and
// DeepSeek are planted verbose, so style control has something to remove.
const TRUE_LENGTH: Record<string, number> = {
  "claude-sonnet-5": 620,
  "deepseek-v4-flash": 810,
  "gemini-3.8-flash": 590,
  "glm-5.2": 880,
  "gpt-5.6-terra": 700,
  "mistral-medium-3.5": 640,
};

// Each system's self-assigned overall rating of the paper (RQ1d): are
// harsher reviewers preferred? Planted with a mild negative relationship.
const TRUE_HARSHNESS: Record<string, number> = {
  "claude-sonnet-5": 4.6,
  "deepseek-v4-flash": 6.1,
  "gemini-3.8-flash": 5.2,
  "glm-5.2": 6.4,
  "gpt-5.6-terra": 4.9,
  "mistral-medium-3.5": 5.8,
};

const DIMENSIONS = [
  "CONTRIBUTION_ACCURACY",
  "RESULTS_INTERPRETATION",
  "COMPARATIVE_ANALYSIS",
  "EVIDENCE_BASED_CRITIQUE",
  "CRITIQUE_CLARITY",
  "COMPLETENESS_COVERAGE",
  "CONSTRUCTIVE_TONE",
  "FALSE_CLAIMS",
] as const;

// Planted specialists: per-dimension offsets from the overall strength, so
// the dimension analysis finds real structure rather than noise.
// GLM is verbose => strong coverage, weak clarity. Claude strong on tone.
const DIM_OFFSET: Record<string, Partial<Record<string, number>>> = {
  COMPLETENESS_COVERAGE: { "glm-5.2": +90, "deepseek-v4-flash": +55, "gemini-3.8-flash": -40 },
  CRITIQUE_CLARITY: { "glm-5.2": -75, "gemini-3.8-flash": +50, "claude-sonnet-5": +30 },
  CONSTRUCTIVE_TONE: { "claude-sonnet-5": +70, "gpt-5.6-terra": -35 },
  FALSE_CLAIMS: { "gpt-5.6-terra": +60, "glm-5.2": -65 },
  EVIDENCE_BASED_CRITIQUE: { "claude-sonnet-5": +40, "mistral-medium-3.5": -45 },
};

// ─── Judge panel parameters ────────────────────────────────────────────────

interface JudgeSpec {
  slug: string;
  /** Weight on true quality difference. Higher = more discriminating. */
  acuity: number;
  /** Rating-point boost this judge gives its OWN review. The RQ2d effect. */
  selfPreference: number;
  /** Probability the two order-swapped passes disagree => recorded TIE. */
  positionInstability: number;
  /** Extra weight on length difference, beyond what humans apply. */
  lengthBias: number;
}

const JUDGES: JudgeSpec[] = [
  { slug: "claude-sonnet-5", acuity: 1.25, selfPreference: 58, positionInstability: 0.10, lengthBias: 0.30 },
  { slug: "deepseek-v4-flash", acuity: 0.80, selfPreference: 92, positionInstability: 0.21, lengthBias: 0.55 },
  { slug: "gemini-3.8-flash", acuity: 1.05, selfPreference: 44, positionInstability: 0.13, lengthBias: 0.38 },
  { slug: "glm-5.2", acuity: 0.72, selfPreference: 105, positionInstability: 0.24, lengthBias: 0.62 },
  { slug: "gpt-5.6-terra", acuity: 1.30, selfPreference: 51, positionInstability: 0.09, lengthBias: 0.28 },
  { slug: "mistral-medium-3.5", acuity: 0.85, selfPreference: 76, positionInstability: 0.19, lengthBias: 0.47 },
];

/**
 * How much of each judge's error is SHARED with the rest of the panel.
 * This is the single most consequential knob in the simulation: at 0 the
 * judges are independent and n_eff = 6; at 1 they are one judge copied six
 * times and n_eff = 1. 0.55 is set to reproduce the regime reported by
 * Nine Judges, Two Effective Votes (~75% of independence lost).
 */
const SHARED_ERROR = 0.55;

// Human rater noise. Humans are not oracles: tuned so human votes recover
// the planted ranking about as well as real arena raters do (~70-75%
// agreement with latent truth on decisive pairs) with a realistic tie rate.
const HUMAN_NOISE = 105;
const HUMAN_TIE_BAND = 0.045;
// Per-rater length preference in SD units. Mean is POSITIVE: raters
// on average mildly favour longer reviews, which is what style control
// (§6.4) has to remove. SD is the between-rater spread that makes the
// participant-level cluster bootstrap necessary.
const PARTICIPANT_BIAS_MEAN = 0.5;
const PARTICIPANT_BIAS_SD = 0.4;

// ─── RNG helpers ───────────────────────────────────────────────────────────

let rng = mulberry32(20260907);
const uniform = () => rng();
/** Box-Muller standard normal. */
function normal(): number {
  const u = Math.max(uniform(), 1e-12);
  const v = uniform();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const logistic = (x: number) => 1 / (1 + Math.exp(-x));

// ─── Simulated records ─────────────────────────────────────────────────────

interface SimComparison {
  participant: string;
  paperIdx: number;
  a: string;
  b: string;
  /** Human overall verdict. */
  winner: "A" | "B" | "TIE";
  dimWinner: Record<string, "A" | "B" | "TIE">;
  lenA: number;
  lenB: number;
  /** True latent quality gap, A minus B, in rating points. */
  trueGap: number;
  decisionMs: number;
  /** Per-judge verdicts and scores. */
  judged: Array<{
    judge: string;
    overall: "A" | "B" | "TIE";
    dim: Record<string, "A" | "B" | "TIE">;
    scoreA: number;
    scoreB: number;
    passesUsed: 1 | 2;
    selfJudging: boolean;
  }>;
}

/** Turn a signed preference strength into an A/B/TIE verdict. */
function verdictFrom(p: number, tieBand: number): "A" | "B" | "TIE" {
  if (Math.abs(p - 0.5) < tieBand) return "TIE";
  return p > 0.5 ? "A" : "B";
}

function simulateStudy(numParticipants: number, papersPerParticipant: number): SimComparison[] {
  const out: SimComparison[] = [];

  for (let p = 1; p <= numParticipants; p++) {
    const participant = `P${String(p).padStart(2, "0")}`;
    // Each participant carries a stable bias toward longer reviews.
    const lengthTaste = PARTICIPANT_BIAS_MEAN + normal() * PARTICIPANT_BIAS_SD;
    // ...and a stable overall leniency (how readily they call a tie).
    const tieTaste = 1 + normal() * 0.25;

    const first = ((p - 1) % ROTATIONS.length) + 1;
    for (let k = 0; k < papersPerParticipant; k++) {
      const rotationId = ((first - 1 + k) % ROTATIONS.length) + 1;
      const rotation = ROTATIONS[rotationId - 1]!;

      for (const [letterA, letterB] of rotation) {
        // The coin flip that decides which system is shown as A.
        const flip = uniform() < 0.5;
        const sysA = STUDY_SYSTEMS[flip ? letterA : letterB]!;
        const sysB = STUDY_SYSTEMS[flip ? letterB : letterA]!;

        const lenA = Math.max(150, TRUE_LENGTH[sysA]! + normal() * 110);
        const lenB = Math.max(150, TRUE_LENGTH[sysB]! + normal() * 110);
        // Length difference in SD units, used by both humans and judges.
        const lenGap = (lenA - lenB) / 250;

        const trueGap = TRUE_BT[sysA]! - TRUE_BT[sysB]!;

        // Human overall verdict: true quality, plus this rater's length
        // taste, plus noise.
        const humanSignal = trueGap + lengthTaste * 55 * lenGap + normal() * HUMAN_NOISE;
        const pHuman = logistic(humanSignal / 173);
        const winner = verdictFrom(pHuman, HUMAN_TIE_BAND * tieTaste);

        // Per-dimension verdicts: the overall signal shifted by planted
        // specialist offsets, with extra per-dimension noise.
        const dimWinner: Record<string, "A" | "B" | "TIE"> = {};
        for (const d of DIMENSIONS) {
          const offA = DIM_OFFSET[d]?.[sysA] ?? 0;
          const offB = DIM_OFFSET[d]?.[sysB] ?? 0;
          const gap = trueGap + offA - offB;
          const sig = gap + lengthTaste * 45 * lenGap + normal() * (HUMAN_NOISE * 1.15);
          dimWinner[d] = verdictFrom(logistic(sig / 173), HUMAN_TIE_BAND * 1.3 * tieTaste);
        }

        // Decision time: log-normal, floored, with a few rushed votes.
        const decisionMs = Math.round(Math.exp(4.05 + normal() * 0.62) * 1000);

        // ── Judge panel ──
        // One shared error draw per comparison: this is what couples the
        // judges' mistakes and drives the effective sample size down.
        const common = normal();
        const judged: SimComparison["judged"] = [];
        for (const j of JUDGES) {
          const selfJudging = j.slug === sysA || j.slug === sysB;
          // Self-preference pushes toward whichever side the judge wrote.
          let selfPush = 0;
          if (j.slug === sysA) selfPush = +j.selfPreference;
          else if (j.slug === sysB) selfPush = -j.selfPreference;

          const idiosyncratic = normal();
          const noise =
            (Math.sqrt(SHARED_ERROR) * common + Math.sqrt(1 - SHARED_ERROR) * idiosyncratic) *
            (78 / j.acuity);

          const signal = trueGap * j.acuity + selfPush + j.lengthBias * 70 * lenGap + noise;
          let overall = verdictFrom(logistic(signal / 173), 0.045);

          // Position instability: the two order-swapped passes disagree,
          // which the pipeline records as a TIE with passes_used = 1.
          const unstable = uniform() < j.positionInstability;
          const passesUsed: 1 | 2 = unstable ? 1 : 2;
          if (unstable) overall = "TIE";

          const dim: Record<string, "A" | "B" | "TIE"> = {};
          for (const d of DIMENSIONS) {
            const offA = DIM_OFFSET[d]?.[sysA] ?? 0;
            const offB = DIM_OFFSET[d]?.[sysB] ?? 0;
            const gap = trueGap + offA - offB;
            const dn =
              (Math.sqrt(SHARED_ERROR) * common + Math.sqrt(1 - SHARED_ERROR) * normal()) *
              (92 / j.acuity);
            const s = gap * j.acuity + selfPush * 0.8 + j.lengthBias * 55 * lenGap + dn;
            dim[d] = verdictFrom(logistic(s / 173), 0.05);
          }

          // Pointwise 0-10 scores from the same call. Anchored on absolute
          // quality, not on the pair, plus the self-preference boost.
          const base = (q: string) => 5.2 + (TRUE_BT[q]! - 1000) / 55;
          const scoreA =
            clamp(base(sysA) + (j.slug === sysA ? j.selfPreference / 90 : 0) +
              j.lengthBias * 0.35 * (lenA - 700) / 250 + normal() * 0.75);
          const scoreB =
            clamp(base(sysB) + (j.slug === sysB ? j.selfPreference / 90 : 0) +
              j.lengthBias * 0.35 * (lenB - 700) / 250 + normal() * 0.75);

          judged.push({ judge: j.slug, overall, dim, scoreA, scoreB, passesUsed, selfJudging });
        }

        out.push({
          participant,
          paperIdx: k,
          a: sysA,
          b: sysB,
          winner,
          dimWinner,
          lenA,
          lenB,
          trueGap,
          decisionMs,
          judged,
        });
      }
    }
  }
  return out;
}

const clamp = (x: number) => Math.max(1, Math.min(10, x));

// ─── Statistics ────────────────────────────────────────────────────────────

const toOutcome = (w: "A" | "B" | "TIE"): Outcome => (w === "A" ? 1 : w === "B" ? 0 : 0.5);

/** Cohen's kappa for two raters over a categorical set. */
function cohensKappa(pairs: Array<[string, string]>): number {
  if (pairs.length === 0) return NaN;
  const cats = [...new Set(pairs.flatMap(([x, y]) => [x, y]))];
  let observed = 0;
  for (const [x, y] of pairs) if (x === y) observed++;
  const po = observed / pairs.length;
  let pe = 0;
  for (const c of cats) {
    const p1 = pairs.filter(([x]) => x === c).length / pairs.length;
    const p2 = pairs.filter(([, y]) => y === c).length / pairs.length;
    pe += p1 * p2;
  }
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
}

/**
 * Mean pairwise correlation of binary error indicators, then Kish n_eff.
 *
 * IMPORTANT: judges are excluded from different comparisons (each abstains
 * on the two pairs containing its own review, and each returns ties on
 * different comparisons). Correlating two judges' raw error vectors
 * positionally would compare errors made on DIFFERENT comparisons and
 * return noise. Correlations are therefore computed pairwise-complete: for
 * each judge pair, over exactly the comparisons where BOTH returned a
 * decisive non-self verdict.
 */
function effectiveSampleSize(errorsByJudge: Map<string, Map<number, number>>): {
  rhoBar: number;
  nEff: number;
  n: number;
  minOverlap: number;
} {
  const slugs = [...errorsByJudge.keys()];
  const n = slugs.length;
  const corrs: number[] = [];
  let minOverlap = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const xm = errorsByJudge.get(slugs[i]!)!;
      const ym = errorsByJudge.get(slugs[j]!)!;
      const x: number[] = [];
      const y: number[] = [];
      for (const [idx, xv] of xm) {
        const yv = ym.get(idx);
        if (yv !== undefined) { x.push(xv); y.push(yv); }
      }
      minOverlap = Math.min(minOverlap, x.length);
      const c = pearson(x, y);
      if (!Number.isNaN(c)) corrs.push(c);
    }
  }
  const rhoBar = corrs.reduce((a, b) => a + b, 0) / corrs.length;
  const nEff = n / (1 + (n - 1) * rhoBar);
  return { rhoBar, nEff, n, minOverlap };
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
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

function spearman(x: number[], y: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((val, i) => [val, i] as const).sort((a, b) => b[0] - a[0]);
    const r = new Array(v.length).fill(0);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  return pearson(rank(x), rank(y));
}

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => (Number.isNaN(n) ? "n/a" : n.toFixed(3));
const pct = (n: number) => (Number.isNaN(n) ? "n/a" : (100 * n).toFixed(1) + "%");

// ─── Main report ───────────────────────────────────────────────────────────

function main() {
  const powerMode = process.argv.includes("--power");
  const sims = simulateStudy(20, 2);

  const out: string[] = [];
  out.push(`# SIMULATED study results — planted ground truth`);
  out.push(``);
  out.push(`> **THESE NUMBERS ARE SYNTHETIC.** Generated by`);
  out.push(`> \`scripts/simulate-study.ts\`, seed 20260907. They exist to lay out`);
  out.push(`> the Results chapter and exercise the analysis before real data`);
  out.push(`> exists. Every number here must be replaced before submission.`);
  out.push(``);
  out.push(`Planted ground-truth BT: ${Object.entries(TRUE_BT).sort((a, b) => b[1] - a[1]).map(([s, r]) => `${s} ${r}`).join(" · ")}`);
  out.push(``);

  // ── Descriptives ──
  const flagged = sims.filter((s) => s.decisionMs < 3000);
  const clean = sims.filter((s) => s.decisionMs >= 3000);
  const times = sims.map((s) => s.decisionMs).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;

  const pairCount = new Map<string, number>();
  for (const s of clean) {
    const k = [s.a, s.b].sort().join(" vs ");
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }

  out.push(`## Table 2 — Descriptives`);
  out.push(``);
  out.push(`| Quantity | Value |`);
  out.push(`|---|---|`);
  out.push(`| Participants | 20 |`);
  out.push(`| Comparisons collected | ${sims.length} |`);
  out.push(`| Excluded: decision time < 3 s | ${flagged.length} |`);
  out.push(`| Comparisons analysed | ${clean.length} |`);
  out.push(`| Median decision time | ${(median / 1000).toFixed(1)} s |`);
  out.push(`| Unique system pairs | ${pairCount.size} of 15 |`);
  out.push(`| Comparisons per pair (min–max) | ${Math.min(...pairCount.values())}–${Math.max(...pairCount.values())} |`);
  out.push(`| Human tie rate | ${pct(clean.filter((s) => s.winner === "TIE").length / clean.length)} |`);
  out.push(``);

  // ── RQ1a: BT with cluster bootstrap ──
  const battles: ClusteredBattle[] = clean.map((s) => ({
    a: s.a, b: s.b, outcome: toOutcome(s.winner), cluster: s.participant,
  }));
  const plain: Battle[] = battles.map(({ a, b, outcome }) => ({ a, b, outcome }));

  const bt = computeBT(plain);
  const clusterCI = bootstrapBTByCluster(battles, 2000);
  const elo = computeElo(plain);
  const eloCI = bootstrapEloCI(plain, 500);

  const wins = new Map<string, { w: number; n: number }>();
  for (const s of clean) {
    for (const [sys, sc] of [[s.a, s.winner === "A" ? 1 : s.winner === "TIE" ? 0.5 : 0],
                             [s.b, s.winner === "B" ? 1 : s.winner === "TIE" ? 0.5 : 0]] as const) {
      const e = wins.get(sys as string) ?? { w: 0, n: 0 };
      e.w += sc as number; e.n += 1; wins.set(sys as string, e);
    }
  }

  const ranked = [...bt.ratings.entries()].sort((a, b) => b[1] - a[1]);
  out.push(`## Table 1 — RQ1a: Bradley–Terry leaderboard`);
  out.push(``);
  out.push(`Mean-centred at 1000 (no anchor, so every system carries an interval). Cluster bootstrap = 2000 replicates over participants.`);
  out.push(``);
  out.push(`| Rank | System | BT | 95% CI (cluster) | Elo | Win rate | n | True BT |`);
  out.push(`|---|---|---|---|---|---|---|---|`);
  ranked.forEach(([slug, r], i) => {
    const ci = clusterCI.get(slug);
    const w = wins.get(slug)!;
    out.push(
      `| ${i + 1} | ${slug} | ${f1(r)} | [${ci ? f1(ci.ciLow) : "—"}, ${ci ? f1(ci.ciHigh) : "—"}] | ${f1(elo.get(slug) ?? 1000)} | ${pct(w.w / w.n)} | ${w.n} | ${TRUE_BT[slug]} |`,
    );
  });
  out.push(``);

  // Separation check
  const seps: string[] = [];
  for (let i = 0; i < ranked.length - 1; i++) {
    const [s1] = ranked[i]!, [s2] = ranked[i + 1]!;
    const c1 = clusterCI.get(s1), c2 = clusterCI.get(s2);
    if (c1 && c2) seps.push(`${s1} vs ${s2}: ${c1.ciLow > c2.ciHigh ? "SEPARATED" : "overlapping"}`);
  }
  out.push(`**Adjacent separation (disjoint cluster CIs):** ${seps.join(" · ")}`);
  out.push(``);
  const recovered = spearman(ranked.map(([s]) => bt.ratings.get(s)!), ranked.map(([s]) => TRUE_BT[s]!));
  out.push(`**Rank recovery vs planted truth:** Spearman ρ = ${f3(recovered)}`);
  out.push(``);

  // ── RQ1b: per-dimension ──
  out.push(`## Table 4 — RQ1b: Per-dimension BT rank`);
  out.push(``);
  const slugs = ranked.map(([s]) => s);
  out.push(`| Dimension | ${slugs.join(" | ")} |`);
  out.push(`|---|${slugs.map(() => "---").join("|")}|`);
  for (const d of DIMENSIONS) {
    const db = computeBT(
      clean.map((s) => ({ a: s.a, b: s.b, outcome: toOutcome(s.dimWinner[d]!) })),
    );
    const order = [...db.ratings.entries()].sort((a, b) => b[1] - a[1]);
    const rank = new Map(order.map(([s], i) => [s, i + 1]));
    out.push(`| ${d} | ${slugs.map((s) => `#${rank.get(s) ?? "—"} (${f1(db.ratings.get(s) ?? NaN)})`).join(" | ")} |`);
  }
  out.push(``);

  // ── RQ1c: length ──
  const lenPref: number[] = clean.filter((s) => s.winner !== "TIE").map((s) => {
    const longerWon = (s.lenA > s.lenB) === (s.winner === "A");
    return longerWon ? 1 : 0;
  });
  out.push(`## RQ1c — Length confound`);
  out.push(``);
  out.push(`Longer review preferred by humans in **${pct(lenPref.reduce((a, b) => a + b, 0) / lenPref.length)}** of decisive comparisons (n=${lenPref.length}).`);
  out.push(``);

  // ── RQ1d: harshness ──
  const harsh = slugs.map((s) => TRUE_HARSHNESS[s]!);
  const btVals = slugs.map((s) => bt.ratings.get(s)!);
  out.push(`## Table 5 — RQ1d: Reviewer stance vs preference`);
  out.push(``);
  out.push(`| System | Mean self-assigned rating | Human BT |`);
  out.push(`|---|---|---|`);
  slugs.forEach((s) => out.push(`| ${s} | ${f1(TRUE_HARSHNESS[s]!)} | ${f1(bt.ratings.get(s)!)} |`));
  out.push(``);
  out.push(`Spearman ρ(self-assigned rating, human BT) = **${f3(spearman(harsh, btVals))}** (n=6, descriptive only).`);
  out.push(``);

  // ── RQ2: judge analysis ──
  const decisive = clean.filter((s) => s.winner !== "TIE");

  // Per-judge agreement (self-judgements excluded), + kappa, + error vectors.
  const errorsByJudge = new Map<string, Map<number, number>>();
  const judgeRows: Array<{ judge: string; agree: number; n: number; kappa: number; ties: number }> = [];
  for (const j of JUDGES) {
    const pairs: Array<[string, string]> = [];
    const errs = new Map<number, number>();
    let ties = 0;
    decisive.forEach((s, idx) => {
      const v = s.judged.find((x) => x.judge === j.slug)!;
      if (v.selfJudging) return;
      if (v.overall === "TIE") { ties++; return; }
      pairs.push([v.overall, s.winner]);
      errs.set(idx, v.overall === s.winner ? 1 : 0);
    });
    errorsByJudge.set(j.slug, errs);
    const vals = [...errs.values()];
    const agree = vals.reduce((a, b) => a + b, 0) / vals.length;
    judgeRows.push({ judge: j.slug, agree, n: vals.length, kappa: cohensKappa(pairs), ties });
  }

  // Panel majority (self excluded).
  const panelPairs: Array<[string, string]> = [];
  let panelTies = 0;
  for (const s of decisive) {
    const vs = s.judged.filter((v) => !v.selfJudging && v.overall !== "TIE");
    if (vs.length === 0) { panelTies++; continue; }
    const a = vs.filter((v) => v.overall === "A").length;
    const b = vs.filter((v) => v.overall === "B").length;
    if (a === b) { panelTies++; continue; }
    panelPairs.push([a > b ? "A" : "B", s.winner]);
  }
  const panelAgree = panelPairs.filter(([x, y]) => x === y).length / panelPairs.length;
  const panelKappa = cohensKappa(panelPairs);

  judgeRows.sort((x, y) => y.agree - x.agree);
  const best = judgeRows[0]!;

  out.push(`## Table 6 — RQ2a/b: Judge and panel agreement with humans`);
  out.push(``);
  out.push(`Self-judgements excluded. Decisive human votes only.`);
  out.push(``);
  out.push(`| Judge | Agreement | Cohen's κ | n | Judge ties (excl.) |`);
  out.push(`|---|---|---|---|---|`);
  for (const r of judgeRows) {
    out.push(`| ${r.judge} | ${pct(r.agree)} | ${f3(r.kappa)} | ${r.n} | ${r.ties} |`);
  }
  out.push(`| **Panel majority** | **${pct(panelAgree)}** | **${f3(panelKappa)}** | ${panelPairs.length} | ${panelTies} |`);
  out.push(`| *Best single judge* | *${pct(best.agree)}* | *${f3(best.kappa)}* | ${best.n} | — |`);
  out.push(``);
  out.push(`**κ deflation:** panel raw agreement ${pct(panelAgree)} → κ ${f3(panelKappa)} (${f1(100 * panelAgree - 100 * panelKappa)} pp).`);
  out.push(``);
  out.push(panelAgree > best.agree
    ? `Panel majority **beats** its best member by ${f1(100 * (panelAgree - best.agree))} pp.`
    : `Panel majority does **not** beat its best member (${f1(100 * (best.agree - panelAgree))} pp behind) — consistent with Nine Judges, Two Effective Votes.`);
  out.push(``);

  // ── RQ2c: independence ──
  const { rhoBar, nEff, minOverlap } = effectiveSampleSize(errorsByJudge);
  out.push(`## Table 7 — RQ2c/e: Judge independence and position stability`);
  out.push(``);
  out.push(`| Statistic | Value |`);
  out.push(`|---|---|`);
  out.push(`| Mean pairwise error correlation ρ̄ | ${f3(rhoBar)} |`);
  out.push(`| **Effective sample size (Kish)** | **${f2(nEff)} of 6 judges** |`);
  out.push(`| Independence retained | ${pct(nEff / 6)} |`);
  out.push(`| Smallest judge-pair overlap | ${minOverlap} comparisons |`);
  out.push(``);
  out.push(`| Judge | Swap-consistent verdicts (passes=2) |`);
  out.push(`|---|---|`);
  for (const j of JUDGES) {
    const all = clean.map((s) => s.judged.find((v) => v.judge === j.slug)!);
    out.push(`| ${j.slug} | ${pct(all.filter((v) => v.passesUsed === 2).length / all.length)} |`);
  }
  out.push(``);

  // ── RQ2d: self-preference matrix — THE headline ──
  out.push(`## Table 8 — RQ2d: Judge × system mean score (0–10)`);
  out.push(``);
  out.push(`Diagonal = self-judgement. Δ = self minus off-diagonal mean.`);
  out.push(``);
  out.push(`| Judge ↓ / System → | ${slugs.join(" | ")} | Off-diag | **Δ self** |`);
  out.push(`|---|${slugs.map(() => "---").join("|")}|---|---|`);
  const deltas: number[] = [];
  for (const j of JUDGES) {
    const cell = new Map<string, { s: number; n: number }>();
    for (const s of clean) {
      const v = s.judged.find((x) => x.judge === j.slug)!;
      for (const [sys, sc] of [[s.a, v.scoreA], [s.b, v.scoreB]] as const) {
        const e = cell.get(sys) ?? { s: 0, n: 0 };
        e.s += sc; e.n++; cell.set(sys, e);
      }
    }
    const vals = slugs.map((s) => { const e = cell.get(s); return e ? e.s / e.n : NaN; });
    const self = cell.get(j.slug)!;
    const selfMean = self.s / self.n;
    const offVals = slugs.filter((s) => s !== j.slug).map((s) => { const e = cell.get(s)!; return e.s / e.n; });
    const offMean = offVals.reduce((a, b) => a + b, 0) / offVals.length;
    const d = selfMean - offMean;
    deltas.push(d);
    out.push(`| ${j.slug} | ${vals.map((v) => (slugs[vals.indexOf(v)] === j.slug ? `**${f2(v)}**` : f2(v))).join(" | ")} | ${f2(offMean)} | **${d >= 0 ? "+" : ""}${f2(d)}** |`);
  }
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  out.push(``);
  out.push(`**Pooled self-preference: ${meanDelta >= 0 ? "+" : ""}${f2(meanDelta)} points** on a 0–10 scale (mean over 6 judges; range ${f2(Math.min(...deltas))} to ${f2(Math.max(...deltas))}).`);
  out.push(``);

  // ── RQ2g: per-dimension automatability ──
  out.push(`## Table 10 — RQ2g: Per-dimension human–judge agreement (panel, self-excluded)`);
  out.push(``);
  out.push(`| Dimension | Panel agreement | κ | n |`);
  out.push(`|---|---|---|---|`);
  for (const d of DIMENSIONS) {
    const pr: Array<[string, string]> = [];
    for (const s of clean) {
      if (s.dimWinner[d] === "TIE") continue;
      const vs = s.judged.filter((v) => !v.selfJudging && v.dim[d] !== "TIE");
      if (vs.length === 0) continue;
      const a = vs.filter((v) => v.dim[d] === "A").length;
      const b = vs.filter((v) => v.dim[d] === "B").length;
      if (a === b) continue;
      pr.push([a > b ? "A" : "B", s.dimWinner[d]!]);
    }
    const ag = pr.filter(([x, y]) => x === y).length / pr.length;
    out.push(`| ${d} | ${pct(ag)} | ${f3(cohensKappa(pr))} | ${pr.length} |`);
  }
  out.push(``);

  // ── Power sweep ──
  if (powerMode) {
    out.push(`## Table 11 — Power: rank recovery vs sample size`);
    out.push(``);
    out.push(`| Comparisons | Spearman ρ (recovered vs planted) | Adjacent pairs separated |`);
    out.push(`|---|---|---|`);
    for (const n of [60, 120, 240, 480, 960]) {
      rng = mulberry32(4242);
      const reps = 20;
      let rhoSum = 0, sepSum = 0;
      for (let r = 0; r < reps; r++) {
        const s = simulateStudy(Math.round(n / 6), 2).slice(0, n);
        const bb: ClusteredBattle[] = s.map((x) => ({ a: x.a, b: x.b, outcome: toOutcome(x.winner), cluster: x.participant }));
        const fit = computeBT(bb, { baselineSlug: "claude-sonnet-5" });
        const ord = [...fit.ratings.entries()].sort((a, b) => b[1] - a[1]);
        if (ord.length < 6) continue;
        rhoSum += spearman(ord.map(([q]) => fit.ratings.get(q)!), ord.map(([q]) => TRUE_BT[q]!));
        const ci = bootstrapBTByCluster(bb, 300, { baselineSlug: "claude-sonnet-5" });
        let sep = 0;
        for (let i = 0; i < ord.length - 1; i++) {
          const c1 = ci.get(ord[i]![0]), c2 = ci.get(ord[i + 1]![0]);
          if (c1 && c2 && c1.ciLow > c2.ciHigh) sep++;
        }
        sepSum += sep;
      }
      out.push(`| ${n} | ${f3(rhoSum / reps)} | ${f1(sepSum / reps)} of 5 |`);
    }
    out.push(``);
  }

  console.log(out.join("\n"));
}

main();
