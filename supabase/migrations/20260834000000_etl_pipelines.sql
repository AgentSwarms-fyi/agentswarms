-- ETL pipelines: Python-first extract/transform/load, executed in the sandboxed
-- notebook runtime as batch kernels.
--
-- Distinct from BI prep flows, deliberately. A prep flow is SQL pushed down
-- into a warehouse the app can already reach; a pipeline is Python (dlt, ibis,
-- pandas) that pulls from systems the warehouse cannot see — files, APIs,
-- other databases — and lands the result in object storage, where the Data
-- Catalog crawls it and BI, the analyst and agents can already query it.
--
-- A pipeline is EITHER visual (a step graph compiled deterministically to
-- Python) or code (the Python is the artifact). Both store source_code; for
-- visual pipelines it is the compiled output, regenerated on every save, so
-- the executor and the Runs tab never need to know which mode authored it.

CREATE TABLE IF NOT EXISTS public.etl_pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  -- 'visual' | 'code'. Visual keeps `graph` authoritative; code keeps
  -- `source_code` authoritative. Switching visual -> code is one-way per
  -- pipeline (the graph cannot be reconstructed from edited Python).
  mode text NOT NULL DEFAULT 'code' CHECK (mode IN ('visual', 'code')),
  -- The Python that actually runs. For visual mode, compiler output.
  source_code text NOT NULL DEFAULT '',
  -- Visual step graph (see src/utils/etl/codegen.ts for the shape). NULL for
  -- code-mode pipelines.
  graph jsonb,
  -- One pip requirement per line, installed in the sandbox before the run.
  requirements text NOT NULL DEFAULT '',
  -- KEY=({{secret:NAME}}) bindings, resolved server-side at run start and
  -- delivered into the sandbox process env over HTTP — never container env,
  -- never interpolated into code. Same envelope as mcp_apps.secret_refs.
  secret_refs text NOT NULL DEFAULT '',
  -- Destination catalog source to crawl after a successful run, so what the
  -- pipeline loaded shows up as assets without waiting for a schedule.
  dest_catalog_source_id uuid,
  -- 'manual' | 'hourly' | 'daily' | 'weekly'
  schedule text NOT NULL DEFAULT 'manual'
    CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly')),
  next_run_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  -- Rotatable bearer for the external trigger endpoint. NULL = no external
  -- trigger. Stored as a hash, same reasoning as notebook API keys: the
  -- plaintext is shown once and never persisted.
  trigger_token_hash text,
  timeout_minutes int NOT NULL DEFAULT 30 CHECK (timeout_minutes BETWEEN 1 AND 240),
  last_run_at timestamptz,
  last_run_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_etl_pipelines_user ON public.etl_pipelines(user_id);
-- The scheduler sweep: active pipelines whose next_run_at has passed.
CREATE INDEX IF NOT EXISTS idx_etl_pipelines_due
  ON public.etl_pipelines(next_run_at)
  WHERE is_active AND next_run_at IS NOT NULL;

ALTER TABLE public.etl_pipelines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own etl pipelines"
  ON public.etl_pipelines FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_etl_pipelines_updated_at
  BEFORE UPDATE ON public.etl_pipelines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- One row per execution. This table IS the observability surface: status,
-- duration, captured stdout (secret values scrubbed server-side before
-- persisting), and whatever metrics the run reported (rows loaded, files
-- written). Kept when the pipeline is edited; deleted with the pipeline.
CREATE TABLE IF NOT EXISTS public.etl_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.etl_pipelines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- 'manual' | 'schedule' | 'trigger'
  trigger text NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual', 'schedule', 'trigger')),
  -- The sandbox session executing this run; how the result callback finds us.
  session_id uuid REFERENCES public.notebook_runtime_sessions(id) ON DELETE SET NULL,
  -- Exact code that ran, pinned at start: the pipeline can be edited while a
  -- run is in flight, and a run log that points at code which no longer says
  -- what ran is evidence of nothing.
  source_code text NOT NULL DEFAULT '',
  logs text,
  error text,
  -- {"rows_loaded": n, "files_written": n, ...} — whatever the run reported.
  metrics jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etl_runs_pipeline ON public.etl_runs(pipeline_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_etl_runs_user ON public.etl_runs(user_id);

ALTER TABLE public.etl_runs ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner: runs are written exclusively by the server (service
-- role) so a client cannot forge a "succeeded" row or edit captured logs.
CREATE POLICY "Users read own etl runs"
  ON public.etl_runs FOR SELECT
  USING (auth.uid() = user_id);

-- Link a batch sandbox session to the ETL run it executes, following the
-- mcp_app_id precedent: the source route reads this to decide which bundle to
-- serve, and the result callback reads it to know which run to finalise.
ALTER TABLE public.notebook_runtime_sessions
  ADD COLUMN IF NOT EXISTS etl_run_id uuid REFERENCES public.etl_runs(id) ON DELETE SET NULL;
