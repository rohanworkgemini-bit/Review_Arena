-- Remove everything the adaptive arena sampler left behind.
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/migrations/2026-09-09-cleanup-sampling-strategy.sql
--
-- The platform briefly carried two arena samplers — uniform and the
-- adaptive draw — behind an admin setting. Only uniform
-- survives (see apps/api/src/pair/select-pair.ts for why; adaptive sampling
-- is future work, and would need an inverse-probability correction in the
-- estimator to go with it).
--
-- What goes, and why it is safe:
--   papers.sampling_strategy    which sampler chose a paper's pair. With one
--     sampler the provenance is constant. The column never held a non-NULL
--     value: it was introduced and removed without a release in between.
--   app_settings.sampling_strategy   the switch. Only ever held the default.
--   review_systems.boost        stage-1 x5 cold-start multiplier. A weight,
--     and a uniform draw has no weights.
--   review_systems.battle_targets   soft preference for particular rivals.
--     Also a weight.
--   review_systems.battle_strict_targets   hard whitelist of permitted
--     opponents. Not a weight, but never used: no system ever set one, the
--     pool is six fixed systems, and the study's pairs come from the
--     rotation. Removing it drops the last rule in the eligibility set that
--     could never fire.
-- All three review_systems columns were operator knobs that no code path
-- ever wrote: the seeds do not set them and no admin endpoint exposed them,
-- so every row holds the column default (false / '[]'). Verified on the dev
-- database before this script was written; check yours with the SELECT
-- below if in doubt.
--
-- The eligibility columns that STAY, because the uniform sampler reads
-- them: sample_weight (as an off switch), outage, anon.
--
-- IF EXISTS throughout, so this is a no-op on a database that never saw the
-- switch, and re-running it changes nothing. Take a backup first anyway
-- (deploy/backup.sh): dropping a column is the one step here that cannot be
-- undone by re-running something.

-- Run this first if you want to see what you are about to drop:
--   SELECT count(*) FILTER (WHERE boost) AS boosted,
--          count(*) FILTER (WHERE battle_targets <> '[]'::jsonb) AS with_targets,
--          count(*) FILTER (WHERE battle_strict_targets <> '[]'::jsonb) AS with_strict
--   FROM review_systems;
-- All three should be 0. If any is not, an operator set a knob by hand and
-- you should record the values before dropping the columns.

BEGIN;

ALTER TABLE papers DROP COLUMN IF EXISTS sampling_strategy;
DELETE FROM app_settings WHERE key = 'sampling_strategy';

ALTER TABLE review_systems DROP COLUMN IF EXISTS boost;
ALTER TABLE review_systems DROP COLUMN IF EXISTS battle_targets;
ALTER TABLE review_systems DROP COLUMN IF EXISTS battle_strict_targets;

COMMIT;

\echo ''
\echo 'Remaining settings:'
SELECT key, value, updated_at FROM app_settings ORDER BY key;
\echo ''
\echo 'Pair-selection columns that remain on review_systems:'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'review_systems'
  AND column_name IN ('sample_weight', 'outage', 'anon',
                      'boost', 'battle_targets', 'battle_strict_targets')
ORDER BY column_name;
