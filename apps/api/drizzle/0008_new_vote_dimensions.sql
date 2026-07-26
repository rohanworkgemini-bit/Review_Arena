-- Replace the eight per-dimension comparison axes with the paper-grounded
-- rubric (contribution accuracy, results interpretation, comparative
-- analysis, evidence-based critique, critique clarity, completeness
-- coverage, constructive tone, factual reliability).
--
-- The old axes (COMPREHENSIVENESS, CLARITY, FAIRNESS, ACTIONABILITY,
-- CONSTRUCTIVENESS, OBJECTIVITY, RELEVANCE, TECHNICAL_TERMS) are not
-- semantically equivalent to the new ones, so pilot dimension votes cannot
-- be carried over — they are deleted rather than remapped, so that every
-- per-dimension vote in the dataset means exactly one thing.
--
-- KEPT: papers, reviews, votes (the overall A/B verdicts) and the overall
-- Elo history. Only per-dimension data is reset.

-- 1. Drop pilot per-dimension votes.
DELETE FROM "dimension_votes";
--> statement-breakpoint

-- 2. Drop per-dimension Elo snapshots (derived from the votes above).
--    Overall snapshots (dimension IS NULL) are preserved.
DELETE FROM "elo_snapshots" WHERE "dimension" IS NOT NULL;
--> statement-breakpoint

-- 3. Detach both columns from the enum so the type can be replaced.
ALTER TABLE "dimension_votes" ALTER COLUMN "dimension" TYPE text;
--> statement-breakpoint
ALTER TABLE "elo_snapshots" ALTER COLUMN "dimension" TYPE text;
--> statement-breakpoint

-- 4. Swap the enum definition.
DROP TYPE "public"."vote_dimension";
--> statement-breakpoint
CREATE TYPE "public"."vote_dimension" AS ENUM('CONTRIBUTION_ACCURACY', 'RESULTS_INTERPRETATION', 'COMPARATIVE_ANALYSIS', 'EVIDENCE_BASED_CRITIQUE', 'CRITIQUE_CLARITY', 'COMPLETENESS_COVERAGE', 'CONSTRUCTIVE_TONE', 'FALSE_CLAIMS');
--> statement-breakpoint

-- 5. Re-attach the columns to the new type.
ALTER TABLE "dimension_votes" ALTER COLUMN "dimension" TYPE "public"."vote_dimension" USING "dimension"::"public"."vote_dimension";
--> statement-breakpoint
ALTER TABLE "elo_snapshots" ALTER COLUMN "dimension" TYPE "public"."vote_dimension" USING "dimension"::"public"."vote_dimension";
