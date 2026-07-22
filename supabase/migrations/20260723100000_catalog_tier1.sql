-- Data Catalog tier 1: scheduled crawls, change detection, curation depth.
--
--   - catalog_sources.crawl_schedule/next_crawl_at: the shared in-process
--     scheduler (and /api/bi/cron) re-crawls due sources and notifies the
--     owner about added/removed/changed assets.
--   - catalog_assets.schema_hash: fingerprint of the column set, used to
--     detect schema drift between crawls.
--   - catalog_assets.owner/status: governance curation — plain-text owner
--     and a certification state (draft / certified / deprecated). Like
--     description and tags, these survive re-crawls.

ALTER TABLE public.catalog_sources
  ADD COLUMN crawl_schedule text NOT NULL DEFAULT 'manual'
    CHECK (crawl_schedule IN ('manual', 'daily', 'weekly')),
  ADD COLUMN next_crawl_at timestamptz;

CREATE INDEX idx_catalog_sources_due
  ON public.catalog_sources(next_crawl_at)
  WHERE crawl_schedule <> 'manual';

ALTER TABLE public.catalog_assets
  ADD COLUMN owner text,
  ADD COLUMN status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'certified', 'deprecated')),
  ADD COLUMN schema_hash text;
