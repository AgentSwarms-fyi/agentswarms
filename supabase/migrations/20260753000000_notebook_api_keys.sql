-- Publishing a notebook as a callable API.
--
-- Notebooks could already be run headlessly (the batch runner), but only from
-- inside the platform. This lets an owner mint a key so their own systems can
-- POST inputs to a notebook and get its entrypoint's return value back — the
-- same execution path, reached from outside.
--
-- Keys are stored HASHED. The plaintext is shown once at creation and is not
-- recoverable, only rotated, which matches how swarm and embed keys already
-- behave here.

CREATE TABLE IF NOT EXISTS public.notebook_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notebook_id uuid NOT NULL REFERENCES public.user_python_notebooks(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- sha256 of the plaintext key. Never store the key itself.
  key_hash text NOT NULL UNIQUE,
  -- First few characters, so the UI can tell two keys apart without holding one.
  key_prefix text NOT NULL,
  -- Function called with the parsed request body. Empty = run the notebook
  -- top to bottom and return whatever the last expression evaluated to.
  entrypoint text NOT NULL DEFAULT 'entrypoint',
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  revoked_at timestamptz,
  rotated_from uuid REFERENCES public.notebook_api_keys(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  last_used_ip text,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notebook_api_keys_notebook
  ON public.notebook_api_keys(notebook_id);
-- Auth resolves by hash on every request; keep that a single index hit.
CREATE INDEX IF NOT EXISTS idx_notebook_api_keys_hash
  ON public.notebook_api_keys(key_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.notebook_api_keys ENABLE ROW LEVEL SECURITY;

-- Owners manage their own keys. The run endpoint authenticates by hash with the
-- service role, so it does not depend on these policies.
CREATE POLICY "Users manage own notebook api keys"
  ON public.notebook_api_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Link a batch session back to the key that triggered it, so a published
-- notebook's runs are attributable in exactly the way an interactive run is.
ALTER TABLE public.notebook_runtime_sessions
  ADD COLUMN IF NOT EXISTS api_key_id uuid
    REFERENCES public.notebook_api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_nb_runtime_sessions_api_key
  ON public.notebook_runtime_sessions(api_key_id) WHERE api_key_id IS NOT NULL;
