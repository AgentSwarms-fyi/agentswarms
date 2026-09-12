-- More than one copy of a model answering, and something to decide how many.
--
-- A warm endpoint was ONE sandbox. One sandbox is one Python process scoring
-- one request at a time, so the second caller waits for the first — and at
-- that point the twenty seconds a warm endpoint saved are being spent again in
-- the queue, just somewhere less visible.
--
-- So the sandbox moves out of ml_deployments and into its own table, one row
-- per copy. ml_deployments keeps what it always was: the POLICY for a model's
-- endpoint — which version, how long to hold it, and now how many copies it
-- may have. The copies themselves are here.
--
-- ONE SOURCE OF TRUTH: ml_deployments.session_id and .endpoint are dropped
-- below rather than left in place as a mirror of "the first replica". A row
-- that agrees with the replicas table until one day it does not is the kind of
-- thing that answers a health check correctly while serving from a container
-- that stopped an hour ago.

CREATE TABLE IF NOT EXISTS public.ml_deployment_replicas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES public.ml_deployments(id) ON DELETE CASCADE,
  -- Denormalised from the deployment so the reaper and the scorer can act on a
  -- replica without a join, and so a session can be stopped as its owner.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.notebook_runtime_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'ready', 'failed', 'stopped')),
  -- Remembered so scoring does not ask the orchestrator where the sandbox is
  -- on every call, which was most of the latency a warm endpoint removed.
  endpoint text,
  last_used_at timestamptz,
  last_started_at timestamptz,
  last_error text,
  request_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The scorer asks for live replicas of one deployment, ordered by how long
-- each has gone unused; the reaper asks for every live replica.
CREATE INDEX IF NOT EXISTS ml_deployment_replicas_live_idx
  ON public.ml_deployment_replicas (deployment_id, status, last_used_at)
  WHERE status IN ('starting', 'ready');

ALTER TABLE public.ml_deployment_replicas ENABLE ROW LEVEL SECURITY;

-- Reached only through the service role, like ml_deployments itself: a replica
-- is infrastructure, and the model's ACL is what decides who may see it.
DROP POLICY IF EXISTS ml_deployment_replicas_none ON public.ml_deployment_replicas;
CREATE POLICY ml_deployment_replicas_none ON public.ml_deployment_replicas
  FOR ALL USING (false) WITH CHECK (false);

-- ── How many copies, and the bookkeeping to decide it ──────────────────────
--
-- max_replicas DEFAULTS TO 1, so nothing about an existing endpoint changes
-- until its owner raises it. Each copy is a container holding sklearn in
-- memory on somebody's machine; starting more of them because a feature
-- shipped would be spending their RAM without asking.
ALTER TABLE public.ml_deployments
  ADD COLUMN IF NOT EXISTS min_replicas integer NOT NULL DEFAULT 1
    CHECK (min_replicas BETWEEN 0 AND 64),
  ADD COLUMN IF NOT EXISTS max_replicas integer NOT NULL DEFAULT 1
    CHECK (max_replicas BETWEEN 1 AND 64),
  -- The counter and the moment it was read, so the next pass can measure a
  -- RATE rather than guess one from a cumulative total.
  ADD COLUMN IF NOT EXISTS scale_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS scale_checked_count bigint,
  ADD COLUMN IF NOT EXISTS last_scaled_at timestamptz,
  -- Recorded in plain words so a reader can see why the endpoint is this size.
  ADD COLUMN IF NOT EXISTS last_scale_reason text;

ALTER TABLE public.ml_deployments
  DROP CONSTRAINT IF EXISTS ml_deployments_replica_range;
ALTER TABLE public.ml_deployments
  ADD CONSTRAINT ml_deployments_replica_range CHECK (min_replicas <= max_replicas);

COMMENT ON COLUMN public.ml_deployments.min_replicas IS
  'Copies held even with no traffic. 0 lets an idle endpoint scale to nothing and pay a cold start on the next call.';
COMMENT ON COLUMN public.ml_deployments.max_replicas IS
  'Ceiling on copies. Defaults to 1, so autoscaling does nothing until an owner asks for it. Every copy is also counted against the instance-wide warm-endpoint limits.';

-- ── The sandbox each live endpoint already has becomes its first replica ───
--
-- Without this, every endpoint running at the moment of deploy would be
-- orphaned: the deployment row would say ready while the replicas table said
-- there was nothing to score on, and the next request would quietly take the
-- cold path for ever.
INSERT INTO public.ml_deployment_replicas
  (deployment_id, user_id, session_id, status, endpoint, last_used_at, last_started_at, request_count)
SELECT d.id, d.user_id, d.session_id, d.status, d.endpoint, d.last_used_at, d.last_started_at, d.request_count
FROM public.ml_deployments d
WHERE d.session_id IS NOT NULL
  AND d.status IN ('starting', 'ready')
  AND NOT EXISTS (
    SELECT 1 FROM public.ml_deployment_replicas r WHERE r.deployment_id = d.id
  );

ALTER TABLE public.ml_deployments DROP COLUMN IF EXISTS session_id;
ALTER TABLE public.ml_deployments DROP COLUMN IF EXISTS endpoint;
