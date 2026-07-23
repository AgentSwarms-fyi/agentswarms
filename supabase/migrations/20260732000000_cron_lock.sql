-- Cross-instance leader lease for the scheduled-work pass.
--
-- AgentSwarms runs a 60s in-process scheduler (BI refreshes, data alerts,
-- scheduled reports, swarm schedules, catalog crawls, notebook-kernel reaping)
-- and also exposes /api/bi/cron for external cron services. When the app runs
-- as MULTIPLE instances behind a load balancer, each instance's scheduler (and
-- any external cron) would otherwise process the same due rows and double-fire
-- side effects (duplicate alert emails, scheduled report digests, swarm runs,
-- catalog crawls). This single-row lease, claimed with an atomic conditional
-- UPDATE, ensures only one runner does the work at a time; a TTL on the lease
-- makes a crashed holder self-heal without any coordination service.
create table if not exists public.cron_locks (
  name text primary key,
  locked_until timestamptz,
  holder text,
  updated_at timestamptz not null default now()
);

alter table public.cron_locks enable row level security;
-- Deliberately NO policies: only the service role (which bypasses RLS) ever
-- reads or writes this table. It holds no user data.

-- Seed the single lease row the scheduler claims.
insert into public.cron_locks (name) values ('scheduler')
on conflict (name) do nothing;
