-- R316: an experiment run's log and finish are one statement each.
--
-- FOUND IN R316. The API read the run, merged what it was sent onto what it had
-- read, and wrote the result over whatever the run held by then. Twenty metrics
-- logged at once from twenty threads kept five. And `finish` wrote every field
-- it could be sent, given or not: a run whose model `save_model` had just
-- recorded lost it to the `finish()` at the end of `with start_run(...)`, which
-- sends no artifact, so the run could not be registered.
--
-- This function locks the run, merges onto what it holds, and writes only the
-- fields it was given. A second write to the same run waits for the first to
-- commit and then merges onto what the first wrote.
CREATE OR REPLACE FUNCTION public.ml_experiment_run_write(
  p_run_id uuid,
  p_user_id uuid,
  p_params jsonb,
  p_metrics jsonb,
  p_max_keys integer,
  -- NULL for a log. For a finish: `status`, and whichever of `error`, `notes`
  -- and the artifact pair the caller sent. A field it did not send is kept.
  p_close jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.ml_experiment_runs%ROWTYPE;
  merged_params jsonb;
  merged_metrics jsonb;
  n integer;
BEGIN
  SELECT * INTO r
    FROM public.ml_experiment_runs
   WHERE id = p_run_id AND user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'missing');
  END IF;
  -- A finished run is a record of what happened. Late arrivals from a process
  -- that outlived its own `finish` would rewrite it.
  IF r.status <> 'running' THEN
    RETURN jsonb_build_object('error', 'closed', 'status', r.status);
  END IF;

  merged_params := r.params || COALESCE(p_params, '{}'::jsonb);
  SELECT count(*) INTO n FROM jsonb_object_keys(merged_params);
  IF n > p_max_keys THEN
    RETURN jsonb_build_object('error', 'too_many', 'what', 'parameters', 'count', n);
  END IF;
  merged_metrics := r.metrics || COALESCE(p_metrics, '{}'::jsonb);
  SELECT count(*) INTO n FROM jsonb_object_keys(merged_metrics);
  IF n > p_max_keys THEN
    RETURN jsonb_build_object('error', 'too_many', 'what', 'metrics', 'count', n);
  END IF;

  IF p_close IS NULL THEN
    UPDATE public.ml_experiment_runs
       SET params = merged_params, metrics = merged_metrics
     WHERE id = r.id;
  ELSE
    UPDATE public.ml_experiment_runs
       SET params = merged_params,
           metrics = merged_metrics,
           status = p_close->>'status',
           finished_at = now(),
           -- Capped at the column's range: a run left open for 25 days still closes.
           duration_ms = LEAST(extract(epoch FROM now() - r.started_at) * 1000, 2147483647)::integer,
           error = CASE WHEN p_close ? 'error' THEN p_close->>'error' ELSE r.error END,
           notes = CASE WHEN p_close ? 'notes' THEN p_close->>'notes' ELSE r.notes END,
           -- The artifact is a pair, replaced together or not at all: a digest
           -- kept beside another file's URI verifies nothing.
           artifact_uri = CASE WHEN p_close ?| array['artifact_uri', 'artifact_sha256']
                               THEN p_close->>'artifact_uri' ELSE r.artifact_uri END,
           artifact_sha256 = CASE WHEN p_close ?| array['artifact_uri', 'artifact_sha256']
                                  THEN p_close->>'artifact_sha256' ELSE r.artifact_sha256 END,
           artifact_bytes = CASE WHEN p_close ?| array['artifact_uri', 'artifact_sha256']
                                 THEN NULL ELSE r.artifact_bytes END
     WHERE id = r.id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.ml_experiment_run_write(uuid, uuid, jsonb, jsonb, integer, jsonb) IS
  'Log to or finish an experiment run in one locked statement: merges params and metrics onto what the run holds, and writes only the finish fields it is given (R316).';

-- SECURITY DEFINER with a user id ARGUMENT writes to anybody's run, so it must
-- not be reachable by anybody. The API calls it with the service role after
-- resolving the caller.
REVOKE ALL ON FUNCTION public.ml_experiment_run_write(uuid, uuid, jsonb, jsonb, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ml_experiment_run_write(uuid, uuid, jsonb, jsonb, integer, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ml_experiment_run_write(uuid, uuid, jsonb, jsonb, integer, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ml_experiment_run_write(uuid, uuid, jsonb, jsonb, integer, jsonb) TO service_role;
