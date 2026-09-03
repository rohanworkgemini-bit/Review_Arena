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
  // Kept in sync with LeaderboardResponseSchema in
  // packages/shared-types/src/api.ts — that copy is what the web app parses.
  method: z.enum(["BT", "ELO"]),
  totalPapers: z.number().int().nonnegative(),
  totalVotes: z.number().int().nonnegative(),
  entries: z.array(LeaderboardEntrySchema),
  unranked: z.array(z.object({ systemSlug: z.string(), systemName: z.string() })),
  anchor: z.enum(["BASELINE", "MEAN"]).nullable(),
  baselineSlug: z.string().nullable(),
  computedAt: z.string(), // ISO 8601
});

export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ─── GET /reveal ────────────────────────────────────────────────────────────

export const RevealReviewSchema = z.object({
  reviewId: CuidSchema,
  systemName: z.string(),
  judgeOverall: z.number().nullable(),
  judgeDimensions: z.record(z.number()).nullable(),
});

// Pairwise judge verdict, mapped onto this vote's blinded sides.
export const RevealJudgeVerdictSchema = z.object({
  overall: z.enum(["A", "B", "TIE"]),
  dimensions: z.record(z.enum(["A", "B", "TIE"])),
  passesUsed: z.number().int().min(1).max(2),
});

export const RevealResponseSchema = z.object({
  reviewA: RevealReviewSchema,
  reviewB: RevealReviewSchema,
  judgeVerdict: RevealJudgeVerdictSchema.nullable(),
});

export type RevealResponse = z.infer<typeof RevealResponseSchema>;

// ─── POST /votes (response) ──────────────────────────────────────────────────

export const SubmitVoteResponseSchema = z.object({
  voteId: CuidSchema,
  reveal: RevealResponseSchema,
});

export type SubmitVoteResponse = z.infer<typeof SubmitVoteResponseSchema>;

// ─── POST /papers (response) ────────────────────────────────────────────────

export const UploadPaperResponseSchema = z.object({
  paperId: CuidSchema,
  status: z.string(),
  deduplicated: z.boolean(),
});

export type UploadPaperResponse = z.infer<typeof UploadPaperResponseSchema>;

// ─── GET /papers/:id ────────────────────────────────────────────────────────

export const PairReviewSchema = z.object({
  reviewId: CuidSchema,
  slug: z.string(),
});

export const PaperDetailResponseSchema = z.object({
  id: CuidSchema,
  title: z.string().nullable(),
  status: z.string(),
  pageCount: z.number().int().nullable(),
  reviewCount: z.number().int(),
  completedReviewCount: z.number().int(),
  terminalReviewCount: z.number().int(),
  expectedReviewCount: z.number().int(),
  createdAt: z.string(),
  reviewIds: z.array(PairReviewSchema),
});

export type PaperDetailResponse = z.infer<typeof PaperDetailResponseSchema>;

// ─── Admin endpoints ────────────────────────────────────────────────────────

export const ReviewSystemSchema = z.object({
  id: CuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  adapterKey: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export type ReviewSystem = z.infer<typeof ReviewSystemSchema>;

export const AdminReviewSystemsListResponseSchema = z.array(ReviewSystemSchema);

export type AdminReviewSystemsListResponse = z.infer<typeof AdminReviewSystemsListResponseSchema>;

export const AdminRegenResponseSchema = z.object({
  ok: z.boolean(),
  paperId: CuidSchema,
  dropped: z.number().int(),
  message: z.string(),
});

export type AdminRegenResponse = z.infer<typeof AdminRegenResponseSchema>;

export const AdminScoreResponseSchema = z.object({
  ok: z.boolean(),
  paperId: CuidSchema,
});

export type AdminScoreResponse = z.infer<typeof AdminScoreResponseSchema>;

export const AdminExportResponseSchema = z.object({
  exportedAt: z.string(),
  systems: z.array(z.any()),
  papers: z.array(z.any()),
  votes: z.array(z.any()),
  metrics: z.array(z.any()),
  snapshots: z.array(z.any()),
});

export type AdminExportResponse = z.infer<typeof AdminExportResponseSchema>;
