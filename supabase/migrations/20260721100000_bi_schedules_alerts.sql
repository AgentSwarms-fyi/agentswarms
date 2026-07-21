-- Scheduled dashboard refresh, data alerts and in-app notifications.
-- Schedules/alerts are owner-managed (RLS); the server-side processor runs
-- with the service role. Notifications are readable/markable by their owner
-- but only the service role may insert them.

CREATE TABLE IF NOT EXISTS public.bi_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL UNIQUE REFERENCES public.bi_dashboards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  cadence text NOT NULL DEFAULT 'daily' CHECK (cadence IN ('hourly','daily','weekly')),
  -- Daily/weekly run time, in UTC.
  at_hour int NOT NULL DEFAULT 6 CHECK (at_hour BETWEEN 0 AND 23),
  weekday int NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bi_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bi_schedules_owner_all" ON public.bi_schedules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS bi_schedules_due_idx
  ON public.bi_schedules (next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.bi_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES public.bi_dashboards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  widget_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  -- Empty column = alert on the row count instead of a value.
  column_name text NOT NULL DEFAULT '',
  aggregation text NOT NULL DEFAULT 'first'
    CHECK (aggregation IN ('first','sum','avg','min','max','count')),
  operator text NOT NULL CHECK (operator IN ('gt','gte','lt','lte','eq','neq')),
  threshold numeric NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  -- 'triggered' suppresses re-notification until the condition clears.
  last_state text NOT NULL DEFAULT 'ok' CHECK (last_state IN ('ok','triggered')),
  last_value numeric,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bi_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bi_alerts_owner_all" ON public.bi_alerts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS bi_alerts_dashboard_idx ON public.bi_alerts (dashboard_id);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications_owner_select" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "notifications_owner_update" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "notifications_owner_delete" ON public.notifications
  FOR DELETE USING (auth.uid() = user_id);
-- No INSERT policy: only the service role writes notifications.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);
