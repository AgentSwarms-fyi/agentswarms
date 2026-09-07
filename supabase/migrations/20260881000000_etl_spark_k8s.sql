-- Per-run Spark clusters on Kubernetes.
--
-- The Spark engine gained a provider: `static` is what shipped (one endpoint
-- somebody else runs, shared by every run), and `k8s` creates a driver and its
-- executors for each run and deletes them when it ends. Sizing lives beside the
-- platform's other compute knobs — a null column means "not set here", so the
-- environment variable, then the built-in default, decides.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS spark_provider text NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS spark_image text,
  ADD COLUMN IF NOT EXISTS spark_executors integer,
  ADD COLUMN IF NOT EXISTS spark_executor_cores integer,
  ADD COLUMN IF NOT EXISTS spark_executor_mem_mb integer,
  ADD COLUMN IF NOT EXISTS spark_driver_mem_mb integer;

ALTER TABLE public.notebook_runtime_settings
  DROP CONSTRAINT IF EXISTS notebook_runtime_settings_spark_provider_check;
ALTER TABLE public.notebook_runtime_settings
  ADD CONSTRAINT notebook_runtime_settings_spark_provider_check
  CHECK (spark_provider IN ('static', 'k8s'));

COMMENT ON COLUMN public.notebook_runtime_settings.spark_provider IS
  'Where a Spark-engine run''s cluster comes from: static (a shared endpoint) or k8s (one per run).';

-- What to tear down, and where the run''s sandbox dials. On the run rather than
-- in memory because the replica that finalises a run is rarely the one that
-- started it — and a cluster nobody deletes costs real money.
ALTER TABLE public.etl_runs
  ADD COLUMN IF NOT EXISTS spark_cluster_ref text,
  ADD COLUMN IF NOT EXISTS spark_connect_url text;

COMMENT ON COLUMN public.etl_runs.spark_cluster_ref IS
  'Per-run Spark cluster to release when this run ends (namespace/name), or NULL for a shared endpoint.';
