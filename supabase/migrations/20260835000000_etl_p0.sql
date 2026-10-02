-- ETL P0 operability: retries, cron schedules, overlap policy, parameters,
-- chaining, and engine-managed incremental state.
--
-- Each column here answers a question an operator asks in the first hour with
-- any mature ETL tool: what happens on a transient failure (retry_count),
-- can I say "weekdays at 06:00 Berlin" (cron_expr + timezone), can two runs
-- of one pipeline overlap (allow_concurrent), how do I re-run July 3-9
-- (params), and what runs after this succeeds (run_after).

ALTER TABLE public.etl_pipelines
  -- Automatic retries with exponential backoff, engine-owned. 0 = fail fast.
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0
    CHECK (retry_count BETWEEN 0 AND 5),
  -- Five-field cron, used when schedule = 'cron'. Kept separate from the
  -- schedule enum so the simple presets stay simple.
  ADD COLUMN IF NOT EXISTS cron_expr text,
  -- IANA zone the cron is evaluated in. NULL = UTC.
  ADD COLUMN IF NOT EXISTS timezone text,
  -- Overlap policy. FALSE (default) refuses a start while a run is queued or
  -- running — the safe default, because append targets double-load under
  -- overlap. Schedules already skip a beat; this extends the same guarantee
  -- to manual, webhook and chained starts.
  ADD COLUMN IF NOT EXISTS allow_concurrent boolean NOT NULL DEFAULT false,
  -- Defaults merged under any per-run params; both reach entrypoint(inputs).
  ADD COLUMN IF NOT EXISTS default_params jsonb,
  -- Chaining: start this pipeline when the referenced one succeeds. Cycles are
  -- refused at save time (the server walks the chain).
  ADD COLUMN IF NOT EXISTS run_after uuid REFERENCES public.etl_pipelines(id) ON DELETE SET NULL;

ALTER TABLE public.etl_pipelines
  DROP CONSTRAINT IF EXISTS etl_pipelines_schedule_check;
ALTER TABLE public.etl_pipelines
  ADD CONSTRAINT etl_pipelines_schedule_check
    CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly', 'cron'));

CREATE INDEX IF NOT EXISTS idx_etl_pipelines_run_after
  ON public.etl_pipelines(run_after) WHERE run_after IS NOT NULL;

ALTER TABLE public.etl_runs
  -- 1-based attempt counter; retries reuse the SAME run row so the Runs tab
  -- shows one logical run with its attempt history in the logs.
  ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1,
  -- Decremented as attempts fail; snapshot of the pipeline's retry_count at
  -- start, so editing the pipeline mid-run cannot change a run's contract.
  ADD COLUMN IF NOT EXISTS retries_remaining int NOT NULL DEFAULT 0,
  -- When status = 'retrying', the moment the sweep may start the next attempt.
  ADD COLUMN IF NOT EXISTS retry_at timestamptz,
  -- Exactly what entrypoint(inputs) received, pinned per run for forensics.
  ADD COLUMN IF NOT EXISTS params jsonb;

ALTER TABLE public.etl_runs
  DROP CONSTRAINT IF EXISTS etl_runs_status_check;
ALTER TABLE public.etl_runs
  ADD CONSTRAINT etl_runs_status_check
    CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled'));

ALTER TABLE public.etl_runs
  DROP CONSTRAINT IF EXISTS etl_runs_trigger_check;
ALTER TABLE public.etl_runs
  ADD CONSTRAINT etl_runs_trigger_check
    CHECK (trigger IN ('manual', 'schedule', 'trigger', 'chain'));

-- The retry sweep: due retrying runs.
CREATE INDEX IF NOT EXISTS idx_etl_runs_retry_due
  ON public.etl_runs(retry_at) WHERE status = 'retrying';

-- Engine-managed incremental state: one cursor per (pipeline, node). The
-- generated code reports the max cursor it loaded in its metrics; the finalize
-- hook persists it here; the next run's env carries it back in. Server-written
-- only — a client that could edit a watermark could silently skip data.
CREATE TABLE IF NOT EXISTS public.etl_pipeline_state (
  pipeline_id uuid NOT NULL REFERENCES public.etl_pipelines(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cursor_value text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_id, node_id)
);

ALTER TABLE public.etl_pipeline_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own etl state"
  ON public.etl_pipeline_state FOR SELECT
  USING (auth.uid() = user_id);
