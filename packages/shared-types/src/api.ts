import { z } from "zod";
import { VOTE_DIMENSIONS, VoteDimensionSchema } from "./dimensions.js";
import { StructuredReviewSchema } from "./structured-review.js";

// ─── Shared scalars ─────────────────────────────────────────────────────────

export const CuidSchema = z.string().min(20).max(40);

// The one verdict encoding, used for the overall vote AND for each of the
// eight per-dimension picks (unified 2026-09-10; the dimensions previously
// carried a signed integer -1 / 0 / +1). Storing both in one encoding means
// one conversion to a Bradley-Terry outcome serves all nine boards, so the
// overall log and the per-dimension logs cannot disagree about what a
// verdict means.
export const WinnerSchema = z.enum(["A", "B", "TIE"]);
export type Winner = z.infer<typeof WinnerSchema>;

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
  // per-dimension leaderboards with sparse data. `winner` uses the SAME
  // "A" / "B" / "TIE" encoding as the overall verdict above (2026-09-10;
  // previously a signed integer -1 / 0 / +1), so one conversion serves all
  // nine boards. Each dimension may carry an optional free-text `note`
  // explaining the rating (qualitative signal for thesis analysis).
  dimensions: z
    .array(
      z.object({
        dimension: VoteDimensionSchema,
        winner: z.enum(["A", "B", "TIE"]),
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
    // The verdict the rater just cast, echoed back so the reveal can name
    // the preferred side without inferring it from rating movement.
    winner: z.enum(["A", "B", "TIE"]),
    reviewA: z.object({
      reviewId: CuidSchema,
      systemSlug: z.string(),
      systemName: z.string(),
      // Bradley-Terry refit before and after this vote, on the same 1000-point
      // scale as the leaderboard. null when the system is not on the BT board
      // yet — too few comparisons to connect it to the rest of the field.
      // (Online Elo is no longer computed at runtime; the thesis analysis
      // recomputes it offline from the vote log to compare against BT.)
      btBefore: z.number().nullable(),
      btAfter: z.number().nullable(),
    }),
    reviewB: z.object({
      reviewId: CuidSchema,
      systemSlug: z.string(),
      systemName: z.string(),
      btBefore: z.number().nullable(),
      btAfter: z.number().nullable(),
    }),
  }),
});
export type SubmitVoteResponse = z.infer<typeof SubmitVoteResponseSchema>;

// ─── GET /reveal/:voteId ────────────────────────────────────────────────────

// Keep in sync with apps/api/src/routes/schemas.ts (Reveal*).
export const RevealSideSchema = z.object({
  reviewId: CuidSchema,
  systemName: z.string(),
  // Mean overall score (0..10) across the judge-panel members that
  // returned. null until any did.
  judgeOverall: z.number().nullable(),
  // Per-dimension panel-mean scores in 0..10, keyed by VoteDimension.
  judgeDimensions: z.record(z.string(), z.number()).nullable(),
  // How many judges the means are over.
  judgeCount: z.number().int().min(0),
});
export type RevealSide = z.infer<typeof RevealSideSchema>;

const JudgePreferenceSchema = z.enum(["A", "B", "TIE"]);
export type JudgePreference = z.infer<typeof JudgePreferenceSchema>;

// One judge-panel member's pairwise verdict: it compared both reviews in
// one request (order-swapped double pass) and emitted the same construct
// human raters give. "A"/"B" are already mapped onto THIS vote's blinded
// sides. passesUsed: 2 = swap-consistent; 1 = one pass failed, so the
// position-bias control was unavailable. selfJudging: the judge generated
// one of the two reviews.
export const JudgeEntrySchema = z.object({
  judge: z.string(),
  judgeName: z.string(),
  overall: JudgePreferenceSchema,
  dimensions: z.record(z.string(), JudgePreferenceSchema),
  passesUsed: z.number().int().min(1).max(2),
  selfJudging: z.boolean(),
  scoreA: z.number().nullable(),
  scoreB: z.number().nullable(),
});
export type JudgeEntry = z.infer<typeof JudgeEntrySchema>;

// Panel majority: the side with more judge votes; TIE votes count for
// neither side and an even split is TIE.
export const JudgeVerdictSchema = z.object({
  overall: JudgePreferenceSchema,
  dimensions: z.record(z.string(), JudgePreferenceSchema),
  counts: z.object({ A: z.number().int(), B: z.number().int(), TIE: z.number().int() }),
  judgesReturned: z.number().int().min(0),
  judgesExpected: z.number().int().min(0),
  judges: z.array(JudgeEntrySchema),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JudgeStatusSchema = z.enum(["PENDING", "RUNNING", "COMPLETE", "PARTIAL", "FAILED"]);
export type JudgeStatus = z.infer<typeof JudgeStatusSchema>;

export const RevealDetailResponseSchema = z.object({
  reviewA: RevealSideSchema,
  reviewB: RevealSideSchema,
  // null until at least one panel member has returned.
  judgeVerdict: JudgeVerdictSchema.nullable(),
  // PENDING = not judged (arena papers never are); RUNNING = panel in
  // flight; COMPLETE / PARTIAL / FAILED = settled.
  judgeStatus: JudgeStatusSchema,
});
export type RevealDetailResponse = z.infer<typeof RevealDetailResponseSchema>;

// ─── GET /leaderboard ───────────────────────────────────────────────────────

// Which rating system a board was computed with. Only Bradley-Terry — the
// maximum-likelihood fit over the whole comparison log, what LMArena
// publishes — is computed and served. Online Elo is no longer run at
// runtime: the thesis analysis recomputes it offline from the vote log,
// purely to compare its order-dependent ranking against BT's.
export const RatingMethodSchema = z.enum(["BT"]);
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
  // null only when the board has no rows yet.
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
