-- The six review systems, as SQL.
--
-- scripts/seed.ts cannot run in the production container: the runtime image
-- copies only apps/api/dist, and scripts/ is never compiled. This is the
-- same upsert expressed directly against postgres:
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena < deploy/sql/ops/seed-systems.sql
--
-- Idempotent: existing rows are updated in place and keep their id, so
-- reviews, votes and Elo history survive re-running it.
--
-- ONE DIFFERENCE from the TypeScript seeder. That one sets `enabled` from
-- whether the provider's API key is present in the environment; SQL cannot
-- see the environment, so this enables all six unconditionally. If a key is
-- actually missing, that system will be paired and then fail to generate —
-- so run the preflight afterwards, which auth-checks every key for real:
--
--   pnpm --filter @reviewarena/api preflight --live
--
-- Keep in sync with apps/api/scripts/seed.ts.

BEGIN;

-- ─── Retired systems ───────────────────────────────────────────────────
-- Disabled rather than deleted, so their reviews and rating history stay
-- readable. Listed explicitly so restoring an old backup cannot quietly
-- put a system back in the lineup mid-study.
UPDATE review_systems SET enabled = false, updated_at = now()
WHERE slug IN (
  'kimi-k3',
  'gpt-5.2', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-pro',
  'claude-opus-4-8',
  'gemini-3.1-pro', 'gemini-3.6-flash',
  'deepseek-v4-pro',
  'mistral-large-3'
) AND enabled;

-- ─── The study lineup ──────────────────────────────────────────────────
-- One system per provider. Each also sits on the judge panel: the pipeline
-- calls judge.py once per system for every study pair, naming config.model
-- as the judge.
INSERT INTO review_systems (id, slug, name, description, adapter_key, config, enabled)
VALUES
  (gen_random_uuid()::text, 'gemini-3.8-flash', 'Gemini 3.8 Flash',
   'Google Gemini 3.8 Flash (current generation) with our zero-shot reviewer prompt.',
   'gemini-3.8-flash',
   '{"model":"gemini-3.8-flash","temperature":0.2}'::jsonb, true),

  (gen_random_uuid()::text, 'gpt-5.6-terra', 'GPT-5.6 Terra',
   'OpenAI GPT-5.6 Terra (balanced tier of the 5.6 family) with our zero-shot reviewer prompt.',
   'gpt-5.6-terra',
   '{"model":"gpt-5.6-terra"}'::jsonb, true),

  (gen_random_uuid()::text, 'claude-sonnet-5', 'Claude Sonnet 5',
   'Anthropic Claude Sonnet 5 (mid tier) via the native Anthropic SDK, adaptive thinking enabled.',
   'claude-sonnet-5',
   '{"model":"claude-sonnet-5","thinking":true}'::jsonb, true),

  -- "mistral-medium-3.5" is callable but is an ALIAS resolving to the dated
  -- "mistral-medium-2604". The dated id is pinned so a silent upgrade
  -- mid-study cannot invalidate the comparison.
  (gen_random_uuid()::text, 'mistral-medium-3.5', 'Mistral Medium 3.5',
   'Mistral Medium 3.5 (mid tier) zero-shot reviewer via Mistral''s OpenAI-compatible endpoint.',
   'mistral-medium-3.5',
   '{"model":"mistral-medium-2604","temperature":0.2}'::jsonb, true),

  (gen_random_uuid()::text, 'glm-5.2', 'GLM-5.2',
   'Zhipu GLM-5.2 (744B MoE, open-weight) zero-shot reviewer via Z.ai''s OpenAI-compatible endpoint.',
   'glm-5.2',
   '{"model":"glm-5.2","temperature":0.2}'::jsonb, true),

  (gen_random_uuid()::text, 'deepseek-v4-flash', 'DeepSeek V4 Flash',
   'DeepSeek V4 Flash (mid tier) zero-shot reviewer via DeepSeek''s OpenAI-compatible endpoint.',
   'deepseek-v4-flash',
   '{"model":"deepseek-v4-flash","temperature":0.2}'::jsonb, true)

ON CONFLICT (slug) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  adapter_key = EXCLUDED.adapter_key,
  config      = EXCLUDED.config,
  enabled     = true,
  updated_at  = now();

COMMIT;

\echo ''
\echo 'Enabled systems:'
SELECT slug, adapter_key, config->>'model' AS model, enabled
FROM review_systems ORDER BY enabled DESC, slug;
\echo ''
\echo 'Six enabled rows expected. Now auth-check the keys for real:'
\echo '  pnpm --filter @reviewarena/api preflight --live'
