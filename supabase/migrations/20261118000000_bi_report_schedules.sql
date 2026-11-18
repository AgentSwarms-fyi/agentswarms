-- Scheduled report delivery (R509).
--
-- A paginated report already lays itself out as a PDF in the browser. This is
-- the other half of what a report is for: it arrives by itself. A schedule
-- names a report, when it runs (daily, on weekdays, weekly or monthly, at an
-- hour in a time zone), who receives it, and the parameter values it runs
-- with. The server runs every block's query as the report's OWNER, lays the
-- PDF out and sends it as an attachment.
--
-- WHO MAY WRITE. Owners READ their schedules under RLS, but no policy lets a
-- browser write one: every insert, update and delete goes through a server
-- function. The reason is the recipient list. Who a report may be sent to is
-- an instance policy (accounts on this install, plus the domains in
-- REPORT_EMAIL_DOMAINS), and a policy RLS cannot see is a policy a direct
-- PostgREST write walks around. The server checks the list when a schedule is
-- saved and again when it sends.

CREATE TABLE IF NOT EXISTS public.bi_report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES public.bi_reports(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  cadence text NOT NULL DEFAULT 'weekly'
    CHECK (cadence IN ('daily', 'weekdays', 'weekly', 'monthly')),
  -- The local hour in `timezone`, not UTC: "8 in the morning" has to stay
  -- 8 in the morning across a daylight-saving change.
  at_hour smallint NOT NULL DEFAULT 8 CHECK (at_hour BETWEEN 0 AND 23),
  -- 0 = Sunday … 6 = Saturday, as Date.getDay() counts. Read for weekly only.
  weekday smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  -- 1-28, or 0 for the month's last day. Read for monthly only. No 29-31:
  -- a schedule that silently skips February is not a monthly schedule.
  month_day smallint NOT NULL DEFAULT 1 CHECK (month_day BETWEEN 0 AND 28),
  -- An IANA name (Europe/London). Checked by the server, which owns the clock.
  timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  recipients text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 25),
  subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 200),
  message text NOT NULL DEFAULT '' CHECK (length(message) <= 2000),
  -- Parameter name -> a value, or a relative date such as "@prev_month_start"
  -- resolved in `timezone` on the day it runs.
  param_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Send nothing when every table and fields block came back empty.
  skip_empty boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('sent', 'skipped', 'partial', 'failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_report_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners read their report schedules" ON public.bi_report_schedules;
CREATE POLICY "Owners read their report schedules"
  ON public.bi_report_schedules FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS bi_report_schedules_due_idx
  ON public.bi_report_schedules (next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS bi_report_schedules_report_idx
  ON public.bi_report_schedules (report_id);

-- Who a report goes to is the change a review asks about, so a change to the
-- recipients, the switch or the timing is audited; the clock columns the
-- scheduler stamps on every run are not.
DROP TRIGGER IF EXISTS audit_bi_report_schedules ON public.bi_report_schedules;
CREATE TRIGGER audit_bi_report_schedules
  AFTER INSERT OR DELETE OR UPDATE OF name, enabled, cadence, at_hour, weekday, month_day,
    timezone, recipients, param_values
  ON public.bi_report_schedules
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('bi_report_schedule');

-- What was sent, when and to how many. Written by the server only and never
-- updated: a delivery that failed cannot later be edited into one that sent.
CREATE TABLE IF NOT EXISTS public.bi_report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES public.bi_reports(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES public.bi_report_schedules(id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status text NOT NULL CHECK (status IN ('sent', 'skipped', 'partial', 'failed')),
  -- How many addresses it went to; the addresses are on the schedule.
  recipients integer NOT NULL DEFAULT 0,
  pages integer,
  bytes integer,
  detail text CHECK (detail IS NULL OR length(detail) <= 1000)
);

ALTER TABLE public.bi_report_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners read their report deliveries" ON public.bi_report_deliveries;
CREATE POLICY "Owners read their report deliveries"
  ON public.bi_report_deliveries FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS bi_report_deliveries_schedule_idx
  ON public.bi_report_deliveries (schedule_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS bi_report_deliveries_report_idx
  ON public.bi_report_deliveries (report_id, ran_at DESC);

-- Which of these addresses are accounts on this install, lower-cased. The
-- server's recipient check, and nothing else: it answers the service role
-- only, so a browser cannot use it to list who has an account.
CREATE OR REPLACE FUNCTION public.report_recipient_accounts(_emails text[])
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(array_agg(DISTINCT lower(u.email)), '{}')
  FROM auth.users u
  WHERE u.email IS NOT NULL
    AND lower(u.email) = ANY (SELECT lower(e) FROM unnest(_emails) AS e)
    AND (u.banned_until IS NULL OR u.banned_until < now())
    AND u.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.report_recipient_accounts(text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_recipient_accounts(text[]) TO service_role;
