-- DESTRUCTIVE. Empties every study/arena data table so a study can start
-- from zero, keeping the schema and the review_systems registry.
--
-- The host-side equivalent is apps/api/scripts/wipe-data.ts, but that needs
-- a DATABASE_URL and prod Postgres publishes no host port, so this goes
-- through the same `exec -T postgres psql` path as the rest of deploy/.
--
-- TAKE A BACKUP FIRST — ./deploy/backup.sh — and check the dump is non-empty.
-- The votes table is the thesis dataset; there is no undo here.
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena -v confirm=yes \
--     < deploy/reset-study-data.sql
--
-- Without -v confirm=yes it prints the current row counts and changes
-- nothing, which is the intended way to look before leaping.
--
-- Participants are dropped too: a fresh study means a fresh pool, and the
-- codes on an old handout sheet must stop working. Re-mint straight after
-- with deploy/mint-participants.sql, real and test batches separately.

\echo ''
\echo 'Current row counts:'
SELECT 'participants'     AS table, count(*) FROM participants
UNION ALL SELECT 'papers',            count(*) FROM papers
UNION ALL SELECT 'reviews',           count(*) FROM reviews
UNION ALL SELECT 'votes',             count(*) FROM votes
UNION ALL SELECT 'dimension_votes',   count(*) FROM dimension_votes
UNION ALL SELECT 'ratings',           count(*) FROM ratings
UNION ALL SELECT 'judge_verdicts',    count(*) FROM judge_verdicts
UNION ALL SELECT 'study_comparisons', count(*) FROM study_comparisons
UNION ALL SELECT 'metric_scores',     count(*) FROM metric_scores
UNION ALL SELECT 'review_systems',    count(*) FROM review_systems;

\if :{?confirm}
\else
  \set confirm no
\endif

\if :confirm
\else
  \echo ''
  \echo 'DRY RUN — nothing deleted. Re-run with -v confirm=yes to wipe.'
  \q
\endif

-- One statement, one transaction: an FK or trigger error can never leave
-- the study half-wiped. CASCADE walks the FKs so the order below does not
-- have to be exactly right; RESTART IDENTITY resets sequence counters.
TRUNCATE TABLE
  judge_verdicts,
  study_comparisons,
  metric_scores,
  ratings,
  dimension_votes,
  votes,
  reviews,
  papers,
  participants
RESTART IDENTITY CASCADE;

\echo ''
\echo 'After the wipe (review_systems is deliberately preserved):'
SELECT 'participants'     AS table, count(*) FROM participants
UNION ALL SELECT 'papers',            count(*) FROM papers
UNION ALL SELECT 'reviews',           count(*) FROM reviews
UNION ALL SELECT 'votes',             count(*) FROM votes
UNION ALL SELECT 'dimension_votes',   count(*) FROM dimension_votes
UNION ALL SELECT 'ratings',           count(*) FROM ratings
UNION ALL SELECT 'judge_verdicts',    count(*) FROM judge_verdicts
UNION ALL SELECT 'study_comparisons', count(*) FROM study_comparisons
UNION ALL SELECT 'metric_scores',     count(*) FROM metric_scores
UNION ALL SELECT 'review_systems',    count(*) FROM review_systems;
