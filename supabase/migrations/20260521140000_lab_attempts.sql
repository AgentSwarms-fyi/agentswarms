-- Failure-Mode Lab progress. Mirrors the quiz_attempts pattern: one row per
-- (user, lab), updated in place on each attempt. RLS scopes every row to its
-- owner. After applying, regenerate src/integrations/supabase/types.ts.

create table if not exists public.lab_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  lab_id text not null,
  solved boolean not null default false,
  hints_used int not null default 0,
  attempts int not null default 1,
  revealed boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, lab_id)
);

alter table public.lab_attempts enable row level security;

create policy "own lab_attempts read"
  on public.lab_attempts for select
  using (auth.uid() = user_id);

create policy "own lab_attempts insert"
  on public.lab_attempts for insert
  with check (auth.uid() = user_id);

create policy "own lab_attempts update"
  on public.lab_attempts for update
  using (auth.uid() = user_id);
