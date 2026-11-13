-- R477: Amazon ECS (Fargate) as a sandbox backend.
--
-- 1. The settings row may name it.
-- 2. A sandbox on ECS gets its environment from the app, once, for a nonce
--    (src/utils/notebookRuntime/bootstrap.server.ts): RunTask's overrides are
--    recorded in CloudTrail, so its secrets cannot travel there. The session
--    row keeps the environment, sealed under the deployment key, and the
--    nonce's hash, until the sandbox trades the nonce for it.
--
-- Additive: an older build ignores the new columns and the new function, and
-- never writes 'ecs'.

ALTER TABLE public.notebook_runtime_settings
  DROP CONSTRAINT IF EXISTS notebook_runtime_settings_backend_check;
ALTER TABLE public.notebook_runtime_settings
  ADD CONSTRAINT notebook_runtime_settings_backend_check
  CHECK (backend IN ('docker', 'k8s', 'e2b', 'ecs'));

ALTER TABLE public.notebook_runtime_sessions
  ADD COLUMN IF NOT EXISTS bootstrap_env jsonb,
  ADD COLUMN IF NOT EXISTS bootstrap_hash text,
  ADD COLUMN IF NOT EXISTS bootstrap_used_at timestamptz;

COMMENT ON COLUMN public.notebook_runtime_sessions.bootstrap_env IS
  'ECS backend: the sandbox''s environment, sealed under the deployment key, until the sandbox fetches it once (R477). Null after.';
COMMENT ON COLUMN public.notebook_runtime_sessions.bootstrap_hash IS
  'ECS backend: sha256 of the one-time nonce the sandbox trades for bootstrap_env (R477).';

-- Hands the sealed environment over and deletes it in one step, so a nonce
-- opens it once. Two callers racing: the second waits on the row lock, then
-- finds bootstrap_env gone and gets NULL.
CREATE OR REPLACE FUNCTION public.redeem_notebook_bootstrap(
  p_session uuid,
  p_hash text,
  p_window_minutes integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT s.bootstrap_env INTO v
    FROM public.notebook_runtime_sessions s
   WHERE s.id = p_session
     AND s.bootstrap_hash = p_hash
     AND s.bootstrap_env IS NOT NULL
     AND s.status IN ('starting', 'running', 'ready')
     AND s.created_at > now() - make_interval(mins => p_window_minutes)
   FOR UPDATE;
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.notebook_runtime_sessions
     SET bootstrap_env = NULL, bootstrap_used_at = now()
   WHERE id = p_session;
  RETURN v;
END
$$;

REVOKE ALL ON FUNCTION public.redeem_notebook_bootstrap(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_notebook_bootstrap(uuid, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_notebook_bootstrap(uuid, text, integer) TO service_role;
