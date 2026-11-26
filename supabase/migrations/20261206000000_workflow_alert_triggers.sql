-- A workflow that starts itself when a model raises an alert (R544).
--
-- A model already raises two alerts: drift (the rows it scores no longer look
-- like its training rows) and accuracy below training (measured against real
-- outcomes). A workflow can now name the models and alerts it answers, so an
-- ML pipeline retrains, checks, promotes and deploys without someone reading
-- the notification and pressing Run.
--
-- Additive only: three nullable columns, and one more value a run's trigger
-- may take. Nothing existing changes meaning.

ALTER TABLE public.workflows
  -- {models: [uuid], events: ["drift"|"decay"], cooldownHours: int}, or NULL
  -- for a workflow that does not answer alerts. Validated by the app at save
  -- (every model must be the owner's own); the shape is checked here too, so
  -- a write that bypassed the app cannot leave something the starter
  -- misreads.
  ADD COLUMN IF NOT EXISTS alert_trigger jsonb
    CHECK (
      alert_trigger IS NULL OR (
        jsonb_typeof(alert_trigger) = 'object'
        AND jsonb_typeof(alert_trigger -> 'models') = 'array'
        AND jsonb_typeof(alert_trigger -> 'events') = 'array'
        AND jsonb_typeof(alert_trigger -> 'cooldownHours') = 'number'
      )
    ),
  -- When an alert last started this workflow. Claimed with a conditional
  -- UPDATE (only if older than the wait), so two alerts landing together start
  -- one run, and a pipeline whose own scoring drifts cannot loop.
  ADD COLUMN IF NOT EXISTS alert_started_at timestamptz,
  -- The last alert it heard and what came of it ({at, event, model_name,
  -- started, run_id?, reason?}), so "why did it not start?" has an answer on
  -- the page.
  ADD COLUMN IF NOT EXISTS alert_last jsonb;

COMMENT ON COLUMN public.workflows.alert_trigger IS
  'Models and alerts (drift, decay) that start this workflow, and the hours to wait between alert starts (R544).';

-- Only workflows that answer alerts are ever looked up by one.
CREATE INDEX IF NOT EXISTS idx_workflows_alert_trigger
  ON public.workflows(user_id)
  WHERE alert_trigger IS NOT NULL;

ALTER TABLE public.workflow_runs
  -- For a run an alert started: {event, model_id, model_name, prediction_id,
  -- score}. Also how "once per alert" is checked: the same prediction run
  -- never starts the same workflow twice.
  ADD COLUMN IF NOT EXISTS trigger_detail jsonb;

-- 'alert' joins the triggers.
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_trigger_check;
ALTER TABLE public.workflow_runs
  ADD CONSTRAINT workflow_runs_trigger_check
  CHECK (trigger IN ('manual', 'schedule', 'api', 'workflow', 'rerun', 'alert'));

-- Which alerts start a workflow is part of when work runs, exactly as a cron
-- expression is (20260896000000), so the row-change audit watches it too. A
-- direct write that bypassed the app is recorded all the same. The two
-- bookkeeping columns are not watched, as last_run_at is not.
DROP TRIGGER IF EXISTS audit_workflows ON public.workflows;
CREATE TRIGGER audit_workflows
  AFTER INSERT OR DELETE OR UPDATE OF name, graph, schedule, is_active, cron_expr, timezone, alert_trigger
  ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('workflow');
