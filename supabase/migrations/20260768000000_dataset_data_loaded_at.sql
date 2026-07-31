-- When was this dataset's DATA last written?
--
-- `updated_at` cannot answer that. A BEFORE UPDATE trigger stamps it on every
-- write to the row, so renaming a dataset or re-saving its column metadata
-- resets the clock — and a freshness SLA built on it would report a table that
-- stopped loading months ago as fresh, which is the most misleading direction
-- to be wrong in. (Same failure the dashboard share page had when its
-- "Data as of" read `updated_at`.)
--
-- `data_loaded_at` is set only by the paths that actually replace rows:
-- uploads, prep runs, scheduled refreshes and restores.
ALTER TABLE public.user_data_tables
  ADD COLUMN IF NOT EXISTS data_loaded_at timestamptz;

-- Backfill: for existing datasets `updated_at` is the best estimate available,
-- and it is never newer than the real load.
UPDATE public.user_data_tables
  SET data_loaded_at = COALESCE(updated_at, created_at)
  WHERE data_loaded_at IS NULL;

ALTER TABLE public.user_data_tables
  ALTER COLUMN data_loaded_at SET DEFAULT now();
