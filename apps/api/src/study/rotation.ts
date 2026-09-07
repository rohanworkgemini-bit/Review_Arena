/**
 * The controlled study's deterministic pairing design.
 *
 * 20 participants × 2 papers × 3 disjoint pairs = 120 comparison events;
 * 15 unique pairs among 6 systems × 8 direct comparisons each = 120. The
 * five-round rotation is a 1-factorization of K6: within a rotation the
 * three pairs are disjoint (every system appears exactly once per paper),
 * and across R1–R5 every unique pair appears exactly once. 40 papers ÷ 5
 * rotations = each rotation used 8 times = each pair measured 8 times.
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
export const NUM_PARTICIPANTS = 20;

/**
 * Rotation ids (1-based) for one participant's papers. P01 → [R1, R2],
 * P02 → [R2, R3], … P05 → [R5, R1], then the cycle repeats each block of
 * five. Every rotation serves as paper-1 for 4 participants and paper-2
 * for 4 others → used exactly 8 times.
 */
export function rotationsForParticipant(participantIndex: number): number[] {
  if (participantIndex < 1 || participantIndex > NUM_PARTICIPANTS) {
    throw new Error(`participant index out of range: ${participantIndex}`);
  }
  const first = ((participantIndex - 1) % 5) + 1;
  const second = (first % 5) + 1;
  return [first, second];
}

/** The three (slugA, slugB) pairs for a rotation id (1-based). */
export function pairsForRotation(rotationId: number): Array<[string, string]> {
  const rotation = ROTATIONS[rotationId - 1];
  if (!rotation) throw new Error(`unknown rotation: ${rotationId}`);
  return rotation.map(([x, y]) => [STUDY_SYSTEMS[x]!, STUDY_SYSTEMS[y]!]);
}
