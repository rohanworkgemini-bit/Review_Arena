import { describe, expect, it } from "vitest";
import {
  aggregateVerdicts,
  majority,
  mapWithConcurrency,
  meanScores,
  panelStatus,
  remapPreference,
  type VerdictRow,
} from "../judge-panel.js";

describe("panelStatus", () => {
  it("is COMPLETE only when every expected member returned", () => {
    expect(panelStatus(6, 6)).toBe("COMPLETE");
    expect(panelStatus(3, 6)).toBe("PARTIAL");
    expect(panelStatus(1, 6)).toBe("PARTIAL");
    expect(panelStatus(0, 6)).toBe("FAILED");
  });

  it("treats an empty panel as FAILED rather than trivially complete", () => {
    expect(panelStatus(0, 0)).toBe("FAILED");
  });
});

describe("mapWithConcurrency", () => {
  it("isolates one rejection and keeps positional results", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 6, async (n) => {
      if (n === 4) throw new Error("boom");
      return n * 10;
    });
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled",
    ]);
    expect(results[1]).toEqual({ status: "fulfilled", value: 20 });
    expect((results[3] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it("never exceeds the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("handles an empty input", async () => {
    expect(await mapWithConcurrency([], 6, async () => 1)).toEqual([]);
  });
});

describe("remapPreference / majority", () => {
  it("flips A/B only when swapped, never TIE", () => {
    expect(remapPreference("A", false)).toBe("A");
    expect(remapPreference("A", true)).toBe("B");
    expect(remapPreference("B", true)).toBe("A");
    expect(remapPreference("TIE", true)).toBe("TIE");
  });

  it("ignores TIE votes and calls an even split a TIE", () => {
    expect(majority({ A: 3, B: 2, TIE: 1 })).toBe("A");
    expect(majority({ A: 1, B: 4, TIE: 1 })).toBe("B");
    expect(majority({ A: 2, B: 2, TIE: 2 })).toBe("TIE");
    expect(majority({ A: 0, B: 0, TIE: 6 })).toBe("TIE");
  });
});

describe("aggregateVerdicts", () => {
  const row = (
    judgeModel: string,
    overall: VerdictRow["overallPreference"],
    dims: Record<string, VerdictRow["overallPreference"]>,
    swapped = false,
  ): VerdictRow => ({
    judgeModel,
    overallPreference: overall,
    dimensionPreferences: dims,
    swapped,
    passesUsed: 2,
  });

  it("takes the majority overall and per dimension", () => {
    const agg = aggregateVerdicts([
      row("j1", "A", { CLARITY: "A", TONE: "B" }),
      row("j2", "A", { CLARITY: "B", TONE: "B" }),
      row("j3", "B", { CLARITY: "A", TONE: "TIE" }),
      row("j4", "TIE", { CLARITY: "TIE", TONE: "A" }),
    ]);
    expect(agg.overall).toBe("A");
    expect(agg.counts).toEqual({ A: 2, B: 1, TIE: 1 });
    expect(agg.dimensions).toEqual({ CLARITY: "A", TONE: "B" });
    expect(agg.dimensionCounts.TONE).toEqual({ A: 1, B: 2, TIE: 1 });
  });

  it("remaps swapped rows before counting", () => {
    // Stored as "A" relative to reversed sides → counts as B for the caller.
    const agg = aggregateVerdicts([
      row("j1", "A", { CLARITY: "A" }, true),
      row("j2", "A", { CLARITY: "A" }, true),
      row("j3", "A", { CLARITY: "B" }, false),
    ]);
    expect(agg.overall).toBe("B");
    expect(agg.counts).toEqual({ A: 1, B: 2, TIE: 0 });
    expect(agg.dimensions.CLARITY).toBe("B");
  });

  it("is TIE with no rows", () => {
    const agg = aggregateVerdicts([]);
    expect(agg.overall).toBe("TIE");
    expect(agg.dimensions).toEqual({});
  });
});

describe("meanScores", () => {
  it("averages overall and per-dimension scores across judges", () => {
    const m = meanScores([
      { value: 8, dimensionScores: { CLARITY: 9, TONE: 7 } },
      { value: 6, dimensionScores: { CLARITY: 5, TONE: 7 } },
    ]);
    expect(m.overall).toBe(7);
    expect(m.dimensions).toEqual({ CLARITY: 7, TONE: 7 });
  });

  it("tolerates a judge with no dimension block", () => {
    const m = meanScores([
      { value: 8, dimensionScores: { CLARITY: 9 } },
      { value: 6, dimensionScores: null },
    ]);
    expect(m.overall).toBe(7);
    expect(m.dimensions).toEqual({ CLARITY: 9 });
  });

  it("returns nulls on empty input", () => {
    expect(meanScores([])).toEqual({ overall: null, dimensions: null });
  });
});
