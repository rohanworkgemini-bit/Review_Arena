import type { JudgePreference } from "../clients/judge-client.js";

// Pure helpers for the judge panel — no DB, no network — so the fan-out
// bookkeeping and the read-side aggregation are unit-testable on their own.
//
// The panel is the six study systems (study/rotation.ts STUDY_SLUGS): every
// study pair is judged by every member, including the two systems that
// wrote the pair's reviews. Self-judgements are kept and flagged rather than
// skipped, so self-enhancement bias (Zheng et al. 2023) is a measured
// quantity in the thesis analysis instead of an unmeasured threat.

export interface PanelMember {
  /** review_systems.slug — what judge_model columns store. */
  slug: string;
  systemId: string;
  /** Backing model id sent to the Python judge (review_systems.config.model). */
  model: string;
}

/** Members judged in parallel per pair; one in-flight call per member. */
export const PANEL_CONCURRENCY = 6;

export type PanelStatus = "COMPLETE" | "PARTIAL" | "FAILED";

/** COMPLETE if every expected member returned, PARTIAL if some, FAILED if none. */
export function panelStatus(returned: number, expected: number): PanelStatus {
  if (expected > 0 && returned >= expected) return "COMPLETE";
  if (returned > 0) return "PARTIAL";
  return "FAILED";
}

/**
 * Promise.allSettled over `items` with at most `limit` calls in flight.
 * Results are positional, like allSettled.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Read-side aggregation ─────────────────────────────────────────────────

export interface VerdictRow {
  judgeModel: string;
  overallPreference: JudgePreference;
  dimensionPreferences: Record<string, JudgePreference>;
  /** The row's A/B are reversed relative to the sides the caller cares about. */
  swapped: boolean;
  passesUsed: number;
}

export interface PreferenceCounts {
  A: number;
  B: number;
  TIE: number;
}

export interface AggregatedVerdict {
  overall: JudgePreference;
  dimensions: Record<string, JudgePreference>;
  counts: PreferenceCounts;
  dimensionCounts: Record<string, PreferenceCounts>;
}

/** Map a stored preference onto the caller's sides. */
export function remapPreference(p: JudgePreference, swapped: boolean): JudgePreference {
  if (p === "TIE" || !swapped) return p;
  return p === "A" ? "B" : "A";
}

/** Side with more judge votes; TIE votes count for neither; equal = TIE. */
export function majority(counts: PreferenceCounts): JudgePreference {
  if (counts.A > counts.B) return "A";
  if (counts.B > counts.A) return "B";
  return "TIE";
}

function emptyCounts(): PreferenceCounts {
  return { A: 0, B: 0, TIE: 0 };
}

/** Panel majority overall and per dimension, after remapping swapped rows. */
export function aggregateVerdicts(rows: readonly VerdictRow[]): AggregatedVerdict {
  const counts = emptyCounts();
  const dimensionCounts: Record<string, PreferenceCounts> = {};
  for (const row of rows) {
    counts[remapPreference(row.overallPreference, row.swapped)]++;
    for (const [dim, p] of Object.entries(row.dimensionPreferences)) {
      const c = (dimensionCounts[dim] ??= emptyCounts());
      c[remapPreference(p, row.swapped)]++;
    }
  }
  const dimensions = Object.fromEntries(
    Object.entries(dimensionCounts).map(([dim, c]) => [dim, majority(c)]),
  );
  return { overall: majority(counts), dimensions, counts, dimensionCounts };
}

export interface ScoreRow {
  value: number;
  dimensionScores: Record<string, number> | null;
}

/** Mean overall and per-dimension score across judges; null when empty. */
export function meanScores(rows: readonly ScoreRow[]): {
  overall: number | null;
  dimensions: Record<string, number> | null;
} {
  if (rows.length === 0) return { overall: null, dimensions: null };
  const overall = rows.reduce((s, r) => s + r.value, 0) / rows.length;
  const sums = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    for (const [dim, v] of Object.entries(r.dimensionScores ?? {})) {
      if (typeof v !== "number") continue;
      const acc = sums.get(dim) ?? { n: 0, sum: 0 };
      acc.n++;
      acc.sum += v;
      sums.set(dim, acc);
    }
  }
  const dimensions =
    sums.size === 0
      ? null
      : Object.fromEntries([...sums].map(([dim, { n, sum }]) => [dim, sum / n]));
  return { overall, dimensions };
}
