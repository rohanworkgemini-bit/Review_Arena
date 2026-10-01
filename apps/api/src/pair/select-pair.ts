/**
 * Pair selection for the comparison UI: uniform random over eligible pairs.
 *
 * One eligible unordered pair is drawn with equal probability, then a coin
 * flip assigns sides for blinding. Ratings are never consulted.
 *
 * Adaptive/active sampling is future work, not a switch: it belongs with a
 * larger system pool, and it would need the inverse-probability correction
 * in the estimator to go with it.
 *
 * Eligibility below keeps every rule that decides whether a matchup is
 * ALLOWED — outage, sampleWeight = 0 (the operator's off switch), and the
 * anon-vs-anon ban — and there are no rules that merely weight one allowed
 * matchup above another. The strict-target whitelist upstream carries was
 * dropped with the adaptive sampler: no system ever set one, and with six
 * fixed systems there is no matchup to restrict.
 */

export interface SystemForPairing {
  systemId: string;
  reviewId: string;
  /** stable identifier, carried through to the orchestrator. */
  slug: string;
  /** 0 disables the system; any positive value is equivalent to any other,
   *  since a uniform draw has no weights to scale. */
  sampleWeight: number;
  /** Excluded entirely. */
  outage: boolean;
  /** Anonymous-only — never paired with another anonymous system. */
  anon: boolean;
}

export interface SelectPairOptions {
  alreadySeenPairs?: ReadonlySet<string>;
  rng?: () => number;
}

export interface SelectedPair {
  reviewA: SystemForPairing;
  reviewB: SystemForPairing;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Draw one eligible unordered pair with equal probability, then coin-flip
 * sides.
 *
 * Seen pairs are handled as a preference rather than a weight so the draw
 * stays uniform: while any unseen eligible pair exists, the draw is uniform
 * over the unseen ones; once every eligible pair has been shown to this
 * session, it is uniform over all of them (so a session is never starved
 * the way a hard exclusion would).
 */
export function selectPairUniform(
  candidates: readonly SystemForPairing[],
  opts: SelectPairOptions = {},
): SelectedPair | null {
  if (candidates.length < 2) return null;
  const rng = opts.rng ?? Math.random;
  const seen = opts.alreadySeenPairs ?? new Set<string>();

  const eligible: Array<[SystemForPairing, SystemForPairing]> = [];
  for (let i = 0; i < candidates.length; i++) {
    const x = candidates[i]!;
    if (x.outage || x.sampleWeight <= 0) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const y = candidates[j]!;
      if (y.outage || y.sampleWeight <= 0) continue;
      if (x.systemId === y.systemId) continue;
      if (x.anon && y.anon) continue;
      eligible.push([x, y]);
    }
  }
  if (eligible.length === 0) return null;

  const unseen = eligible.filter(([x, y]) => !seen.has(pairKey(x.systemId, y.systemId)));
  const pool = unseen.length > 0 ? unseen : eligible;
  const [x, y] = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;

  return rng() < 0.5 ? { reviewA: x, reviewB: y } : { reviewA: y, reviewB: x };
}
