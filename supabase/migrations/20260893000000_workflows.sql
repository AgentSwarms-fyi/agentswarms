-- One graph over work that kept four separate clocks.
--
-- The platform could already CHAIN: a pipeline names SQL models and ML
-- schedules to start when it succeeds. But a chain is a LINE. It cannot fan
-- out to three things that run at once, and — the part that actually bites —
-- it cannot fan IN. "Retrain only after BOTH the orders pipeline and the
-- customers model have finished" is not expressible, so the workaround is to
-- stagger cron times and hope the first one is done by the time the second
-- starts. That hope is what a workflow removes.
--
-- Nodes are things that already exist and already run: an ETL pipeline, a SQL
-- model build, an ML schedule, a notebook. Nothing new executes here — the
-- workflow only decides WHEN, and records what happened as one run rather
-- than four unrelated ones.

CREATE TABLE IF NOT EXISTS public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  -- { nodes: [{id, kind, label, targetId?, models?, continueOnFailure?, x, y}],
  --   edges: [{from, to}] } — see src/lib/workflows.ts, which owns the shape
  --   and is the only place that validates it.
  graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  -- Same vocabulary as a pipeline's own schedule, deliberately: an operator
  -- who knows one knows the other, and 'manual' is the default because a
  -- graph is usually built before anyone wants it on a clock.
  schedule text NOT NULL DEFAULT 'manual'
    CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly')),
  next_run_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_run_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workflows_user ON public.workflows(user_id);
-- The sweep: active workflows whose next_run_at has passed. Partial, for the
-- same reason the pipeline index is — most rows are never due.
CREATE INDEX IF NOT EXISTS idx_workflows_due
  ON public.workflows(next_run_at)
  WHERE is_active AND next_run_at IS NOT NULL;

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own workflows"
  ON public.workflows FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Owner-only, matching the pipelines and models a workflow orchestrates. A
-- graph that could start work its viewer cannot see would be a way around
-- every grant the platform has, so sharing one is a larger change than adding
-- a policy.

-- ── A run of the whole graph ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
  trigger text NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual', 'schedule')),
  -- The graph as it was when the run started. A workflow can be edited while
  -- a run is in flight, and a run whose steps no longer match what ran is
  -- evidence of nothing — the same reason etl_runs pins source_code.
  graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
  ON public.workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user ON public.workflow_runs(user_id);
-- The advancer's own sweep: runs still in flight.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_live
  ON public.workflow_runs(started_at)
  WHERE state = 'running';

ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner: runs are written exclusively by the server, so a
-- client cannot forge a "succeeded" row.
CREATE POLICY "Users read own workflow runs"
  ON public.workflow_runs FOR SELECT
  USING (auth.uid() = user_id);

-- ── One step of one run ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workflow_node_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The node's id inside the pinned graph, not a foreign key: the workflow's
  -- own nodes may be renamed or deleted afterwards and this row still has to
  -- describe what ran.
  node_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pipeline', 'sql_models', 'ml_schedule', 'notebook')),
  label text NOT NULL DEFAULT '',
  -- 'skipped' is NOT a failure. A step that never ran because its dependency
  -- failed tells you nothing about itself, and folding the two together makes
  -- a run report say four things broke when one did.
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  -- The id of the run this step STARTED in the other subsystem (an etl_runs
  -- id, a sql_model_runs id, and so on), so a red step links to the log that
  -- explains it instead of just saying "failed".
  target_run_id text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_run
  ON public.workflow_node_runs(run_id);
-- The advancer polls the steps it is waiting on.
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_live
  ON public.workflow_node_runs(run_id, state)
  WHERE state = 'running';

ALTER TABLE public.workflow_node_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own workflow step runs"
  ON public.workflow_node_runs FOR SELECT
  USING (auth.uid() = user_id);

-- The graph is configuration somebody can be handed; its runs are history.
-- Audit the shape, not every run.
DROP TRIGGER IF EXISTS audit_workflows ON public.workflows;
CREATE TRIGGER audit_workflows
  AFTER INSERT OR DELETE OR UPDATE OF name, graph, schedule, is_active
  ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('workflow');
