-- A pipeline's success can now start more than another pipeline.
--
-- The common shape of a data platform is ingest → transform → train, and the
-- three lived on three unrelated clocks: a pipeline chained only to another
-- pipeline, SQL models rebuilt on their own schedule, ML schedules on theirs.
-- A pipeline may now name the SQL models to build and the ML schedules to run
-- when it succeeds, which is the first step from three schedules to one graph.
--
-- chain_sql_models: NULL = build nothing; '{}' = every active model the owner
-- has; names = those models with their ancestors (what a build always does).
ALTER TABLE public.etl_pipelines
  ADD COLUMN IF NOT EXISTS chain_sql_models text[],
  ADD COLUMN IF NOT EXISTS chain_ml_schedules uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.etl_pipelines.chain_sql_models IS
  'SQL models to build when a run succeeds: NULL none, empty every active model, else these (with ancestors).';
COMMENT ON COLUMN public.etl_pipelines.chain_ml_schedules IS
  'ML schedules (retrain / batch predict) to run when a run succeeds.';

-- A build started by a pipeline is its own kind of trigger, so a run list can
-- say which builds were chained rather than manual.
ALTER TABLE public.sql_model_runs DROP CONSTRAINT IF EXISTS sql_model_runs_trigger_check;
ALTER TABLE public.sql_model_runs
  ADD CONSTRAINT sql_model_runs_trigger_check
  CHECK (trigger IN ('manual', 'schedule', 'api', 'chain'));
