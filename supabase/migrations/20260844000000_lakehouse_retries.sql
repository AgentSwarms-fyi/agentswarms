-- Write-conflict retries are invisible unless we record them: a table under
-- contention looks identical to a healthy one in the history view. Storing the
-- count per statement makes contention something an operator can SEE before it
-- turns into user-visible failures.
ALTER TABLE public.lakehouse_query_history
  ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.lakehouse_query_history.retries IS
  'Times this write lost a DuckLake commit race and was re-run. A losing commit applies nothing, so each retry is exactly-once.';
