-- Execution traces (granular logs for every agent run)
CREATE TABLE public.execution_traces (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID,
  agent_name TEXT NOT NULL,
  llm_provider TEXT NOT NULL DEFAULT 'lovable_ai',
  llm_model TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  prompt TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.execution_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own traces"
ON public.execution_traces FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_traces_user_created ON public.execution_traces(user_id, created_at DESC);
CREATE INDEX idx_traces_agent ON public.execution_traces(agent_id);

-- Budget settings (one row per user)
CREATE TABLE public.budget_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  monthly_cap_usd NUMERIC(10, 2) NOT NULL DEFAULT 500,
  alerts_enabled BOOLEAN NOT NULL DEFAULT true,
  alert_thresholds INTEGER[] NOT NULL DEFAULT ARRAY[50, 75, 90],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.budget_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own budget"
ON public.budget_settings FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_budget_settings_updated_at
BEFORE UPDATE ON public.budget_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-agent spend limits
CREATE TABLE public.agent_limits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL UNIQUE,
  max_spend_per_day_usd NUMERIC(10, 2) NOT NULL DEFAULT 10,
  auto_disable_on_limit BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own agent limits"
ON public.agent_limits FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_agent_limits_updated_at
BEFORE UPDATE ON public.agent_limits
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();