-- A worker's report belongs to the phase it was started for.
--
-- FOUND BY RUNNING IT. 20260912000000 clears shard_results when a job moves to
-- the next phase, which it must: otherwise the previous phase's entries make
-- "n of n reported" true before the new phase's workers have said anything.
--
-- But clearing has a mirror-image hazard, and it is worse. A shard that was
-- already recorded becomes eligible again, so a RETRIED callback from the
-- phase that just ended is accepted into the phase that just began — and it
-- counts toward completion. Observed live: a search worker's duplicate
-- callback completed the parallel_fit phase while the second slice's container
-- was still being created, so the job assembled from one slice plus a leftover
-- search result and recorded the version as trained on zero rows.
--
-- The fix is to make the phase part of the report's identity. A worker carries
-- the phase it was started for in its own stash, the callback passes it, and
-- this refuses anything that does not match where the job actually is. The
-- body is otherwise exactly what it was.
DROP FUNCTION IF EXISTS public.ml_job_record_shard(uuid, integer, jsonb);

CREATE OR REPLACE FUNCTION public.ml_job_record_shard(
  _job uuid,
  _shard integer,
  _result jsonb,
  _phase text
)
RETURNS TABLE (done integer, total integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ml_training_jobs
     SET shard_results = shard_results || jsonb_build_array(
           jsonb_set(COALESCE(_result, '{}'::jsonb), '{shard}', to_jsonb(_shard))
         )
   WHERE id = _job
     -- Where the job actually is, not where the worker thinks it is. A late
     -- report from a phase that has ended matches no row and changes nothing,
     -- the same way a duplicate report was already a no-op.
     AND phase = _phase
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(shard_results) e
        WHERE (e->>'shard')::integer = _shard
     )
  RETURNING jsonb_array_length(shard_results), shards;
$$;
