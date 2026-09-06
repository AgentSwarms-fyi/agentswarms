-- A training job may now span several sandboxes.
--
-- The job tries a handful of algorithms and then tunes the best of them, and
-- it did all of that in one container, one candidate after another. Splitting
-- the SEARCH across workers is the part that fits this architecture: worker w
-- of n takes candidates w, w+n, w+2n…, and the job keeps whichever worker's
-- model scored best. A single model still trains in one container.
--
-- Two columns and one function. The function exists because the merge is a
-- race: with n workers, n callbacks arrive at once, and whichever one is last
-- has to notice that it is last. Doing that as read-then-write in the app
-- would let two workers both believe they were last and finalise the job
-- twice.

ALTER TABLE public.ml_training_jobs
  ADD COLUMN IF NOT EXISTS shards integer NOT NULL DEFAULT 1,
  -- One entry per worker that reported: its outcome, plus the whole result of
  -- the winner so the merge does not need to re-fetch anything.
  ADD COLUMN IF NOT EXISTS shard_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Every sandbox this job started, so cancelling stops all of them and the
  -- orphan sweep can tell which are still alive. `session_id` keeps holding
  -- the first, so everything that reads one session still works.
  ADD COLUMN IF NOT EXISTS shard_sessions uuid[] NOT NULL DEFAULT '{}';

/**
 * Record one worker's outcome and say whether the job is now complete.
 *
 * Atomic on purpose: the append and the count happen in ONE statement, so of
 * n simultaneous callbacks exactly one sees done = total and performs the
 * merge. A second callback for a shard already recorded matches nothing and
 * returns no row, which is how a retried callback becomes a no-op.
 */
CREATE OR REPLACE FUNCTION public.ml_job_record_shard(
  _job uuid,
  _shard integer,
  _result jsonb
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
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(shard_results) e
        WHERE (e->>'shard')::integer = _shard
     )
  RETURNING jsonb_array_length(shard_results), shards;
$$;

-- Only the service role calls this; it is the app's own bookkeeping, not
-- something a browser session should be able to drive.
REVOKE ALL ON FUNCTION public.ml_job_record_shard(uuid, integer, jsonb)
  FROM public, anon, authenticated;

-- How many workers a search may use. Null = the env var, then the default of
-- 1, which is exactly what every job did before this migration.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_train_workers integer;
