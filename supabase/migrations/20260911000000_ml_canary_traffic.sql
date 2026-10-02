-- A share of real traffic, answered by the candidate.
--
-- Shadowing (20260909000000) mirrors requests to a candidate and throws its
-- answers away. A CANARY gives it some of them to answer for real. Same
-- candidate, same copy, one more value in candidate_mode — and a much larger
-- blast radius, which is why the counters and the rollback record live here.

ALTER TABLE public.ml_deployments
  DROP CONSTRAINT IF EXISTS ml_deployments_candidate_mode_check;

ALTER TABLE public.ml_deployments
  ADD CONSTRAINT ml_deployments_candidate_mode_check
    CHECK (candidate_mode IN ('off', 'shadow', 'canary'));

ALTER TABLE public.ml_deployments
  -- Whole per cent. A share finer than that is a false precision on traffic
  -- nobody is measuring to that resolution.
  ADD COLUMN IF NOT EXISTS candidate_percent integer NOT NULL DEFAULT 0,
  -- BOTH sides are counted, because the question a canary has to answer is not
  -- "is the candidate failing" but "is the candidate failing WORSE THAN what
  -- it would replace". With only the candidate's figures, a lakehouse outage
  -- reads as a bad model and rolls back to a version failing just as hard.
  ADD COLUMN IF NOT EXISTS canary_primary_requests bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canary_primary_errors bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canary_requests bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canary_errors bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canary_last_error text,
  -- Kept after the rollback, not cleared with it. Somebody arriving in the
  -- morning to an endpoint serving its old version needs to find out why from
  -- the endpoint itself, not by correlating timestamps in the audit log.
  ADD COLUMN IF NOT EXISTS canary_rolled_back_at timestamptz,
  ADD COLUMN IF NOT EXISTS canary_rollback_reason text;

ALTER TABLE public.ml_deployments
  DROP CONSTRAINT IF EXISTS ml_deployments_candidate_percent_check;

ALTER TABLE public.ml_deployments
  ADD CONSTRAINT ml_deployments_candidate_percent_check
    CHECK (candidate_percent >= 0 AND candidate_percent <= 100);

COMMENT ON COLUMN public.ml_deployments.candidate_mode IS
  'off; shadow (every warm request is mirrored to candidate_version_id and the answers compared, and the candidate answers nobody); or canary (candidate_percent of real requests are ANSWERED by the candidate).';
COMMENT ON COLUMN public.ml_deployments.candidate_percent IS
  'Share of real requests the candidate answers while candidate_mode is canary. Applied per request against a fresh roll, so the observed share lands near this number rather than on it.';

-- Record one answered request, atomically.
--
-- The same reasoning as record_ml_shadow_result: a read-then-write from the
-- application loses counts under exactly the concurrency a warm endpoint
-- exists for, and here the lost counts feed an AUTOMATIC ROLLBACK — undercount
-- the candidate's failures and a bad version keeps serving.
--
-- p_side is 'primary' or 'candidate'; p_failed says whether that request
-- failed. An unknown side is ignored rather than miscounted.
CREATE OR REPLACE FUNCTION public.record_ml_canary_result(
  p_id uuid,
  p_side text,
  p_failed boolean,
  p_error text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ml_deployments
  SET canary_primary_requests = canary_primary_requests
        + CASE WHEN p_side = 'primary' THEN 1 ELSE 0 END,
      canary_primary_errors = canary_primary_errors
        + CASE WHEN p_side = 'primary' AND p_failed THEN 1 ELSE 0 END,
      canary_requests = canary_requests
        + CASE WHEN p_side = 'candidate' THEN 1 ELSE 0 END,
      canary_errors = canary_errors
        + CASE WHEN p_side = 'candidate' AND p_failed THEN 1 ELSE 0 END,
      canary_last_error = CASE
        WHEN p_side = 'candidate' AND p_failed THEN COALESCE(p_error, canary_last_error)
        ELSE canary_last_error
      END
  WHERE id = p_id
    AND p_side IN ('primary', 'candidate');
$$;
