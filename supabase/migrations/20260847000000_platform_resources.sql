-- Compute limits an operator can actually change.
--
-- These knobs decided how much of the host the platform would use, and they
-- lived in three different places: two in this settings table with validation
-- ceilings baked in, two only in .env (so changing them meant a redeploy), and
-- two as CONSTANTS in TypeScript — unreachable without a code change. On a
-- 16-core / 128 GB machine the defaults spent about 6 cores and 12 GB and
-- there was no supported way to spend the rest.
--
-- Everything is nullable and defaults to NULL, meaning "keep using the
-- environment variable or the built-in default". Nothing changes for an
-- existing deployment until someone deliberately sets a value.
ALTER TABLE public.notebook_runtime_settings
  -- DuckDB engine serving the lakehouse, in THIS process (not a sandbox).
  -- NULL = LAKEHOUSE_MEMORY_LIMIT / LAKEHOUSE_THREADS, else their defaults.
  ADD COLUMN IF NOT EXISTS lakehouse_memory_limit text,
  ADD COLUMN IF NOT EXISTS lakehouse_threads integer,
  -- ETL throughput. Previously MAX_CONCURRENT_RUNS_PER_USER and
  -- PIPELINES_PER_SWEEP, both hardcoded to 3.
  ADD COLUMN IF NOT EXISTS etl_max_concurrent_runs_per_user integer,
  ADD COLUMN IF NOT EXISTS etl_pipelines_per_sweep integer,
  -- Writable scratch inside a sandbox: /home/runner/.local (pip installs) and
  -- /home/runner/work. 512 MB was hardcoded, and a pipeline using both the SQL
  -- transform and a lakehouse node installs ~447 MB into it — close enough to
  -- the ceiling to fail intermittently.
  ADD COLUMN IF NOT EXISTS sandbox_tmpfs_mb integer;

COMMENT ON COLUMN public.notebook_runtime_settings.lakehouse_memory_limit IS
  'Memory ceiling per lakehouse query engine, e.g. ''48GB''. NULL = LAKEHOUSE_MEMORY_LIMIT env, else 2GB.';
COMMENT ON COLUMN public.notebook_runtime_settings.lakehouse_threads IS
  'Threads per lakehouse query engine. NULL = LAKEHOUSE_THREADS env, else 4.';
COMMENT ON COLUMN public.notebook_runtime_settings.etl_max_concurrent_runs_per_user IS
  'Pipelines one user may have running at once. NULL = 3.';
COMMENT ON COLUMN public.notebook_runtime_settings.etl_pipelines_per_sweep IS
  'Due pipelines started per scheduler sweep (sweeps run every 60s). NULL = 3.';
COMMENT ON COLUMN public.notebook_runtime_settings.sandbox_tmpfs_mb IS
  'Writable tmpfs size per sandbox for ~/.local and ~/work, in MB. NULL = 512.';
