import { describe, expect, it } from "vitest";
import {
  NUM_PARTICIPANTS,
  PAPERS_PER_PARTICIPANT,
  ROTATIONS,
  STUDY_SLUGS,
  STUDY_SYSTEMS,
  pairsForRotation,
  rotationsForParticipant,
} from "../rotation.js";

// These tests prove the design's balance claims programmatically, so any
// accidental edit to the tables fails loudly instead of quietly skewing
// the study's comparison counts.

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

describe("study rotation design", () => {
  it("maps six distinct letters to six distinct slugs", () => {
    expect(Object.keys(STUDY_SYSTEMS).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(new Set(STUDY_SLUGS).size).toBe(6);
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

  it("participant schedule uses every rotation exactly 8 times over 40 papers", () => {
    const usage = new Map<number, number>();
    for (let p = 1; p <= NUM_PARTICIPANTS; p++) {
      const rotations = rotationsForParticipant(p);
      expect(rotations).toHaveLength(PAPERS_PER_PARTICIPANT);
      for (const r of rotations) usage.set(r, (usage.get(r) ?? 0) + 1);
    }
    expect([...usage.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    for (const count of usage.values()) expect(count).toBe(8);
  });

  it("the full study yields exactly 8 comparisons for each of the 15 slug pairs", () => {
    const counts = new Map<string, number>();
    for (let p = 1; p <= NUM_PARTICIPANTS; p++) {
      for (const rotationId of rotationsForParticipant(p)) {
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
    for (let p = 1; p <= NUM_PARTICIPANTS; p++) {
      const [r1, r2] = rotationsForParticipant(p);
      expect(r1).not.toBe(r2);
    }
  });
});
