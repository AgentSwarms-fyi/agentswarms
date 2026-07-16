create table if not exists public.blog_reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  blog_slug text not null,
  reaction text not null check (reaction in ('like','dislike')),
  created_at timestamptz default now(),
  unique (user_id, blog_slug)
);

alter table public.blog_reactions enable row level security;

create policy "reactions readable by all" on public.blog_reactions for select using (true);
create policy "own reaction insert" on public.blog_reactions for insert with check (auth.uid() = user_id);
create policy "own reaction update" on public.blog_reactions for update using (auth.uid() = user_id);
create policy "own reaction delete" on public.blog_reactions for delete using (auth.uid() = user_id);

create table if not exists public.blog_comments (
  id uuid primary key default gen_random_uuid(),
  blog_slug text not null,
  user_id uuid not null,
  author_name text not null,
  content text not null,
  created_at timestamptz default now()
);

alter table public.blog_comments enable row level security;

create policy "comments readable by all" on public.blog_comments for select using (true);
create policy "own comment insert" on public.blog_comments for insert with check (auth.uid() = user_id);
create policy "own comment delete" on public.blog_comments for delete using (auth.uid() = user_id);