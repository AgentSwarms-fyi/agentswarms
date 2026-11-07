-- The catalog learns what a lake is.
--
-- Four additions, none of which touches a row that is already there:
--
--   hive_metastore    a source kind: a Hive Metastore, read over Thrift.
--                     Metadata only, like iceberg_rest. No secret is stored, so
--                     `credentials` stays NULL and `config` holds host and port.
--
--   glue              a source kind: AWS Glue Data Catalog, which is the same
--                     table model reached by signed HTTPS. Its keys are
--                     encrypted in `credentials`, as a bucket's are.
--
--   metadata          where an asset lives and how it is laid out: location,
--                     table type, file format, serde, partition keys and count,
--                     a view's SQL. Crawler-owned and rewritten on every crawl.
--
--   catalog_schema_versions
--                     what changed each time a schema changed. A crawl has
--                     always compared a fingerprint, and that fingerprint was
--                     all it kept: the catalog could say "changed", not what.
--
-- Apply this BEFORE deploying the build that reads it: the catalog page selects
-- `metadata` by name. A build from before this ignores every one of the four.

ALTER TABLE public.catalog_sources DROP CONSTRAINT catalog_sources_kind_check;
ALTER TABLE public.catalog_sources
  ADD CONSTRAINT catalog_sources_kind_check
  CHECK (kind IN ('warehouse', 'object_storage', 'iceberg_rest', 'hive_metastore', 'glue'));

ALTER TABLE public.catalog_assets
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.catalog_assets.metadata IS
  'Crawler-owned facts about where the asset lives and how it is laid out. Replaced on every crawl; curation lives in description, tags, owner and status.';

CREATE TABLE public.catalog_schema_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.catalog_sources(id) ON DELETE CASCADE,
  -- The asset's name, not its id: an asset that goes and comes back is the same
  -- table to whoever is reading its history.
  fqn text NOT NULL,
  schema_hash text NOT NULL,
  -- { added: [{name,type}], removed: [{name,type}], retyped: [{name,from,to}] }
  changes jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalog_schema_versions_asset
  ON public.catalog_schema_versions (source_id, fqn, recorded_at DESC);

ALTER TABLE public.catalog_schema_versions ENABLE ROW LEVEL SECURITY;

-- Read like the assets: the owner, and whoever the source is granted to.
CREATE POLICY "Owners read their schema history"
  ON public.catalog_schema_versions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Granted schema history is visible"
  ON public.catalog_schema_versions FOR SELECT
  USING (public.has_resource_access('catalog_source', source_id, auth.uid()));

-- No write policy, on purpose. This is a record of what the source did, written
-- by the crawl under the service role. An owner may curate an asset; nobody
-- edits what happened to it. Default privileges already keep writes from anon,
-- and these keep them from a signed-in client too.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.catalog_schema_versions FROM anon, authenticated;
