-- Columnar mirror of each dataset, for the DuckDB local engine.
--
-- Rows live in user_data_rows as one JSONB document each. That is a fine
-- system of record and a terrible thing to query: answering one question
-- means paging every row out over PostgREST — 250 round trips for a
-- 250k-row table — and rebuilding an in-memory table each time.
--
-- A Parquet mirror in object storage replaces that with a single compressed,
-- columnar read that DuckDB can project and filter directly. It is strictly a
-- CACHE: user_data_rows remains the source of truth, and every read path
-- falls back to it when the mirror is missing or stale.
--
-- `parquet_synced_at` is compared against `data_loaded_at` to decide currency.
-- A mirror is usable only when it is at least as new as the last row write —
-- so a write that fails to refresh the mirror degrades to the slow path
-- rather than serving stale numbers.
ALTER TABLE public.user_data_tables
  ADD COLUMN IF NOT EXISTS parquet_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS parquet_rows integer,
  ADD COLUMN IF NOT EXISTS parquet_bytes bigint;

-- Private. Objects are read server-side with the service role; nothing here is
-- ever handed to a browser, because a dataset's Parquet has no row filter or
-- column mask applied to it.
INSERT INTO storage.buckets (id, name, public)
VALUES ('datasets', 'datasets', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- No storage RLS policies are granted to `authenticated` on purpose: there is
-- no legitimate direct-download path for these objects. Adding one would
-- bypass shared_dataset_rows() and hand a grantee the unmasked table.
