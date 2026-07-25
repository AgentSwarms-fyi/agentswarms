-- Source-derived data lineage for the catalog. Complements the existing
-- app-usage lineage (which scans BI dashboards / prep flows / metrics for
-- table references) with REAL upstream→downstream edges read from the source
-- system's own lineage tables — Databricks Unity Catalog
-- system.access.table_lineage / column_lineage, with column-level pairs when
-- available. Refreshed on each crawl (deleted + reinserted per source).
create table public.catalog_lineage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  upstream_fqn text not null,
  downstream_fqn text not null,
  -- NULL for table-level edges; set for column-level lineage.
  upstream_column text,
  downstream_column text,
  source_system text not null default 'databricks',
  created_at timestamptz not null default now()
);

create index idx_catalog_lineage_source ON public.catalog_lineage(source_id);
create index idx_catalog_lineage_down ON public.catalog_lineage(downstream_fqn);
create index idx_catalog_lineage_up ON public.catalog_lineage(upstream_fqn);

alter table public.catalog_lineage enable row level security;
-- Owner manages their own lineage…
create policy "Users manage own catalog lineage"
  on public.catalog_lineage for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- …and grantees of the parent source can read it (same grain as assets).
create policy "Granted catalog lineage is visible"
  on public.catalog_lineage for select
  using (public.has_resource_access('catalog_source', source_id, auth.uid()));
