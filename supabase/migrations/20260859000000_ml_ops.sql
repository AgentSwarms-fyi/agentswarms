-- ML platform: operations. Scheduled retraining and batch prediction, drift
-- monitoring against the training distribution, and two more operator
-- settings (training GPUs, the drift alert threshold).

-- ── Schedules ────────────────────────────────────────────────────────────────
-- One row per recurring job on a model: retrain (a new version on a cadence,
-- promoted when it beats production) or batch_predict (score a lakehouse
-- table into a table the owner owns). The same claim-by-clock pattern as
-- ETL pipelines: next_run_at is advanced before the run starts, and only the
-- sweep that still sees the old value wins the row.
CREATE TABLE IF NOT EXISTS public.ml_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('retrain', 'batch_predict')),
  schedule text NOT NULL DEFAULT 'daily'
    CHECK (schedule IN ('hourly', 'daily', 'weekly', 'cron')),
  cron_expr text,
  timezone text,
  -- retrain: {time_budget_minutes?, max_rows?, tuning?}
  -- batch_predict: {input: {schema, table, where?}, output: {schema, table}}
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- retrain only: promote the new version when its primary metric beats production
  promote_if_better boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  -- what the last run started: a training job id or a prediction id
  last_ref_id uuid,
  -- retrain: the version the last run produced, and the last one judged for promotion
  last_version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  evaluated_version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_schedules_model ON public.ml_schedules(model_id);
CREATE INDEX IF NOT EXISTS idx_ml_schedules_due
  ON public.ml_schedules(next_run_at) WHERE is_active;

ALTER TABLE public.ml_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own ml schedules" ON public.ml_schedules;
CREATE POLICY "Users manage own ml schedules"
  ON public.ml_schedules FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- A schedule decides when compute is spent and what serves production:
-- audited by trigger like the models themselves.
DROP TRIGGER IF EXISTS audit_ml_schedules ON public.ml_schedules;
CREATE TRIGGER audit_ml_schedules
  AFTER INSERT OR UPDATE OR DELETE ON public.ml_schedules
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ml_schedule');

-- ── Drift ────────────────────────────────────────────────────────────────────
-- The training distribution of every feature (decile bins for numbers, top
-- categories for categoricals) so a batch of new rows can be compared with
-- what the model learned from, as a population stability index per feature.
ALTER TABLE public.ml_model_versions
  ADD COLUMN IF NOT EXISTS feature_stats jsonb;
ALTER TABLE public.ml_predictions
  ADD COLUMN IF NOT EXISTS drift_score double precision;
CREATE INDEX IF NOT EXISTS idx_ml_predictions_drift
  ON public.ml_predictions(model_id, created_at DESC) WHERE drift_score IS NOT NULL;

-- ── Settings ─────────────────────────────────────────────────────────────────
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_train_gpus integer,
  ADD COLUMN IF NOT EXISTS ml_drift_alert_psi double precision;
COMMENT ON COLUMN public.notebook_runtime_settings.ml_train_gpus IS
  'GPUs requested for each training sandbox (Docker device request / nvidia.com/gpu limit); NULL = env ML_TRAIN_GPUS, then 0.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_drift_alert_psi IS
  'Population stability index above which a batch prediction raises a drift notification; NULL = env ML_DRIFT_ALERT_PSI, then 0.25.';
COMMENT ON COLUMN public.ml_model_versions.feature_stats IS 'Per-feature training distribution for drift monitoring.';
COMMENT ON COLUMN public.ml_predictions.drift_score IS 'Highest per-feature PSI of the scored rows against the training distribution.';
