import { describe, expect, it } from "vitest";
import { scaleFor, splitLeadingScore } from "./ScoreLine";

describe("scaleFor", () => {
  it("reads the overall scale off the venue", () => {
    expect(scaleFor("Rating", "iclr")).toBe(10);
    expect(scaleFor("Rating", "neurips")).toBe(6);
    expect(scaleFor("Overall Recommendation", "icml")).toBe(6);
  });

  it("assumes the widest overall scale when the venue is unknown", () => {
    // Better to under-fill a bar than to draw a 4 as nearly full.
    expect(scaleFor("Rating")).toBe(10);
  });

  it("uses the shared 1-5 confidence scale regardless of venue", () => {
    expect(scaleFor("Confidence", "iclr")).toBe(5);
    expect(scaleFor("Confidence", "neurips")).toBe(5);
  });

  it("puts the 1-4 sub-dimensions on their own scale", () => {
    for (const h of ["Soundness", "Presentation", "Contribution", "Originality"])
      expect(scaleFor(h, "iclr")).toBe(4);
  });

  it("is case- and whitespace-insensitive, as model headings vary", () => {
    expect(scaleFor("  rating  ", "iclr")).toBe(10);
    expect(scaleFor("CONFIDENCE", "iclr")).toBe(5);
  });

  it("returns null for prose sections", () => {
    for (const h of ["Summary", "Strengths", "Weaknesses", "Questions", "Limitations"])
      expect(scaleFor(h, "iclr")).toBeNull();
  });
});

describe("splitLeadingScore", () => {
  it("lifts the number out and keeps the sentence", () => {
    const r = splitLeadingScore("4 The paper presents a useful system.", 10);
    expect(r).toEqual({ value: 4, rest: "The paper presents a useful system." });
  });

  it("accepts the punctuation models put after the number", () => {
    for (const t of ["6. Marginally above", "6) Marginally above", "6: Marginally above"])
      expect(splitLeadingScore(t, 10)?.value).toBe(6);
  });

  it("accepts a written-out fraction", () => {
    const r = splitLeadingScore("4/5 I am fairly confident.", 5);
    expect(r).toEqual({ value: 4, rest: "I am fairly confident." });
  });

  it("keeps zero, which is a real ICLR score", () => {
    expect(splitLeadingScore("0 Strong reject.", 10)?.value).toBe(0);
  });

  it("handles halves", () => {
    expect(splitLeadingScore("3.5 Borderline.", 6)?.value).toBe(3.5);
  });

  // The important direction: prose that merely opens with a digit must
  // survive untouched, or the renderer silently eats words from a review.
  it("leaves prose alone when the number is out of scale", () => {
    expect(splitLeadingScore("2024 was the cut-off year for the corpus.", 10)).toBeNull();
    expect(splitLeadingScore("15 baselines were compared.", 10)).toBeNull();
  });

  it("leaves a bare number alone — a score needs its sentence", () => {
    expect(splitLeadingScore("4", 10)).toBeNull();
    expect(splitLeadingScore("4   ", 10)).toBeNull();
  });

  it("does not fire when the paragraph opens with a word", () => {
    expect(splitLeadingScore("The paper scores 4 on soundness.", 10)).toBeNull();
  });

  it("does not fire on a number glued to its text", () => {
    // "3sigma" is not a score; requiring the separator keeps that safe.
    expect(splitLeadingScore("3sigma deviations were observed.", 10)).toBeNull();
  });
});
