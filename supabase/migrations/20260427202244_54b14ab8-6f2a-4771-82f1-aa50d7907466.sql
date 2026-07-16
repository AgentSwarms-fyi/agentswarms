create table if not exists public.user_announcements_dismissed (
  user_id uuid not null,
  announcement_key text not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, announcement_key)
);
alter table public.user_announcements_dismissed enable row level security;
create policy "users read own dismissals" on public.user_announcements_dismissed
  for select using (auth.uid() = user_id);
create policy "users insert own dismissals" on public.user_announcements_dismissed
  for insert with check (auth.uid() = user_id);