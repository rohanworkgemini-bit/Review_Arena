-- Schema catch-up for the judge-panel + settings work, for a production
-- database that predates it.
--
-- The prod API image is built with `pnpm install --prod`, which drops
-- drizzle-kit, so `drizzle-kit push` cannot run inside the container. This
-- is the same set of changes expressed as SQL, applied through postgres
-- directly:
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/migrations/2026-09-08-judge-panel.sql
--
-- Idempotent by construction: every step checks first, so re-running it is
-- a no-op and applying it to an already-current database is safe.
--
-- ONE DESTRUCTIVE STEP, and only on a database that has not been migrated:
-- metric_scores and judge_verdicts are TRUNCATED before judge_model is
-- added. The column is NOT NULL and there is no honest value to backfill —
-- rows written before the panel existed came from a single judge whose
-- identity was never recorded. Both tables are derived: every row is
-- rebuilt by
--
--   scripts/rescore-missing.ts
--
-- Human votes, papers, reviews and participants are untouched.

BEGIN;

-- ─── metric_scores.judge_model ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'metric_scores' AND column_name = 'judge_model'
  ) THEN
    RAISE NOTICE 'metric_scores: adding judge_model (truncating derived rows first)';
    TRUNCATE TABLE metric_scores;
    ALTER TABLE metric_scores ADD COLUMN judge_model text NOT NULL;
  ELSE
    RAISE NOTICE 'metric_scores: judge_model already present, skipping';
  END IF;
END $$;

-- The uniqueness rule widens: one score per review per kind per REFERENCE
-- per JUDGE, because six judges now score the same review.
DROP INDEX IF EXISTS metric_scores_review_kind_ref_uk;
CREATE UNIQUE INDEX IF NOT EXISTS metric_scores_review_kind_ref_judge_uk
  ON metric_scores (review_id, kind, reference_type, judge_model);
CREATE INDEX IF NOT EXISTS metric_scores_judge_idx ON metric_scores (judge_model);

-- ─── judge_verdicts.judge_model ────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'judge_verdicts' AND column_name = 'judge_model'
  ) THEN
    RAISE NOTICE 'judge_verdicts: adding judge_model (truncating derived rows first)';
    TRUNCATE TABLE judge_verdicts;
    ALTER TABLE judge_verdicts ADD COLUMN judge_model text NOT NULL;
  ELSE
    RAISE NOTICE 'judge_verdicts: judge_model already present, skipping';
  END IF;
END $$;

-- One verdict per pair per judge, not one per pair.
DROP INDEX IF EXISTS judge_verdicts_pair_uk;
CREATE UNIQUE INDEX IF NOT EXISTS judge_verdicts_pair_judge_uk
  ON judge_verdicts (review_a_id, review_b_id, judge_model);

-- ─── app_settings ──────────────────────────────────────────────────────
-- Runtime switches the study runner flips between sessions — currently
-- just whether the judge panel runs. Absent, the API falls back to its
-- documented defaults, so this is additive.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

COMMIT;

-- ─── What the deployment should look like afterwards ───────────────────
\echo ''
\echo 'Post-migration state:'
SELECT
  (SELECT count(*) FROM papers)                                   AS papers,
  (SELECT count(*) FROM votes)                                    AS votes,
  (SELECT count(*) FROM reviews)                                  AS reviews,
  (SELECT count(*) FROM metric_scores)                            AS metric_scores,
  (SELECT count(*) FROM judge_verdicts)                           AS judge_verdicts,
  (SELECT count(*) FROM participants)                             AS participants,
  (SELECT count(*) FROM review_systems WHERE enabled)             AS enabled_systems;
\echo ''
\echo 'metric_scores / judge_verdicts at 0 is expected on a first run.'
\echo 'Rebuild them with:  scripts/rescore-missing.ts'
