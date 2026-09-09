-- Drop the online-Elo leaderboard rows, now that Elo is offline-only.
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/cleanup-elo-snapshots.sql
--
-- Context. The API no longer computes online Elo: snapshotLeaderboard()
-- writes method='BT' rows only, and the leaderboard route reads only those
-- (routes/leaderboard.ts, METHOD = "BT"). The method='ELO' rows written
-- before that change are dead weight — nothing reads them, and they double
-- the size of every DISTINCT ON scan over elo_snapshots.
--
-- Is this safe? The rows are derived, not source data. Elo is a
-- deterministic replay of the vote log from INIT_RATING (elo/elo.ts), so
-- thesis-analysis.ts reconstructs the exact same ratings from `votes`
-- whenever the BT-vs-Elo comparison is needed. Deleting the cache loses
-- nothing that `votes` cannot regenerate. What is NOT recoverable is the
-- votes table itself — so run deploy/backup.sh before this, as with any
-- delete.
--
-- Idempotent: a second run deletes nothing.

BEGIN;

\echo ''
\echo 'Before:'
SELECT method, count(*)::int AS rows, max(computed_at) AS newest
FROM elo_snapshots GROUP BY method ORDER BY method;

DELETE FROM elo_snapshots WHERE method = 'ELO';

\echo ''
\echo 'After:'
SELECT method, count(*)::int AS rows, max(computed_at) AS newest
FROM elo_snapshots GROUP BY method ORDER BY method;

-- The board is served from the latest BT row per system. If this comes back
-- empty on a deployment that has votes, stop and roll back the transaction:
-- it would mean BT rows were never written and the ELO rows were the only
-- thing on the board.
\echo ''
\echo 'Latest BT row per system (this is what the leaderboard serves):'
SELECT DISTINCT ON (s.review_system_id) r.slug, round(s.rating::numeric, 1) AS rating,
       s.dimension, s.vote_count, s.computed_at
FROM elo_snapshots s
JOIN review_systems r ON r.id = s.review_system_id
WHERE s.method = 'BT' AND s.dimension IS NULL
ORDER BY s.review_system_id, s.computed_at DESC;

COMMIT;

VACUUM ANALYZE elo_snapshots;
