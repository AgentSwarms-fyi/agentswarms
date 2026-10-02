-- Data monitors: standing checks on tables that run on the platform's own
-- clock, keep their history, learn what normal looks like, open an incident
-- when a check fails and close it when the check passes again.
--
-- The catalog already notices schema drift when it crawls and ETL already
-- gates quality on the way in; nothing watched a table that was simply
-- standing there - going stale, shrinking, filling with nulls, growing
-- duplicates - which is how a dashboard shows last week's number with
-- today's date on it. A monitor is the standing question, an incident is
-- the open answer, and both are audited under the owner's name.

CREATE TABLE IF NOT EXISTS public.data_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- lakehouse: a table of the built-in lakehouse; warehouse: a connected warehouse.
  source_kind text NOT NULL CHECK (source_kind IN ('lakehouse', 'warehouse')),
  warehouse_id uuid REFERENCES public.data_warehouse_connections(id) ON DELETE CASCADE,
  schema_name text NOT NULL CHECK (length(schema_name) BETWEEN 1 AND 200),
  table_name text NOT NULL CHECK (length(table_name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('freshness', 'volume', 'schema', 'nulls', 'uniqueness', 'custom_sql')),
  -- freshness: {column, max_age_minutes}
  -- volume:    {mode: 'delta'|'total', min_rows?, max_rows?, anomaly: bool}
  -- schema:    {}
  -- nulls:     {column, max_null_pct}
  -- uniqueness:{columns: [..]}
  -- custom_sql:{sql, min?, max?}  (one row, one numeric column)
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule text NOT NULL DEFAULT 'hourly'
    CHECK (schedule IN ('hourly', 'daily', 'weekly', 'cron')),
  cron_expr text,
  timezone text,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('ok', 'alert', 'error')),
  last_value double precision,
  last_message text,
  consecutive_alerts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_kind <> 'warehouse' OR warehouse_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS data_monitors_user_idx ON public.data_monitors (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS data_monitors_due_idx ON public.data_monitors (is_active, next_run_at);
CREATE INDEX IF NOT EXISTS data_monitors_table_idx ON public.data_monitors (user_id, source_kind, schema_name, table_name);

-- Every run, so a value has a history to be judged against and a person can
-- see when a table started drifting rather than only that it did.
CREATE TABLE IF NOT EXISTS public.data_monitor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES public.data_monitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual', 'pipeline')),
  status text NOT NULL CHECK (status IN ('ok', 'alert', 'error')),
  value double precision,
  -- {mean, std, n, sigma} the value was judged against, when a baseline existed
  baseline jsonb,
  -- kind-specific: freshness {latest, age_minutes}; volume {total, delta};
  -- schema {columns, added, removed, changed}; custom_sql {sql}
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  duration_ms integer,
  -- the lakehouse snapshot the check read, so a finding can be replayed
  snapshot_id text
);

CREATE INDEX IF NOT EXISTS data_monitor_runs_monitor_idx ON public.data_monitor_runs (monitor_id, ran_at DESC);

-- One open incident per monitor at a time: opened by the first failing run,
-- kept open while runs keep failing, resolved by the first passing run or by
-- a person. Acknowledging silences the repeat notifications, not the check.
CREATE TABLE IF NOT EXISTS public.data_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES public.data_monitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrences integer NOT NULL DEFAULT 1,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by text CHECK (resolved_by IS NULL OR resolved_by IN ('run', 'user')),
  notified_at timestamptz
);

CREATE INDEX IF NOT EXISTS data_incidents_open_idx ON public.data_incidents (user_id, status, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS data_incidents_one_open_idx
  ON public.data_incidents (monitor_id) WHERE status <> 'resolved';

ALTER TABLE public.data_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_monitor_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own data monitors" ON public.data_monitors;
CREATE POLICY "Users manage own data monitors" ON public.data_monitors FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users read own monitor runs" ON public.data_monitor_runs;
CREATE POLICY "Users read own monitor runs" ON public.data_monitor_runs FOR SELECT
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users manage own incidents" ON public.data_incidents;
CREATE POLICY "Users manage own incidents" ON public.data_incidents FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- A monitor's definition is governance; its clock is not. Runs update the
-- last_* columns every tick, so the trigger lists the columns a person edits.
DROP TRIGGER IF EXISTS audit_data_monitors ON public.data_monitors;
CREATE TRIGGER audit_data_monitors
  AFTER INSERT OR DELETE OR UPDATE OF
    name, source_kind, warehouse_id, schema_name, table_name, kind, config,
    schedule, cron_expr, timezone, severity, is_active
  ON public.data_monitors
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('data_monitor');

-- Instance defaults, editable under Admin -> Developer runtime; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS data_monitors_per_sweep integer,
  ADD COLUMN IF NOT EXISTS data_monitor_anomaly_sigma double precision;
COMMENT ON COLUMN public.notebook_runtime_settings.data_monitors_per_sweep IS
  'Due data monitors one scheduler sweep runs; NULL = env DATA_MONITORS_PER_SWEEP, then 20.';
COMMENT ON COLUMN public.notebook_runtime_settings.data_monitor_anomaly_sigma IS
  'Standard deviations from the learned baseline beyond which a volume check alerts; NULL = env DATA_MONITOR_ANOMALY_SIGMA, then 3.';
