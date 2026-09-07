import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewPanel } from "@/components/comparison/ReviewPanel";
import type { StructuredReview } from "@reviewarena/shared-types";

// The property under test: the panel renders EVERYTHING the model sent,
// in order — every section of the venue form, every score line, every
// bullet. The only permitted alteration is stripping asterisk emphasis
// markers. If a future edit reintroduces a filtered view, this fails.

const structured: StructuredReview = {
  summary: "fallback summary",
  strengths: ["s1"],
  weaknesses: ["w1"],
  questions: ["q1"],
};

const RAW = `## Summary
This paper proposes **FooNet** for zero-shot bar.

## Strengths And Weaknesses
Narrative across the four dimensions.

### Strengths
- Clear *formulation* of the problem
- Strong empirical section

### Weaknesses
- **Limited baselines**: only two competitors

## Quality
3
Technically sound overall.

## Clarity
4
Very well written.

## Originality
2
Incremental over FooNet-v1.

## Questions
1. Why was baseline Z omitted?
2) How does it scale?

## Limitations
Societal impact is not discussed.

## Flag For Ethics Review
No ethics review needed.

## Rating
4
Borderline accept.

## Confidence
4
Confident but not certain.`;

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "\n");
}

describe("ReviewPanel", () => {
  it("renders every line the model produced, emphasis markers stripped", () => {
    const html = renderToStaticMarkup(
      <ReviewPanel label="Review A" review={structured} raw={RAW} />,
    );
    const text = textOf(html);

    // Every heading of the venue form survives — including the ones the
    // old parsed view dropped (Originality, Flag For Ethics Review,
    // standalone Limitations, the Strengths And Weaknesses narrative).
    for (const heading of [
      "Summary",
      "Strengths And Weaknesses",
      "Strengths",
      "Weaknesses",
      "Quality",
      "Clarity",
      "Originality",
      "Questions",
      "Limitations",
      "Flag For Ethics Review",
      "Rating",
      "Confidence",
    ]) {
      expect(text).toContain(heading);
    }

    // Every content line survives.
    for (const content of [
      "This paper proposes FooNet for zero-shot bar.",
      "Narrative across the four dimensions.",
      "Clear formulation of the problem",
      "Strong empirical section",
      "Limited baselines: only two competitors",
      "Technically sound overall.",
      "Very well written.",
      "Incremental over FooNet-v1.",
      "Why was baseline Z omitted?",
      "How does it scale?",
      "Societal impact is not discussed.",
      "No ethics review needed.",
      "Borderline accept.",
      "Confident but not certain.",
    ]) {
      expect(text).toContain(content);
    }

    // Sanitized: no emphasis markers reach the screen…
    expect(html).not.toContain("**");
    // …and no literal markdown header markers either (they render as
    // styled headings, not text).
    expect(text).not.toMatch(/^#{1,4}\s/m);

    // Order is preserved: Rating comes after Questions, as the model
    // wrote it.
    expect(text.indexOf("Questions")).toBeLessThan(text.indexOf("Rating"));

    // Lists render as real list items. Matched loosely on the opening tag:
    // <li> also carries the data-hl-block attribute the highlighter anchors
    // its offsets to, and this assertion is about list structure, not attrs.
    expect(html).toMatch(/<li[^>]*>Strong empirical section<\/li>/);
    expect(html).toMatch(/<li[^>]*>How does it scale\?<\/li>/);
  });

  it("falls back to structured fields when rawOutput is absent (legacy rows)", () => {
    const html = renderToStaticMarkup(
      <ReviewPanel label="Review B" review={structured} raw={null} />,
    );
    for (const s of ["fallback summary", "s1", "w1", "q1"]) {
      expect(html).toContain(s);
    }
  });
});
