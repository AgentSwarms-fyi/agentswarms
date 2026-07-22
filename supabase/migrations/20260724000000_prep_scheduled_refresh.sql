-- Scheduled refresh for data-prep flows.
--
-- A saved flow can re-run itself server-side on a cadence: it recompiles its
-- pipeline (source + ordered transform steps), executes it against the
-- owner's stored datasets, and overwrites the materialised output dataset.
-- Shares the same 60s scheduler tick / /api/bi/cron path as BI dashboard
-- refresh.

ALTER TABLE public.user_prep_flows
  ADD COLUMN IF NOT EXISTS refresh_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refresh_interval_minutes integer,
  ADD COLUMN IF NOT EXISTS last_refresh_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_refresh_error text;

-- Only flows that have already been run at least once (have an output table)
-- are eligible; the scheduler picks the oldest-refreshed enabled flows first.
CREATE INDEX IF NOT EXISTS idx_user_prep_flows_refresh
  ON public.user_prep_flows(refresh_enabled, last_refresh_at)
  WHERE refresh_enabled;
