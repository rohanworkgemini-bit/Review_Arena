/**
 * The controlled study's pairing design.
 *
 * 2 papers per participant × 3 disjoint pairs = 6 comparison events each;
 * at 20 participants that is 120, and 15 unique pairs among 6 systems × 8
 * direct comparisons each = 120. The five-round rotation is a
 * 1-factorization of K6: within a rotation the three pairs are disjoint
 * (every system appears exactly once per paper), and across R1–R5 every
 * unique pair appears exactly once. 40 papers ÷ 5 rotations = each
 * rotation used 8 times = each pair measured 8 times.
 *
 * Which rotation a paper gets is NOT pre-assigned to a participant slot.
 * It is drawn at upload time by nextRotationId() — round-robin over the
 * whole study, always the least-used rotation so far. Participants are
 * therefore an open pool of anonymous codes rather than a fixed roster of
 * numbered slots, and the balance above still falls out exactly whenever
 * the paper count is a multiple of five. Past that it degrades gracefully:
 * with, say, 22 participants two rotations are used 9 times and three 8,
 * so pair coverage stays within one of even instead of drifting.
 *
 * The letter → slug mapping is FIXED and preregistered (alphabetical by
 * slug; re-lettered once, pre-study, in 2026-09 when deepseek-v4-flash
 * replaced kimi-k3). Do not change any of these constants once the study
 * has started — the balance properties above hold only for this exact
 * assignment. rotation.test.ts proves every property programmatically.
 *
 * The same six systems form the LLM judge panel (pipeline/judge-panel.ts):
 * every study pair is judged by all six, self-judgements flagged.
 */

export const STUDY_SYSTEMS: Record<string, string> = {
  A: "claude-sonnet-5",
  B: "deepseek-v4-flash",
  C: "gemini-3.8-flash",
  D: "glm-5.2",
  E: "gpt-5.6-terra",
  F: "mistral-medium-3.5",
};

export const STUDY_SLUGS: readonly string[] = Object.values(STUDY_SYSTEMS);

/** R1–R5, three disjoint letter pairs each (the user's design table). */
export const ROTATIONS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [["A", "F"], ["B", "E"], ["C", "D"]], // R1
  [["A", "E"], ["F", "D"], ["B", "C"]], // R2
  [["A", "D"], ["E", "C"], ["F", "B"]], // R3
  [["A", "C"], ["D", "B"], ["E", "F"]], // R4
  [["A", "B"], ["C", "F"], ["D", "E"]], // R5
];

export const PAPERS_PER_PARTICIPANT = 2;
export const PAIRS_PER_PAPER = 3;

/** Rotation ids, 1-based: [1, 2, 3, 4, 5]. */
export const ROTATION_IDS: readonly number[] = ROTATIONS.map((_, i) => i + 1);

/**
 * The rotation for the next study paper: whichever has been used least so
 * far, lowest id breaking ties. On a clean study that is plain round-robin
 * — R1, R2, R3, R4, R5, R1, … — so the five stay within one use of each
 * other at every point, not just at the end. A paper whose parse failed is
 * not counted by the caller, so a failed upload does not burn a slot.
 *
 * `alreadyUsed` is the rotations this participant's other papers hold.
 * Those are skipped so nobody judges the same three system pairs twice —
 * the old per-slot schedule guaranteed that too. If every rotation is
 * excluded (more papers per participant than rotations, which the current
 * design never reaches) the constraint is dropped rather than throwing.
 */
export function nextRotationId(
  usageByRotation: ReadonlyMap<number, number>,
  alreadyUsed: readonly number[] = [],
): number {
  const excluded = new Set(alreadyUsed);
  const candidates = ROTATION_IDS.filter((id) => !excluded.has(id));
  const pool = candidates.length > 0 ? candidates : ROTATION_IDS;
  // pool is ascending, so a strict < keeps the lowest id on a tie.
  let best = pool[0]!;
  let bestCount = usageByRotation.get(best) ?? 0;
  for (const id of pool.slice(1)) {
    const count = usageByRotation.get(id) ?? 0;
    if (count < bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/** The three (slugA, slugB) pairs for a rotation id (1-based). */
export function pairsForRotation(rotationId: number): Array<[string, string]> {
  const rotation = ROTATIONS[rotationId - 1];
  if (!rotation) throw new Error(`unknown rotation: ${rotationId}`);
  return rotation.map(([x, y]) => [STUDY_SYSTEMS[x]!, STUDY_SYSTEMS[y]!]);
}
