-- Kubeflow Pipelines (R540): a connection type, and a workflow step that runs
-- one of that server's pipelines.
--
-- A team that keeps its ML pipelines on Kubeflow connects the server under
-- Integrations (its address, and a token its sign-in accepts, encrypted like
-- every connection's secret); a workflow's "Kubeflow pipeline" step starts a
-- run with parameters and waits for it beside the platform's own steps.
--
-- Both are CHECK constraints, so both are widened; nothing else changes.

ALTER TABLE public.integrations
  DROP CONSTRAINT IF EXISTS integrations_type_check;
ALTER TABLE public.integrations
  ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('llm_provider', 'llm_gateway', 'n8n', 'firecrawl', 'notification', 'mlflow', 'kubeflow'));

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
      'kubeflow_run',
      -- Control flow, which the orchestrator owns itself
      'condition',
      'wait',
      'approval',
      'sub_workflow'
    )
  );
