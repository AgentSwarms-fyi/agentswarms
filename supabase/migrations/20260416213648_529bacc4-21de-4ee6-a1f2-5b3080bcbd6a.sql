CREATE TABLE public.provider_credentials (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('bedrock', 'vertex', 'anthropic', 'azure_openai')),
  label TEXT NOT NULL DEFAULT '',
  -- Encrypted credentials payload (JSON ciphertext encoded as base64)
  -- Kept opaque to the DB; encryption/decryption happens in server code.
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Non-secret config (e.g. region, project id, endpoint, default model)
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_model TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_test_status TEXT,
  last_test_error TEXT,
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own provider credentials"
ON public.provider_credentials
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_provider_credentials_updated_at
BEFORE UPDATE ON public.provider_credentials
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_provider_credentials_user ON public.provider_credentials(user_id);