-- Query history gains the two facts that make performance debuggable:
-- whether a result came from cache (so a "fast" query is not mistaken for a
-- fast plan), and how many rows the engine actually scanned.
ALTER TABLE public.lakehouse_query_history
  ADD COLUMN IF NOT EXISTS cached boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rows_scanned bigint;
