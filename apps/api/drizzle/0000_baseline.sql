CREATE TYPE "public"."claim_verdict" AS ENUM('SUPPORTED', 'CONTRADICTED', 'UNSUPPORTED');--> statement-breakpoint
CREATE TYPE "public"."judge_status" AS ENUM('COMPLETE', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."metric_kind" AS ENUM('BLEU', 'ROUGE_1', 'ROUGE_2', 'ROUGE_L', 'LLM_JUDGE_OVERALL', 'LLM_JUDGE_VERIFIABILITY');--> statement-breakpoint
CREATE TYPE "public"."metric_reference_type" AS ENUM('NONE', 'HUMAN_REVIEW', 'OTHER_SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."paper_status" AS ENUM('UPLOADED', 'PARSING', 'PARSED', 'PARSE_FAILED');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."vote_dimension" AS ENUM('COMPREHENSIVENESS', 'CLARITY', 'FAIRNESS', 'ACTIONABILITY', 'CONSTRUCTIVENESS', 'OBJECTIVITY', 'RELEVANCE', 'TECHNICAL_TERMS');--> statement-breakpoint
CREATE TYPE "public"."vote_winner" AS ENUM('A', 'B', 'TIE');--> statement-breakpoint
CREATE TABLE "claim_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"claim_text" text NOT NULL,
	"verdict" "claim_verdict" NOT NULL,
	"evidence" text,
	"judge_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimension_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"vote_id" text NOT NULL,
	"dimension" "vote_dimension" NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elo_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"review_system_id" text NOT NULL,
	"dimension" "vote_dimension",
	"rating" double precision NOT NULL,
	"rating_ci_low" double precision NOT NULL,
	"rating_ci_high" double precision NOT NULL,
	"vote_count" integer NOT NULL,
	"trigger_vote_id" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"kind" "metric_kind" NOT NULL,
	"value" double precision NOT NULL,
	"reference_type" "metric_reference_type" DEFAULT 'NONE' NOT NULL,
	"meta" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"parsed_structure" jsonb,
	"parser_raw_xml" text,
	"canonical_text" text,
	"canonical_tokens" integer,
	"full_tokens" integer,
	"length_band" text,
	"uploaded_by_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"adapter_key" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sample_weight" double precision DEFAULT 1 NOT NULL,
	"boost" boolean DEFAULT false NOT NULL,
	"outage" boolean DEFAULT false NOT NULL,
	"anon" boolean DEFAULT false NOT NULL,
	"battle_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"battle_strict_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"selected_section_ids" jsonb,
	"judge_status" "judge_status" DEFAULT 'COMPLETE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"review_a_id" text NOT NULL,
	"review_b_id" text NOT NULL,
	"winner" "vote_winner" NOT NULL,
	"session_id" text NOT NULL,
	"user_agent" text,
	"decision_ms" integer,
	"quality_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pair_sig" text GENERATED ALWAYS AS (LEAST(review_a_id, review_b_id) || '|' || GREATEST(review_a_id, review_b_id)) STORED NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_checks" ADD CONSTRAINT "claim_checks_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_votes" ADD CONSTRAINT "dimension_votes_vote_id_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elo_snapshots" ADD CONSTRAINT "elo_snapshots_review_system_id_review_systems_id_fk" FOREIGN KEY ("review_system_id") REFERENCES "public"."review_systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elo_snapshots" ADD CONSTRAINT "elo_snapshots_trigger_vote_id_votes_id_fk" FOREIGN KEY ("trigger_vote_id") REFERENCES "public"."votes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_scores" ADD CONSTRAINT "metric_scores_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_review_system_id_review_systems_id_fk" FOREIGN KEY ("review_system_id") REFERENCES "public"."review_systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_review_a_id_reviews_id_fk" FOREIGN KEY ("review_a_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_review_b_id_reviews_id_fk" FOREIGN KEY ("review_b_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_checks_review_idx" ON "claim_checks" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "claim_checks_verdict_idx" ON "claim_checks" USING btree ("verdict");--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_votes_vote_dim_uk" ON "dimension_votes" USING btree ("vote_id","dimension");--> statement-breakpoint
CREATE INDEX "dimension_votes_dim_idx" ON "dimension_votes" USING btree ("dimension");--> statement-breakpoint
CREATE INDEX "elo_snapshots_system_dim_computed_idx" ON "elo_snapshots" USING btree ("review_system_id","dimension","computed_at");--> statement-breakpoint
CREATE INDEX "elo_snapshots_computed_idx" ON "elo_snapshots" USING btree ("computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_scores_review_kind_ref_uk" ON "metric_scores" USING btree ("review_id","kind","reference_type");--> statement-breakpoint
CREATE INDEX "metric_scores_kind_idx" ON "metric_scores" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "papers_content_hash_idx" ON "papers" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "papers_status_idx" ON "papers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "review_systems_slug_uk" ON "review_systems" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "reviews_paper_system_idx" ON "reviews" USING btree ("paper_id","review_system_id");--> statement-breakpoint
CREATE INDEX "reviews_paper_idx" ON "reviews" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "reviews_system_idx" ON "reviews" USING btree ("review_system_id");--> statement-breakpoint
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "votes_paper_idx" ON "votes" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "votes_session_idx" ON "votes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "votes_created_idx" ON "votes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "votes_review_a_idx" ON "votes" USING btree ("review_a_id");--> statement-breakpoint
CREATE INDEX "votes_review_b_idx" ON "votes" USING btree ("review_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_session_pair_sig_uk" ON "votes" USING btree ("session_id","paper_id","pair_sig");--> statement-breakpoint
CREATE INDEX "votes_quality_flagged_idx" ON "votes" USING btree ("quality_flagged");