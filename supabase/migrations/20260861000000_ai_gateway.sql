-- AI gateway (inbound): an OpenAI-compatible endpoint under /api/v1 in front
-- of a user's saved agents and connected models.
--
-- The platform already governs every model call it makes - IAM model rules,
-- budgets, guardrails, traces, audit - but only for callers that speak its
-- own request shape. Tools that expect the OpenAI API shape (SDKs, IDE
-- plugins, evaluation harnesses, other agents) could not reach an agent at
-- all. A gateway key opens that door without opening anything else: it is
-- minted by one user, reaches only that user's agents and the models that
-- user may call, pays from that user's budgets, and every call it makes is
-- traced and audited under that user's name.

CREATE TABLE IF NOT EXISTS public.gateway_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- sha256 of the plaintext key. Never store the key itself.
  key_hash text NOT NULL UNIQUE,
  -- First few characters, so the UI can tell two keys apart without holding one.
  key_prefix text NOT NULL,
  -- agents: call the owner's saved agents (model = "agent:<id or name>").
  -- models: call a connected model directly (model = "<provider>/<model>").
  scopes text[] NOT NULL DEFAULT ARRAY['agents']::text[]
    CHECK (scopes <@ ARRAY['agents', 'models']::text[] AND cardinality(scopes) >= 1),
  -- Empty = every agent the owner has; otherwise only these.
  agent_ids uuid[] NOT NULL DEFAULT '{}',
  -- provider/model patterns a "models" key may call directly ("openrouter/*",
  -- "anthropic/claude-*"); empty = anything the owner's IAM rules allow.
  model_allow text[] NOT NULL DEFAULT '{}',
  -- Ordered provider/model entries tried, in turn, when the requested model
  -- fails with a retryable error. The instance-wide chain follows these.
  fallback_models text[] NOT NULL DEFAULT '{}',
  -- Per-key ceiling; NULL = the instance default (AI_GATEWAY_RATE_LIMIT_PER_MIN).
  rate_limit_per_min integer CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min >= 1),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_keys_user_idx
  ON public.gateway_keys (user_id, created_at DESC);

ALTER TABLE public.gateway_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own gateway keys" ON public.gateway_keys;
CREATE POLICY "Users manage own gateway keys"
  ON public.gateway_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Minting, editing and revoking a key are governance events.
DROP TRIGGER IF EXISTS audit_gateway_keys ON public.gateway_keys;
CREATE TRIGGER audit_gateway_keys
  AFTER INSERT OR UPDATE OR DELETE ON public.gateway_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('gateway_key');

-- Spend made through a gateway key is attributed to the key, so a monthly
-- budget can be set on the key the way it can on an embed or swarm key.
ALTER TABLE public.execution_traces
  DROP CONSTRAINT IF EXISTS execution_traces_cost_scope_type_check;
ALTER TABLE public.execution_traces
  ADD CONSTRAINT execution_traces_cost_scope_type_check
  CHECK (cost_scope_type IS NULL OR cost_scope_type IN ('embed_key', 'swarm_api_key', 'gateway_key'));

ALTER TABLE public.budget_limits
  DROP CONSTRAINT IF EXISTS budget_limits_scope_type_check;
ALTER TABLE public.budget_limits
  ADD CONSTRAINT budget_limits_scope_type_check
  CHECK (scope_type IN ('group', 'embed_key', 'swarm_api_key', 'gateway_key'));

-- The read and write policies list credential kinds one by one; the gateway
-- key joins them, owned by whoever minted it.
DROP POLICY IF EXISTS "budget limits readable by admin, members and owners" ON public.budget_limits;
CREATE POLICY "budget limits readable by admin, members and owners"
  ON public.budget_limits FOR SELECT
  USING (
    public.is_superadmin(auth.uid())
    OR (
      scope_type = 'group'
      AND EXISTS (
        SELECT 1 FROM public.iam_group_members m
        WHERE m.group_id = budget_limits.scope_id AND m.user_id = auth.uid()
      )
    )
    OR (
      scope_type = 'embed_key'
      AND EXISTS (
        SELECT 1 FROM public.embed_keys k
        WHERE k.id = budget_limits.scope_id AND k.user_id = auth.uid()
      )
    )
    OR (
      scope_type = 'swarm_api_key'
      AND EXISTS (
        SELECT 1 FROM public.swarm_api_keys k
        WHERE k.id = budget_limits.scope_id AND k.user_id = auth.uid()
      )
    )
    OR (
      scope_type = 'gateway_key'
      AND EXISTS (
        SELECT 1 FROM public.gateway_keys k
        WHERE k.id = budget_limits.scope_id AND k.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "credential budget limits writable by owner" ON public.budget_limits;
CREATE POLICY "credential budget limits writable by owner"
  ON public.budget_limits FOR ALL
  USING (
    (
      scope_type = 'embed_key'
      AND EXISTS (SELECT 1 FROM public.embed_keys k WHERE k.id = scope_id AND k.user_id = auth.uid())
    )
    OR (
      scope_type = 'swarm_api_key'
      AND EXISTS (SELECT 1 FROM public.swarm_api_keys k WHERE k.id = scope_id AND k.user_id = auth.uid())
    )
    OR (
      scope_type = 'gateway_key'
      AND EXISTS (SELECT 1 FROM public.gateway_keys k WHERE k.id = scope_id AND k.user_id = auth.uid())
    )
  )
  WITH CHECK (
    (
      scope_type = 'embed_key'
      AND EXISTS (SELECT 1 FROM public.embed_keys k WHERE k.id = scope_id AND k.user_id = auth.uid())
    )
    OR (
      scope_type = 'swarm_api_key'
      AND EXISTS (SELECT 1 FROM public.swarm_api_keys k WHERE k.id = scope_id AND k.user_id = auth.uid())
    )
    OR (
      scope_type = 'gateway_key'
      AND EXISTS (SELECT 1 FROM public.gateway_keys k WHERE k.id = scope_id AND k.user_id = auth.uid())
    )
  );

-- Instance defaults, editable under Admin -> Developer runtime; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS gateway_rate_limit_per_min integer,
  ADD COLUMN IF NOT EXISTS gateway_fallback_models text[];
COMMENT ON COLUMN public.notebook_runtime_settings.gateway_rate_limit_per_min IS
  'Calls a minute one gateway key may make unless the key sets its own; NULL = env AI_GATEWAY_RATE_LIMIT_PER_MIN, then 60.';
COMMENT ON COLUMN public.notebook_runtime_settings.gateway_fallback_models IS
  'Ordered provider/model entries every gateway call may fall back to after the key''s own chain; NULL = env AI_GATEWAY_FALLBACK_MODELS.';
