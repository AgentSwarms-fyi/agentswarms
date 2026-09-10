-- The step kinds a run may record.
--
-- FOUND FROM THE UI. The engine grew from four kinds to fifteen and this CHECK
-- did not come with it, so a graph containing a condition, a wait or an HTTP
-- call saved happily, drew on the canvas, and then failed the instant anybody
-- ran it — with a Postgres constraint name where a reason should be.
--
-- The list lives in `src/lib/workflows.ts` as `NODE_KINDS`; a test pins the two
-- against each other so they cannot drift apart again.
ALTER TABLE public.workflow_node_runs DROP CONSTRAINT IF EXISTS workflow_node_runs_kind_check;
ALTER TABLE public.workflow_node_runs
  ADD CONSTRAINT workflow_node_runs_kind_check
  CHECK (
    kind IN (
      -- Work the platform already knows how to start
      'pipeline',
      'sql_models',
      'ml_schedule',
      'notebook',
      'sql',
      'swarm',
      'prep_flow',
      'dashboard_refresh',
      'data_monitor',
      -- Reaching outside
      'http',
      'notify',
      -- Control flow, which the orchestrator owns itself
      'condition',
      'wait',
      'approval',
      'sub_workflow'
    )
  );
