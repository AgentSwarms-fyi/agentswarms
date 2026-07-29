-- MCP Builder — author an MCP server in Python (FastMCP) and expose it as an API.
--
-- Until now the platform was only an MCP *client*: /mcp registers someone
-- else's server by URL. This is the other half — the source lives here, it runs
-- on the same hardened sandbox the Developer workspace already uses, and it is
-- reachable over Streamable HTTP at /api/mcp/s/<slug>.
--
-- Two deliberate choices are encoded below:
--   * `slug` is generated server-side, never chosen by the user, so one tenant
--     cannot claim or shadow another's public path.
--   * the running container is a row in notebook_runtime_sessions (kind =
--     'service'), NOT a parallel table — that way the existing concurrency
--     caps, reconcile loop and reaper keep working with one extra branch
--     instead of a second copy of all of it.

CREATE TABLE IF NOT EXISTS public.mcp_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Generated as slugify(name) + '-' + 6 random chars. Unique across the
  -- instance because it is the public path segment.
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  source_code text NOT NULL DEFAULT '',
  -- Extra pip requirements, one per line, installed at container start.
  requirements text NOT NULL DEFAULT '',

  -- What tools/list returned on the last successful deploy, plus a stable hash
  -- of it. Tool descriptions are instructions the model reads, so a silent
  -- change to them is a prompt-injection vector: when the hash moves we stamp
  -- tools_changed_at and make the owner re-approve before agents may call it.
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_hash text,
  tools_changed_at timestamptz,
  tools_approved_at timestamptz,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'deploying', 'ready', 'error', 'stopped')),
  deploy_error text,

  -- Scale-to-zero by default: no container until the first call, stopped again
  -- after idle_ttl_minutes. keep_warm opts one app out of that.
  keep_warm boolean NOT NULL DEFAULT false,
  idle_ttl_minutes integer NOT NULL DEFAULT 15 CHECK (idle_ttl_minutes BETWEEN 1 AND 1440),

  -- Internal first, public opt-in. While false the endpoint answers 404 to
  -- anything but an internal caller.
  is_public boolean NOT NULL DEFAULT false,
  -- Browser origins permitted to call the endpoint (MCP requires Origin
  -- validation against DNS rebinding). Empty = no browser origin allowed;
  -- non-browser callers send no Origin and are unaffected.
  allowed_origins text[] NOT NULL DEFAULT '{}',
  -- Hosts this app says it needs to reach. Egress filtering is a single shared
  -- proxy, so these are surfaced to an administrator for approval rather than
  -- applied per app.
  requested_egress_hosts text[] NOT NULL DEFAULT '{}',
  -- {{secret:NAME}} references resolved at container start only.
  secret_refs text[] NOT NULL DEFAULT '{}',

  -- The mcp_servers row created when the app is registered for this instance's
  -- agents, so /mcp and the agent tools pick it up with no changes.
  registered_server_id uuid REFERENCES public.mcp_servers(id) ON DELETE SET NULL,

  last_deployed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_apps_user ON public.mcp_apps(user_id);

ALTER TABLE public.mcp_apps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own mcp apps"
  ON public.mcp_apps FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- Immutable snapshots taken on every deploy, so a bad edit is one click from
-- being undone and the tool list at each point stays inspectable.
CREATE TABLE IF NOT EXISTS public.mcp_app_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.mcp_apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  source_code text NOT NULL DEFAULT '',
  requirements text NOT NULL DEFAULT '',
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, version)
);

CREATE INDEX IF NOT EXISTS idx_mcp_app_versions_app ON public.mcp_app_versions(app_id);

ALTER TABLE public.mcp_app_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own mcp app versions"
  ON public.mcp_app_versions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- Keys for the public endpoint. Same rules as notebook_api_keys: hashed at
-- rest, plaintext shown once, revoked rather than deleted so the usage trail
-- survives whatever the key already did.
CREATE TABLE IF NOT EXISTS public.mcp_app_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.mcp_apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  -- Empty = every tool the server exposes. Otherwise tools/call is refused at
  -- the edge for anything outside the list, and tools/list is filtered to match
  -- (so a narrowed key does not even advertise what it cannot call).
  tool_allowlist text[] NOT NULL DEFAULT '{}',
  -- Empty = any source address.
  ip_allowlist text[] NOT NULL DEFAULT '{}',
  -- Set when the app registers itself for this instance's agents; hidden from
  -- the owner's key list because it is managed, not issued.
  is_internal boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_app_keys_app ON public.mcp_app_keys(app_id);
-- Every request resolves a key by hash; keep that a single index hit.
CREATE INDEX IF NOT EXISTS idx_mcp_app_keys_hash
  ON public.mcp_app_keys(key_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.mcp_app_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own mcp app keys"
  ON public.mcp_app_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- Public <-> upstream MCP session map.
--
-- The id here is the Mcp-Session-Id we hand to the caller; upstream_session_id
-- is whatever the user's server issued. Translating means the upstream id never
-- leaves this process, a session is bound to the key that opened it, and one
-- tenant cannot guess into another's session.
CREATE TABLE IF NOT EXISTS public.mcp_app_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.mcp_apps(id) ON DELETE CASCADE,
  key_id uuid REFERENCES public.mcp_app_keys(id) ON DELETE CASCADE,
  upstream_session_id text,
  runtime_session_id uuid REFERENCES public.notebook_runtime_sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_app_sessions_app ON public.mcp_app_sessions(app_id);
-- The reaper drops sessions whose containers are gone; this keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_mcp_app_sessions_seen ON public.mcp_app_sessions(last_seen_at);

ALTER TABLE public.mcp_app_sessions ENABLE ROW LEVEL SECURITY;

-- No client ever reads this table — the edge route resolves it with the service
-- role. RLS is on with no permissive policy so an authenticated client cannot
-- enumerate live sessions.
REVOKE ALL ON public.mcp_app_sessions FROM anon, authenticated;


-- One running MCP server is a runtime session of kind 'service'.
ALTER TABLE public.notebook_runtime_sessions
  ADD COLUMN IF NOT EXISTS mcp_app_id uuid
    REFERENCES public.mcp_apps(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_nb_runtime_sessions_mcp_app
  ON public.notebook_runtime_sessions(mcp_app_id) WHERE mcp_app_id IS NOT NULL;


-- Keep updated_at honest without every writer having to remember.
CREATE OR REPLACE FUNCTION public.touch_mcp_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mcp_apps_updated_at ON public.mcp_apps;
CREATE TRIGGER trg_mcp_apps_updated_at
  BEFORE UPDATE ON public.mcp_apps
  FOR EACH ROW EXECUTE FUNCTION public.touch_mcp_updated_at();

DROP TRIGGER IF EXISTS trg_mcp_app_keys_updated_at ON public.mcp_app_keys;
CREATE TRIGGER trg_mcp_app_keys_updated_at
  BEFORE UPDATE ON public.mcp_app_keys
  FOR EACH ROW EXECUTE FUNCTION public.touch_mcp_updated_at();
