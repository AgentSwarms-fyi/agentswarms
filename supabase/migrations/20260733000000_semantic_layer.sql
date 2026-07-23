-- Semantic layer: governed, compilable metrics + dimensions.
--
-- A semantic_model binds a physical source (a local dataset or a warehouse
-- table) to a set of DIMENSIONS (how you slice) and METRICS (what you measure),
-- each authored as a trusted SQL fragment. A structured semantic query
-- (metrics + dimensions + filters) compiles deterministically to SQL, so
-- "revenue" always means the same thing across the BI engine and the AI agents —
-- and the AI only ever picks metric/dimension NAMES, never writes raw SQL.
create table if not exists public.semantic_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,                    -- stable id, ^[a-zA-Z_][a-zA-Z0-9_]*$
  label text,
  description text,
  source_kind text not null check (source_kind in ('data_table', 'warehouse')),
  table_id uuid references public.user_data_tables(id) on delete cascade,
  connection_id uuid references public.data_warehouse_connections(id) on delete cascade,
  source_table text not null,            -- FROM target: dataset name, or schema.table
  dimensions jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists idx_semantic_models_user on public.semantic_models(user_id);
create index if not exists idx_semantic_models_table on public.semantic_models(table_id);
create index if not exists idx_semantic_models_conn on public.semantic_models(connection_id);

alter table public.semantic_models enable row level security;

-- Owner manages their own models.
create policy "Users manage own semantic models"
  on public.semantic_models for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Forward-compat read sharing: once an IAM grant of type 'semantic_model'
-- exists, granted users/groups can read. Dormant until such grants are added
-- (the resource_grants type list is extended when the sharing UI lands).
create policy "Shared semantic models are readable"
  on public.semantic_models for select
  using (public.has_resource_access('semantic_model', id, auth.uid()));

create trigger update_semantic_models_updated_at
  before update on public.semantic_models
  for each row execute function public.update_updated_at_column();
