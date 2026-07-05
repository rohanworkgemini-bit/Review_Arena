DROP TABLE "claim_checks" CASCADE;--> statement-breakpoint
-- Purge rows on the retired metric kind before the enum is narrowed, else
-- the USING cast below fails on any DB that recorded verifiability scores.
DELETE FROM "public"."metric_scores" WHERE "kind" = 'LLM_JUDGE_VERIFIABILITY';--> statement-breakpoint
ALTER TABLE "public"."metric_scores" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."metric_kind";--> statement-breakpoint
CREATE TYPE "public"."metric_kind" AS ENUM('BLEU', 'ROUGE_1', 'ROUGE_2', 'ROUGE_L', 'LLM_JUDGE_OVERALL');--> statement-breakpoint
ALTER TABLE "public"."metric_scores" ALTER COLUMN "kind" SET DATA TYPE "public"."metric_kind" USING "kind"::"public"."metric_kind";--> statement-breakpoint
DROP TYPE "public"."claim_verdict";