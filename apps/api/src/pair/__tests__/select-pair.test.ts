import { describe, it, expect } from "vitest";
import { selectPairUniform, pairKey, type SystemForPairing } from "../select-pair.js";

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const sys = (id: string, overrides: Partial<SystemForPairing> = {}): SystemForPairing => ({
  systemId: id,
  reviewId: `rev-${id}`,
  slug: id,
  sampleWeight: 1.0,
  outage: false,
  anon: false,
  ...overrides,
});

/** Empirical frequency of each unordered pair over N draws. */
function pairFrequencies(
  draw: (rng: () => number) => { reviewA: SystemForPairing; reviewB: SystemForPairing } | null,
  n: number,
  seed = 7,
): Map<string, number> {
  const rng = seededRng(seed);
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const p = draw(rng);
    if (!p) continue;
    const k = pairKey(p.reviewA.systemId, p.reviewB.systemId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return new Map([...counts].map(([k, c]) => [k, c / n]));
}

describe("selectPairUniform", () => {
  it("returns null with fewer than 2 candidates", () => {
    expect(selectPairUniform([])).toBeNull();
    expect(selectPairUniform([sys("a")])).toBeNull();
  });

  it("returns the only available pair when there are exactly two systems", () => {
    const p = selectPairUniform([sys("a"), sys("b")], { rng: seededRng(1) });
    expect(p).not.toBeNull();
    expect(new Set([p!.reviewA.systemId, p!.reviewB.systemId])).toEqual(new Set(["a", "b"]));
  });

  // The defining property: every eligible matchup is equally likely. This is
  // what lets the study treat its comparison counts as a fixed design rather
  // than as an outcome of the sampler.
  it("draws every eligible pair equally often", () => {
    const four = [sys("a"), sys("b"), sys("c"), sys("d")];
    const freq = pairFrequencies((rng) => selectPairUniform(four, { rng }), 6000);
    expect(freq.size).toBe(6);
    for (const f of freq.values()) expect(f).toBeGreaterThan(1 / 6 - 0.03);
    for (const f of freq.values()) expect(f).toBeLessThan(1 / 6 + 0.03);
  });

  it("stays uniform over six systems — the study's fifteen matchups", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((s) => sys(s));
    const freq = pairFrequencies((rng) => selectPairUniform(six, { rng }), 15000);
    expect(freq.size).toBe(15);
    for (const f of freq.values()) expect(f).toBeGreaterThan(1 / 15 - 0.02);
    for (const f of freq.values()) expect(f).toBeLessThan(1 / 15 + 0.02);
  });

  it("keeps the eligibility rules: outage and sampleWeight=0 exclude a system", () => {
    const out = [sys("a", { outage: true }), sys("b"), sys("c")];
    const freq = pairFrequencies((rng) => selectPairUniform(out, { rng }), 500);
    expect([...freq.keys()]).toEqual([pairKey("b", "c")]);

    const off = [sys("a", { sampleWeight: 0 }), sys("b"), sys("c")];
    const freq2 = pairFrequencies((rng) => selectPairUniform(off, { rng }), 500);
    expect([...freq2.keys()]).toEqual([pairKey("b", "c")]);
  });

  it("treats sampleWeight as an off switch, not a weight", () => {
    // A positive weight is a positive weight: 5 does not beat 1, because a
    // uniform draw has nothing to scale.
    const weighted = [sys("a", { sampleWeight: 5 }), sys("b"), sys("c"), sys("d")];
    const freq = pairFrequencies((rng) => selectPairUniform(weighted, { rng }), 6000);
    expect(freq.size).toBe(6);
    for (const f of freq.values()) expect(f).toBeGreaterThan(1 / 6 - 0.03);
    for (const f of freq.values()) expect(f).toBeLessThan(1 / 6 + 0.03);
  });

  it("returns null when nothing is eligible", () => {
    expect(
      selectPairUniform([sys("a", { outage: true }), sys("b", { outage: true })]),
    ).toBeNull();
  });

  it("forbids anon-vs-anon pairs", () => {
    const anon = [sys("a", { anon: true }), sys("b", { anon: true }), sys("c")];
    const freq = pairFrequencies((rng) => selectPairUniform(anon, { rng }), 600);
    expect(freq.has(pairKey("a", "b"))).toBe(false);
    expect(freq.has(pairKey("a", "c"))).toBe(true);
    expect(freq.has(pairKey("b", "c"))).toBe(true);
  });

  it("prefers unseen pairs, then falls back to all eligible pairs", () => {
    const three = [sys("a"), sys("b"), sys("c")];
    const seenTwo = new Set([pairKey("a", "b"), pairKey("a", "c")]);
    const freq = pairFrequencies(
      (rng) => selectPairUniform(three, { rng, alreadySeenPairs: seenTwo }),
      300,
    );
    expect([...freq.keys()]).toEqual([pairKey("b", "c")]);

    const seenAll = new Set([pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")]);
    const freq2 = pairFrequencies(
      (rng) => selectPairUniform(three, { rng, alreadySeenPairs: seenAll }),
      3000,
    );
    expect(freq2.size).toBe(3);
    for (const f of freq2.values()) expect(f).toBeGreaterThan(1 / 3 - 0.04);
  });

  it("randomises A/B ordering (~50/50)", () => {
    const rng = seededRng(3);
    let aFirst = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const p = selectPairUniform([sys("a"), sys("b")], { rng })!;
      if (p.reviewA.systemId === "a") aFirst++;
    }
    expect(aFirst / n).toBeGreaterThan(0.45);
    expect(aFirst / n).toBeLessThan(0.55);
  });
});
