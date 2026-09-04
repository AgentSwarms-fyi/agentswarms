-- ML platform: a model published as an API.
--
-- A key is minted for ONE model (the way a notebook key is minted for one
-- notebook) and carries scopes: predict (score rows, start batch runs), train
-- (start a new version, register an external one) and read (list, poll). The
-- plaintext is never stored; the routes resolve a presented key by hash.
-- Runs started through a key are attributed to it, so a published model's
-- history is as traceable as the owner's own clicks.

CREATE TABLE IF NOT EXISTS public.ml_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- sha256 of the plaintext key. Never store the key itself.
  key_hash text NOT NULL UNIQUE,
  -- First few characters, so the UI can tell two keys apart without holding one.
  key_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['predict']::text[]
    CHECK (scopes <@ ARRAY['predict', 'train', 'read']::text[] AND cardinality(scopes) >= 1),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_api_keys_model ON public.ml_api_keys(model_id);
-- Auth resolves by hash on every request; keep that a single index hit.
CREATE INDEX IF NOT EXISTS idx_ml_api_keys_hash
  ON public.ml_api_keys(key_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.ml_api_keys ENABLE ROW LEVEL SECURITY;

-- Owners manage their own keys. The routes authenticate by hash with the
-- service role, so they do not depend on these policies.
DROP POLICY IF EXISTS "Users manage own ml api keys" ON public.ml_api_keys;
CREATE POLICY "Users manage own ml api keys"
  ON public.ml_api_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Minting and revoking a key is a governance event: audited by trigger, so
-- no code path can do either silently.
DROP TRIGGER IF EXISTS audit_ml_api_keys ON public.ml_api_keys;
CREATE TRIGGER audit_ml_api_keys
  AFTER INSERT OR UPDATE OR DELETE ON public.ml_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ml_api_key');

-- Attribute what a key started.
ALTER TABLE public.ml_training_jobs
  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.ml_api_keys(id) ON DELETE SET NULL;
ALTER TABLE public.ml_predictions
  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.ml_api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ml_training_jobs_api_key
  ON public.ml_training_jobs(api_key_id) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ml_predictions_api_key
  ON public.ml_predictions(api_key_id) WHERE api_key_id IS NOT NULL;

-- A version can be registered from outside: a model trained elsewhere whose
-- artifact follows the documented contract. Nothing in the trainer's own
-- columns changes; the flag tells inference to hand the pipeline the raw
-- feature columns instead of the trainer's prepared frame.
ALTER TABLE public.ml_model_versions
  ADD COLUMN IF NOT EXISTS external boolean NOT NULL DEFAULT false;

COMMENT ON TABLE public.ml_api_keys IS 'Per-model API keys (hashed) for the public ML endpoints.';
COMMENT ON COLUMN public.ml_model_versions.external IS 'True when the artifact was registered through the API rather than trained here.';
