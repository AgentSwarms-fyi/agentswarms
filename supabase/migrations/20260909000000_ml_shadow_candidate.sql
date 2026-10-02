-- Trying a new version on real traffic without serving anybody from it.
--
-- A version is normally adopted by SWITCHING to it, which means the first
-- evidence it behaves differently is production behaving differently. There is
-- no way to ask "would this version have answered the same?" short of finding
-- out the hard way.
--
-- SHADOWING asks it first. A candidate version runs alongside the one in
-- production, every warm request is mirrored to it, its answer is thrown away
-- and the two are compared. The caller waits for neither the mirror nor the
-- comparison, and is never served by the candidate.

-- ── A copy knows which version it is holding ───────────────────────────────
--
-- Until now every copy of an endpoint served ml_deployments.version_id, so the
-- version was a property of the endpoint. With a candidate alongside it, two
-- copies of the same endpoint hold DIFFERENT models, and a scorer that assumed
-- otherwise would mirror traffic to whichever it happened to pick.
ALTER TABLE public.ml_deployment_replicas
  ADD COLUMN IF NOT EXISTS version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  -- Which side of the comparison this copy is. The primary answers; the
  -- candidate is only ever mirrored to.
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary', 'candidate'));

-- Every copy that exists right now is serving the endpoint's version, as a
-- primary. Without this backfill they would have a null version and the
-- scorer could not tell which model it was about to answer from.
UPDATE public.ml_deployment_replicas r
SET version_id = d.version_id
FROM public.ml_deployments d
WHERE r.deployment_id = d.id AND r.version_id IS NULL;

CREATE INDEX IF NOT EXISTS ml_deployment_replicas_role_idx
  ON public.ml_deployment_replicas (deployment_id, role, status)
  WHERE status IN ('starting', 'ready');

-- ── What the endpoint is trying, and what it has learned ───────────────────
ALTER TABLE public.ml_deployments
  ADD COLUMN IF NOT EXISTS candidate_version_id uuid
    REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS candidate_mode text NOT NULL DEFAULT 'off'
    CHECK (candidate_mode IN ('off', 'shadow')),
  ADD COLUMN IF NOT EXISTS candidate_started_at timestamptz,
  -- Running totals rather than a row per mirrored request: an endpoint at a
  -- couple of requests a second would write a hundred and fifty thousand rows
  -- a day to answer a question that is four numbers.
  ADD COLUMN IF NOT EXISTS shadow_requests bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_rows bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_agreed bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_errors bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_last_error text;

COMMENT ON COLUMN public.ml_deployments.candidate_mode IS
  'off, or shadow: every warm request is mirrored to candidate_version_id and the answers compared. The candidate never answers a caller.';
COMMENT ON COLUMN public.ml_deployments.shadow_agreed IS
  'Rows the two versions answered the same way — the same label, or within tolerance for a regression. Compared against shadow_rows, never against shadow_requests.';

-- ── The disagreements themselves, capped ───────────────────────────────────
--
-- The counters say HOW OFTEN they differ; this says HOW. Without it a reader
-- is told "they disagree on 8% of rows" and has nowhere to go next.
CREATE TABLE IF NOT EXISTS public.ml_shadow_disagreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES public.ml_deployments(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  primary_version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  candidate_version_id uuid REFERENCES public.ml_model_versions(id) ON DELETE SET NULL,
  -- What each said. The INPUT is deliberately not stored: a mirrored request
  -- carries whatever the caller sent, and keeping it would put live personal
  -- data in a debugging table nobody thought of as a data store.
  primary_answer text,
  candidate_answer text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ml_shadow_disagreements_recent_idx
  ON public.ml_shadow_disagreements (deployment_id, created_at DESC);

ALTER TABLE public.ml_shadow_disagreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ml_shadow_disagreements_none ON public.ml_shadow_disagreements;
CREATE POLICY ml_shadow_disagreements_none ON public.ml_shadow_disagreements
  FOR ALL USING (false) WITH CHECK (false);
