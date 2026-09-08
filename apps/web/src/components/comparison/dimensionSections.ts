import { VOTE_DIMENSIONS, type VoteDimension } from "@reviewarena/shared-types";

/**
 * Which section of a review form each voting dimension is mostly answered
 * from — used only to scroll the rater to a sensible place.
 *
 * This is a navigation hint, never a restriction: evidence for a dimension
 * can appear anywhere, and jumping does not hide or mark anything. The
 * mapping is deliberately loose and ordered — the first heading a review
 * actually has wins — because the three venue forms use different names for
 * overlapping things, and a model may skip a section entirely.
 *
 * Two dimensions map to nothing on purpose. Completeness and tone are
 * judged across a whole review, so sending the rater to one section would
 * suggest the answer lives there.
 */
const CANDIDATES: Record<VoteDimension, string[]> = {
  CONTRIBUTION_ACCURACY: ["summary", "contribution", "significance"],
  RESULTS_INTERPRETATION: ["soundness", "results", "quality", "rating"],
  COMPARATIVE_ANALYSIS: ["related work", "comparative", "originality", "weaknesses"],
  EVIDENCE_BASED_CRITIQUE: ["weaknesses", "strengths"],
  CRITIQUE_CLARITY: ["questions", "key questions for authors", "weaknesses"],
  COMPLETENESS_COVERAGE: [],
  CONSTRUCTIVE_TONE: [],
  FALSE_CLAIMS: ["weaknesses", "summary"],
};

/** Same normalisation the section pairing uses, so the keys line up. */
function norm(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Index of the section to scroll to for `dimension`, or null when the
 * dimension spans the whole review or none of its sections are present.
 * Matches on containment so "Overall Rating" answers a "rating" candidate.
 */
export function sectionForDimension(
  dimension: VoteDimension,
  headings: readonly (string | null)[],
): number | null {
  for (const want of CANDIDATES[dimension]) {
    const idx = headings.findIndex((h) => h !== null && norm(h).includes(want));
    if (idx !== -1) return idx;
  }
  return null;
}

/** Dimensions that have somewhere to jump to in this particular pair. */
export function jumpableDimensions(
  headings: readonly (string | null)[],
): Set<VoteDimension> {
  const out = new Set<VoteDimension>();
  for (const d of VOTE_DIMENSIONS) {
    if (sectionForDimension(d, headings) !== null) out.add(d);
  }
  return out;
}
