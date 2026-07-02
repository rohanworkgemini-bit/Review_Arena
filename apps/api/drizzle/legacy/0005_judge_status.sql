-- Track judge execution status per review so failed judge calls don't
-- corrupt the leaderboard. Stores COMPLETE | PARTIAL | FAILED.
-- COMPLETE: both judge passes succeeded, all scores populated.
-- PARTIAL: one judge pass succeeded, scores from first pass.
-- FAILED: all judge passes failed, no scores recorded.
-- Defaults to COMPLETE for existing rows (backwards compat).

DO $$ BEGIN
  CREATE TYPE judge_status_enum AS ENUM ('COMPLETE', 'PARTIAL', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "reviews"
  ADD COLUMN IF NOT EXISTS "judge_status" judge_status_enum DEFAULT 'COMPLETE';
