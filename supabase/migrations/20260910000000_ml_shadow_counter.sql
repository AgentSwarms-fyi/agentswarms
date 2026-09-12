-- Record one mirrored request, atomically.
--
-- The application used to read the four totals off the deployment row it was
-- already holding, add to them, and write them back. Two requests in flight
-- at once — which is the ONLY situation a warm endpoint exists for — would
-- both read the same figures and the second would overwrite the first.
--
-- The platform already learned this for request_count in
-- increment_ml_deployment_use; the shadow totals are the same shape of number
-- and deserve the same treatment, because they are what a person reads before
-- deciding to put a new model in front of customers.
--
-- The arithmetic mirrors addComparison() in src/lib/mlShadow.ts exactly: a
-- request always counts, a failure counts as an error and contributes no
-- rows, and a success contributes rows and agreements and no error.
CREATE OR REPLACE FUNCTION public.record_ml_shadow_result(
  p_id uuid,
  p_rows integer,
  p_agreed integer,
  p_error text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ml_deployments
  SET shadow_requests = shadow_requests + 1,
      shadow_rows = shadow_rows + CASE WHEN p_error IS NULL THEN COALESCE(p_rows, 0) ELSE 0 END,
      shadow_agreed = shadow_agreed + CASE WHEN p_error IS NULL THEN COALESCE(p_agreed, 0) ELSE 0 END,
      shadow_errors = shadow_errors + CASE WHEN p_error IS NULL THEN 0 ELSE 1 END,
      shadow_last_error = COALESCE(p_error, shadow_last_error)
  WHERE id = p_id;
$$;
