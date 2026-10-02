-- Workflows, grown up.
--
-- The first cut could run four kinds of work in a DAG. That is the skeleton of
-- an orchestrator and not yet an orchestrator: what an operator actually needs
-- from one is the boring, unglamorous half — retry that flaky step twice,
-- branch on a parameter, wait for a human, give up after an hour, run it from
-- someone else's CI, and tell me when it breaks.
--
-- Everything here is that half.

-- ── The workflow ────────────────────────────────────────────────────────────

ALTER TABLE public.workflows
  -- A cron expression, so "07:00 on weekdays in Europe/London" is expressible.
  -- The four coarse schedules stay, because most workflows want one of them and
  -- a cron expression is a thing to get wrong.
  ADD COLUMN IF NOT EXISTS cron_expr text,
  ADD COLUMN IF NOT EXISTS timezone text,
  -- Declared parameters: [{name, default, description}]. A run may override
  -- any of them; anything not overridden takes the default.
  ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What to do when the clock comes round and a run is still in flight.
  -- 'skip' is the safe default: two runs of one graph would start the same
  -- pipeline twice and race each other's tables.
  ADD COLUMN IF NOT EXISTS overlap text NOT NULL DEFAULT 'skip'
    CHECK (overlap IN ('skip', 'queue')),
  -- When to raise a notification for the owner.
  ADD COLUMN IF NOT EXISTS notify_on text NOT NULL DEFAULT 'failure'
    CHECK (notify_on IN ('never', 'failure', 'always')),
  -- Rotatable bearer for the external trigger endpoint. NULL = no external
  -- trigger. Stored as a hash, same reasoning as an ETL pipeline's: the
  -- plaintext is shown once and never persisted.
  ADD COLUMN IF NOT EXISTS trigger_token_hash text,
  -- A run that outlives this is failed rather than left in flight forever.
  ADD COLUMN IF NOT EXISTS timeout_minutes int NOT NULL DEFAULT 720
    CHECK (timeout_minutes BETWEEN 1 AND 10080);

-- 'cron' joins the coarse four.
ALTER TABLE public.workflows DROP CONSTRAINT IF EXISTS workflows_schedule_check;
ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_schedule_check
  CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly', 'cron'));

COMMENT ON COLUMN public.workflows.params IS
  'Declared run parameters [{name, default, description}]; a run may override any.';
COMMENT ON COLUMN public.workflows.trigger_token_hash IS
  'SHA-256 of the bearer for POST /api/workflows/run. Plaintext is shown once.';

-- ── A run ───────────────────────────────────────────────────────────────────

ALTER TABLE public.workflow_runs
  -- The parameters this run actually used, resolved at start. Pinned for the
  -- same reason the graph is: a run whose inputs are only knowable by re-reading
  -- today's defaults is evidence of nothing.
  ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which way each condition step went, so the run view can grey the branch
  -- that was not taken and the advancer can resume without re-deciding.
  ADD COLUMN IF NOT EXISTS branches jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set when this run was started BY another workflow's sub-workflow step.
  ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  -- A re-run starts from the failed steps of this one, keeping what succeeded.
  ADD COLUMN IF NOT EXISTS rerun_of uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL;

-- 'api' (external trigger) and 'workflow' (a sub-workflow step) join the two.
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_trigger_check;
ALTER TABLE public.workflow_runs
  ADD CONSTRAINT workflow_runs_trigger_check
  CHECK (trigger IN ('manual', 'schedule', 'api', 'workflow', 'rerun'));

CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent
  ON public.workflow_runs(parent_run_id)
  WHERE parent_run_id IS NOT NULL;

-- ── One step of one run ─────────────────────────────────────────────────────

ALTER TABLE public.workflow_node_runs
  -- Which try this is. 1 is the first; a retry increments it in place, so a
  -- step is one row however many times it was attempted and the run view does
  -- not fill with near-duplicates.
  ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1,
  -- When the next attempt is due. The advancer treats a step with this set and
  -- state 'pending' as "not yet", rather than as ready.
  ADD COLUMN IF NOT EXISTS retry_at timestamptz,
  -- A wait step's own clock, and an approval's pending request.
  ADD COLUMN IF NOT EXISTS wait_until timestamptz,
  ADD COLUMN IF NOT EXISTS approval_id uuid,
  -- A condition step's decision, kept on the step as well as on the run so a
  -- reader can see it beside the expression that produced it.
  ADD COLUMN IF NOT EXISTS branch text CHECK (branch IS NULL OR branch IN ('true', 'false')),
  -- Whatever the step reported: a row count, an HTTP status, the swarm's
  -- output. Small on purpose — this is for reading, not for passing data
  -- between steps.
  ADD COLUMN IF NOT EXISTS output jsonb;

-- The advancer's sweep over steps waiting on a clock.
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_due
  ON public.workflow_node_runs(retry_at)
  WHERE retry_at IS NOT NULL AND state = 'pending';

COMMENT ON COLUMN public.workflow_node_runs.attempt IS
  'Which try this is; a retry increments in place so a step stays one row.';
COMMENT ON COLUMN public.workflow_node_runs.output IS
  'What the step reported, for reading. Not a channel between steps.';
