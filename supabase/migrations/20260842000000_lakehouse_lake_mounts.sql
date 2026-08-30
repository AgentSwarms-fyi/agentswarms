-- Lake mounts: a lakehouse schema whose tables are VIEWS over files in a
-- catalog object-storage source. Users query them as ordinary tables; the
-- read_parquet/read_csv calls are server-authored inside the view bodies, so
-- nobody gains raw file access from the SQL editor.
ALTER TABLE public.lakehouse_schemas
  ADD COLUMN IF NOT EXISTS lake_source_id uuid REFERENCES public.catalog_sources(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.lakehouse_schemas.lake_source_id IS
  'When set, this schema is a READ-ONLY mount of that catalog storage source.';
