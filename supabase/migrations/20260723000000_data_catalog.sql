-- Data Catalog: crawlable data sources + cataloged assets.
--
-- A catalog source is either a registered warehouse/database connection
-- (references data_warehouse_connections) or an S3-compatible object
-- storage bucket (config public parts in `config`, secret credentials
-- AES-GCM encrypted in `credentials`, same scheme as warehouse creds).
-- Crawling lists tables/objects, infers schemas (CSV/JSON sampling for
-- buckets, information_schema for databases), flags likely-PII columns
-- and upserts the result into catalog_assets.

CREATE TABLE public.catalog_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('warehouse', 'object_storage')),
  name text NOT NULL,
  -- warehouse sources: the underlying connection (delete cascades here)
  connection_id uuid REFERENCES public.data_warehouse_connections(id) ON DELETE CASCADE,
  -- object storage sources: endpoint/region/bucket/prefix (non-secret)
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- object storage sources: { ciphertext, iv } (AES-GCM, server-side key)
  credentials jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'crawling', 'ready', 'error')),
  last_crawl_at timestamptz,
  last_error text,
  -- last crawl stats: { assets, columns, sampled, duration_ms }
  crawl_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE public.catalog_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own catalog sources" ON public.catalog_sources
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.catalog_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.catalog_sources(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('table', 'view', 'file', 'dataset')),
  -- warehouse schema, or the object's directory prefix for buckets
  schema_name text,
  name text NOT NULL,
  -- fully qualified name, unique within the source (schema.table / object key)
  fqn text NOT NULL,
  -- [{ name, type, sample?, pii? }]
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count bigint,
  size_bytes bigint,
  -- file assets: csv / json / ndjson / parquet / …; dataset = file count > 1
  format text,
  file_count integer,
  description text,
  tags text[] NOT NULL DEFAULT '{}',
  pii boolean NOT NULL DEFAULT false,
  last_crawled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, fqn)
);

ALTER TABLE public.catalog_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own catalog assets" ON public.catalog_assets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_catalog_assets_source ON public.catalog_assets(source_id);
CREATE INDEX idx_catalog_assets_user ON public.catalog_assets(user_id);
