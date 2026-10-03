/**
 * Drizzle schema — mirrors the Checkpoint-2 design 1:1.
 *
 * Conventions:
 *   - cuid2 PKs (no Postgres extension required; pure JS).
 *   - explicit indexes on every FK hot-path.
 *   - status enums for async pipelines (parsing, generation).
 *   - jsonb columns store typed payloads; never queried with WHERE.
 *
 * Migrations are managed by drizzle-kit (see drizzle.config.ts).
 */
import { createId } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const cuid = () => text("id").primaryKey().$defaultFn(() => createId());

// ─── Enums ────────────────────────────────────────────────────────────────

export const paperStatusEnum = pgEnum("paper_status", [
  "UPLOADED",
  "PARSING",
  "PARSED",
  "PARSE_FAILED",
]);

export const reviewStatusEnum = pgEnum("review_status", [
  "PENDING",
  "GENERATING",
  "COMPLETED",
  "FAILED",
]);

export const judgeStatusEnum = pgEnum("judge_status", [
  // Not yet judged. New review rows start here; the column default stays
  // COMPLETE only so legacy rows (which predate judge-status tracking)
  // keep counting on the leaderboard. Arena papers are never judged and
  // stay PENDING for good — only study pairs go through the panel.
  "PENDING",
  // Every member of the judge panel returned a verdict for the pair.
  "COMPLETE",
  // At least one panel member returned, at least one failed after retries.
  // The pair still counts for the leaderboard; the analysis can filter.
  "PARTIAL",
  // No panel member returned a verdict.
  "FAILED",
  // Claimed by an in-flight pairwise judge run (both reviews of a pair
  // are claimed atomically so concurrent completion events can't judge
  // the same pair twice). The sweeper fails rows stuck here.
  "RUNNING",
]);

export const voteWinnerEnum = pgEnum("vote_winner", ["A", "B", "TIE"]);

// Which collection regime produced a vote. ARENA = the open app (8-dim
// form, live leaderboard); STUDY = the controlled 20-participant design
// (single axis, deterministic rotation pairs, offline analysis).
export const voteModeEnum = pgEnum("vote_mode", ["ARENA", "STUDY"]);

// Both rating systems are computed on every vote and stored side by side.
// BT (Bradley-Terry MLE) is what the leaderboard shows by default and what
// LMArena reports publicly; ELO is the online, order-dependent system kept
// for the reveal-screen delta and for the thesis' side-by-side comparison.
export const ratingMethodEnum = pgEnum("rating_method", ["ELO", "BT"]);

// Keep in sync with VOTE_DIMENSIONS in packages/shared-types/src/dimensions.ts
// and _DIMENSIONS in services/review-gen/app/judge.py. All eight are
// polarity-aligned (higher / picked = better), including FALSE_CLAIMS,
// where "better" means fewer false or contradictory claims.
export const voteDimensionEnum = pgEnum("vote_dimension", [
  "CONTRIBUTION_ACCURACY",
  "RESULTS_INTERPRETATION",
  "COMPARATIVE_ANALYSIS",
  "EVIDENCE_BASED_CRITIQUE",
  "CRITIQUE_CLARITY",
  "COMPLETENESS_COVERAGE",
  "CONSTRUCTIVE_TONE",
  "FALSE_CLAIMS",
]);

// LLM-as-judge is the single automatic quality metric. BLEU/ROUGE were
// removed — reference-overlap metrics are a poor fit for peer reviews
// (a review isn't a translation of the paper).
export const metricKindEnum = pgEnum("metric_kind", ["LLM_JUDGE_OVERALL"]);

export const metricReferenceTypeEnum = pgEnum("metric_reference_type", [
  "NONE",
  "HUMAN_REVIEW",
  "OTHER_SYSTEM",
]);

// ─── Papers ───────────────────────────────────────────────────────────────

// ─── Study participants ───────────────────────────────────────────────────

// The controlled study's participants — an open pool, minted as needed by
// scripts/seed-participants.ts. `id` is an opaque public label carrying no
// schedule (rotations are drawn per paper at upload; early rows predate
// this and are still labelled P01..P20); `code` is the secret they type to
// enter /study (capability token — no PII anywhere).
export const participants = pgTable("participants", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  // Dry-run codes (T01, T02, …) handed to the team to walk the flow before
  // and during the study window. Everything they produce is written exactly
  // as a real participant's is — same rotations, same judging — and then
  // excluded at read time: from the Bradley-Terry fit (routes/votes.ts
  // loadBattles) and from the analysis exports. Excluding at read time
  // rather than refusing to store means a test session exercises the real
  // write path, which is the point of having it.
  isTest: boolean("is_test").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const papers = pgTable(
  "papers",
  {
    id: cuid(),
    // SHA-256 of the PDF bytes. Cache key for review generation.
    contentHash: text("content_hash").notNull(),
    // Title the uploader typed (optional) — kept separate from the
    // parser's extraction so we can show "the human-entered title"
    // without losing either source.
    userTitle: text("user_title"),
    extractedTitle: text("extracted_title"),
    authors: jsonb("authors").$type<string[]>(),
    abstract: text("abstract"),
    // Legacy. Older rows stored a disk path here for /uploads serving;
    // new uploads never persist the PDF, so this is null going forward.
    // Kept on the schema (instead of dropped) so existing rows still read.
    pdfPath: text("pdf_path"),
    pageCount: integer("page_count"),
    status: paperStatusEnum("status").notNull().default("UPLOADED"),
    errorMessage: text("error_message"),
    // Study mode: set on papers uploaded through /study. participantId
    // links to the participant whose code was used, paperIndex is 1 or 2
    // within their session, rotationId (1-5) fixes which three system pairs
    // this paper's comparisons use — drawn at upload by nextRotationId()
    // (see src/study/rotation.ts). All null for arena uploads.
    participantId: text("participant_id").references(() => participants.id),
    paperIndex: integer("paper_index"),
    rotationId: integer("rotation_id"),
    // Typed JSON shape lives in packages/shared-types/parsed-paper.ts.
    parsedStructure: jsonb("parsed_structure"),
    parserRawXml: text("parser_raw_xml"),
    // ─── Fairness: canonical input (docs/FAIRNESS.md A1/C1) ───────────────
    // The ONE canonical paper string handed byte-identically to every
    // system, rendered once at parse time — the COMPLETE paper (input
    // caps removed by design; commercial models fit whole papers).
    // canonicalTokens = its reference-token count; fullTokens = the
    // untruncated paper's token count (now equal for new rows).
    // lengthBand buckets fullTokens for length-as-covariate analysis.
    canonicalText: text("canonical_text"),
    canonicalTokens: integer("canonical_tokens"),
    fullTokens: integer("full_tokens"),
    lengthBand: text("length_band"),
    // The session that uploaded this paper. Used by /reviews/stream/:id
    // to authorise live generation requests — only the original uploader
    // can trigger the (billable) model call. Nullable for legacy rows
    // uploaded before this column existed.
    uploadedBySessionId: text("uploaded_by_session_id"),
    // When the uploader accepted the data-processing notice (/consent):
    // paper content is sent to commercial AI APIs (OpenAI, Google,
    // Anthropic, DeepSeek, Mistral, Z.ai — each both generates reviews and
    // sits on the judge panel) and the Datalab parsing API; infrastructure
    // runs on Vercel, Google Cloud, and a Postgres we operate. Keep this
    // list in sync with
    // apps/web/src/pages/ConsentPage.tsx — it is the processor list
    // participants actually consent to. Required for new uploads (the API
    // rejects uploads without consent). Nullable for legacy rows only.
    consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }),
    // Which venue's review form / rating scale the generated reviews
    // follow (iclr | icml | neurips | arr). Chosen at upload; both
    // systems in a battle inherit it. Kept as text, not a pgEnum, so
    // adding a venue needs no migration — the allowed set is enforced by
    // ConferenceSchema in packages/shared-types. Scales defined in
    // services/review-gen/app/review_forms.py.
    conference: text("conference").notNull().default("iclr"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // contentHash is NOT unique — re-uploads of the same paper get a
    // fresh row + fresh review pair, so the user can iterate on scope
    // / re-test reviewers without dedup short-circuits.
    contentHashIdx: index("papers_content_hash_idx").on(t.contentHash),
    statusIdx: index("papers_status_idx").on(t.status),
  }),
);

// ─── ReviewSystems ────────────────────────────────────────────────────────

export const reviewSystems = pgTable(
  "review_systems",
  {
    id: cuid(),
    // Stable, human-friendly identifier ("gpt-5", "claude-opus-4-8").
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Adapter dispatch key in the Python service. Often equals slug, but
    // separate so two systems can share an adapter with different configs.
    adapterKey: text("adapter_key").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    // ─── Pair-selection eligibility ────────────────────────────────────────
    // The sampler is a uniform draw over eligible pairs (select-pair.ts), so
    // every field here decides whether a matchup is ALLOWED. There is
    // deliberately no field that weights one allowed matchup above another:
    // the weighting knobs this table used to carry (boost, battle_targets)
    // belonged to the adaptive sampler and were dropped with it, as was the
    // battle_strict_targets whitelist, which no system ever set.
    //
    // Positive = eligible; 0 disables the system. The magnitude is not read:
    // a uniform draw has no weights to scale.
    sampleWeight: doublePrecision("sample_weight").notNull().default(1.0),
    // Temporarily exclude from pairing (e.g. adapter is rate-limited or
    // broken). Different from `enabled`: enabled=false stops *generation*;
    // outage=true keeps existing reviews queryable but skips them in pairs.
    outage: boolean("outage").notNull().default(false),
    // Anonymous-only system — never paired with another anonymous system.
    // Currently unused in our flow (all systems revealed on the reveal screen)
    // but kept for parity in case a future "stealth" model is added.
    anon: boolean("anon").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugIdx: uniqueIndex("review_systems_slug_uk").on(t.slug) }),
);

// ─── Reviews ──────────────────────────────────────────────────────────────

export const reviews = pgTable(
  "reviews",
  {
    id: cuid(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    reviewSystemId: text("review_system_id")
      .notNull()
      .references(() => reviewSystems.id),
    status: reviewStatusEnum("status").notNull().default("PENDING"),
    errorMessage: text("error_message"),
    // Typed shape in shared-types/structured-review.ts.
    structured: jsonb("structured"),
    rawOutput: text("raw_output"),
    generationMs: integer("generation_ms"),
    // ─── Fairness: per-generation token accounting (docs/FAIRNESS.md A4) ───
    // Proves no silent truncation and feeds verbosity analysis.
    //   inputTokensSent     — canonical tokens handed to the system
    //   inputTokensConsumed — tokens the model actually saw
    //   contextWindow       — the system's native window (logged, not used
    //                         to size input — that is equalized)
    //   outputTokens        — reference-token count of the produced review
    //   timeToFirstTokenMs  — streaming latency to first token (B2)
    inputTokensSent: integer("input_tokens_sent"),
    inputTokensConsumed: integer("input_tokens_consumed"),
    contextWindow: integer("context_window"),
    outputTokens: integer("output_tokens"),
    timeToFirstTokenMs: integer("time_to_first_token_ms"),
    // Judge-panel status of the pair this review belongs to (both reviews
    // of a pair are always set together): COMPLETE if every panel member
    // returned, PARTIAL if some did, FAILED if none. Arena reviews are not
    // judged and stay PENDING. Defaults to COMPLETE for legacy rows.
    judgeStatus: judgeStatusEnum("judge_status").notNull().default("COMPLETE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Cache-once invariant: same (paper, system) never regenerates.
    // DB-level so concurrent generation requests can't race past it.
    // (paper, system) is NOT unique — every fresh upload creates new
    // review rows even if the same paper+system pair has been reviewed
    // before. Kept as a non-unique index for query speed.
    paperSystemIdx: index("reviews_paper_system_idx").on(t.paperId, t.reviewSystemId),
    paperIdx: index("reviews_paper_idx").on(t.paperId),
    systemIdx: index("reviews_system_idx").on(t.reviewSystemId),
    statusIdx: index("reviews_status_idx").on(t.status),
  }),
);

// ─── Votes ────────────────────────────────────────────────────────────────

export const votes = pgTable(
  "votes",
  {
    id: cuid(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id),
    // Blinded positions. Reveal screen maps them back to system identities.
    // A/B is whatever the user SAW (post coin-flip in selectPair). Canonical
    // dedupe happens via `pairSig` below, not by sorting A/B here — that
    // would leak the swap into other surfaces (the reveal screen relies on
    // these being the as-displayed orientation).
    reviewAId: text("review_a_id").notNull().references(() => reviews.id),
    reviewBId: text("review_b_id").notNull().references(() => reviews.id),
    winner: voteWinnerEnum("winner").notNull(),
    // Which collection regime produced this vote. Both carry the same
    // instrument — overall verdict plus all eight dimensions — and both feed
    // the same boards: the rating path filters on review status, judge status
    // and the quality flag, never on mode. The tag exists so the offline
    // analysis can separate the two deliberately where a research question
    // calls for it, not to exclude either from the ratings.
    mode: voteModeEnum("mode").notNull().default("ARENA"),
    // Set on STUDY votes only. Ties a participant's two papers and six
    // comparisons together as one record; also what an offline analysis
    // would group on if it wanted to account for within-participant
    // correlation.
    participantId: text("participant_id").references(() => participants.id),
    // Optional free-text rationale for the overall verdict (mirrors the
    // per-dimension note; qualitative signal for thesis analysis).
    note: text("note"),
    // Anonymous session cookie. No PII column anywhere on this table by design.
    sessionId: text("session_id").notNull(),
    userAgent: text("user_agent"),
    decisionMs: integer("decision_ms"),
    // Quality flag: true if vote meets criteria for exclusion from Elo
    // (e.g., decision time < 3s). Flagged votes still recorded but excluded
    // from leaderboard computation for fairness (B4 control).
    qualityFlagged: boolean("quality_flagged").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Canonical pair signature, auto-computed by Postgres as
    // LEAST(a, b) || '|' || GREATEST(a, b). Used by the dedupe index
    // below — order-independent so a session can't slip a second vote
    // through by getting the next /pair call's A/B coin flip to land
    // the opposite way. Generated STORED so the value lives on disk
    // and existing rows backfill on column add.
    pairSig: text("pair_sig")
      .notNull()
      .generatedAlwaysAs(
        sql`LEAST(review_a_id, review_b_id) || '|' || GREATEST(review_a_id, review_b_id)`,
      ),
  },
  (t) => ({
    paperIdx: index("votes_paper_idx").on(t.paperId),
    sessionIdx: index("votes_session_idx").on(t.sessionId),
    createdIdx: index("votes_created_idx").on(t.createdAt),
    reviewAIdx: index("votes_review_a_idx").on(t.reviewAId),
    reviewBIdx: index("votes_review_b_idx").on(t.reviewBId),
    // Replay protection: one session cannot vote on the same (paper, pair)
    // twice — regardless of how A/B happened to land on each /pair call.
    // The old uk on (sessionId, paperId, reviewAId, reviewBId) leaked
    // because the A/B coin flip created two "different" orderings of the
    // same pair; pairSig collapses both into one key.
    sessionPairSigUk: uniqueIndex("votes_session_pair_sig_uk").on(
      t.sessionId,
      t.paperId,
      t.pairSig,
    ),
    qualityFlaggedIdx: index("votes_quality_flagged_idx").on(t.qualityFlagged),
  }),
);

export const dimensionVotes = pgTable(
  "dimension_votes",
  {
    id: cuid(),
    voteId: text("vote_id")
      .notNull()
      .references(() => votes.id, { onDelete: "cascade" }),
    dimension: voteDimensionEnum("dimension").notNull(),
    // Preference on this dimension, in the SAME encoding as the overall
    // verdict on `votes.winner`: "A", "B" or "TIE" (2026-09-10; previously
    // an integer -1 / 0 / +1). One convention across all nine boards means
    // one conversion to a Bradley-Terry outcome (`outcomeOf` in rating/bt.ts)
    // rather than an encoding per board, and the domain is enforced by the
    // database here exactly as it is for the overall verdict — the integer
    // column carried no CHECK, so its three-value domain held only by
    // convention at the API layer.
    winner: voteWinnerEnum("winner").notNull(),
    // Optional free-text rationale for this dimension's pick.
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One slider per dimension per vote.
    voteDimUk: uniqueIndex("dimension_votes_vote_dim_uk").on(t.voteId, t.dimension),
    dimIdx: index("dimension_votes_dim_idx").on(t.dimension),
  }),
);

// ─── Ratings / leaderboard ────────────────────────────────────────────────

// One row per (system, board, method) rating computation. Renamed from
// `elo_snapshots` on 2026-09-10: the table has held Bradley-Terry rows
// since Elo went offline-only, and the old name made every reader ask
// whether the leaderboard was still Elo. `method` still distinguishes the
// two, so nothing is lost by naming the table after what it stores.
export const ratings = pgTable(
  "ratings",
  {
    id: cuid(),
    reviewSystemId: text("review_system_id")
      .notNull()
      .references(() => reviewSystems.id),
    // null = overall leaderboard; otherwise per-dimension sub-leaderboard.
    dimension: voteDimensionEnum("dimension"),
    // Which rating system produced this row. Defaults to ELO so the migration
    // labels rows written before BT existed correctly — application code
    // always sets it explicitly.
    method: ratingMethodEnum("method").notNull().default("ELO"),
    // BT only: 'BASELINE' if RATING_BASELINE_SLUG was pinned to 1000 on this
    // board, 'MEAN' if that system had not battled here and the board was
    // mean-centred instead. Null for ELO rows, which have no free constant.
    anchor: text("anchor"),
    rating: doublePrecision("rating").notNull(),
    ratingCiLow: doublePrecision("rating_ci_low").notNull(),
    ratingCiHigh: doublePrecision("rating_ci_high").notNull(),
    voteCount: integer("vote_count").notNull(),
    // Which vote triggered this snapshot; null for batch recomputes.
    triggerVoteId: text("trigger_vote_id").references(() => votes.id),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    systemDimMethodComputedIdx: index("ratings_system_dim_method_computed_idx").on(
      t.reviewSystemId,
      t.dimension,
      t.method,
      t.computedAt,
    ),
    computedIdx: index("ratings_computed_idx").on(t.computedAt),
  }),
);

// ─── Automatic metrics ────────────────────────────────────────────────────

export const metricScores = pgTable(
  "metric_scores",
  {
    id: cuid(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    kind: metricKindEnum("kind").notNull(),
    value: doublePrecision("value").notNull(),
    referenceType: metricReferenceTypeEnum("reference_type").notNull().default("NONE"),
    meta: jsonb("meta"),
    // Slug of the review system acting as judge for this row (the panel is
    // the six study systems; each judges every study pair, itself included).
    // The backing model id is in meta.judge_model_id.
    judgeModel: text("judge_model").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A given (review, metric, reference-type, judge) is computed once and
    // cached; a re-judge replaces it. Readers aggregate across judges.
    reviewKindRefJudgeUk: uniqueIndex("metric_scores_review_kind_ref_judge_uk").on(
      t.reviewId,
      t.kind,
      t.referenceType,
      t.judgeModel,
    ),
    kindIdx: index("metric_scores_kind_idx").on(t.kind),
    judgeIdx: index("metric_scores_judge_idx").on(t.judgeModel),
  }),
);

// ─── Pairwise judge verdicts ──────────────────────────────────────────────

export const judgePreferenceEnum = pgEnum("judge_preference", ["A", "B", "TIE"]);

// One row per (judged pair, judge): each member of the judge panel reads the
// paper + BOTH reviews in one request (order-swapped double pass, Zheng et
// al. 2023 position-bias control) and emits the same construct humans give
// — a per-dimension A/B/TIE preference. "A"/"B" are relative to
// reviewAId/reviewBId ON THIS ROW; the reveal route re-maps them onto the
// vote's blinded sides and takes the panel majority. The per-review 1-10
// scores from the same request land in metric_scores, one row per judge.
export const judgeVerdicts = pgTable(
  "judge_verdicts",
  {
    id: cuid(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    reviewAId: text("review_a_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    reviewBId: text("review_b_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    overallPreference: judgePreferenceEnum("overall_preference").notNull(),
    // {DIMENSION: "A" | "B" | "TIE"} for the 8 vote dimensions.
    dimensionPreferences: jsonb("dimension_preferences").notNull(),
    // Audit trail: raw per-pass payloads, passes_used (2 = swap-consistent;
    // 1 = single valid pass, position-bias control unavailable), panel_size,
    // judge_model_id (backing model) and self_judging (the judge generated
    // one of the two reviews) — the analysis filters on these.
    meta: jsonb("meta"),
    // Slug of the review system acting as judge (see metric_scores).
    judgeModel: text("judge_model").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairJudgeUk: uniqueIndex("judge_verdicts_pair_judge_uk").on(
      t.reviewAId,
      t.reviewBId,
      t.judgeModel,
    ),
    paperIdx: index("judge_verdicts_paper_idx").on(t.paperId),
  }),
);

// ─── Study comparisons ────────────────────────────────────────────────────

// The deterministic replacement for the arena pair sampler: three rows per
// study paper, created when generation is dispatched, one per rotation
// pair. reviewAId/reviewBId already carry the blinding coin flip (which
// side each system landed on is decided at creation and stored). voteId
// links the participant's single-axis vote once cast.
export const studyComparisons = pgTable(
  "study_comparisons",
  {
    id: cuid(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    pairIndex: integer("pair_index").notNull(), // 1..3, display order
    reviewAId: text("review_a_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    reviewBId: text("review_b_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    voteId: text("vote_id").references(() => votes.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paperPairUk: uniqueIndex("study_comparisons_paper_pair_uk").on(t.paperId, t.pairIndex),
  }),
);

// ─── Relations (only the joins we actually traverse in code) ──────────────

export const papersRelations = relations(papers, ({ many }) => ({
  reviews: many(reviews),
  votes: many(votes),
}));

export const reviewSystemsRelations = relations(reviewSystems, ({ many }) => ({
  reviews: many(reviews),
  ratings: many(ratings),
}));

export const reviewsRelations = relations(reviews, ({ one, many }) => ({
  paper: one(papers, { fields: [reviews.paperId], references: [papers.id] }),
  reviewSystem: one(reviewSystems, {
    fields: [reviews.reviewSystemId],
    references: [reviewSystems.id],
  }),
  metricScores: many(metricScores),
}));

export const votesRelations = relations(votes, ({ one, many }) => ({
  paper: one(papers, { fields: [votes.paperId], references: [papers.id] }),
  reviewA: one(reviews, {
    fields: [votes.reviewAId],
    references: [reviews.id],
    relationName: "voteReviewA",
  }),
  reviewB: one(reviews, {
    fields: [votes.reviewBId],
    references: [reviews.id],
    relationName: "voteReviewB",
  }),
  dimensions: many(dimensionVotes),
}));

export const dimensionVotesRelations = relations(dimensionVotes, ({ one }) => ({
  vote: one(votes, { fields: [dimensionVotes.voteId], references: [votes.id] }),
}));

export const ratingsRelations = relations(ratings, ({ one }) => ({
  reviewSystem: one(reviewSystems, {
    fields: [ratings.reviewSystemId],
    references: [reviewSystems.id],
  }),
  triggerVote: one(votes, {
    fields: [ratings.triggerVoteId],
    references: [votes.id],
  }),
}));

export const metricScoresRelations = relations(metricScores, ({ one }) => ({
  review: one(reviews, { fields: [metricScores.reviewId], references: [reviews.id] }),
}));

// ─── Runtime settings ─────────────────────────────────────────────────────
//
// Operational switches the study runner flips between sessions, kept in the
// database rather than the environment so they take effect without a
// redeploy and without shelling into the VM mid-session. Not configuration:
// anything that belongs in .env stays in .env.

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Type re-exports for convenience ──────────────────────────────────────

export type Paper = typeof papers.$inferSelect;
export type NewPaper = typeof papers.$inferInsert;
export type ReviewSystem = typeof reviewSystems.$inferSelect;
export type NewReviewSystem = typeof reviewSystems.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Vote = typeof votes.$inferSelect;
export type NewVote = typeof votes.$inferInsert;
export type DimensionVote = typeof dimensionVotes.$inferSelect;
export type Rating = typeof ratings.$inferSelect;
export type MetricScore = typeof metricScores.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
