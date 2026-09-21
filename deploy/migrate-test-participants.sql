-- participants.is_test — dry-run codes (T01, T02, …) that walk the real
-- study path and are filtered back out at read time: out of the
-- Bradley-Terry fit (routes/votes.ts loadBattles) and out of the admin
-- exports. Existing rows are real participants, which is what the default
-- says, so this is safe to run against a live database mid-study.
--
-- Matches apps/api/src/db/schema.ts. `db:push` produces the same column;
-- this file exists for the production box, where the runbook applies SQL
-- by hand rather than pointing drizzle-kit at the live database.
--
--   docker exec -i reviewarena-postgres psql -U reviewarena -d reviewarena \
--     < deploy/migrate-test-participants.sql

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- Report, so the operator sees what the study pool looks like afterwards.
SELECT
  count(*) FILTER (WHERE NOT is_test) AS real_participants,
  count(*) FILTER (WHERE is_test)     AS test_participants
FROM participants;
