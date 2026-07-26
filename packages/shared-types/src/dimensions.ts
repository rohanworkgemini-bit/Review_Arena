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

// The rubric definition behind each axis — what the dimension actually
// measures. Used for tooltips / participant instructions, and mirrored in
// the LLM-judge prompt so human voters and the judge score the same thing.
export const DIMENSION_RUBRIC: Record<VoteDimension, string> = {
  CONTRIBUTION_ACCURACY:
    "Whether the review correctly understands the paper's main contributions and methodological innovations without misrepresenting them.",
  RESULTS_INTERPRETATION:
    "Whether tables, figures, metrics, statistical comparisons, and experimental results are interpreted correctly without exaggeration.",
  COMPARATIVE_ANALYSIS:
    "Whether the review appropriately discusses the paper's baselines and related-work comparisons without making unsupported claims.",
  EVIDENCE_BASED_CRITIQUE:
    "Whether criticisms are supported by identifiable evidence from sections, equations, algorithms, tables, or figures.",
  CRITIQUE_CLARITY:
    "Whether weaknesses and questions are concrete enough for authors to understand the issue and how it could be addressed.",
  COMPLETENESS_COVERAGE:
    "Whether the review covers the major parts of the paper, including methodology, theory, experiments, and related work.",
  CONSTRUCTIVE_TONE:
    "Whether the review is professional, balanced, respectful, and focused on helping improve the work.",
  FALSE_CLAIMS:
    "Whether the review avoids inventing content, claiming an existing experiment is missing, or contradicting the paper's methods or reported findings.",
};
