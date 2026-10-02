-- ETL-written lineage edges belong to a pipeline: runs replace their own
-- pipeline's edges wholesale (targets can be renamed between runs), and
-- deleting a pipeline takes its lineage with it.
alter table public.catalog_lineage
  add column if not exists pipeline_id uuid references public.etl_pipelines(id) on delete cascade;

create index if not exists catalog_lineage_pipeline_idx
  on public.catalog_lineage (pipeline_id) where pipeline_id is not null;
