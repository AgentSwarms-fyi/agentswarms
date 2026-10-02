-- The workflow audit trigger was watching the wrong set of columns.
--
-- `audit_workflows` fires on INSERT, DELETE and UPDATE OF name, graph,
-- schedule, is_active — the governance-relevant shape of a workflow. But
-- `schedule` only says *cron*; the expression itself lives in `cron_expr` and
-- the clock it is read against lives in `timezone`, and neither was watched.
--
-- So moving a workflow from "07:00 on weekdays" to "every minute" — or from
-- Europe/London to UTC, which shifts every run by an hour — changed when work
-- runs across the whole platform and left no audit row at all, because
-- `schedule` was 'cron' before and after.
--
-- FOUND while wiring the app-level events: the database trigger is the record
-- that cannot be bypassed, so the fix belongs here rather than in a handler
-- that a direct write would skip.
DROP TRIGGER IF EXISTS audit_workflows ON public.workflows;
CREATE TRIGGER audit_workflows
  AFTER INSERT OR DELETE OR UPDATE OF name, graph, schedule, is_active, cron_expr, timezone
  ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('workflow');
