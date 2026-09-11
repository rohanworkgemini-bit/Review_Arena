import { describe, expect, it } from "vitest";
import {
  PAPERS_PER_PARTICIPANT,
  ROTATIONS,
  ROTATION_IDS,
  STUDY_SLUGS,
  STUDY_SYSTEMS,
  nextRotationId,
  pairsForRotation,
} from "../rotation.js";

// These tests prove the design's balance claims programmatically, so any
// accidental edit to the tables fails loudly instead of quietly skewing
// the study's comparison counts.

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Replays the study the way the upload route does: participants arrive one
 * at a time, each uploads PAPERS_PER_PARTICIPANT papers, and every paper
 * draws from the running usage counts. Returns the rotations each
 * participant ended up with.
 */
function simulateStudy(participantCount: number): number[][] {
  const usage = new Map<number, number>();
  const schedule: number[][] = [];
  for (let p = 0; p < participantCount; p++) {
    const mine: number[] = [];
    for (let i = 0; i < PAPERS_PER_PARTICIPANT; i++) {
      const id = nextRotationId(usage, mine);
      usage.set(id, (usage.get(id) ?? 0) + 1);
      mine.push(id);
    }
    schedule.push(mine);
  }
  return schedule;
}

describe("study rotation design", () => {
  it("maps six distinct letters to six distinct slugs", () => {
    expect(Object.keys(STUDY_SYSTEMS).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(new Set(STUDY_SLUGS).size).toBe(6);
  });

  it("letters A–F follow the preregistered alphabetical-by-slug order", () => {
    expect(Object.values(STUDY_SYSTEMS)).toEqual([...STUDY_SLUGS].sort());
  });

  it("is the 2026-09 lineup: deepseek-v4-flash in, kimi-k3 out", () => {
    expect(STUDY_SLUGS).toContain("deepseek-v4-flash");
    expect(STUDY_SLUGS).not.toContain("kimi-k3");
  });

  it("each rotation is a perfect matching: 3 disjoint pairs covering all 6", () => {
    for (const rotation of ROTATIONS) {
      const letters = rotation.flat();
      expect(letters).toHaveLength(6);
      expect(new Set(letters).size).toBe(6);
    }
  });

  it("across R1-R5 every unique pair appears exactly once (1-factorization of K6)", () => {
    const seen = new Map<string, number>();
    for (const rotation of ROTATIONS) {
      for (const [x, y] of rotation) {
        seen.set(key(x, y), (seen.get(key(x, y)) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(15);
    for (const count of seen.values()) expect(count).toBe(1);
  });

  it("round-robins R1-R5 on a clean study", () => {
    const usage = new Map<number, number>();
    const drawn: number[] = [];
    for (let i = 0; i < 12; i++) {
      const id = nextRotationId(usage);
      usage.set(id, (usage.get(id) ?? 0) + 1);
      drawn.push(id);
    }
    expect(drawn).toEqual([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2]);
  });

  it("always picks the least-used rotation, lowest id breaking ties", () => {
    expect(nextRotationId(new Map([[1, 3], [2, 1], [3, 1], [4, 2], [5, 3]]))).toBe(2);
    expect(nextRotationId(new Map([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]))).toBe(1);
    // The participant's own rotation is skipped even when it is least used.
    expect(nextRotationId(new Map([[1, 0], [2, 1], [3, 1], [4, 1], [5, 1]]), [1])).toBe(2);
  });

  it("falls back to the full pool if every rotation is excluded", () => {
    expect(ROTATION_IDS).toEqual([1, 2, 3, 4, 5]);
    const usage = new Map([[1, 2], [2, 2], [3, 0], [4, 2], [5, 2]]);
    expect(nextRotationId(usage, [...ROTATION_IDS])).toBe(3);
  });

  it("uses every rotation exactly 8 times over a 20-participant study", () => {
    const usage = new Map<number, number>();
    for (const mine of simulateStudy(20)) {
      expect(mine).toHaveLength(PAPERS_PER_PARTICIPANT);
      for (const r of mine) usage.set(r, (usage.get(r) ?? 0) + 1);
    }
    expect([...usage.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    for (const count of usage.values()) expect(count).toBe(8);
  });

  it("the full study yields exactly 8 comparisons for each of the 15 slug pairs", () => {
    const counts = new Map<string, number>();
    for (const mine of simulateStudy(20)) {
      for (const rotationId of mine) {
        for (const [slugA, slugB] of pairsForRotation(rotationId)) {
          counts.set(key(slugA, slugB), (counts.get(key(slugA, slugB)) ?? 0) + 1);
        }
      }
    }
    expect(counts.size).toBe(15);
    for (const count of counts.values()) expect(count).toBe(8);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(120);
  });

  it("a participant's two papers never repeat a rotation", () => {
    for (const [r1, r2] of simulateStudy(50)) expect(r1).not.toBe(r2);
  });

  it("degrades gracefully past 20: rotation use stays within one of even", () => {
    for (const participantCount of [1, 7, 13, 22, 31, 100]) {
      const usage = new Map<number, number>();
      for (const mine of simulateStudy(participantCount)) {
        for (const r of mine) usage.set(r, (usage.get(r) ?? 0) + 1);
      }
      const counts = ROTATION_IDS.map((id) => usage.get(id) ?? 0);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(
        participantCount * PAPERS_PER_PARTICIPANT,
      );
    }
  });
});
