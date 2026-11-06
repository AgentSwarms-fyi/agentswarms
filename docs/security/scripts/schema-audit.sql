-- A read of what the migrated schema actually ended up with.
--
-- Reading the migrations tells you what was written. This reads Postgres's own catalog,
-- so it sees the sum of every migration, and Supabase's default grants, which no
-- migration in this repository mentions. It changes nothing: it runs in a read-only
-- transaction and rolls back.
--
--   docker exec -i supabase-db psql -U postgres -d postgres < docs/security/scripts/schema-audit.sql
--   psql "$DATABASE_URL" -f docs/security/scripts/schema-audit.sql
--
-- Run it after any migration that touches access, and before a release. Each section
-- says what healthy looks like. docs/security/README.md says how to read the output, and
-- docs/security/assessments/2026-11-06-schema.md is what it printed last.
begin transaction read only;
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '

\echo == 1 tables with row-level security off. Healthy: none.
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
order by 1;

\echo == 2 views running as their owner, which skip the row-level security of the caller. Healthy: none.
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and not coalesce(c.reloptions::text ~ 'security_invoker=(true|on)', false)
order by 1;

\echo == 3 materialized views, which row-level security cannot cover, that clients can read. Healthy: none.
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'm'
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
order by 1;

\echo == 4 SECURITY DEFINER functions with no fixed search_path. Healthy: none.
select p.oid::regprocedure
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
order by 1;

\echo == 5 SECURITY DEFINER functions the signed-out role can call, excluding triggers. Read each new one.
select p.oid::regprocedure,
       case when pg_get_functiondef(p.oid) ~ 'auth\.uid\(\)' then 'mentions auth.uid' else 'no caller check' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
  and p.prorettype <> 'trigger'::regtype
order by 1;

\echo == 6 guards written as IF NOT (...) over something that can be NULL. Read each one.
\echo == With no signed-in user auth.uid() is NULL, a comparison with it is NULL, NOT NULL is NULL, and IF NULL does not refuse.
\echo == Safe only if every branch is a real true or false. Wrap the condition in COALESCE(..., false).
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosrc ~* 'if\s+not\s*\(' and p.prosrc ~* 'auth\.(uid|role|jwt)\('
order by 1;

\echo == 7 policies the signed-out role reaches with no auth check. Healthy: only ones that are false.
select tablename, policyname, cmd, left(coalesce(qual, ''), 80), left(coalesce(with_check, ''), 80)
from pg_policies
where schemaname = 'public' and roles && array['anon', 'public']::name[]
  and coalesce(qual, '') !~ 'auth\.' and coalesce(with_check, '') !~ 'auth\.'
order by 1, 2;

\echo == 8 write policies whose condition is simply true. Healthy: none.
select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true')
order by 1, 2;

\echo == 9 read policies whose condition is simply true. Read each: everyone signed in sees the whole table.
select tablename, policyname, roles::text
from pg_policies
where schemaname = 'public' and cmd in ('SELECT', 'ALL') and qual = 'true'
order by 1, 2;

\echo == 10 tables the signed-out role can write to, or that a client can truncate. Healthy: none.
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
  and (has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update')
       or has_table_privilege('anon', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'truncate')
       or has_table_privilege('authenticated', c.oid, 'truncate'))
order by 1;

\echo == 11 tables with an is_sample flag and no trigger refusing it from clients. Healthy: none.
select c.table_name
from information_schema.columns c
where c.table_schema = 'public' and c.column_name = 'is_sample'
  and not exists (
    select 1 from pg_trigger t
    where t.tgrelid = format('public.%I', c.table_name)::regclass and t.tgname = 'refuse_client_sample_flag'
  )
order by 1;

\echo == 12 samples somebody owns. Healthy: none. Every real sample has no owner, so look at any row here.
select 'user_data_tables', id::text, name from public.user_data_tables where is_sample and user_id is not null
union all select 'knowledge_bases', id::text, name from public.knowledge_bases where is_sample and user_id is not null
union all select 'knowledge_documents', id::text, name from public.knowledge_documents where is_sample and user_id is not null
order by 1, 3;

\echo == 13 storage buckets as id, public, size limit, types allowed. A public bucket should have both limits.
select id, public, file_size_limit, coalesce(array_to_string(allowed_mime_types, ','), 'any type')
from storage.buckets order by 1;

\echo == 14 storage policies open to the signed-out role. Read each.
select policyname, cmd, left(coalesce(qual, ''), 80)
from pg_policies
where schemaname = 'storage' and tablename = 'objects' and roles && array['anon', 'public']::name[]
order by 1;

\echo == 15 tables published to Realtime. Read each: row-level security decides who hears a change.
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1, 2;

rollback;
