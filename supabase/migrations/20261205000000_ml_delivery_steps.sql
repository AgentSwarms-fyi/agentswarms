-- Promote model and Deploy model, as workflow steps (R542).
--
-- An ML pipeline can now finish what it starts: put the newest version it
-- trained into production (through the model's own approval gate, asking its
-- approvers and waiting when it has any) and serve it, or try it beside
-- production on a share of requests. The steps' work happens in tables that
-- already exist (approvals, ml_models, ml_deployments); only the list of step
-- kinds a run may record grows.
--
-- Replaces the check with the full current list (R540's plus the two new
-- kinds), so it is right whichever of the two migrations ran first.

ALTER TABLE public.workflow_node_runs DROP CONSTRAINT IF EXISTS workflow_node_runs_kind_check;
ALTER TABLE public.workflow_node_runs
  ADD CONSTRAINT workflow_node_runs_kind_check
  CHECK (
    kind IN (
      -- Work the platform already knows how to start
      'pipeline',
      'sql_models',
      'ml_schedule',
      'ml_promote',
      'ml_deploy',
      'notebook',
      'sql',
      'swarm',
      'prep_flow',
      'dashboard_refresh',
      'data_monitor',
      -- Reaching outside
      'http',
      'notify',
      'kubeflow_run',
      -- Control flow, which the orchestrator owns itself
      'condition',
      'wait',
      'approval',
      'sub_workflow'
    )
  );
