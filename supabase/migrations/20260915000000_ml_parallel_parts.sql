-- The fitted slices have to outlive the transition that consumes them.
--
-- FOUND BY RUNNING IT. ml_job_advance_phase clears shard_results as part of
-- moving a job to its next phase, which it must, or the previous phase's
-- entries make the new one look finished before it starts. But the ASSEMBLE
-- phase's whole input is the previous phase's entries — the artifacts the
-- slices uploaded — and the container reads them from the database after the
-- transition, by which time they are gone.
--
-- The assemble container therefore started, found no parts, and raised
-- "Nothing to assemble: no worker reported a fitted model." The transition
-- that starts the assemble had destroyed what the assemble is for.
--
-- So the parts are written ONTO the job in the same statement that clears the
-- results. Atomic for the same reason the rest of that statement is: between
-- the clear and a separate write there is a window where the job is in the
-- assemble phase with nothing to assemble.
ALTER TABLE public.ml_training_jobs
  ADD COLUMN IF NOT EXISTS parallel_parts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.ml_training_jobs.parallel_parts IS
  'The artifacts the parallel_fit slices uploaded, kept for the assemble container to average. Written by ml_job_advance_phase in the same statement that clears shard_results, because that clear is what would otherwise destroy them.';

CREATE OR REPLACE FUNCTION public.ml_job_advance_phase(
  _job uuid,
  _from text,
  _to text,
  _shards integer,
  _algorithm text,
  _search jsonb,
  _parts jsonb
)
RETURNS TABLE (claimed boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ml_training_jobs
  SET phase = _to,
      shards = _shards,
      shard_results = '[]'::jsonb,
      shard_sessions = '{}',
      parallel_algorithm = COALESCE(_algorithm, parallel_algorithm),
      search_result = COALESCE(_search, search_result),
      parallel_parts = COALESCE(_parts, parallel_parts)
  WHERE id = _job AND phase = _from
  RETURNING true;
$$;

DROP FUNCTION IF EXISTS public.ml_job_advance_phase(uuid, text, text, integer, text, jsonb);
