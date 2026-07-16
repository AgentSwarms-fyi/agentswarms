-- MCP Servers table
CREATE TABLE public.mcp_servers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  endpoint TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  tools_count INTEGER NOT NULL DEFAULT 0,
  auth_type TEXT NOT NULL DEFAULT 'none',
  auth_token TEXT,
  last_ping TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own mcp servers"
ON public.mcp_servers FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_mcp_servers_updated_at
BEFORE UPDATE ON public.mcp_servers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Swarms table (stores React Flow graph)
CREATE TABLE public.swarms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL DEFAULT 'Untitled Swarm',
  description TEXT,
  nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  edges JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_deployed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.swarms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own swarms"
ON public.swarms FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_swarms_updated_at
BEFORE UPDATE ON public.swarms
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Approvals table (Human-in-the-Loop)
CREATE TABLE public.approvals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID,
  agent_name TEXT NOT NULL,
  agent_avatar TEXT,
  action_type TEXT NOT NULL,
  action_title TEXT NOT NULL,
  description TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_level TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own approvals"
ON public.approvals FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Enable realtime for approvals so the bell updates live
ALTER TABLE public.approvals REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.approvals;
ALTER PUBLICATION supabase_realtime ADD TABLE public.mcp_servers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.swarms;