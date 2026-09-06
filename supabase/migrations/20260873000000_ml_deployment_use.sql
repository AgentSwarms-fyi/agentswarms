-- Count a served request, atomically.
--
-- A read-then-write from the application would lose counts under exactly the
-- concurrency a warm endpoint exists to handle, and the number is the one
-- honest answer to "is this deployment earning the memory it holds".
--
-- SECURITY DEFINER with the owner NOT a parameter: the id comes from the
-- deployment the caller just scored on, and this writes nothing a caller could
-- use to read another account's row.
CREATE OR REPLACE FUNCTION public.increment_ml_deployment_use(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ml_deployments
  SET request_count = request_count + 1, last_used_at = now()
  WHERE id = p_id;
$$;
