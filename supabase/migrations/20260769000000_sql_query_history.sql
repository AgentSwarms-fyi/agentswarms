-- SQL workbench query history.
--
-- The audit trail already records THAT a dataset was queried, but it stores a
-- 200-character excerpt for compliance, not the statement you actually want
-- back. Every other SQL tool keeps a per-user history because the most common
-- request is "what was that query I ran on Tuesday" — and without one, a long
-- ad-hoc query is lost the moment the editor is cleared.
--
-- Deliberately separate from audit_events: that table is hash-chained and
-- retention-governed for compliance, while this is a convenience log the user
-- owns and may delete at will.
CREATE TABLE IF NOT EXISTS public.sql_query_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Where it ran: the local dataset engine, or a warehouse connection.
  source text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'warehouse')),
  connection_id uuid,
  connection_name text,
  sql text NOT NULL,
  row_count integer,
  duration_ms integer,
  -- Failures are kept too: re-running the query that broke is the point.
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sql_history_user_time
  ON public.sql_query_history(user_id, created_at DESC);

ALTER TABLE public.sql_query_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own query history" ON public.sql_query_history
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
