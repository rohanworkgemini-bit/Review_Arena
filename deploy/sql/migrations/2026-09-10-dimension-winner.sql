-- dimension_votes: signed integer -> the same A / B / TIE encoding the
-- overall verdict already uses (2026-09-10).
--
-- Before: dimension_votes.value  integer, -1 = A better, 0 = tie, +1 = B better
-- After:  dimension_votes.winner vote_winner, 'A' | 'B' | 'TIE'
--
-- Why: the overall verdict and the eight per-dimension verdicts are the same
-- kind of datum and were stored two different ways, so the conversion to a
-- Bradley-Terry outcome existed twice -- routes/votes.ts branched on the sign
-- and thesis-analysis.ts branched on equality. Those agreed on -1/0/+1 and
-- disagreed on anything else, and nothing at the database level ruled
-- anything else out: `value` was a plain integer with no CHECK, whereas the
-- overall verdict has always been a pgEnum. One encoding means one converter
-- (outcomeOf in src/elo/elo.ts) for all nine boards, and a domain the
-- database enforces.
--
-- Apply, as with the other deploy SQL (drizzle-kit is not in the prod image):
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/migrations/2026-09-10-dimension-winner.sql
--
-- LOSSLESS AND IDEMPOTENT. Every recorded pick maps onto exactly one of the
-- three labels, the backfill runs before the old column is dropped, and
-- re-running the script on an already-migrated database is a no-op.
--
-- DO NOT reach for `drizzle-kit push` for this one. Push diffs the schema
-- and would drop `value` and add a NOT NULL `winner` with no backfill
-- between the two, which on a database holding real votes either fails on
-- the NOT NULL or silently discards every per-dimension judgment. The
-- backfill below is the whole point of doing it as SQL.

BEGIN;

-- ─── Guard: refuse to run against unexpected data ──────────────────────
-- The mapping below is exhaustive over {-1, 0, +1}. If a row carries
-- anything else, the intended verdict is genuinely unknown -- the two
-- converters in the old code disagreed about such a row -- so stop rather
-- than guess.
DO $$
DECLARE
  stray bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dimension_votes' AND column_name = 'value'
  ) THEN
    SELECT count(*) INTO stray
    FROM dimension_votes
    WHERE value NOT IN (-1, 0, 1);

    IF stray > 0 THEN
      RAISE EXCEPTION
        'dimension_votes: % row(s) hold a value outside (-1, 0, 1); '
        'inspect them before migrating -- the old code paths disagreed '
        'about what such a row means', stray;
    END IF;
  END IF;
END $$;

-- ─── dimension_votes.winner ────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dimension_votes' AND column_name = 'winner'
  ) THEN
    RAISE NOTICE 'dimension_votes: winner already present, skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dimension_votes' AND column_name = 'value'
  ) THEN
    RAISE EXCEPTION
      'dimension_votes has neither `value` nor `winner` -- refusing to '
      'guess at the shape of this database';
  END IF;

  RAISE NOTICE 'dimension_votes: adding winner and backfilling from value';

  -- Nullable first, so the backfill has somewhere to land.
  ALTER TABLE dimension_votes ADD COLUMN winner vote_winner;

  --  -1 = A better  ->  'A'
  --  +1 = B better  ->  'B'
  --   0 = tie       ->  'TIE'
  UPDATE dimension_votes
  SET winner = CASE
                 WHEN value < 0 THEN 'A'::vote_winner
                 WHEN value > 0 THEN 'B'::vote_winner
                 ELSE 'TIE'::vote_winner
               END;

  ALTER TABLE dimension_votes ALTER COLUMN winner SET NOT NULL;
  ALTER TABLE dimension_votes DROP COLUMN value;
END $$;

COMMIT;

-- ─── Verify ────────────────────────────────────────────────────────────
-- Expect one row per label actually used, and a total matching
-- (number of votes) x 8.
--
--   SELECT winner, count(*) FROM dimension_votes GROUP BY winner ORDER BY winner;
--   SELECT (SELECT count(*) FROM dimension_votes) AS dim_rows,
--          (SELECT count(*) * 8 FROM votes)       AS expected;
--
-- No snapshot rebuild is needed. The mapping is lossless and the converter
-- lands on the same outcome as before for every recorded row, so each of the
-- nine boards refits to exactly the numbers it already holds. The next vote
-- recomputes them all in the normal way regardless.
--
-- (Do not reach for scripts/seed-demo-votes.ts to force a recompute. It
-- INSERTS synthetic votes, which is the last thing a study database wants.)
