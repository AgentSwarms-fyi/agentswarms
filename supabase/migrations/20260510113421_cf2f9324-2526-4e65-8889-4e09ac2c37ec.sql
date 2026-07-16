
-- swarm_runs
CREATE TABLE public.swarm_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  swarm_id UUID,
  swarm_name TEXT,
  swarm_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_prompt TEXT,
  final_output TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  total_tokens_in INTEGER NOT NULL DEFAULT 0,
  total_tokens_out INTEGER NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_swarm_runs_user_started ON public.swarm_runs(user_id, started_at DESC);
CREATE INDEX idx_swarm_runs_swarm_started ON public.swarm_runs(swarm_id, started_at DESC);
CREATE POLICY "Users manage own swarm runs" ON public.swarm_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_swarm_runs_updated_at
  BEFORE UPDATE ON public.swarm_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- swarm_run_steps
CREATE TABLE public.swarm_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.swarm_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  node_id TEXT NOT NULL,
  node_label TEXT,
  node_kind TEXT NOT NULL DEFAULT 'agent',
  agent_id UUID,
  parent_step_id UUID,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output TEXT,
  thinking TEXT,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  rag_chunks JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_extractions JSONB NOT NULL DEFAULT '[]'::jsonb,
  llm_provider TEXT,
  llm_model TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_run_steps ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_swarm_run_steps_run ON public.swarm_run_steps(run_id, started_at);
CREATE INDEX idx_swarm_run_steps_user ON public.swarm_run_steps(user_id, started_at DESC);
CREATE POLICY "Users manage own swarm run steps" ON public.swarm_run_steps
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- swarm_run_edges
CREATE TABLE public.swarm_run_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.swarm_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  source_step_id UUID,
  target_step_id UUID,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  payload_preview TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_run_edges ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_swarm_run_edges_run ON public.swarm_run_edges(run_id, created_at);
CREATE POLICY "Users manage own swarm run edges" ON public.swarm_run_edges
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Enable pg_cron and schedule daily purge of runs older than 30 days
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'purge-old-swarm-runs',
  '0 3 * * *',
  $$ DELETE FROM public.swarm_runs WHERE started_at < now() - interval '30 days'; $$
);
