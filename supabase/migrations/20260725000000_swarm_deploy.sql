-- Deploy & automate: run swarms headlessly via an API key or on a schedule.
--
-- Unlike embed_keys (a capability token that ships inside an iframe, stored
-- in plaintext), a swarm API key is a server-to-server secret: we store only a
-- SHA-256 hash and show the raw key once at creation. Both tables drive the
-- server-side swarm executor (POST /api/swarm/run and the cron path).

-- ── API keys ────────────────────────────────────────────────────────────────
CREATE TABLE public.swarm_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  swarm_id uuid NOT NULL REFERENCES public.swarms(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_hash text NOT NULL UNIQUE, -- sha-256 hex of the raw key (raw is never stored)
  key_prefix text NOT NULL, -- e.g. 'sk_swarm_ab12…' for display only
  -- Headless runs can't pause for a human Approval node. false = auto-approve,
  -- true = auto-reject (which fails the run at that gate).
  reject_approvals boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own swarm api keys" ON public.swarm_api_keys
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_swarm_api_keys_user ON public.swarm_api_keys(user_id);
CREATE INDEX idx_swarm_api_keys_hash ON public.swarm_api_keys(key_hash);
CREATE TRIGGER update_swarm_api_keys_updated_at
  BEFORE UPDATE ON public.swarm_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Schedules ─────────────────────────────────────────────────────────────────
-- Interval-based (minutes), matching the existing ensureScheduler / cron path
-- used by prepared-dataset refresh and BI alerts.
CREATE TABLE public.swarm_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  swarm_id uuid NOT NULL REFERENCES public.swarms(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Scheduled run',
  input text NOT NULL DEFAULT '',
  input_state jsonb NOT NULL DEFAULT '{}'::jsonb, -- typed-field values ({{name}} → value)
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes >= 5),
  reject_approvals boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_run_status text,
  last_run_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own swarm schedules" ON public.swarm_schedules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_swarm_schedules_user ON public.swarm_schedules(user_id);
CREATE INDEX idx_swarm_schedules_due ON public.swarm_schedules(is_active, last_run_at);
CREATE TRIGGER update_swarm_schedules_updated_at
  BEFORE UPDATE ON public.swarm_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
