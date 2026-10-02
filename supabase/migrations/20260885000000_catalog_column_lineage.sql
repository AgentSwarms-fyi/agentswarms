-- Column-level lineage.
--
-- catalog_lineage already carried upstream_column / downstream_column for
-- crawled (Unity Catalog) lineage; pipelines and SQL model builds now write
-- column edges too. One thing a column edge needs that a table edge did not:
-- whether it is exact. A column that passed through a Python or SQL step the
-- tracer cannot read is recorded as depending on every input column of that
-- step, and the page must be able to say so rather than present a guess as a
-- fact.
ALTER TABLE public.catalog_lineage
  ADD COLUMN IF NOT EXISTS exact boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.catalog_lineage.exact IS
  'false: this column edge is one of every input column of an opaque step (Python, SQL), not a traced dependency.';
