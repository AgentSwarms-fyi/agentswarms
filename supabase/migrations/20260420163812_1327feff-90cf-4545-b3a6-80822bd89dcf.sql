-- Tables for user-uploaded CSV datasets queryable via SQL playground & sql_query agent tool

create table public.user_data_tables (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  source_filename text,
  columns jsonb not null default '[]'::jsonb,
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.user_data_rows (
  id bigserial primary key,
  table_id uuid not null references public.user_data_tables(id) on delete cascade,
  row jsonb not null
);

create index idx_user_data_rows_table_id on public.user_data_rows(table_id);
create index idx_user_data_tables_user_id on public.user_data_tables(user_id);

alter table public.user_data_tables enable row level security;
alter table public.user_data_rows enable row level security;

-- user_data_tables policies
create policy "Users manage own data tables"
  on public.user_data_tables
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_data_rows policies (scoped via parent table ownership)
create policy "Users select own data rows"
  on public.user_data_rows
  for select
  using (exists (
    select 1 from public.user_data_tables t
    where t.id = user_data_rows.table_id and t.user_id = auth.uid()
  ));

create policy "Users insert own data rows"
  on public.user_data_rows
  for insert
  with check (exists (
    select 1 from public.user_data_tables t
    where t.id = user_data_rows.table_id and t.user_id = auth.uid()
  ));

create policy "Users update own data rows"
  on public.user_data_rows
  for update
  using (exists (
    select 1 from public.user_data_tables t
    where t.id = user_data_rows.table_id and t.user_id = auth.uid()
  ));

create policy "Users delete own data rows"
  on public.user_data_rows
  for delete
  using (exists (
    select 1 from public.user_data_tables t
    where t.id = user_data_rows.table_id and t.user_id = auth.uid()
  ));

-- updated_at trigger
create trigger update_user_data_tables_updated_at
  before update on public.user_data_tables
  for each row
  execute function public.update_updated_at_column();