-- Cross-instance rate limiting and concurrency gating.
--
-- The limits behind POST /api/swarm/run (SWARM_RUN_RATE_LIMIT_PER_MIN,
-- SWARM_RUN_MAX_CONCURRENT) were counted in each app instance's memory, so
-- behind a load balancer with N instances the real ceiling was N x the
-- configured number. An operator who set "30 runs per minute" and scaled to
-- four instances silently got 120. A documented limit that is not the actual
-- limit is a governance defect, not a tuning detail.
--
-- Both primitives live in SQL so every instance shares one counter. The two
-- functions are the whole API; callers never touch these tables directly.

-- ── Sliding-window request hits ─────────────────────────────────────────────
create table if not exists public.rate_limit_hits (
  id bigserial primary key,
  bucket text not null,
  at timestamptz not null default now()
);

-- The only access pattern: "recent hits for this bucket", plus expiry sweeps.
create index if not exists rate_limit_hits_bucket_at_idx
  on public.rate_limit_hits (bucket, at desc);

alter table public.rate_limit_hits enable row level security;
-- Deliberately NO policies: service role only. Holds no user data (buckets are
-- opaque keys such as 'swarm-run:<api key id>').

-- ── Concurrency leases ──────────────────────────────────────────────────────
-- A LEASE rather than a counter: if an instance dies mid-run its slot must free
-- itself, or the cap ratchets down to zero and never recovers. Callers renew
-- nothing; they release explicitly and the TTL is the backstop.
create table if not exists public.concurrency_leases (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists concurrency_leases_bucket_idx
  on public.concurrency_leases (bucket, expires_at);

alter table public.concurrency_leases enable row level security;
-- Service role only, as above.

-- ── take a slot in the sliding window ───────────────────────────────────────
-- Returns true when the caller is ALLOWED (and the hit has been recorded),
-- false when the bucket is already at its limit. One statement per branch so
-- the count-and-insert cannot interleave with a concurrent caller.
create or replace function public.rate_limit_take(
  _bucket text,
  _max int,
  _window_seconds int default 60
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  used int;
begin
  -- Expire this bucket's old hits first so the window really slides.
  delete from public.rate_limit_hits
   where bucket = _bucket
     and at < now() - make_interval(secs => _window_seconds);

  select count(*) into used
    from public.rate_limit_hits
   where bucket = _bucket;

  if used >= _max then
    return false;
  end if;

  insert into public.rate_limit_hits (bucket) values (_bucket);
  return true;
end;
$$;

-- ── acquire / release a concurrency slot ────────────────────────────────────
-- Returns the lease id, or null when the bucket is full. The caller MUST pass
-- the id to concurrency_release in a finally block; the TTL only covers crashes.
create or replace function public.concurrency_acquire(
  _bucket text,
  _max int,
  _lease_seconds int default 900
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  used int;
  new_id uuid;
begin
  delete from public.concurrency_leases
   where bucket = _bucket and expires_at < now();

  select count(*) into used
    from public.concurrency_leases
   where bucket = _bucket;

  if used >= _max then
    return null;
  end if;

  insert into public.concurrency_leases (bucket, expires_at)
       values (_bucket, now() + make_interval(secs => _lease_seconds))
    returning id into new_id;

  return new_id;
end;
$$;

create or replace function public.concurrency_release(_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.concurrency_leases where id = _id;
$$;

-- Housekeeping for buckets that stop being used entirely: the per-call deletes
-- above only ever touch the bucket being asked about.
create or replace function public.rate_limit_sweep()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limit_hits where at < now() - interval '1 hour';
  delete from public.concurrency_leases where expires_at < now();
$$;

revoke all on function public.rate_limit_take(text, int, int) from public, anon, authenticated;
revoke all on function public.concurrency_acquire(text, int, int) from public, anon, authenticated;
revoke all on function public.concurrency_release(uuid) from public, anon, authenticated;
revoke all on function public.rate_limit_sweep() from public, anon, authenticated;
