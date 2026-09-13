-- Training one model on more rows than one container holds.
--
-- 20260878000000 spread the SEARCH across containers: every worker read the
-- same rows and tried a different set of algorithms. This spreads the ROWS:
-- once the search has picked a winner, workers refit that one algorithm on
-- disjoint slices and their fits are averaged into a single model.
--
-- So a job can now have three phases rather than one, and the columns here
-- exist because the merge has to know which phase it is merging. The same
-- ml_job_record_shard function counts the workers in every phase — the phase
-- transition resets shard_results, so "n of n reported" means the same thing
-- each time.

ALTER TABLE public.ml_training_jobs
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'search',
  -- What the search decided, kept so the assemble step can write the job's
  -- result without re-deriving a leaderboard nobody re-ran.
  ADD COLUMN IF NOT EXISTS search_result jsonb,
  ADD COLUMN IF NOT EXISTS parallel_algorithm text,
  ADD COLUMN IF NOT EXISTS parallel_workers integer NOT NULL DEFAULT 0,
  -- Rows the fit actually covered and rows there were. Both, because "trained
  -- on 8 million rows" and "trained on 8 of 100 million rows" are different
  -- claims and only one of them is usually true.
  ADD COLUMN IF NOT EXISTS parallel_rows bigint,
  ADD COLUMN IF NOT EXISTS parallel_total_rows bigint;

ALTER TABLE public.ml_training_jobs
  DROP CONSTRAINT IF EXISTS ml_training_jobs_phase_check;

ALTER TABLE public.ml_training_jobs
  ADD CONSTRAINT ml_training_jobs_phase_check
    CHECK (phase IN ('search', 'parallel_fit', 'assemble'));

COMMENT ON COLUMN public.ml_training_jobs.phase IS
  'search: workers try different algorithms on the same rows. parallel_fit: workers refit the winning algorithm on disjoint slices of the rows. assemble: one container averages their fits into a single model. A job that is not data-parallel stays in search for its whole life.';
COMMENT ON COLUMN public.ml_training_jobs.parallel_rows IS
  'Rows the distributed fit actually read, across all workers. Compared against parallel_total_rows, never assumed equal to it.';

/**
 * Move a job to its next phase, once.
 *
 * The same race the shard merge has, one level up: of n workers finishing a
 * phase, exactly one must start the next. `WHERE phase = _from` is the claim —
 * the losers update no row, read nothing back, and return.
 *
 * shard_results is cleared as part of the same statement rather than
 * afterwards, because a worker from the NEXT phase reporting into the previous
 * phase's results would make "n of n reported" true early and assemble a model
 * out of half the slices.
 */
CREATE OR REPLACE FUNCTION public.ml_job_advance_phase(
  _job uuid,
  _from text,
  _to text,
  _shards integer,
  _algorithm text,
  _search jsonb
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
      search_result = COALESCE(_search, search_result)
  WHERE id = _job AND phase = _from
  RETURNING true;
$$;
