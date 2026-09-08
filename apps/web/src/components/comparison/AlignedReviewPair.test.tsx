import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AlignedReviewPair, pairSections } from "./AlignedReviewPair";
import { parseReviewSections } from "./ReviewPanel";

const sec = (heading: string | null) => ({ heading, nodes: [] });

describe("pairSections", () => {
  it("pairs the same headings across the two reviews", () => {
    const rows = pairSections(
      [sec("Summary"), sec("Strengths")],
      [sec("Summary"), sec("Strengths")],
    );
    expect(rows.map((r) => r.heading)).toEqual(["Summary", "Strengths"]);
    expect(rows.every((r) => r.a && r.b)).toBe(true);
  });

  it("pairs across differences in case and punctuation", () => {
    const rows = pairSections([sec("Flag For Ethics Review")], [sec("FLAG FOR ETHICS REVIEW:")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.a && rows[0]!.b).toBeTruthy();
  });

  // The point of aligning: B answering the form in a different order must
  // still line up against A, not cascade every later section out of step.
  it("aligns on the heading, not on position", () => {
    const rows = pairSections(
      [sec("Summary"), sec("Strengths"), sec("Weaknesses")],
      [sec("Summary"), sec("Weaknesses"), sec("Strengths")],
    );
    expect(rows.map((r) => r.heading)).toEqual(["Summary", "Strengths", "Weaknesses"]);
    expect(rows.every((r) => r.a && r.b)).toBe(true);
  });

  it("leaves the other side empty when one review omits a section", () => {
    const rows = pairSections([sec("Summary"), sec("Limitations")], [sec("Summary")]);
    const lim = rows.find((r) => r.heading === "Limitations")!;
    expect(lim.a).not.toBeNull();
    expect(lim.b).toBeNull();
  });

  it("keeps a section only B produced rather than dropping it", () => {
    const rows = pairSections([sec("Summary")], [sec("Summary"), sec("Extra Thoughts")]);
    const extra = rows.find((r) => r.heading === "Extra Thoughts")!;
    expect(extra.a).toBeNull();
    expect(extra.b).not.toBeNull();
  });

  it("gives a repeated heading its own row instead of merging", () => {
    const rows = pairSections([sec("Questions"), sec("Questions")], [sec("Questions")]);
    expect(rows.filter((r) => r.heading === "Questions")).toHaveLength(2);
    expect(rows.filter((r) => r.b !== null)).toHaveLength(1);
  });

  it("puts both preambles in the same first row", () => {
    const rows = pairSections([sec(null), sec("Summary")], [sec(null), sec("Summary")]);
    expect(rows[0]!.heading).toBeNull();
    expect(rows[0]!.a && rows[0]!.b).toBeTruthy();
  });
});

// The whole point is that nothing the model wrote is lost to the layout.
describe("AlignedReviewPair", () => {
  const RAW_A = `## Summary
A concise summary from A.

## Strengths
- A strength A noticed

## Rating
6 Marginally above the bar.`;

  const RAW_B = `## Summary
B's summary.

## Rating
4 Below the bar.

## Limitations
B alone discussed limitations.`;

  const html = renderToStaticMarkup(
    <AlignedReviewPair labelA="Review A" labelB="Review B" rawA={RAW_A} rawB={RAW_B} conference="iclr" />,
  );

  it("renders every section of both reviews", () => {
    for (const t of [
      "A concise summary from A.",
      "A strength A noticed",
      "Marginally above the bar.",
      "B&#x27;s summary.",
      "Below the bar.",
      "B alone discussed limitations.",
    ])
      expect(html).toContain(t);
  });

  it("states each shared heading once", () => {
    expect(html.match(/Summary/g) ?? []).toHaveLength(1);
    expect(html.match(/Rating/g) ?? []).toHaveLength(1);
  });

  it("says so when one review skipped a section", () => {
    expect(html).toContain("did not answer this section");
  });

  it("keeps each panel as one subtree so highlighting still has a root", () => {
    expect(html.match(/display:contents/g) ?? []).toHaveLength(2);
  });

  it("still draws the score on its scale", () => {
    expect(html).toContain("/10");
  });
});

describe("parseReviewSections", () => {
  it("splits on headings and keeps a preamble", () => {
    const secs = parseReviewSections("intro line\n\n## Summary\nbody", []);
    expect(secs.map((s) => s.heading)).toEqual([null, "Summary"]);
  });

  it("drops an empty preamble", () => {
    const secs = parseReviewSections("## Summary\nbody", []);
    expect(secs.map((s) => s.heading)).toEqual(["Summary"]);
  });
});

// Venue forms use grouping headers — "Strengths and Weaknesses" standing
// above Strengths and Weaknesses. A header with no text of its own was
// rendering a body row under it, which read as an unexplained blank strip
// between two bands.
describe("grouping headings", () => {
  const GROUPED = `## Summary
Text.

## Strengths and Weaknesses

### Strengths
- A point

### Weaknesses
- Another point`;

  const html = renderToStaticMarkup(
    <AlignedReviewPair labelA="Review A" labelB="Review B" rawA={GROUPED} rawB={GROUPED} />,
  );

  it("still shows the grouping header", () => {
    expect(html).toContain("Strengths and Weaknesses");
  });

  it("does not claim either review skipped it", () => {
    // One "did not answer" per genuinely absent section — never for a
    // header that was never meant to carry text.
    expect(html).not.toContain("did not answer this section");
  });

  it("keeps the sections underneath", () => {
    expect(html).toContain("A point");
    expect(html).toContain("Another point");
  });

  it("marks a section one review left empty as unanswered", () => {
    const withEmpty = renderToStaticMarkup(
      <AlignedReviewPair
        labelA="Review A"
        labelB="Review B"
        rawA={"## Summary\nText.\n\n## Limitations\nA discussed them."}
        rawB={"## Summary\nText.\n\n## Limitations\n"}
      />,
    );
    expect(withEmpty).toContain("did not answer this section");
  });
});
