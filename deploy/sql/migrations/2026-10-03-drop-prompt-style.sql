-- Drops papers.prompt_style. The review prompt is now determined by the
-- venue alone (a venue form, or the venue-neutral General form), so the
-- column carries no information: every existing row holds the blanket
-- 'study' backfill from when the column was added.
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/migrations/2026-10-03-drop-prompt-style.sql
BEGIN;
ALTER TABLE papers DROP COLUMN IF EXISTS prompt_style;
COMMIT;
