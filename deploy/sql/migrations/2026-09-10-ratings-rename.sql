-- elo_snapshots -> ratings (2026-09-10).
--
-- The table has held nothing but Bradley-Terry rows since online Elo went
-- offline-only (see routes/leaderboard.ts), so the name asked every reader
-- whether the leaderboard was still Elo when it is not. The `method` column
-- still separates BT from the legacy ELO rows, so naming the table after
-- what it stores loses nothing.
--
-- Pure rename: no column is added, dropped, or rewritten, and every row and
-- foreign key survives. Postgres rewrites the dependent constraints and
-- indexes' *targets* automatically; only their names are cosmetic, which is
-- why they are renamed explicitly below.
--
-- Apply, as with the other deploy SQL (drizzle-kit is not in the prod image):
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/migrations/2026-09-10-ratings-rename.sql
--
-- IDEMPOTENT: re-running against an already-renamed database is a no-op.
--
-- ORDER MATTERS relative to the code deploy. The running API queries
-- whichever name its image was built with, so rename and restart together;
-- a rename with the old image still up means every leaderboard read fails
-- until the new image lands.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ratings') THEN
    RAISE NOTICE 'ratings: already renamed, skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'elo_snapshots') THEN
    RAISE EXCEPTION
      'neither elo_snapshots nor ratings exists -- refusing to guess at the '
      'shape of this database';
  END IF;

  RAISE NOTICE 'renaming elo_snapshots -> ratings';
  ALTER TABLE elo_snapshots RENAME TO ratings;
END $$;

-- Indexes and constraints keep their old names through a table rename.
-- Rename them too, so a future drizzle-kit diff does not see a mismatch and
-- propose dropping and recreating them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT indexname AS old_name,
           regexp_replace(indexname, '^elo_snapshots', 'ratings') AS new_name
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname LIKE 'elo\_snapshots%'
  LOOP
    RAISE NOTICE 'renaming index % -> %', r.old_name, r.new_name;
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
  END LOOP;

  FOR r IN
    SELECT conname AS old_name,
           regexp_replace(conname, '^elo_snapshots', 'ratings') AS new_name
    FROM pg_constraint
    WHERE conrelid = 'ratings'::regclass AND conname LIKE 'elo\_snapshots%'
  LOOP
    RAISE NOTICE 'renaming constraint % -> %', r.old_name, r.new_name;
    EXECUTE format('ALTER TABLE ratings RENAME CONSTRAINT %I TO %I', r.old_name, r.new_name);
  END LOOP;
END $$;

COMMIT;

-- ─── Verify ────────────────────────────────────────────────────────────
--   \d ratings
--   SELECT method, count(*) FROM ratings GROUP BY method ORDER BY method;
--
-- The row count must match what elo_snapshots held before the rename; a
-- rename moves rows, it does not touch them.
