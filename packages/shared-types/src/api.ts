import { z } from "zod";
import { VOTE_DIMENSIONS, VoteDimensionSchema } from "./dimensions.js";
import { StructuredReviewSchema } from "./structured-review.js";

// ─── Shared scalars ─────────────────────────────────────────────────────────

export const CuidSchema = z.string().min(20).max(40);

// ─── Conference (review-form scale) ─────────────────────────────────────────
// The uploader picks which venue's review form / rating scale the generated
// reviews follow. Both systems in a battle always share the same conference.
// Scales live in services/review-gen/app/conference_scales.py.

// Exactly the three venue editions the thesis studies, each with its
// real 2026 review form (ARR was dropped 2026-09: the study is scoped to
// the three ML venues whose forms the prompts reproduce verbatim).
export const CONFERENCES = ["iclr", "icml", "neurips"] as const;
export const ConferenceSchema = z.enum(CONFERENCES);
export type Conference = z.infer<typeof ConferenceSchema>;

export const CONFERENCE_NAMES: Record<Conference, string> = {
  iclr: "ICLR 2026",
  icml: "ICML 2026",
  neurips: "NeurIPS 2026",
};

// ─── POST /papers (upload) ──────────────────────────────────────────────────

export const UploadPaperResponseSchema = z.object({
  paperId: CuidSchema,
  status: z.enum(["UPLOADED", "PARSING", "PARSED", "PARSE_FAILED"]),
  // True if we found an existing Paper by contentHash and reused it.
  deduplicated: z.boolean(),
  // The pair of review IDs the upload-time selector chose. Browser
  // opens SSE streams to /reviews/stream/:reviewId for each to render
  // tokens live. Empty when the parse is still pending (Generate-Mode
  // re-uploads, dedupe hits without re-generation).
  reviewIds: z
    .array(z.object({ slug: z.string(), reviewId: CuidSchema }))
    .default([]),
});
export type UploadPaperResponse = z.infer<typeof UploadPaperResponseSchema>;

// ─── GET /pair (next comparison) ────────────────────────────────────────────

export const ComparisonReviewSchema = z.object({
  reviewId: CuidSchema,
  // The actual structured review the user reads. System identity is hidden.
  // null while the review is still GENERATING — the browser opens an SSE
  // stream to /reviews/stream/:reviewId for token-level rendering and
  // gets the final structured form via the stream's 'done' event.
  structured: StructuredReviewSchema.nullable(),
  // The model's verbatim markdown output, for the "Raw" view toggle.
  // null while generating (the SSE stream accumulates it client-side).
  rawOutput: z.string().nullable().optional(),
  status: z.enum(["PENDING", "GENERATING", "COMPLETED", "FAILED"]).optional(),
});

export const PairResponseSchema = z.object({
  paper: z.object({
    id: CuidSchema,
    title: z.string().nullable(),
    // Which venue's review form both reviews follow. Optional for
    // backwards compatibility with pre-conference rows (treated as iclr).
    conference: ConferenceSchema.optional(),
  }),
  reviewA: ComparisonReviewSchema,
  reviewB: ComparisonReviewSchema,
  // Echoed back with the vote so the server can verify A/B mapping.
  pairToken: z.string(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

// ─── POST /votes ────────────────────────────────────────────────────────────

export const SubmitVoteRequestSchema = z.object({
  pairToken: z.string(),
  winner: z.enum(["A", "B", "TIE"]),
  // Optional free-text rationale for the overall verdict — the same
  // qualitative signal the per-dimension notes carry, one level up.
  note: z.string().max(1000).optional(),
  decisionMs: z.number().int().nonnegative().optional(),
  // All 8 dimensions are now required (one pick per dimension, no
  // duplicates). The UI gates the submit button on this; the server
  // enforces it too so a non-UI client can't bypass it and pollute
  // per-dimension leaderboards with sparse data. value is -1 (A wins),
  // 1 (B wins), or 0 (tie on this dimension). Each dimension may carry
  // an optional free-text `note` explaining the rating (qualitative
  // signal for thesis analysis).
  dimensions: z
    .array(
      z.object({
        dimension: VoteDimensionSchema,
        value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
        note: z.string().max(1000).optional(),
      }),
    )
    .length(VOTE_DIMENSIONS.length)
    .refine(
      (arr) => new Set(arr.map((d) => d.dimension)).size === arr.length,
      { message: "Each dimension may appear at most once." },
    )
    .refine(
      (arr) =>
        VOTE_DIMENSIONS.every((d) => arr.some((x) => x.dimension === d)),
      { message: "All voting dimensions must be provided." },
    ),
});
export type SubmitVoteRequest = z.infer<typeof SubmitVoteRequestSchema>;

export const SubmitVoteResponseSchema = z.object({
  voteId: CuidSchema,
  // Reveal payload — sent in the same response so the UI can transition
  // straight to the reveal screen without a second round-trip.
  reveal: z.object({
    reviewA: z.object({
      reviewId: CuidSchema,
      systemSlug: z.string(),
      systemName: z.string(),
      eloBefore: z.number(),
      eloAfter: z.number(),
      // Bradley-Terry refit before and after this vote, on the same 1000-point
      // scale as the leaderboard. null when the system is not on the BT board
      // yet — too few comparisons to connect it to the rest of the field.
      btBefore: z.number().nullable(),
      btAfter: z.number().nullable(),
    }),
    reviewB: z.object({
      reviewId: CuidSchema,
      systemSlug: z.string(),
      systemName: z.string(),
      eloBefore: z.number(),
      eloAfter: z.number(),
      btBefore: z.number().nullable(),
      btAfter: z.number().nullable(),
    }),
  }),
});
export type SubmitVoteResponse = z.infer<typeof SubmitVoteResponseSchema>;

// ─── GET /reveal/:voteId ────────────────────────────────────────────────────

export const RevealSideSchema = z.object({
  reviewId: CuidSchema,
  systemName: z.string(),
  judgeOverall: z.number().nullable(),
  // Per-dimension judge scores in 0..10, keyed by VoteDimension. null until
  // scoring runs.
  judgeDimensions: z.record(z.string(), z.number()).nullable(),
});
export type RevealSide = z.infer<typeof RevealSideSchema>;

export const RevealDetailResponseSchema = z.object({
  reviewA: RevealSideSchema,
  reviewB: RevealSideSchema,
});
export type RevealDetailResponse = z.infer<typeof RevealDetailResponseSchema>;

// ─── GET /leaderboard ───────────────────────────────────────────────────────

// Which rating system a board was computed with. BT (Bradley-Terry MLE) is
// the default and what LMArena publishes; ELO is the online, order-dependent
// system, kept as a second view.
export const RatingMethodSchema = z.enum(["BT", "ELO"]);
export type RatingMethod = z.infer<typeof RatingMethodSchema>;

export const LeaderboardEntrySchema = z.object({
  rank: z.number().int().min(1),
  systemSlug: z.string(),
  systemName: z.string(),
  rating: z.number(),
  ratingCiLow: z.number(),
  ratingCiHigh: z.number(),
  voteCount: z.number().int().nonnegative(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z.object({
  // null = overall, otherwise per-dimension leaderboard.
  dimension: VoteDimensionSchema.nullable(),
  method: RatingMethodSchema,
  totalPapers: z.number().int().nonnegative(),
  totalVotes: z.number().int().nonnegative(),
  entries: z.array(LeaderboardEntrySchema),
  // Enabled systems this board cannot place: no votes yet, or — on BT — not
  // yet connected to the rest of the field by a chain of wins and losses.
  unranked: z.array(z.object({ systemSlug: z.string(), systemName: z.string() })),
  // BT only. "BASELINE": baselineSlug is pinned to 1000, so the scale's
  // origin is fixed and boards stay comparable over time. "MEAN": that system
  // has not battled here, so this board is mean-centred on 1000 instead.
  // null for the Elo board, which has no free constant to fix.
  anchor: z.enum(["BASELINE", "MEAN"]).nullable(),
  baselineSlug: z.string().nullable(),
  computedAt: z.string(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ─── Admin: review systems ──────────────────────────────────────────────────

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

export const CreateReviewSystemRequestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  adapterKey: z.string(),
  config: z.record(z.unknown()).default({}),
});
export type CreateReviewSystemRequest = z.infer<typeof CreateReviewSystemRequestSchema>;
