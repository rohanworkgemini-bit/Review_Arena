ALTER TABLE "public"."metric_scores" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."metric_kind";--> statement-breakpoint
CREATE TYPE "public"."metric_kind" AS ENUM('LLM_JUDGE_OVERALL');--> statement-breakpoint
-- BLEU/ROUGE removed: purge any rows of the dropped kinds BEFORE the
-- cast back to the narrowed enum, otherwise the USING cast throws.
DELETE FROM "public"."metric_scores" WHERE "kind" NOT IN ('LLM_JUDGE_OVERALL');--> statement-breakpoint
ALTER TABLE "public"."metric_scores" ALTER COLUMN "kind" SET DATA TYPE "public"."metric_kind" USING "kind"::"public"."metric_kind";