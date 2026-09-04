-- Machine learning platform: a model registry with versions and training jobs.
--
-- A model is a governed resource like a knowledge base or a warehouse
-- connection: owner-only under RLS, shareable read-only through
-- iam_resource_grants ('ml_model'), audited by trigger so no code path can
-- create, rename, promote or delete one silently. A version is one trained
-- artifact with its metrics, the lakehouse snapshot it was trained on and the
-- decision id that makes the training run replayable evidence. A job is the
-- sandbox run that produced (or failed to produce) a version, modelled on
-- etl_runs so the same orphan-reconciliation and log-streaming apply.

CREATE TABLE public.ml_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  task text NOT NULL CHECK (task IN ('classification', 'regression', 'forecast')),
  -- {kind:'lakehouse', schema, table}. Access to the schema is checked as the
  -- model's OWNER every time a job starts, never trusted from this document.
  source jsonb NOT NULL,
  target_column text NOT NULL,
  -- Forecasting only: the time axis, the periods ahead, how rows in one
  -- period combine.
  time_column text,
  horizon integer,
  aggregation text CHECK (aggregation IS NULL OR aggregation IN ('sum', 'mean')),
  -- NULL = every column except target/time, after the trainer's own pruning.
  feature_columns text[],
  production_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE public.ml_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'training'
    CHECK (status IN ('training', 'ready', 'failed', 'cancelled')),
  stage text NOT NULL DEFAULT 'candidate'
    CHECK (stage IN ('candidate', 'staging', 'production', 'archived')),
  algorithm text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  leaderboard jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_importance jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the serialised pipeline lives (s3://bucket/ml-artifacts/...) and its
  -- digest. Inference refuses an artifact whose bytes do not hash to this.
  artifact_uri text,
  artifact_sha256 text,
  artifact_bytes bigint,
  training_rows integer,
  training_total_rows bigint,
  training_sampled boolean NOT NULL DEFAULT false,
  -- The lakehouse snapshot current when training began: the training set can
  -- be re-read as of this moment, which is what makes a model reproducible.
  training_snapshot_id bigint,
  decision_id uuid,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Forecast versions keep their projected points so BI can draw them
  -- without a sandbox.
  forecast jsonb,
  trained_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

ALTER TABLE public.ml_models
  ADD CONSTRAINT ml_models_production_version_fk
  FOREIGN KEY (production_version_id) REFERENCES public.ml_model_versions(id) ON DELETE SET NULL;

CREATE TABLE public.ml_training_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  trigger text NOT NULL DEFAULT 'manual',
  session_id uuid,
  logs text,
  error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX ml_model_versions_model_idx ON public.ml_model_versions (model_id, version DESC);
CREATE INDEX ml_training_jobs_model_idx ON public.ml_training_jobs (model_id, created_at DESC);
CREATE INDEX ml_training_jobs_live_idx ON public.ml_training_jobs (status)
  WHERE status IN ('queued', 'running');

-- ── Row-level security: owner-only, plus additive read-only shares ──────────
ALTER TABLE public.ml_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_model_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_training_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own ML models"
  ON public.ml_models FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage their own ML model versions"
  ON public.ml_model_versions FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage their own ML training jobs"
  ON public.ml_training_jobs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Shares are read-only by construction: SELECT policies only, OR'd with the
-- owner policies above. Write policies are untouched.
CREATE POLICY "Shared ML models are readable"
  ON public.ml_models FOR SELECT
  USING (public.has_resource_access('ml_model', id, auth.uid()));
CREATE POLICY "Shared ML model versions are readable"
  ON public.ml_model_versions FOR SELECT
  USING (public.has_resource_access('ml_model', model_id, auth.uid()));
CREATE POLICY "Shared ML training jobs are readable"
  ON public.ml_training_jobs FOR SELECT
  USING (public.has_resource_access('ml_model', model_id, auth.uid()));

-- ── Grant type ──────────────────────────────────────────────────────────────
-- The CHECK is REPLACED, not extended, so this list must be the full current
-- set — every type any earlier migration added, plus the new one. Copying the
-- list from an older migration silently REVOKES the types added since.
-- tests/unit/iamGrantTypes.test.ts compares this against the app's own list.
ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT IF EXISTS iam_resource_grants_resource_type_check;

ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (
    resource_type IN (
      'knowledge_base',
      'data_table',
      'secret',
      'bi_dashboard',
      'semantic_model',
      'catalog_source',
      'integration',
      'provider_credential',
      'warehouse_connection',
      'saas_connection',
      'ai_analyst',
      'lakehouse_schema',
      -- New: a trained model. Sharing conveys the right to PREDICT with it
      -- and read its metrics. Retraining, promotion and deletion stay with
      -- the owner.
      'ml_model'
    )
  );

-- ── Audit by trigger: create / rename / promote / delete cannot be bypassed ──
DROP TRIGGER IF EXISTS trg_audit_ml_models_ins ON public.ml_models;
CREATE TRIGGER trg_audit_ml_models_ins
  AFTER INSERT OR DELETE ON public.ml_models
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ml_model');

DROP TRIGGER IF EXISTS trg_audit_ml_models_upd ON public.ml_models;
CREATE TRIGGER trg_audit_ml_models_upd
  AFTER UPDATE ON public.ml_models
  FOR EACH ROW
  WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.production_version_id IS DISTINCT FROM NEW.production_version_id
    OR OLD.feature_columns IS DISTINCT FROM NEW.feature_columns
  )
  EXECUTE FUNCTION public.audit_row_change('ml_model');

-- ── Decision kinds: a training run and a prediction run are evidence too ────
-- Both carry a lakehouse snapshot and a decision id, so a model's training
-- set and a batch of predictions get the same passport and replay machinery
-- as an agent's answer.
ALTER TABLE public.decisions DROP CONSTRAINT IF EXISTS decisions_kind_check;
ALTER TABLE public.decisions
  ADD CONSTRAINT decisions_kind_check
  CHECK (kind IN ('chat_turn', 'swarm_run', 'dashboard_refresh', 'ml_training', 'ml_prediction'));

-- ── Limits an operator can change without a redeploy ────────────────────────
-- NULL = the environment variable, else the built-in default. Nothing in the
-- code caps these: a 64-core, 512 GB machine is allowed to use itself.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_train_max_rows bigint,
  ADD COLUMN IF NOT EXISTS ml_train_time_budget_minutes integer,
  ADD COLUMN IF NOT EXISTS ml_train_mem_limit_mb integer,
  ADD COLUMN IF NOT EXISTS ml_max_concurrent_trainings_per_user integer,
  ADD COLUMN IF NOT EXISTS ml_predict_max_rows bigint;

COMMENT ON COLUMN public.notebook_runtime_settings.ml_train_max_rows IS
  'Rows read for one training run; larger tables are reservoir-sampled. NULL = ML_TRAIN_MAX_ROWS env, else 2000000.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_train_time_budget_minutes IS
  'Default wall-clock budget for one training run; the sandbox is also bounded by batch_max_minutes. NULL = ML_TRAIN_TIME_BUDGET_MINUTES env, else 30.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_train_mem_limit_mb IS
  'Memory ceiling of a training sandbox, in MB. NULL = ML_TRAIN_MEM_LIMIT_MB env, else 8192.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_max_concurrent_trainings_per_user IS
  'Training runs one user may have live at once. NULL = ML_MAX_CONCURRENT_TRAININGS_PER_USER env, else 2.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_predict_max_rows IS
  'Rows one batch prediction may score. NULL = ML_PREDICT_MAX_ROWS env, else 5000000.';
