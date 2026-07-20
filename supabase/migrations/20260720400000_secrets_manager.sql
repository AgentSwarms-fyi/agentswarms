-- Secrets Manager. Values are AES-GCM encrypted in server code (same scheme
-- as provider_credentials) and are write-only: never returned to any client.
-- Consumers reference secrets as {{secret:NAME}} inside warehouse connection
-- fields and LLM provider keys; resolution happens server-side at use time
-- with an access check.
--
-- Access control plugs into the existing IAM grant system: iam_resource_grants
-- gains a 'secret' resource type, so superadmins share secrets with users or
-- groups from the IAM console exactly like knowledge bases and data tables.

CREATE TABLE public.user_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Reference name used in {{secret:NAME}} — identifier-shaped by design.
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_]*$' AND length(name) <= 64),
  description text,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX idx_user_secrets_user ON public.user_secrets(user_id);
CREATE INDEX idx_user_secrets_name ON public.user_secrets(name);

ALTER TABLE public.user_secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own secrets"
  ON public.user_secrets FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
-- Grantees can see the metadata row (name/description — the value column only
-- ever holds ciphertext, and clients never query it).
CREATE POLICY "Granted secrets are visible"
  ON public.user_secrets FOR SELECT
  USING (public.has_resource_access('secret', id, auth.uid()));

CREATE TRIGGER update_user_secrets_updated_at
  BEFORE UPDATE ON public.user_secrets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Allow 'secret' as a grantable resource type in IAM.
ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT iam_resource_grants_resource_type_check;
ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (resource_type IN ('knowledge_base', 'data_table', 'secret'));
