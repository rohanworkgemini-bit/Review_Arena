/**
 * Bradley-Terry (maximum-likelihood) ratings + bootstrapped 95% CI.
 *
 * BT is the only rating method here: it refits from scratch on every
 * snapshot, so unlike online Elo the result does not depend on vote order.
 *
 *   1. Optimiser. The weighted logistic likelihood is maximised with the MM
 *      (Zermelo 1929 / Hunter 2004) fixed-point update: monotone,
 *      derivative-free, and converging to the MLE.
 *
 *   2. Connectivity guard. The BT likelihood has a finite maximiser iff the
 *      win-graph is strongly connected (Ford 1957) — an unbeaten or winless
 *      system sends its rating to +/- infinity. We fit over the largest
 *      strongly-connected component and return everything else as
 *      `unranked`, rather than reporting an iteration cap as if it were a
 *      rating. No prior or ridge is added.
 *
 * The leaderboard row (leaderboardBT): the rating is the single fit on all
 * battles (computeBT) and only the interval comes from the bootstrap
 * quantiles.
 *
 * Scale: theta is in log-BASE units, so rating = theta * 400 + 1000 gives the
 * usual "400 points = 10x the odds" reading, identical to Elo's scale.
 */

import { logger } from "../logger.js";

export type Outcome = 0 | 0.5 | 1;

export interface Battle {
  /** stable identifier for system A — typically the slug */
  a: string;
  /** stable identifier for system B */
  b: string;
  /** 1 = A won, 0 = B won, 0.5 = tie */
  outcome: Outcome;
}

/** A recorded verdict, as stored on `votes.winner` and `dimension_votes.winner`. */
export type Winner = "A" | "B" | "TIE";

/**
 * The single mapping from a recorded verdict to a Bradley-Terry outcome.
 *
 * Every board goes through here — the overall one and all eight
 * per-dimension ones — so the nine comparison logs cannot disagree about
 * what a verdict means. That was a live hazard while the dimensions used a
 * signed integer: the snapshot path branched on the sign and the thesis
 * analysis branched on equality, which agreed on the three intended values
 * and diverged on anything else, and nothing at the database level ruled
 * anything else out.
 */
export function outcomeOf(winner: Winner): Outcome {
  return winner === "A" ? 1 : winner === "B" ? 0 : 0.5;
}

/** One leaderboard row: point rating plus its 95% bootstrap interval. */
export interface BootstrapInterval {
  rating: number;       // leaderboardBT: full-data fit; intervalsFrom: bootstrap median
  ciLow: number;        // 2.5th percentile
  ciHigh: number;       // 97.5th percentile
  voteCount: number;    // battles involving this system in the original set
}

/**
 * Linear-interpolated percentile, matching numpy's default
 * (np.percentile with interpolation="linear").
 */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) throw new Error("percentile of empty array");
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = pos - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export interface BTConstants {
  BASE: number;
  SCALE: number;
  INIT_RATING: number;
}

export const DEFAULT_BT: BTConstants = {
  BASE: 10,
  SCALE: 400,
  INIT_RATING: 1000,
};

/** Max MM sweeps before we give up and log. Converged data needs ~50. */
export const BT_MAX_ITER = 1000;
/** Convergence threshold on max |log(pi_next / pi)| across systems. */
export const BT_TOL = 1e-10;

/** Which rule fixed the (otherwise free) location of the rating scale. */
export type BTAnchor = "BASELINE" | "MEAN";

export interface BTOptions {
  c?: BTConstants;
  /**
   * Slug pinned to INIT_RATING. We pin a
   * configured baseline to 1000 so snapshots stay comparable as systems are
   * added and retired. Absent from the fitted set (or null) => mean-centre.
   */
  baselineSlug?: string | null;
  maxIter?: number;
  tol?: number;
}

export interface BTResult {
  /** slug -> rating, ranked systems only. */
  ratings: Map<string, number>;
  /** Systems outside the largest strongly-connected component, sorted. */
  unranked: string[];
  anchor: BTAnchor;
  converged: boolean;
}

/** One aggregated cell of the design: a distinct (a, b, outcome) triple. */
export interface BTRow {
  a: number;
  b: number;
  /** 1 = a won, 0.5 = tie, 0 = b won. */
  outcome: number;
  /** How many battles collapsed into this row. */
  weight: number;
}

export interface BTDesign {
  models: string[];
  rows: BTRow[];
}

/**
 * Collapse the battle log into unique
 * (matchup, outcome) triples with occurrence counts as weights. The fit only
 * ever sees at most n*(n-1)*3 rows, so cost stops growing with vote count.
 */
export function preprocessForBT(battles: readonly Battle[]): BTDesign {
  const ids = new Map<string, number>();
  const models: string[] = [];
  const id = (slug: string): number => {
    let i = ids.get(slug);
    if (i === undefined) {
      i = models.length;
      ids.set(slug, i);
      models.push(slug);
    }
    return i;
  };

  const cells = new Map<string, BTRow>();
  for (const { a, b, outcome } of battles) {
    const ia = id(a);
    const ib = id(b);
    // outcome is already 1 / 0.5 / 0.
    const key = `${ia}|${ib}|${outcome}`;
    const cell = cells.get(key);
    if (cell) cell.weight += 1;
    else cells.set(key, { a: ia, b: ib, outcome, weight: 1 });
  }

  return { models, rows: [...cells.values()] };
}

/**
 * Largest strongly-connected component of the win-graph (edge a -> b when a
 * took points off b; a tie contributes both directions). Ford's condition:
 * the BT MLE is finite and unique exactly on such a component.
 *
 * Transitive closure rather than Tarjan — n is the number of review systems
 * (~10), so n^3 is nothing and there is no recursion to blow a stack in the
 * bootstrap's inner loop.
 */
export function largestStronglyConnected(rows: readonly BTRow[], n: number): number[] {
  const reach = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) reach[i * n + i] = 1;
  for (const r of rows) {
    if (r.weight <= 0) continue;
    if (r.outcome > 0) reach[r.a * n + r.b] = 1;
    if (r.outcome < 1) reach[r.b * n + r.a] = 1;
  }

  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!reach[i * n + k]) continue;
      for (let j = 0; j < n; j++) {
        if (reach[k * n + j]) reach[i * n + j] = 1;
      }
    }
  }

  let best: number[] = [];
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const comp: number[] = [];
    for (let j = 0; j < n; j++) {
      if (reach[i * n + j] && reach[j * n + i]) {
        comp.push(j);
        seen[j] = 1;
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

/**
 * MM fixed point for the weighted Bradley-Terry likelihood, in pi = e^(alpha*theta)
 * space:
 *
 *   pi_i <- W_i / sum_{rows containing i} w / (pi_a + pi_b)
 *
 * where W_i is i's total (fractional) win credit — a tie hands half to each
 * side, as outcome=0.5 does inside the log-loss. Each
 * sweep renormalises to geometric mean 1: the likelihood is scale-invariant
 * in pi, so this pins the free parameter without touching the fit and keeps
 * the iterates away from overflow.
 *
 * Callers must pass a strongly-connected row set (see largestStronglyConnected),
 * which guarantees W_i > 0 and a finite fixed point.
 */
export function fitBT(
  rows: readonly BTRow[],
  n: number,
  maxIter: number = BT_MAX_ITER,
  tol: number = BT_TOL,
): { pi: Float64Array; converged: boolean; iterations: number } {
  const W = new Float64Array(n);
  for (const r of rows) {
    W[r.a]! += r.weight * r.outcome;
    W[r.b]! += r.weight * (1 - r.outcome);
  }

  const pi = new Float64Array(n).fill(1);
  const next = new Float64Array(n);
  const denom = new Float64Array(n);
  let converged = false;
  let iterations = 0;

  for (let iter = 1; iter <= maxIter; iter++) {
    iterations = iter;
    denom.fill(0);
    for (const r of rows) {
      const inv = r.weight / (pi[r.a]! + pi[r.b]!);
      denom[r.a]! += inv;
      denom[r.b]! += inv;
    }

    let logSum = 0;
    for (let i = 0; i < n; i++) {
      next[i] = W[i]! / denom[i]!;
      logSum += Math.log(next[i]!);
    }
    const gm = Math.exp(logSum / n);

    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i]! /= gm;
      delta = Math.max(delta, Math.abs(Math.log(next[i]! / pi[i]!)));
    }
    pi.set(next);
    if (delta < tol) {
      converged = true;
      break;
    }
  }

  return { pi, converged, iterations };
}

/**
 * Restrict the design to one component and renumber it to a dense 0..k-1
 * index space. Fitting over the full model list instead would hand fitBT
 * systems that appear in no row: their win credit and their denominator are
 * both zero, and the resulting 0/0 poisons the geometric-mean normalisation,
 * turning the entire sweep into NaN (and so "never converged").
 */
function componentRows(
  rows: readonly BTRow[],
  members: readonly number[],
  nModels: number,
): BTRow[] {
  const local = new Int32Array(nModels).fill(-1);
  for (let l = 0; l < members.length; l++) local[members[l]!] = l;
  const out: BTRow[] = [];
  for (const r of rows) {
    const a = local[r.a]!;
    const b = local[r.b]!;
    if (a >= 0 && b >= 0) out.push({ a, b, outcome: r.outcome, weight: r.weight });
  }
  return out;
}

/**
 * Natural scale -> Elo-like points, then shift so the baseline sits at
 * INIT_RATING. fitBT returns geometric-mean-1 pi, so the unanchored ratings
 * are already mean-centred on INIT_RATING.
 */
function scaleAndOffset(
  pi: Float64Array,
  members: readonly number[],
  models: readonly string[],
  c: BTConstants,
  baselineSlug: string | null,
): { ratings: Map<string, number>; anchor: BTAnchor } {
  const logBase = Math.log(c.BASE);
  const ratings = new Map<string, number>();
  // pi is indexed by component-local position; members maps that back to the
  // global model index.
  for (let local = 0; local < members.length; local++) {
    const theta = Math.log(pi[local]!) / logBase;
    ratings.set(models[members[local]!]!, theta * c.SCALE + c.INIT_RATING);
  }

  const baseline = baselineSlug ? ratings.get(baselineSlug) : undefined;
  if (baseline === undefined) return { ratings, anchor: "MEAN" };

  const shift = c.INIT_RATING - baseline;
  for (const [slug, r] of ratings) ratings.set(slug, r + shift);
  return { ratings, anchor: "BASELINE" };
}

/** Full-data BT fit, with the connectivity guard. */
export function computeBT(battles: readonly Battle[], opts: BTOptions = {}): BTResult {
  const c = opts.c ?? DEFAULT_BT;
  const baselineSlug = opts.baselineSlug ?? null;
  const start = Date.now();

  const { models, rows } = preprocessForBT(battles);
  if (models.length < 2) {
    return { ratings: new Map(), unranked: [...models].sort(), anchor: "MEAN", converged: true };
  }

  const members = largestStronglyConnected(rows, models.length);
  // A component of one is a system compared only with itself's-worth of
  // information — no pairwise information to rate it against, so nothing is
  // ranked at all.
  if (members.length < 2) {
    return { ratings: new Map(), unranked: [...models].sort(), anchor: "MEAN", converged: true };
  }

  const fitRows = componentRows(rows, members, models.length);
  const { pi, converged, iterations } = fitBT(
    fitRows,
    members.length,
    opts.maxIter ?? BT_MAX_ITER,
    opts.tol ?? BT_TOL,
  );
  const { ratings, anchor } = scaleAndOffset(pi, members, models, c, baselineSlug);
  const unranked = models.filter((slug) => !ratings.has(slug)).sort();

  if (!converged) {
    logger.warn(
      { systemCount: members.length, rowCount: fitRows.length, iterations },
      "bt_fit_did_not_converge",
    );
  }
  logger.debug(
    {
      systemCount: members.length,
      unrankedCount: unranked.length,
      battleCount: battles.length,
      rowCount: fitRows.length,
      iterations,
      anchor,
      elapsedMs: Date.now() - start,
    },
    "bt_computation_complete",
  );

  return { ratings, unranked, anchor, converged };
}

/**
 * Bootstrap BT. The battles themselves never change across
 * rounds — only how often each aggregated row is drawn — so a resample is one
 * multinomial over the row weights rather than a fresh pass over every battle.
 * That is what keeps the bootstrap flat in vote count.
 *
 * Rounds where a system falls outside the resample's connected component
 * contribute no sample for that system, rather than whatever value an
 * unbounded fit stopped at. Percentiles are taken over
 * the samples a system actually has; a system with none stays unranked.
 *
 * Anchoring. Every round uses the same origin as the full-data fit
 * (computeBT), so the percentiles are taken over draws on one scale:
 *
 *   - Full fit baseline-anchored (the baseline is in the full-data
 *     component): each round is shifted so the baseline sits at INIT_RATING.
 *     A round whose resample leaves the baseline outside its component has
 *     no way to express its draws on that scale, so the whole round is
 *     dropped from every system's percentiles. This is the standard
 *     treatment for replicates in which the statistic is undefined; the
 *     alternative — mean-centring those rounds — mixes two origins in one
 *     interval, which is what this used to do. The dropped count is logged.
 *   - Full fit mean-centred (no baseline, or baseline outside the full-data
 *     component): every round is mean-centred too, even one where the
 *     baseline happens to land in the resample's component.
 */
export function bootstrapBTCI(
  battles: readonly Battle[],
  rounds: number = 100,
  opts: BTOptions = {},
  rng: () => number = mulberry32(0),
): Map<string, BootstrapInterval> {
  if (battles.length === 0) return new Map();

  const c = opts.c ?? DEFAULT_BT;
  const { models, rows } = preprocessForBT(battles);
  if (models.length < 2) return new Map();

  // Mirror computeBT's anchoring decision on the full data.
  const requestedBaseline = opts.baselineSlug || null;
  const fullMembers = largestStronglyConnected(rows, models.length);
  const baselineIdx = requestedBaseline === null ? -1 : models.indexOf(requestedBaseline);
  const baselineAnchored =
    fullMembers.length >= 2 && baselineIdx >= 0 && fullMembers.includes(baselineIdx);
  const roundBaseline = baselineAnchored ? requestedBaseline : null;

  const voteCount = new Map<string, number>();
  for (const { a, b } of battles) {
    voteCount.set(a, (voteCount.get(a) ?? 0) + 1);
    voteCount.set(b, (voteCount.get(b) ?? 0) + 1);
  }

  const total = rows.reduce((s, r) => s + r.weight, 0);
  const probs = rows.map((r) => r.weight / total);
  const samples = new Map<string, number[]>();
  for (const m of models) samples.set(m, []);

  let usedRounds = 0;
  let droppedNoAnchor = 0;
  for (let round = 0; round < rounds; round++) {
    const counts = multinomialCounts(battles.length, probs, rng);
    const resampled: BTRow[] = [];
    for (let k = 0; k < rows.length; k++) {
      const w = counts[k]!;
      if (w > 0) resampled.push({ ...rows[k]!, weight: w });
    }

    const members = largestStronglyConnected(resampled, models.length);
    if (members.length < 2) continue;
    if (baselineAnchored && !members.includes(baselineIdx)) {
      droppedNoAnchor++;
      continue;
    }
    const fitRows = componentRows(resampled, members, models.length);
    const { pi } = fitBT(fitRows, members.length, opts.maxIter ?? BT_MAX_ITER, opts.tol ?? BT_TOL);
    const { ratings } = scaleAndOffset(pi, members, models, c, roundBaseline);
    for (const [slug, rating] of ratings) samples.get(slug)!.push(rating);
    usedRounds++;
  }

  logger.debug(
    {
      requestedRounds: rounds,
      usedRounds,
      droppedNoAnchor,
      anchor: baselineAnchored ? "BASELINE" : "MEAN",
    },
    "bt_bootstrap_complete",
  );

  return intervalsFrom(samples, voteCount);
}

/**
 * Leaderboard rows: rating = computeBT on the full
 * battle log, interval = 2.5/97.5 percentiles of bootstrapBTCI. Only systems
 * the full fit can place are returned; the rating is not guaranteed to lie
 * inside its interval.
 */
export function leaderboardBT(
  battles: readonly Battle[],
  rounds: number = 100,
  opts: BTOptions = {},
  rng: () => number = mulberry32(0),
): { rows: Map<string, BootstrapInterval>; anchor: BTAnchor } {
  const fit = computeBT(battles, opts);
  const ci = bootstrapBTCI(battles, rounds, opts, rng);
  const voteCount = new Map<string, number>();
  for (const { a, b } of battles) {
    voteCount.set(a, (voteCount.get(a) ?? 0) + 1);
    voteCount.set(b, (voteCount.get(b) ?? 0) + 1);
  }
  const rows = new Map<string, BootstrapInterval>();
  for (const [slug, rating] of fit.ratings) {
    const iv = ci.get(slug);
    rows.set(slug, {
      rating,
      ciLow: iv?.ciLow ?? rating,
      ciHigh: iv?.ciHigh ?? rating,
      voteCount: voteCount.get(slug) ?? 0,
    });
  }
  return { rows, anchor: fit.anchor };
}

/** Median + 2.5/97.5 percentile bounds per system, over whatever replicates
 *  that system appeared in. Systems with no replicate stay off the board. */
function intervalsFrom(
  samples: Map<string, number[]>,
  voteCount: Map<string, number>,
): Map<string, BootstrapInterval> {
  const out = new Map<string, BootstrapInterval>();
  for (const [slug, arr] of samples) {
    if (arr.length === 0) continue;
    const sorted = [...arr].sort((x, y) => x - y);
    out.set(slug, {
      rating: percentile(sorted, 0.5),
      ciLow: percentile(sorted, 0.025),
      ciHigh: percentile(sorted, 0.975),
      voteCount: voteCount.get(slug) ?? 0,
    });
  }
  return out;
}

/**
 * Multinomial(n, probs) counts by the conditional-binomial chain. Equivalent
 * to numpy's rng.multinomial.
 */
export function multinomialCounts(
  n: number,
  probs: readonly number[],
  rng: () => number,
): number[] {
  const counts = new Array<number>(probs.length).fill(0);
  let left = n;
  let pLeft = 1;
  for (let k = 0; k < probs.length - 1; k++) {
    if (left <= 0) break;
    const p = pLeft > 0 ? Math.min(1, probs[k]! / pLeft) : 0;
    const drawn = binomialSample(left, p, rng);
    counts[k] = drawn;
    left -= drawn;
    pLeft -= probs[k]!;
  }
  if (left > 0) counts[probs.length - 1]! += left;
  return counts;
}

/**
 * Exact Binomial(n, p) by summing geometric gaps between successes. Chosen
 * over a pmf recursion because (1-p)^n underflows to zero for the large n we
 * hit once the vote log grows; mirrored at p > 0.5 so the loop runs
 * min(np, n(1-p)) times.
 */
function binomialSample(n: number, p: number, rng: () => number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const mirrored = p > 0.5;
  const q = mirrored ? 1 - p : p;
  const logQ = Math.log1p(-q);

  let successes = 0;
  let idx = -1;
  for (;;) {
    const u = rng();
    // floor(log U / log(1-q)) is Geometric(q) on {0, 1, ...}: failures before
    // the next success.
    idx += 1 + Math.floor(Math.log(u > 0 ? u : Number.MIN_VALUE) / logQ);
    if (idx >= n) break;
    successes++;
  }
  return mirrored ? n - successes : successes;
}

/** mulberry32 — small seeded PRNG so bootstrap CIs are reproducible run to
 * run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
