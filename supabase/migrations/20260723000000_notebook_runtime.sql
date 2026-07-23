-- Developer workspace — server-side Python runtime.
--
-- Adds the control-plane tables for real, containerized notebook kernels
-- (Docker / Kubernetes / E2B). The kernels themselves are ephemeral compute
-- managed by the orchestrator; these tables track sessions, batch jobs, the
-- operator's runtime settings, and who is allowed to use the feature.
--
-- The feature is OFF by default (server_runtime_enabled = false): a fresh
-- install keeps working with the browser (Pyodide) runtime until an operator
-- explicitly enables the server runtime and (optionally) grants access.

-- ── Sessions & batch jobs ────────────────────────────────────────────────────
-- One row per kernel. kind='interactive' backs the live editor (websocket to a
-- long-lived kernel); kind='batch' runs a notebook/entrypoint headless to
-- completion (heavy / scheduled jobs) with its result persisted here.
CREATE TABLE public.notebook_runtime_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notebook_id uuid REFERENCES public.user_python_notebooks(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'interactive' CHECK (kind IN ('interactive', 'batch')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'starting', 'ready', 'running', 'succeeded', 'stopping', 'stopped', 'error')),
  backend text NOT NULL DEFAULT 'docker',
  image text,
  -- Orchestrator handles: docker container id, or "<namespace>/<pod>" on K8s.
  container_ref text,
  -- Cluster-internal URL the gateway proxies the kernel websocket to.
  endpoint text,
  cpu_limit text,
  mem_limit_mb integer,
  -- Batch jobs only: what to run and the captured result.
  entrypoint text,
  inputs jsonb,
  result jsonb,
  logs text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  -- Hard wall-clock ceiling; the reaper stops anything past this.
  expires_at timestamptz
);
CREATE INDEX idx_nb_runtime_sessions_user ON public.notebook_runtime_sessions(user_id);
-- The reaper scans by liveness; keep it cheap.
CREATE INDEX idx_nb_runtime_sessions_live
  ON public.notebook_runtime_sessions(status, last_active_at)
  WHERE status IN ('queued', 'starting', 'ready', 'running', 'stopping');

ALTER TABLE public.notebook_runtime_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own runtime sessions"
  ON public.notebook_runtime_sessions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── Operator settings (single row) ───────────────────────────────────────────
CREATE TABLE public.notebook_runtime_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  server_runtime_enabled boolean NOT NULL DEFAULT false,
  -- When true, only superadmins + granted users/groups may start a kernel.
  require_grant boolean NOT NULL DEFAULT false,
  backend text NOT NULL DEFAULT 'docker' CHECK (backend IN ('docker', 'k8s', 'e2b')),
  default_image text NOT NULL DEFAULT 'agentswarms/notebook-runtime:latest',
  -- Concurrency caps protect the cluster.
  max_sessions_per_user integer NOT NULL DEFAULT 3,
  max_sessions_total integer NOT NULL DEFAULT 50,
  -- Lifecycle limits (minutes / seconds).
  idle_ttl_minutes integer NOT NULL DEFAULT 30,
  session_max_minutes integer NOT NULL DEFAULT 480,
  cell_timeout_seconds integer NOT NULL DEFAULT 120,
  -- Interactive kernel resource limits.
  cpu_limit text NOT NULL DEFAULT '1',
  mem_limit_mb integer NOT NULL DEFAULT 2048,
  -- Batch/heavy-job resource limits (bigger, capped runtime).
  batch_cpu_limit text NOT NULL DEFAULT '2',
  batch_mem_limit_mb integer NOT NULL DEFAULT 4096,
  batch_max_minutes integer NOT NULL DEFAULT 120,
  -- Allowlisted egress domains; the egress proxy denies everything else.
  egress_allowlist text[] NOT NULL DEFAULT ARRAY[
    'pypi.org', 'files.pythonhosted.org', 'openrouter.ai', 'api.openai.com'
  ],
  pip_allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.notebook_runtime_settings (id) VALUES (true);

ALTER TABLE public.notebook_runtime_settings ENABLE ROW LEVEL SECURITY;
-- Any signed-in user may read (the UI needs to know if the runtime is enabled);
-- only superadmins may change it.
CREATE POLICY "Anyone can read runtime settings"
  ON public.notebook_runtime_settings FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "Superadmins update runtime settings"
  ON public.notebook_runtime_settings FOR UPDATE
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

-- ── Access grants (who may use the server runtime when require_grant) ─────────
CREATE TABLE public.notebook_runtime_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id uuid NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_type, principal_id)
);
ALTER TABLE public.notebook_runtime_grants ENABLE ROW LEVEL SECURITY;
-- Superadmins manage; a user may see grants that apply to them (for the UI).
CREATE POLICY "Superadmins manage runtime grants"
  ON public.notebook_runtime_grants FOR ALL
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));
CREATE POLICY "Users see grants that apply to them"
  ON public.notebook_runtime_grants FOR SELECT
  TO authenticated
  USING (
    (principal_type = 'user' AND principal_id = auth.uid())
    OR (principal_type = 'group' AND EXISTS (
      SELECT 1 FROM public.iam_group_members m
      WHERE m.group_id = notebook_runtime_grants.principal_id
        AND m.user_id = auth.uid()
    ))
  );

-- Capability check (SECURITY DEFINER so it can read settings/grants regardless
-- of the caller's own policies). Returns true when the runtime is enabled and
-- the user is allowed (open to all, superadmin, or holds a direct/group grant).
CREATE OR REPLACE FUNCTION public.can_use_notebook_runtime(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.server_runtime_enabled
    AND (
      NOT s.require_grant
      OR public.is_superadmin(uid)
      OR EXISTS (
        SELECT 1 FROM public.notebook_runtime_grants g
        WHERE (g.principal_type = 'user' AND g.principal_id = uid)
           OR (g.principal_type = 'group' AND EXISTS (
                 SELECT 1 FROM public.iam_group_members m
                 WHERE m.group_id = g.principal_id AND m.user_id = uid))
      )
    )
  FROM public.notebook_runtime_settings s
  WHERE s.id = true;
$$;

-- (No updated_at trigger: sessions track liveness via last_active_at, which the
-- runtime routes set explicitly on each interaction.)
