import { z } from "zod";

// The eight per-dimension comparison axes. Single source of truth for the
// whole stack — keep in sync with:
//   - the `vote_dimension` pgEnum in apps/api/src/db/schema.ts
//   - `_DIMENSIONS` in services/review-gen/app/judge.py
//
// Every dimension is polarity-aligned: picking a side always means "this
// side is BETTER on this axis". That matters for FALSE_CLAIMS,
// where "better" = *fewer* false claims — the voting question is phrased
// so the picked side is still the good one, and the leaderboard can rank
// high-is-good uniformly across all eight.
export const VOTE_DIMENSIONS = [
  "CONTRIBUTION_ACCURACY",
  "RESULTS_INTERPRETATION",
  "COMPARATIVE_ANALYSIS",
  "EVIDENCE_BASED_CRITIQUE",
  "CRITIQUE_CLARITY",
  "COMPLETENESS_COVERAGE",
  "CONSTRUCTIVE_TONE",
  "FALSE_CLAIMS",
] as const;

export const VoteDimensionSchema = z.enum(VOTE_DIMENSIONS);
export type VoteDimension = z.infer<typeof VoteDimensionSchema>;

export const DIMENSION_LABELS: Record<VoteDimension, string> = {
  CONTRIBUTION_ACCURACY: "Core Contribution Accuracy",
  RESULTS_INTERPRETATION: "Results Interpretation",
  COMPARATIVE_ANALYSIS: "Comparative Analysis",
  EVIDENCE_BASED_CRITIQUE: "Evidence-Based Critique",
  CRITIQUE_CLARITY: "Critique Clarity",
  COMPLETENESS_COVERAGE: "Completeness Coverage",
  CONSTRUCTIVE_TONE: "Constructive Tone",
  FALSE_CLAIMS: "False or Contradictory Claims",
};

// Shown to the voter under each dimension label — phrased as the pairwise
// question they are actually answering, not as an abstract property.
export const DIMENSION_DESCRIPTIONS: Record<VoteDimension, string> = {
  CONTRIBUTION_ACCURACY:
    "Which review more accurately understands and summarizes the paper's core contributions?",
  RESULTS_INTERPRETATION:
    "Which review interprets the paper's experimental results more accurately?",
  COMPARATIVE_ANALYSIS:
    "Which review better evaluates the paper in relation to its baselines and related work?",
  EVIDENCE_BASED_CRITIQUE:
    "Which review provides better paper-grounded evidence for its criticisms?",
  CRITIQUE_CLARITY:
    "Which review expresses its criticisms more clearly and specifically?",
  COMPLETENESS_COVERAGE:
    "Which review provides more complete coverage of the paper?",
  CONSTRUCTIVE_TONE:
    "Which review provides feedback in a more constructive and professional manner?",
  FALSE_CLAIMS:
    "Which review contains fewer false, unsupported, or contradictory claims?",
};
