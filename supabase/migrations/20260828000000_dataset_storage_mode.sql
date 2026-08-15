-- Per-dataset storage mode, and the last-read stamp a capacity budget needs.
--
-- Until now a dataset was mirrored or not by a size heuristic alone, which
-- meant the choice existed but nobody could make it. `storage_mode` turns it
-- into a decision:
--
--   auto    mirror it when the size makes that worth doing (today's behaviour,
--           and therefore the default — this migration changes nothing on its
--           own)
--   import  always mirror; the owner has said this one matters
--   direct  never mirror; always read the source
--
-- `parquet_last_used_at` is what makes eviction least-recently-USED rather than
-- least-recently-WRITTEN. Without it the only orderings available are by size
-- (which drops the useful big table first) or by refresh time (which drops the
-- stable table that never changes because it never changes).
--
-- Eviction only ever removes a CACHE. A dataset whose mirror is dropped still
-- answers the same question from the row store, more slowly. Nothing here can
-- narrow a query's scope, and nothing here changes an answer.
ALTER TABLE public.user_data_tables
  ADD COLUMN IF NOT EXISTS storage_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS parquet_last_used_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_data_tables_storage_mode_check'
  ) THEN
    ALTER TABLE public.user_data_tables
      ADD CONSTRAINT user_data_tables_storage_mode_check
      CHECK (storage_mode IN ('auto', 'import', 'direct'));
  END IF;
END $$;

-- The eviction sweep orders by this column across a whole workspace, so it is
-- worth an index even though the table is small per user.
CREATE INDEX IF NOT EXISTS user_data_tables_mirror_lru_idx
  ON public.user_data_tables (parquet_last_used_at)
  WHERE parquet_bytes IS NOT NULL;
