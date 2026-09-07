import { describe, it, expect } from "vitest";
import { addHighlights, countsByDimension, type Highlight } from "./highlight";

const D1 = "CONTRIBUTION_ACCURACY" as const;
const D2 = "CRITIQUE_CLARITY" as const;

/** Compact view of a highlight set for readable assertions. */
const shape = (hs: readonly Highlight[]) =>
  hs.map((h) => `${h.block}:${h.start}-${h.end}:${h.dimension}`);

describe("addHighlights", () => {
  it("adds a span to an empty set", () => {
    const out = addHighlights([], [{ block: 0, start: 5, end: 10 }], D1);
    expect(shape(out)).toEqual(["0:5-10:CONTRIBUTION_ACCURACY"]);
  });

  it("leaves highlights in other blocks alone", () => {
    const a = addHighlights([], [{ block: 0, start: 0, end: 4 }], D1);
    const b = addHighlights(a, [{ block: 1, start: 0, end: 4 }], D2);
    expect(shape(b)).toEqual(["0:0-4:CONTRIBUTION_ACCURACY", "1:0-4:CRITIQUE_CLARITY"]);
  });

  it("re-tagging the exact same span replaces it rather than stacking", () => {
    const a = addHighlights([], [{ block: 0, start: 2, end: 8 }], D1);
    const b = addHighlights(a, [{ block: 0, start: 2, end: 8 }], D2);
    expect(shape(b)).toEqual(["0:2-8:CRITIQUE_CLARITY"]);
  });

  it("splits an existing span when the new one lands inside it", () => {
    const a = addHighlights([], [{ block: 0, start: 0, end: 20 }], D1);
    const b = addHighlights(a, [{ block: 0, start: 8, end: 12 }], D2);
    expect(shape(b)).toEqual([
      "0:0-8:CONTRIBUTION_ACCURACY",
      "0:8-12:CRITIQUE_CLARITY",
      "0:12-20:CONTRIBUTION_ACCURACY",
    ]);
  });

  it("trims an existing span the new one partially covers", () => {
    const a = addHighlights([], [{ block: 0, start: 0, end: 10 }], D1);
    const b = addHighlights(a, [{ block: 0, start: 6, end: 15 }], D2);
    expect(shape(b)).toEqual(["0:0-6:CONTRIBUTION_ACCURACY", "0:6-15:CRITIQUE_CLARITY"]);
  });

  it("drops an existing span the new one fully covers", () => {
    const a = addHighlights([], [{ block: 0, start: 4, end: 6 }], D1);
    const b = addHighlights(a, [{ block: 0, start: 0, end: 10 }], D2);
    expect(shape(b)).toEqual(["0:0-10:CRITIQUE_CLARITY"]);
  });

  it("adjacent spans do not disturb each other", () => {
    const a = addHighlights([], [{ block: 0, start: 0, end: 5 }], D1);
    const b = addHighlights(a, [{ block: 0, start: 5, end: 9 }], D2);
    expect(shape(b)).toEqual(["0:0-5:CONTRIBUTION_ACCURACY", "0:5-9:CRITIQUE_CLARITY"]);
  });

  it("tags every block of a multi-block drag under one dimension", () => {
    const out = addHighlights(
      [],
      [
        { block: 2, start: 3, end: 9 },
        { block: 3, start: 0, end: 4 },
      ],
      D1,
    );
    expect(shape(out)).toEqual([
      "2:3-9:CONTRIBUTION_ACCURACY",
      "3:0-4:CONTRIBUTION_ACCURACY",
    ]);
  });
});

describe("countsByDimension", () => {
  it("counts only dimensions that appear", () => {
    const hs = addHighlights(
      addHighlights([], [{ block: 0, start: 0, end: 3 }], D1),
      [{ block: 1, start: 0, end: 3 }],
      D1,
    );
    expect(countsByDimension(hs)).toEqual({ CONTRIBUTION_ACCURACY: 2 });
  });
});
