-- Warm inference: a model version held in memory, ready to score.
--
-- Every prediction until now started a container, booted Python, downloaded and
-- hashed the artifact, scored, posted the answer back and exited. Measured on
-- an idle machine with the image already pulled, the container appears at about
-- three seconds and the sandbox reports ready at about twenty-three. That is
-- the right shape for a batch job over a million rows and the wrong shape
-- entirely for scoring one row behind a web request.
--
-- A DEPLOYMENT is that same artifact loaded once into a long-lived sandbox that
-- answers over HTTP. The scoring code is identical — the same module, the same
-- digest check, the same fitted pipeline — so a warm answer and a cold answer
-- are the same answer. Only the waiting is different.
--
-- One deployment per model, naming ONE version explicitly. A deployment that
-- silently followed whatever was promoted to production would change what it
-- serves without anybody asking it to, which is the opposite of what a pinned
-- endpoint is for. Promoting a new version marks the deployment stale and the
-- owner redeploys.

CREATE TABLE IF NOT EXISTS public.ml_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  -- The version actually loaded in the sandbox, not the one that is current.
  version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'stopped'
    CHECK (status IN ('starting', 'ready', 'failed', 'stopped')),
  -- The long-lived sandbox holding the model. Null whenever it is not running.
  session_id uuid REFERENCES public.notebook_runtime_sessions(id) ON DELETE SET NULL,
  -- Off by default: a held-open container costs memory whether or not anybody
  -- is scoring, and an endpoint nobody calls should not.
  keep_warm boolean NOT NULL DEFAULT false,
  idle_ttl_minutes integer NOT NULL DEFAULT 15
    CHECK (idle_ttl_minutes BETWEEN 1 AND 1440),
  last_used_at timestamptz,
  last_started_at timestamptz,
  last_error text,
  request_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One endpoint per model. Two would race each other awake and asleep.
  UNIQUE (model_id)
);

CREATE INDEX IF NOT EXISTS ml_deployments_live_idx
  ON public.ml_deployments (status, last_used_at)
  WHERE status IN ('starting', 'ready');

ALTER TABLE public.ml_deployments ENABLE ROW LEVEL SECURITY;

-- Owner-only for writes; a grantee who may read the model may see whether its
-- endpoint is up, which is the same disclosure the version list already makes.
CREATE POLICY "Users manage own ml deployments"
  ON public.ml_deployments FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Grantees read ml deployments they can see"
  ON public.ml_deployments FOR SELECT
  USING (public.has_resource_access('ml_model', model_id, auth.uid()));

-- Deploying a model, changing which version serves, or leaving it warm are all
-- configuration with a cost and a blast radius, audited like every other.
DROP TRIGGER IF EXISTS audit_ml_deployments ON public.ml_deployments;
CREATE TRIGGER audit_ml_deployments
  AFTER INSERT OR DELETE OR UPDATE OF version_id, keep_warm, idle_ttl_minutes
  ON public.ml_deployments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ml_deployment');

-- How many warm scorers this instance will hold. A deployment is a container
-- that does not exit, so unlike a batch job it has to be counted.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_max_deployments_per_user integer,
  ADD COLUMN IF NOT EXISTS ml_max_deployments_total integer;
COMMENT ON COLUMN public.notebook_runtime_settings.ml_max_deployments_per_user IS
  'Warm inference endpoints one user may hold open; NULL = env ML_MAX_DEPLOYMENTS_PER_USER, then 2.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_max_deployments_total IS
  'Warm inference endpoints this instance may hold open; NULL = env ML_MAX_DEPLOYMENTS_TOTAL, then 10.';
