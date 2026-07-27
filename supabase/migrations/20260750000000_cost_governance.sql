-- Cost governance beyond the per-user monthly cap.
--
-- What already existed: budget_settings.monthly_cap_usd (per user) with
-- threshold emails, and an opt-in hard stop (ENFORCE_BUDGET_CAP) wired into
-- /api/chat only.
--
-- What was missing, and is added here:
--   • group budgets     — an IAM group has a shared monthly ceiling
--   • per-credential budgets — an embed key or swarm API key gets its own cap,
--     so a leaked/abused public key cannot drain the owner's whole allowance
--   • spend attribution — execution_traces now records WHICH credential a call
--     was made through, which is what makes a per-key cap computable at all

-- 1. Attribution columns on the spend ledger. Nullable: a normal signed-in
--    chat turn has no credential scope.
ALTER TABLE public.execution_traces
  ADD COLUMN IF NOT EXISTS cost_scope_type text,
  ADD COLUMN IF NOT EXISTS cost_scope_id   uuid;

ALTER TABLE public.execution_traces
  DROP CONSTRAINT IF EXISTS execution_traces_cost_scope_type_valid;
ALTER TABLE public.execution_traces
  ADD CONSTRAINT execution_traces_cost_scope_type_valid
  CHECK (cost_scope_type IS NULL OR cost_scope_type IN ('embed_key', 'swarm_api_key'));

-- Month-to-date spend per credential is the hot query for the cap check.
CREATE INDEX IF NOT EXISTS idx_execution_traces_cost_scope
  ON public.execution_traces(cost_scope_type, cost_scope_id, created_at DESC)
  WHERE cost_scope_type IS NOT NULL;

-- 2. Budget limits for scopes that aren't a single user.
CREATE TABLE IF NOT EXISTS public.budget_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('group', 'embed_key', 'swarm_api_key')),
  scope_id uuid NOT NULL,
  monthly_cap_usd numeric(10, 2) NOT NULL CHECK (monthly_cap_usd > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id)
);

ALTER TABLE public.budget_limits ENABLE ROW LEVEL SECURITY;

-- Read: superadmins see everything; members see their group's ceiling (so the
-- UI can explain a refusal); owners see limits on their own credentials.
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
  );

-- Write: group ceilings are an administrator's call; credential ceilings belong
-- to whoever owns the credential.
DROP POLICY IF EXISTS "group budget limits writable by superadmins" ON public.budget_limits;
CREATE POLICY "group budget limits writable by superadmins"
  ON public.budget_limits FOR ALL
  USING (scope_type = 'group' AND public.is_superadmin(auth.uid()))
  WITH CHECK (scope_type = 'group' AND public.is_superadmin(auth.uid()));

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
  );

DROP TRIGGER IF EXISTS update_budget_limits_updated_at ON public.budget_limits;
CREATE TRIGGER update_budget_limits_updated_at
  BEFORE UPDATE ON public.budget_limits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
