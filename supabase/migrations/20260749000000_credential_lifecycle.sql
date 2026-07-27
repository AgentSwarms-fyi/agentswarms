-- Credential lifecycle for the two internet-facing key types.
--
-- Before this, a swarm API key or embed key was valid forever, carried no
-- notion of what it may do, and recorded only "last used at" — so an operator
-- could not answer "which keys should have expired?", "what can this key
-- reach?" or "where was it used from?".
--
-- Adds, to both tables:
--   expires_at     — hard expiry enforced server-side (NULL = never expires)
--   last_used_ip   — forensic hint from the edge headers (never an authz input)
--   revoked_at     — when the key was deactivated, for the audit trail
--   rotated_from   — self-reference set on the replacement key, so a rotation
--                    is auditable and the old key can be retired after a
--                    documented overlap window rather than a hard cutover
-- and, on swarm_api_keys only:
--   scopes         — what the key may do (currently: run). Empty = legacy
--                    behaviour (run), so existing keys keep working.

-- ── swarm_api_keys ──────────────────────────────────────────────────────────
ALTER TABLE public.swarm_api_keys
  ADD COLUMN IF NOT EXISTS expires_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_ip text,
  ADD COLUMN IF NOT EXISTS revoked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS rotated_from uuid REFERENCES public.swarm_api_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scopes       text[] NOT NULL DEFAULT ARRAY['run']::text[];

-- Only scopes we actually implement may be stored, so a typo fails loudly at
-- write time instead of silently granting nothing.
ALTER TABLE public.swarm_api_keys
  DROP CONSTRAINT IF EXISTS swarm_api_keys_scopes_valid;
ALTER TABLE public.swarm_api_keys
  ADD CONSTRAINT swarm_api_keys_scopes_valid
  CHECK (scopes <@ ARRAY['run', 'read_runs']::text[]);

CREATE INDEX IF NOT EXISTS idx_swarm_api_keys_expires
  ON public.swarm_api_keys(expires_at) WHERE expires_at IS NOT NULL;

-- ── embed_keys ──────────────────────────────────────────────────────────────
ALTER TABLE public.embed_keys
  ADD COLUMN IF NOT EXISTS expires_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_ip text,
  ADD COLUMN IF NOT EXISTS revoked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS rotated_from uuid REFERENCES public.embed_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_embed_keys_expires
  ON public.embed_keys(expires_at) WHERE expires_at IS NOT NULL;
