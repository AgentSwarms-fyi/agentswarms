-- The physical layout of a lakehouse table: the columns it is clustered by,
-- and what the last rewrite did.
--
-- Clustering rewrites a table's files in key order so that DuckLake's
-- per-file column statistics (min/max per file, kept in the catalog) let a
-- filtered query open only the files whose range matches — the same lever
-- OPTIMIZE ... ZORDER pulls, in its plain sorted form. DuckLake itself keeps
-- no sort order, so the keys live here; the rewrite is the app's, one
-- transaction per table. Partitioning is different and stays in DuckLake's
-- own catalog: it decides which file a row goes to when written, clustering
-- decides the order of what is already there.

CREATE TABLE public.lakehouse_table_layouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_name text NOT NULL,
  table_name text NOT NULL,
  -- Key order matters: files are ranged on the first key and sorted by all.
  cluster_columns text[] NOT NULL DEFAULT '{}',
  -- NULL = the platform default (LAKEHOUSE_CLUSTER_FILE_BYTES, else 128 MiB).
  target_file_bytes bigint CHECK (target_file_bytes IS NULL OR target_file_bytes > 0),
  -- Maintenance rewrites the table again when files were written since the
  -- last rewrite; off = a one-time rewrite that later loads may disorder.
  keep_clustered boolean NOT NULL DEFAULT false,
  last_rewrite_at timestamptz,
  last_rewrite_ms integer,
  last_rewrite_rows bigint,
  last_rewrite_files_before integer,
  last_rewrite_files_after integer,
  -- The lakehouse snapshot the rewrite produced; files begun after it are
  -- the ones not in key order.
  last_rewrite_snapshot bigint,
  last_error text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schema_name, table_name)
);

ALTER TABLE public.lakehouse_table_layouts ENABLE ROW LEVEL SECURITY;

-- The schema's owner may read the layout row; every write goes through the
-- service role from server functions that check schema access.
CREATE POLICY "Schema owners view table layouts"
  ON public.lakehouse_table_layouts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lakehouse_schemas s
    WHERE s.name = schema_name AND s.user_id = auth.uid()
  ));

CREATE INDEX lakehouse_table_layouts_keep_idx
  ON public.lakehouse_table_layouts (keep_clustered) WHERE keep_clustered;
