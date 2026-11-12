-- What a release of the app can read, write and call in the database: every
-- relation, column, function and enum value in the public schema, as one line
-- of JSON (R468). deploy/ci/migrations/schema-compat.mjs compares the snapshot
-- taken before an upgrade's migrations with the one taken after.
--
-- Functions an extension owns are left out (the extension's own upgrade moves
-- them), and so are trigger functions, which no client calls. The cast to
-- jsonb is what keeps it on one line: json_agg puts a newline between items.
select json_build_object(
  'relations', coalesce((
    select json_agg(json_build_object('name', c.relname, 'kind', c.relkind) order by c.relname)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  ), '[]'),
  'columns', coalesce((
    select json_agg(json_build_object(
             'relation', c.relname,
             'name', a.attname,
             'type', format_type(a.atttypid, a.atttypmod),
             'notNull', a.attnotnull,
             'hasDefault', a.atthasdef or a.attidentity <> '' or a.attgenerated <> ''
           ) order by c.relname, a.attnum)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and a.attnum > 0 and not a.attisdropped
  ), '[]'),
  'functions', coalesce((
    select json_agg(json_build_object(
             'name', p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'returns', pg_get_function_result(p.oid)
           ) order by p.proname, pg_get_function_identity_arguments(p.oid))
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ), '[]'),
  'enums', coalesce((
    select json_agg(json_build_object('type', t.typname, 'label', e.enumlabel)
                    order by t.typname, e.enumsortorder)
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
  ), '[]')
)::jsonb;
