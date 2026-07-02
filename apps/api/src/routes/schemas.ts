/**
 * Response schema validation using Zod.
 *
 * Every endpoint's response shape is validated before sending, catching
 * silent regressions that refactors might introduce. During development,
 * parse() will throw if the response drifts from the schema; in production,
 * you have both runtime verification and type-level assurance.
 */

import { z } from "zod";
import { CuidSchema, StructuredReviewSchema } from "@reviewarena/shared-types";

// ─── GET /leaderboard ────────────────────────────────────────────────────────

export const LeaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  systemSlug: z.string(),
  systemName: z.string(),
  rating: z.number(),
  ratingCiLow: z.number(),
  ratingCiHigh: z.number(),
  voteCount: z.number().int().nonnegative(),
});

export const LeaderboardResponseSchema = z.object({
  dimension: z.string().nullable(),
  totalPapers: z.number().int().nonnegative(),
  totalVotes: z.number().int().nonnegative(),
  entries: z.array(LeaderboardEntrySchema),
  computedAt: z.string(), // ISO 8601
});

export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ─── GET /reveal ────────────────────────────────────────────────────────────

export const RevealReviewSchema = z.object({
  reviewId: CuidSchema,
  systemSlug: z.string(),
  systemName: z.string(),
  eloBefore: z.number(),
  eloAfter: z.number(),
});

export const RevealResponseSchema = z.object({
  reviewA: RevealReviewSchema,
  reviewB: RevealReviewSchema,
  structuredA: StructuredReviewSchema.nullable(),
  structuredB: StructuredReviewSchema.nullable(),
  dimensionScoresA: z.record(z.number()),
  dimensionScoresB: z.record(z.number()),
  overallScoreA: z.number().nullable(),
  overallScoreB: z.number().nullable(),
  claimChecksA: z
    .array(
      z.object({
        claim: z.string(),
        verdict: z.enum(["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"]),
        evidence: z.string().nullable(),
      }),
    )
    .nullable(),
  claimChecksB: z.array(z.any()).nullable(), // same shape as claimChecksA
});

export type RevealResponse = z.infer<typeof RevealResponseSchema>;

// ─── POST /votes (response) ──────────────────────────────────────────────────

export const SubmitVoteResponseSchema = z.object({
  voteId: CuidSchema,
  reveal: RevealResponseSchema,
});

export type SubmitVoteResponse = z.infer<typeof SubmitVoteResponseSchema>;

// ─── GET /papers/:id ────────────────────────────────────────────────────────

export const PaperDetailResponseSchema = z.object({
  id: CuidSchema,
  title: z.string().nullable(),
  status: z.enum(["UPLOADED", "PARSING", "PARSED", "PARSE_FAILED"]),
  pageCount: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  reviewCount: z.number().int(),
  createdAt: z.string(),
});

export type PaperDetailResponse = z.infer<typeof PaperDetailResponseSchema>;

// ─── Admin endpoints ────────────────────────────────────────────────────────

export const ReviewSystemResponseSchema = z.object({
  id: CuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  adapterKey: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export const AdminExportResponseSchema = z.object({
  exportedAt: z.string(),
  papers: z.array(z.any()),
  reviews: z.array(z.any()),
  votes: z.array(z.any()),
  dimensionVotes: z.array(z.any()),
  eloSnapshots: z.array(z.any()),
});

export type AdminExportResponse = z.infer<typeof AdminExportResponseSchema>;
