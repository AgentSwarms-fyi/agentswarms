-- A pipeline can run continuously.
--
-- Stream sources, webhook ingest and change data capture were drained in
-- micro-batches on the scheduler's clock: one run per sixty-second sweep,
-- each paying a sandbox start. schedule = 'continuous' keeps one
-- long-running run live instead — the compiled program loops, ticking every
-- poll_seconds, reporting its positions after every committed load — and
-- the sweep starts a fresh run whenever none is live. The column is the
-- poll interval; the schedule's check list gains the new value (found by the
-- first live save: the insert bounced off the old list).
ALTER TABLE public.etl_pipelines
  ADD COLUMN IF NOT EXISTS poll_seconds integer NOT NULL DEFAULT 5
    CHECK (poll_seconds BETWEEN 1 AND 3600);

ALTER TABLE public.etl_pipelines DROP CONSTRAINT IF EXISTS etl_pipelines_schedule_check;
ALTER TABLE public.etl_pipelines
  ADD CONSTRAINT etl_pipelines_schedule_check
  CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly', 'cron', 'continuous'));

COMMENT ON COLUMN public.etl_pipelines.poll_seconds IS
  'Continuous pipelines: seconds a run waits after an empty tick before draining the source again.';
