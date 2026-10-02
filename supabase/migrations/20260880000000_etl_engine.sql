-- A pipeline chooses its execution engine.
--
-- Every pipeline so far has run as a pandas program inside one sandbox
-- container, and that stays the default — for the thousands of small, fast
-- pipelines it is the right engine and nothing about them changes. `spark`
-- is an opt-in for the pipelines whose data does not fit one box: the same
-- graph, compiled by a second emitter into a program that drives a Spark
-- cluster over Spark Connect from the sandbox.
--
-- ONE COLUMN, DEFAULTED, so this migration touches nothing that exists: every
-- current row becomes `pandas` and compiles to the byte-identical program it
-- compiled to yesterday.

ALTER TABLE public.etl_pipelines
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'pandas'
    CHECK (engine IN ('pandas', 'spark'));

-- Where the sandbox reaches a Spark Connect endpoint. Null means the Spark
-- engine is not available on this instance and the picker says so; the
-- environment variable SPARK_CONNECT_URL is the fallback, as for every other
-- runtime setting. This is the STATIC-ENDPOINT provider — an operator-run
-- cluster, or the compose `spark` profile locally; per-run provisioning on
-- Kubernetes or a cloud is a later provider behind the same setting.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS spark_connect_url text;
