-- The whole schema, from an empty database. Generated from
-- apps/api/src/db/schema.ts with `drizzle-kit generate`; if schema.ts
-- changes, regenerate this file rather than adding a migration next to it.
--
-- Fresh database only: it creates every type and table, and fails on a
-- database that already has them. Run it, then seed the review systems:
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena -v ON_ERROR_STOP=1 < deploy/sql/migrations/init.sql
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/ops/seed-systems.sql
--
-- Locally, `pnpm --filter @reviewarena/api db:push` does the same from
-- schema.ts directly.
BEGIN;

CREATE TYPE "public"."judge_preference" AS ENUM('A', 'B', 'TIE');
CREATE TYPE "public"."judge_status" AS ENUM('PENDING', 'COMPLETE', 'PARTIAL', 'FAILED', 'RUNNING');
CREATE TYPE "public"."metric_kind" AS ENUM('LLM_JUDGE_OVERALL');
CREATE TYPE "public"."metric_reference_type" AS ENUM('NONE', 'HUMAN_REVIEW', 'OTHER_SYSTEM');
CREATE TYPE "public"."paper_status" AS ENUM('UPLOADED', 'PARSING', 'PARSED', 'PARSE_FAILED');
CREATE TYPE "public"."rating_method" AS ENUM('ELO', 'BT');
CREATE TYPE "public"."review_status" AS ENUM('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');
CREATE TYPE "public"."vote_dimension" AS ENUM('CONTRIBUTION_ACCURACY', 'RESULTS_INTERPRETATION', 'COMPARATIVE_ANALYSIS', 'EVIDENCE_BASED_CRITIQUE', 'CRITIQUE_CLARITY', 'COMPLETENESS_COVERAGE', 'CONSTRUCTIVE_TONE', 'FALSE_CLAIMS');
CREATE TYPE "public"."vote_mode" AS ENUM('ARENA', 'STUDY');
CREATE TYPE "public"."vote_winner" AS ENUM('A', 'B', 'TIE');
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "dimension_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"vote_id" text NOT NULL,
	"dimension" "vote_dimension" NOT NULL,
	"winner" "vote_winner" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "judge_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"review_a_id" text NOT NULL,
	"review_b_id" text NOT NULL,
	"overall_preference" "judge_preference" NOT NULL,
	"dimension_preferences" jsonb NOT NULL,
	"meta" jsonb,
	"judge_model" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "metric_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"kind" "metric_kind" NOT NULL,
	"value" double precision NOT NULL,
	"reference_type" "metric_reference_type" DEFAULT 'NONE' NOT NULL,
	"meta" jsonb,
	"judge_model" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "papers" (
	"id" text PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"user_title" text,
	"extracted_title" text,
	"authors" jsonb,
	"abstract" text,
	"pdf_path" text,
	"page_count" integer,
	"status" "paper_status" DEFAULT 'UPLOADED' NOT NULL,
	"error_message" text,
	"participant_id" text,
	"paper_index" integer,
	"rotation_id" integer,
	"parsed_structure" jsonb,
	"parser_raw_xml" text,
	"canonical_text" text,
	"canonical_tokens" integer,
	"full_tokens" integer,
	"length_band" text,
	"uploaded_by_session_id" text,
	"consent_accepted_at" timestamp with time zone,
	"conference" text DEFAULT 'iclr' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_code_unique" UNIQUE("code")
);

CREATE TABLE "ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"review_system_id" text NOT NULL,
	"dimension" "vote_dimension",
	"method" "rating_method" DEFAULT 'ELO' NOT NULL,
	"anchor" text,
	"rating" double precision NOT NULL,
	"rating_ci_low" double precision NOT NULL,
	"rating_ci_high" double precision NOT NULL,
	"vote_count" integer NOT NULL,
	"trigger_vote_id" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "review_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"adapter_key" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sample_weight" double precision DEFAULT 1 NOT NULL,
	"outage" boolean DEFAULT false NOT NULL,
	"anon" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"review_system_id" text NOT NULL,
	"status" "review_status" DEFAULT 'PENDING' NOT NULL,
	"error_message" text,
	"structured" jsonb,
	"raw_output" text,
	"generation_ms" integer,
	"input_tokens_sent" integer,
	"input_tokens_consumed" integer,
	"context_window" integer,
	"output_tokens" integer,
	"time_to_first_token_ms" integer,
	"judge_status" "judge_status" DEFAULT 'COMPLETE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "study_comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"pair_index" integer NOT NULL,
	"review_a_id" text NOT NULL,
	"review_b_id" text NOT NULL,
	"vote_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"review_a_id" text NOT NULL,
	"review_b_id" text NOT NULL,
	"winner" "vote_winner" NOT NULL,
	"mode" "vote_mode" DEFAULT 'ARENA' NOT NULL,
	"participant_id" text,
	"note" text,
	"session_id" text NOT NULL,
	"user_agent" text,
	"decision_ms" integer,
	"quality_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pair_sig" text GENERATED ALWAYS AS (LEAST(review_a_id, review_b_id) || '|' || GREATEST(review_a_id, review_b_id)) STORED NOT NULL
);

ALTER TABLE "dimension_votes" ADD CONSTRAINT "dimension_votes_vote_id_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."votes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "judge_verdicts" ADD CONSTRAINT "judge_verdicts_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "judge_verdicts" ADD CONSTRAINT "judge_verdicts_review_a_id_reviews_id_fk" FOREIGN KEY ("review_a_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "judge_verdicts" ADD CONSTRAINT "judge_verdicts_review_b_id_reviews_id_fk" FOREIGN KEY ("review_b_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "metric_scores" ADD CONSTRAINT "metric_scores_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "papers" ADD CONSTRAINT "papers_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_review_system_id_review_systems_id_fk" FOREIGN KEY ("review_system_id") REFERENCES "public"."review_systems"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_trigger_vote_id_votes_id_fk" FOREIGN KEY ("trigger_vote_id") REFERENCES "public"."votes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_review_system_id_review_systems_id_fk" FOREIGN KEY ("review_system_id") REFERENCES "public"."review_systems"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "study_comparisons" ADD CONSTRAINT "study_comparisons_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "study_comparisons" ADD CONSTRAINT "study_comparisons_review_a_id_reviews_id_fk" FOREIGN KEY ("review_a_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "study_comparisons" ADD CONSTRAINT "study_comparisons_review_b_id_reviews_id_fk" FOREIGN KEY ("review_b_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "study_comparisons" ADD CONSTRAINT "study_comparisons_vote_id_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."votes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "votes" ADD CONSTRAINT "votes_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "votes" ADD CONSTRAINT "votes_review_a_id_reviews_id_fk" FOREIGN KEY ("review_a_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "votes" ADD CONSTRAINT "votes_review_b_id_reviews_id_fk" FOREIGN KEY ("review_b_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "votes" ADD CONSTRAINT "votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "dimension_votes_vote_dim_uk" ON "dimension_votes" USING btree ("vote_id","dimension");
CREATE INDEX "dimension_votes_dim_idx" ON "dimension_votes" USING btree ("dimension");
CREATE UNIQUE INDEX "judge_verdicts_pair_judge_uk" ON "judge_verdicts" USING btree ("review_a_id","review_b_id","judge_model");
CREATE INDEX "judge_verdicts_paper_idx" ON "judge_verdicts" USING btree ("paper_id");
CREATE UNIQUE INDEX "metric_scores_review_kind_ref_judge_uk" ON "metric_scores" USING btree ("review_id","kind","reference_type","judge_model");
CREATE INDEX "metric_scores_kind_idx" ON "metric_scores" USING btree ("kind");
CREATE INDEX "metric_scores_judge_idx" ON "metric_scores" USING btree ("judge_model");
CREATE INDEX "papers_content_hash_idx" ON "papers" USING btree ("content_hash");
CREATE INDEX "papers_status_idx" ON "papers" USING btree ("status");
CREATE INDEX "ratings_system_dim_method_computed_idx" ON "ratings" USING btree ("review_system_id","dimension","method","computed_at");
CREATE INDEX "ratings_computed_idx" ON "ratings" USING btree ("computed_at");
CREATE UNIQUE INDEX "review_systems_slug_uk" ON "review_systems" USING btree ("slug");
CREATE INDEX "reviews_paper_system_idx" ON "reviews" USING btree ("paper_id","review_system_id");
CREATE INDEX "reviews_paper_idx" ON "reviews" USING btree ("paper_id");
CREATE INDEX "reviews_system_idx" ON "reviews" USING btree ("review_system_id");
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");
CREATE UNIQUE INDEX "study_comparisons_paper_pair_uk" ON "study_comparisons" USING btree ("paper_id","pair_index");
CREATE INDEX "votes_paper_idx" ON "votes" USING btree ("paper_id");
CREATE INDEX "votes_session_idx" ON "votes" USING btree ("session_id");
CREATE INDEX "votes_created_idx" ON "votes" USING btree ("created_at");
CREATE INDEX "votes_review_a_idx" ON "votes" USING btree ("review_a_id");
CREATE INDEX "votes_review_b_idx" ON "votes" USING btree ("review_b_id");
CREATE UNIQUE INDEX "votes_session_pair_sig_uk" ON "votes" USING btree ("session_id","paper_id","pair_sig");
CREATE INDEX "votes_quality_flagged_idx" ON "votes" USING btree ("quality_flagged");
COMMIT;
