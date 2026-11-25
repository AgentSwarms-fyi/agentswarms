-- R534: ML models tracked on an MLflow server.
--
-- 1. An MLflow tracking server is a connection like any other: a row in
--    `integrations`, its token or password encrypted the same way. The type
--    CHECK is REPLACED, so the list is the full current set plus 'mlflow'.
-- 2. A model says where it is tracked (ml_models.tracking), and each version
--    records what the sync did (ml_model_versions.tracking): the run, the
--    registered version, or why it was not sent.
--
-- Both columns are owner-writable under the existing "manage their own" RLS
-- policies, like every other column on those rows. The server trusts neither
-- for anything that matters: it loads the connection by the model OWNER's id
-- (never by an id alone) and checks every id MLflow hands back before using it.
--
-- Idempotent: safe to run twice.

ALTER TABLE public.integrations
  DROP CONSTRAINT IF EXISTS integrations_type_check;
ALTER TABLE public.integrations
  ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('llm_provider', 'llm_gateway', 'n8n', 'firecrawl', 'notification', 'mlflow'));

ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS tracking jsonb;
ALTER TABLE public.ml_model_versions
  ADD COLUMN IF NOT EXISTS tracking jsonb;

COMMENT ON COLUMN public.ml_models.tracking IS
  'Where this model is tracked (R534): {integration_id, experiment, registered_model, alias, enabled}. Null when not tracked.';
COMMENT ON COLUMN public.ml_model_versions.tracking IS
  'What the MLflow sync did for this version (R534): {run_id, experiment_id, registered_version, artifacts, synced_at} or {error, failed_at}.';
