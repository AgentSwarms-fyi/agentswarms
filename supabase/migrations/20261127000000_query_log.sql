-- R531: one record of the queries run for each person, and what each cost.
--
-- Queries ran in many places and were kept in few. The workbench kept its own
-- recent list (sql_query_history, which its owner may edit or delete: right
-- for a list to re-run from, wrong for a record of cost), the lakehouse kept
-- its own, and a dashboard refresh, a schedule, an agent's query or the
-- analyst kept nothing. Nothing kept what the warehouse said a query scanned.
--
-- One row per query, written by the server only, at the places every query
-- passes through: the warehouse driver seam, the lakehouse statement runner,
-- the server's local engine, the object-store reader, and (reported by the
-- browser, through a server function) the workbench's in-browser engine.
--
--   user_id         whose history and whose bill: for a shared dashboard the
--                   owner, whose connection ran the query
--   actor_user_id   who caused it, when that is someone else
--   via             what it was for: workbench, dashboard, agent, schedule...
--   engine          what ran it: browser, local, lakehouse, spark, objectstore,
--                   or the warehouse provider (athena, bigquery, trino...)
--   bytes_scanned   what the engine said it read, where it says
--   cost_usd        an estimate at the price in cost_basis, kept with the row
--                   so a later price change does not rewrite history
--   ai_cost_usd     model calls the statement made (ai_* SQL functions)
--
-- Retention follows the trace setting (iam_settings.trace_retention_days):
-- kept unless an administrator sets a window.

CREATE TABLE IF NOT EXISTS public.query_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  via text NOT NULL CHECK (via ~ '^[a-z][a-z_]{0,23}$'),
  engine text NOT NULL CHECK (engine ~ '^[a-z][a-z0-9_]{0,31}$'),
  connection_id text CHECK (connection_id IS NULL OR char_length(connection_id) <= 80),
  connection_name text CHECK (connection_name IS NULL OR char_length(connection_name) <= 200),
  sql text NOT NULL CHECK (char_length(sql) <= 20000),
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  row_count integer CHECK (row_count IS NULL OR row_count >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  bytes_scanned bigint CHECK (bytes_scanned IS NULL OR bytes_scanned >= 0),
  engine_query_id text CHECK (engine_query_id IS NULL OR char_length(engine_query_id) <= 200),
  cost_usd numeric CHECK (cost_usd IS NULL OR cost_usd >= 0),
  cost_basis text CHECK (cost_basis IS NULL OR char_length(cost_basis) <= 200),
  ai_cost_usd numeric CHECK (ai_cost_usd IS NULL OR ai_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS query_log_user_created_idx
  ON public.query_log (user_id, created_at DESC);

ALTER TABLE public.query_log ENABLE ROW LEVEL SECURITY;

-- Owners read their own rows. There is NO insert, update or delete policy:
-- the server writes with the service role, which bypasses RLS, so nobody can
-- edit or erase what a query cost (the lesson of VA-2026-10-25-13, where
-- execution_traces could be zeroed from the browser).
DROP POLICY IF EXISTS "Owners read their query log" ON public.query_log;
CREATE POLICY "Owners read their query log"
  ON public.query_log
  FOR SELECT
  USING (auth.uid() = user_id);

-- What the Query history page adds up: the caller's own queries since a time,
-- by what they were for and what ran them. SECURITY INVOKER, so RLS and the
-- user_id filter both hold.
CREATE OR REPLACE FUNCTION public.query_log_summary(p_since timestamptz)
RETURNS TABLE (
  via text,
  engine text,
  queries bigint,
  failed bigint,
  bytes_scanned numeric,
  cost_usd numeric,
  ai_cost_usd numeric,
  duration_ms numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT q.via,
         q.engine,
         count(*),
         count(*) FILTER (WHERE q.status = 'error'),
         coalesce(sum(q.bytes_scanned), 0),
         coalesce(sum(q.cost_usd), 0),
         coalesce(sum(q.ai_cost_usd), 0),
         coalesce(sum(q.duration_ms), 0)
    FROM public.query_log q
   WHERE q.user_id = auth.uid()
     AND q.created_at >= p_since
   GROUP BY q.via, q.engine;
$$;

REVOKE EXECUTE ON FUNCTION public.query_log_summary(timestamptz) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.query_log_summary(timestamptz) TO authenticated;

-- Prove the lock on apply: one SELECT policy and no client write policy.
DO $$
DECLARE
  n_write integer;
BEGIN
  SELECT count(*) INTO n_write FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'query_log'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  IF n_write > 0 THEN
    RAISE EXCEPTION 'query_log must have no client write policy (found %)', n_write;
  END IF;
END $$;
