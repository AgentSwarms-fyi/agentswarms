-- Dashboards sent on a schedule (R510).
--
-- R509 made a paginated report arrive by itself. A dashboard is the other
-- thing people want in their inbox on Monday morning, and everything a
-- delivery needs already exists: the schedule's timing, recipients, the
-- recipient policy, parameter values and the delivery log. So a schedule now
-- names a report OR a dashboard, never both, and a dashboard schedule may name
-- the pages it sends (none = every page).
--
-- Nothing reads these tables in a released version (R509 is newer than the
-- last release), so widening report_id to nullable breaks no older reader.

ALTER TABLE public.bi_report_schedules
  ALTER COLUMN report_id DROP NOT NULL;

ALTER TABLE public.bi_report_schedules
  ADD COLUMN IF NOT EXISTS dashboard_id uuid REFERENCES public.bi_dashboards(id) ON DELETE CASCADE;

-- Page ids from the dashboard's `pages`. Empty sends every page, and a page
-- deleted later is simply no longer there to send.
ALTER TABLE public.bi_report_schedules
  ADD COLUMN IF NOT EXISTS pages text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(pages) <= 50);

ALTER TABLE public.bi_report_schedules
  DROP CONSTRAINT IF EXISTS bi_report_schedules_one_target;
ALTER TABLE public.bi_report_schedules
  ADD CONSTRAINT bi_report_schedules_one_target
    CHECK (num_nonnulls(report_id, dashboard_id) = 1);

CREATE INDEX IF NOT EXISTS bi_report_schedules_dashboard_idx
  ON public.bi_report_schedules (dashboard_id) WHERE dashboard_id IS NOT NULL;

-- The pages sent are part of what goes out, so a change to them is audited
-- with the recipients and the timing.
DROP TRIGGER IF EXISTS audit_bi_report_schedules ON public.bi_report_schedules;
CREATE TRIGGER audit_bi_report_schedules
  AFTER INSERT OR DELETE OR UPDATE OF name, enabled, cadence, at_hour, weekday, month_day,
    timezone, recipients, param_values, pages
  ON public.bi_report_schedules
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('bi_report_schedule');

ALTER TABLE public.bi_report_deliveries
  ALTER COLUMN report_id DROP NOT NULL;

ALTER TABLE public.bi_report_deliveries
  ADD COLUMN IF NOT EXISTS dashboard_id uuid REFERENCES public.bi_dashboards(id) ON DELETE CASCADE;

ALTER TABLE public.bi_report_deliveries
  DROP CONSTRAINT IF EXISTS bi_report_deliveries_one_target;
ALTER TABLE public.bi_report_deliveries
  ADD CONSTRAINT bi_report_deliveries_one_target
    CHECK (num_nonnulls(report_id, dashboard_id) = 1);

CREATE INDEX IF NOT EXISTS bi_report_deliveries_dashboard_idx
  ON public.bi_report_deliveries (dashboard_id, ran_at DESC) WHERE dashboard_id IS NOT NULL;
