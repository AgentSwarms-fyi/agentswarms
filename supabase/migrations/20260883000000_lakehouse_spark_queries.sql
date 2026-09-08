-- A lakehouse SELECT can now run on the Spark engine.
--
-- Every lakehouse and BI query ran on DuckDB inside one app worker: fast per
-- core, spilling to disk, but one query never spanned machines, and the Spark
-- engine served pipelines only. A query sent to Spark is a job — a sandbox
-- connects to the cluster, builds one view per referenced table from that
-- table's snapshot files, runs the statement, and posts the rows back — so it
-- gets a row like a training job does: a status the page can poll, the rows
-- when it is done, the logs when it is not.
CREATE TABLE public.lakehouse_spark_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sql text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  row_cap integer NOT NULL DEFAULT 10000,
  -- The tables the statement reads and the files each one resolved to at
  -- the pinned snapshot, so the sandbox reads exactly what was governed.
  tables jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot bigint,
  session_id uuid,
  -- Per-query cluster under the Kubernetes provider; NULL under a static endpoint.
  spark_cluster_ref text,
  spark_connect_url text,
  result jsonb,
  logs text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX lakehouse_spark_queries_user_idx
  ON public.lakehouse_spark_queries (user_id, created_at DESC);
CREATE INDEX lakehouse_spark_queries_live_idx
  ON public.lakehouse_spark_queries (status)
  WHERE status IN ('queued', 'running');

ALTER TABLE public.lakehouse_spark_queries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own Spark queries"
  ON public.lakehouse_spark_queries FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.lakehouse_spark_queries IS
  'Lakehouse SELECTs run on the Spark engine: one row per query, polled by the page until it lands.';

-- The history says which engine answered, so a row that took 40 s on Spark is
-- not mistaken for a slow DuckDB one.
ALTER TABLE public.lakehouse_query_history
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'duckdb';
