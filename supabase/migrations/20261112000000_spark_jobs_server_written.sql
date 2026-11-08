-- R459: a Spark job's plan is written by the server only.
--
-- FOUND IN R459, building Iceberg jobs on this table. lakehouse_spark_queries
-- had one policy, FOR ALL with auth.uid() = user_id, and `authenticated` keeps
-- INSERT and UPDATE on every public table (20261110000000 revoked writes from
-- anon only). So a signed-in user could UPDATE their own queued query: the
-- `tables` column is the plan the sandbox is built from, the list of Parquet
-- files the cluster reads, and the scoped credential is minted for the
-- prefixes that list names. Rewritten between the insert and the sandbox's
-- start, it named another user's files, and the server issued a credential
-- for them. Measured on the live project before this migration:
-- has_table_privilege('authenticated', 'public.lakehouse_spark_queries',
-- 'UPDATE') was true and the policy was cmd ALL.
--
-- The app never wrote this table as the user (every write is the service
-- role, in sparkQuery.server.ts), so users keep reading their own jobs and
-- lose every write. etl_runs already had this shape. The code no longer trusts
-- the row either: the plan is sealed when it is recorded and checked before a
-- sandbox is built from it, which holds even where this migration has not run.

DROP POLICY IF EXISTS "Users manage their own Spark queries" ON public.lakehouse_spark_queries;
DROP POLICY IF EXISTS "Users read their own Spark queries" ON public.lakehouse_spark_queries;
CREATE POLICY "Users read their own Spark queries"
  ON public.lakehouse_spark_queries FOR SELECT
  USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.lakehouse_spark_queries FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.lakehouse_spark_queries FROM anon;

COMMENT ON TABLE public.lakehouse_spark_queries IS
  'Lakehouse jobs run on the Spark engine (a SELECT, or an Iceberg table''s maintenance): one row per job, written by the server only, polled by the page until it lands.';
