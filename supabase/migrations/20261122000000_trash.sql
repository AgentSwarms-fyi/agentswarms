-- Trash with restore (R516).
--
-- Deleting was final. A dashboard, an agent or a workflow deleted by a slip of
-- the hand was gone, with its versions, schedules and history, and the only
-- way back was a database restore.
--
-- HOW IT WORKS. Moving something to the trash takes a copy of its row and of
-- every row the database deletes along with it, and then deletes it exactly as
-- before. Nothing else in the product has to know: a trashed workflow has no
-- row, so no scheduler runs it, no key serves it and no list shows it.
-- Restoring puts the rows back with the ids they had, so everything that
-- pointed at the object by id points at it again.
--
-- WHAT IS COPIED is found from the foreign keys, not from a list kept by
-- hand: every ON DELETE CASCADE reference, to any depth. A table added next
-- month with such a reference is copied without this file changing. A
-- reference the database would SET NULL is remembered and put back on
-- restore, when the row that held it is still there and still empty.
--
-- WHO MAY. Only the owner of the object, and only for the kinds listed in
-- trash_kinds(): the ones whose deletion destroys nothing outside this
-- database. The functions are SECURITY DEFINER because a faithful copy has to
-- read rows the owner's own session cannot (a workbook's shares, a
-- dashboard's stored results), so each one checks by hand that the caller
-- owns what it names, and takes the table to act on from the kind, never from
-- the caller.
--
-- WHAT THE OWNER CAN READ BACK. Not the copy. trash_items has row-level
-- security on and no policy: the copy holds rows from tables the owner cannot
-- read directly (key hashes, sealed values). my_trash() lists what is in the
-- trash by name and nothing more.

CREATE TABLE IF NOT EXISTS public.trash_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  object_id uuid NOT NULL,
  -- As it was stored when it was deleted, so a sealed name is still sealed.
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 2000),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  -- Emptied by the daily pass once this has passed.
  purge_after timestamptz NOT NULL,
  -- [{"t": "public.agents", "r": {...}}, ...] in the order they were found.
  payload jsonb NOT NULL,
  -- [{"t": "public.x", "pk": "id", "id": ..., "c": "agent_id", "v": ...}]:
  -- references the delete set to null, to be put back on restore.
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL
);

ALTER TABLE public.trash_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trash_items FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS trash_items_owner_idx
  ON public.trash_items (user_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS trash_items_purge_idx
  ON public.trash_items (purge_after);

-- The kinds that can be moved to the trash, the table each lives in and the
-- column its name is in (or several, comma-separated: the first one filled
-- in is the name, as search names it). A kind is listed here only when deleting it destroys
-- nothing outside this database: no files, no vector index, no running
-- service, and no trigger rewrites other rows. Not listed, and deleted for
-- good as before:
--   datasets         their Parquet copy in storage is swept once the row goes
--   knowledge bases  their vectors are removed from the vector store first
--   ML models        their training containers are stopped
--   MCP projects     their running service is stopped and unregistered
--   ETL pipelines    their replication slots on the source are dropped
--   MCP connections  a trigger takes their name out of every agent and swarm
--   lakehouse tables they are not rows at all
CREATE OR REPLACE FUNCTION public.trash_kinds()
RETURNS TABLE (kind text, root regclass, name_col text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  VALUES
    ('agent', 'public.agents'::regclass, 'name'),
    ('swarm', 'public.swarms'::regclass, 'name'),
    ('prompt', 'public.user_prompts'::regclass, 'title'),
    ('skill', 'public.agent_skills'::regclass, 'name'),
    ('evaluation', 'public.eval_datasets'::regclass, 'name'),
    ('semantic_model', 'public.semantic_models'::regclass, 'label,name'),
    ('data_monitor', 'public.data_monitors'::regclass, 'name'),
    ('ai_analyst', 'public.ai_analysts'::regclass, 'name'),
    ('dashboard', 'public.bi_dashboards'::regclass, 'name'),
    ('report', 'public.bi_reports'::regclass, 'name'),
    ('workbook', 'public.sheet_workbooks'::regclass, 'name'),
    ('workflow', 'public.workflows'::regclass, 'name'),
    ('sql_model', 'public.sql_models'::regclass, 'name'),
    ('notebook', 'public.user_python_notebooks'::regclass, 'title'),
    ('embed', 'public.embed_keys'::regclass, 'name')
$$;

-- How long something stays in the trash.
CREATE OR REPLACE FUNCTION public.trash_retention()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT interval '30 days' $$;

-- Move one object to the trash. Returns the id of its trash entry.
CREATE OR REPLACE FUNCTION public.trash_object(p_kind text, p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_root regclass;
  v_name_col text;
  v_row jsonb;
  v_tbl text;
  v_fk record;
  v_added bigint;
  v_rows bigint;
  v_bytes bigint;
  v_payload jsonb;
  v_links jsonb := '[]'::jsonb;
  v_more jsonb;
  v_pk text;
  v_trash_id uuid;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to move something to the trash.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT k.root, k.name_col INTO v_root, v_name_col
  FROM public.trash_kinds() k WHERE k.kind = p_kind;
  IF v_root IS NULL THEN
    RAISE EXCEPTION 'This kind of thing cannot be moved to the trash.'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- Locked, so nothing is added under it between the copy and the delete.
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE t.id = $1 FOR UPDATE', v_root)
    INTO v_row USING p_id;
  -- Not there, and not the caller's, get the same answer: a different one
  -- would tell anybody holding an id that something with it exists.
  -- IS DISTINCT FROM: a row with no owner is nobody's to delete.
  IF v_row IS NULL OR NULLIF(v_row ->> 'user_id', '')::uuid IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'It is not here any more, or it is not yours to delete.'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF COALESCE((v_row ->> 'is_sample')::boolean, false) THEN
    RAISE EXCEPTION 'A bundled sample cannot be moved to the trash.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Every row the delete will take, found a table at a time. The row's own
  -- address keeps one row reached by two paths from being copied twice.
  -- Gone at the end of the transaction, so nothing of it outlives the call;
  -- emptied first, for a second move in the same transaction.
  CREATE TEMP TABLE IF NOT EXISTS _trash_walk (
    seq bigserial,
    tbl text NOT NULL,
    tid tid NOT NULL,
    r jsonb NOT NULL,
    walked boolean NOT NULL DEFAULT false,
    UNIQUE (tbl, tid)
  ) ON COMMIT DROP;
  TRUNCATE pg_temp._trash_walk;

  EXECUTE format(
    'INSERT INTO pg_temp._trash_walk (tbl, tid, r)
     SELECT %L, t.ctid, to_jsonb(t) FROM %s t WHERE t.id = $1',
    v_root::text, v_root
  ) USING p_id;

  LOOP
    SELECT w.tbl INTO v_tbl FROM pg_temp._trash_walk w WHERE NOT w.walked ORDER BY w.seq LIMIT 1;
    EXIT WHEN v_tbl IS NULL;

    FOR v_fk IN
      SELECT
        c.conrelid::regclass AS child,
        n.nspname AS child_schema,
        cardinality(c.conkey) AS width,
        (SELECT a.attname FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS child_col,
        (SELECT a.attname FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS parent_col
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE c.confrelid = v_tbl::regclass AND c.contype = 'f' AND c.confdeltype = 'c'
    LOOP
      -- A cascade this cannot follow would be rows lost without a copy.
      IF v_fk.width <> 1 OR v_fk.child_schema <> 'public' THEN
        RAISE EXCEPTION 'This cannot be moved to the trash yet: % is deleted with it in a way the trash cannot copy.', v_fk.child
          USING ERRCODE = 'feature_not_supported';
      END IF;
      EXECUTE format(
        'INSERT INTO pg_temp._trash_walk (tbl, tid, r)
         SELECT %L, c.ctid, to_jsonb(c)
         FROM %s c
         WHERE c.%I::text IN (
           SELECT w.r ->> %L FROM pg_temp._trash_walk w
           WHERE w.tbl = %L AND NOT w.walked AND w.r ->> %L IS NOT NULL
         )
         ON CONFLICT (tbl, tid) DO NOTHING',
        v_fk.child::text, v_fk.child, v_fk.child_col,
        v_fk.parent_col, v_tbl, v_fk.parent_col
      );
    END LOOP;

    UPDATE pg_temp._trash_walk SET walked = true WHERE tbl = v_tbl AND NOT walked;

    SELECT count(*), COALESCE(sum(pg_column_size(w.r)), 0) INTO v_rows, v_bytes
    FROM pg_temp._trash_walk w;
    IF v_rows > 50000 OR v_bytes > 64 * 1024 * 1024 THEN
      RAISE EXCEPTION 'This is too large for the trash (% rows). It can only be deleted for good.', v_rows
        USING ERRCODE = 'program_limit_exceeded';
    END IF;
  END LOOP;

  -- What the delete will cut loose instead of deleting: a reference that is
  -- SET NULL (or SET DEFAULT), held by a row that stays. Remembered by that
  -- row's key so it can be put back.
  FOR v_fk IN
    SELECT DISTINCT
      c.conrelid::regclass AS child,
      c.confrelid::regclass::text AS parent,
      (SELECT a.attname FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS child_col,
      (SELECT a.attname FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS parent_col,
      (SELECT a.attname FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = c.conrelid AND i.indisprimary AND i.indnkeyatts = 1) AS pk
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND c.confdeltype IN ('n', 'd')
      AND cardinality(c.conkey) = 1 AND n.nspname = 'public'
      AND c.confrelid::regclass::text IN (SELECT DISTINCT w.tbl FROM pg_temp._trash_walk w)
  LOOP
    CONTINUE WHEN v_fk.pk IS NULL;
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(jsonb_build_object(
          ''t'', %L, ''pk'', %L, ''id'', to_jsonb(c.%I), ''c'', %L, ''v'', to_jsonb(c.%I))), ''[]''::jsonb)
       FROM %s c
       WHERE c.%I::text IN (
           SELECT w.r ->> %L FROM pg_temp._trash_walk w
           WHERE w.tbl = %L AND w.r ->> %L IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM pg_temp._trash_walk x WHERE x.tbl = %L AND x.tid = c.ctid)',
      v_fk.child::text, v_fk.pk, v_fk.pk, v_fk.child_col, v_fk.child_col,
      v_fk.child, v_fk.child_col,
      v_fk.parent_col, v_fk.parent, v_fk.parent_col,
      v_fk.child::text
    ) INTO v_more;
    v_links := v_links || v_more;
  END LOOP;

  SELECT NULLIF(v_row ->> btrim(c), '') INTO v_name
  FROM unnest(string_to_array(v_name_col, ',')) WITH ORDINALITY x(c, ord)
  WHERE NULLIF(v_row ->> btrim(c), '') IS NOT NULL
  ORDER BY ord LIMIT 1;

  SELECT jsonb_agg(jsonb_build_object('t', w.tbl, 'r', w.r) ORDER BY w.seq), count(*)
  INTO v_payload, v_rows
  FROM pg_temp._trash_walk w;

  INSERT INTO public.trash_items
    (user_id, kind, object_id, name, purge_after, payload, links, row_count)
  VALUES (
    v_uid, p_kind, p_id, left(COALESCE(v_name, ''), 2000),
    now() + public.trash_retention(), v_payload, v_links, v_rows
  )
  RETURNING id INTO v_trash_id;

  EXECUTE format('DELETE FROM %s WHERE id = $1', v_root) USING p_id;

  BEGIN
    INSERT INTO public.audit_events (user_id, action, resource_type, resource_name, resource_id, detail)
    VALUES (
      v_uid, p_kind || '.trash', p_kind, left(COALESCE(v_name, ''), 200), p_id,
      jsonb_build_object('rows', v_rows, 'trash_id', v_trash_id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- the record of it must never undo the act
  END;

  RETURN v_trash_id;
END;
$$;

-- Put one trash entry back. Returns how many rows went back and how many of
-- its dependents could not (what they pointed at has gone since).
CREATE OR REPLACE FUNCTION public.restore_trash(p_trash_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.trash_items;
  v_root text;
  v_tbl text;
  v_tables text[];
  v_order text[] := '{}';
  v_left text[];
  v_cols text;
  v_override text;
  v_rows jsonb;
  v_row jsonb;
  v_n bigint;
  v_restored bigint := 0;
  v_skipped bigint := 0;
  v_link jsonb;
  v_progress boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to restore something.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_item FROM public.trash_items t WHERE t.id = p_trash_id FOR UPDATE;
  IF v_item.id IS NULL OR v_item.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'It is not in your trash.' USING ERRCODE = 'no_data_found';
  END IF;

  v_root := v_item.payload -> 0 ->> 't';
  SELECT array_agg(s.t ORDER BY s.first) INTO v_tables
  FROM (
    SELECT e ->> 't' AS t, min(ord) AS first
    FROM jsonb_array_elements(v_item.payload) WITH ORDINALITY x(e, ord)
    GROUP BY 1
  ) s;

  -- Parents before children: a table goes in once every other table of the
  -- set that it references has gone in. A reference to itself does not count.
  v_left := v_tables;
  WHILE cardinality(v_left) > 0 LOOP
    v_progress := false;
    FOREACH v_tbl IN ARRAY v_left LOOP
      IF to_regclass(v_tbl) IS NULL OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.contype = 'f' AND c.conrelid = v_tbl::regclass
          AND c.confrelid <> c.conrelid
          AND c.confrelid::regclass::text = ANY (v_left)
      ) THEN
        v_order := v_order || v_tbl;
        v_left := array_remove(v_left, v_tbl);
        v_progress := true;
      END IF;
    END LOOP;
    -- Tables that reference each other in a ring: take them as they were found.
    IF NOT v_progress THEN
      v_order := v_order || v_left;
      v_left := '{}';
    END IF;
  END LOOP;

  FOREACH v_tbl IN ARRAY v_order LOOP
    -- A table dropped since: its rows have nowhere to go. The object's own
    -- table gone means there is nothing to restore into.
    IF to_regclass(v_tbl) IS NULL THEN
      IF v_tbl = v_root THEN
        RAISE EXCEPTION 'This kind of thing no longer exists in this version.'
          USING ERRCODE = 'feature_not_supported';
      END IF;
      SELECT count(*) INTO v_n FROM jsonb_array_elements(v_item.payload) e WHERE e ->> 't' = v_tbl;
      v_skipped := v_skipped + v_n;
      CONTINUE;
    END IF;

    SELECT jsonb_agg(e -> 'r' ORDER BY ord) INTO v_rows
    FROM jsonb_array_elements(v_item.payload) WITH ORDINALITY x(e, ord)
    WHERE e ->> 't' = v_tbl;

    -- The columns the copy has and the table still has. A generated one is
    -- worked out again; one added since takes its default; one dropped since
    -- is passed over.
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
           CASE WHEN bool_or(a.attidentity = 'a') THEN 'OVERRIDING SYSTEM VALUE ' ELSE '' END
    INTO v_cols, v_override
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = v_tbl::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attgenerated = ''
      AND (v_rows -> 0) ? a.attname;

    BEGIN
      -- All of a table's rows at once, so rows of one table that point at each
      -- other go in together.
      EXECUTE format(
        'INSERT INTO %s (%s) %sSELECT %s FROM jsonb_populate_recordset(NULL::%s, $1)',
        v_tbl, v_cols, v_override, v_cols, v_tbl
      ) USING v_rows;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_restored := v_restored + v_n;
    EXCEPTION
      WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation THEN
        IF v_tbl = v_root THEN
          IF SQLSTATE = '23505' THEN
            RAISE EXCEPTION 'Something else has taken its place: % Rename or remove that one, then restore again.', SQLERRM
              USING ERRCODE = 'unique_violation';
          ELSIF SQLSTATE = '23503' THEN
            RAISE EXCEPTION 'It cannot come back: something it was built on has been deleted since.'
              USING ERRCODE = 'foreign_key_violation';
          END IF;
          RAISE;
        END IF;
        -- One of them cannot go back (what it pointed at has gone, or its
        -- place is taken). Put back the ones that can, one at a time.
        FOR v_row IN SELECT e FROM jsonb_array_elements(v_rows) e LOOP
          BEGIN
            EXECUTE format(
              'INSERT INTO %s (%s) %sSELECT %s FROM jsonb_populate_record(NULL::%s, $1)',
              v_tbl, v_cols, v_override, v_cols, v_tbl
            ) USING v_row;
            v_restored := v_restored + 1;
          EXCEPTION
            WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation THEN
              v_skipped := v_skipped + 1;
          END;
        END LOOP;
    END;
  END LOOP;

  -- References the delete set to null: put back where the row is still there
  -- and still points at nothing.
  FOR v_link IN SELECT e FROM jsonb_array_elements(v_item.links) e LOOP
    CONTINUE WHEN to_regclass(v_link ->> 't') IS NULL;
    BEGIN
      EXECUTE format(
        'UPDATE %s SET %I = ($1 #>> ''{}'')::%s WHERE %I::text = $2 #>> ''{}'' AND %I IS NULL',
        v_link ->> 't', v_link ->> 'c',
        (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = (v_link ->> 't')::regclass AND a.attname = v_link ->> 'c'),
        v_link ->> 'pk', v_link ->> 'c'
      ) USING v_link -> 'v', v_link -> 'id';
    EXCEPTION WHEN OTHERS THEN
      NULL; -- a reference that cannot be put back is not a reason to fail the restore
    END;
  END LOOP;

  DELETE FROM public.trash_items t WHERE t.id = p_trash_id;

  BEGIN
    INSERT INTO public.audit_events (user_id, action, resource_type, resource_name, resource_id, detail)
    VALUES (
      v_uid, v_item.kind || '.restore', v_item.kind, left(v_item.name, 200), v_item.object_id,
      jsonb_build_object('rows', v_restored, 'not_restored', v_skipped)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'kind', v_item.kind, 'id', v_item.object_id, 'restored', v_restored, 'skipped', v_skipped
  );
END;
$$;

-- What is in the caller's trash: names and dates, never the copy itself.
CREATE OR REPLACE FUNCTION public.my_trash()
RETURNS TABLE (
  id uuid,
  kind text,
  object_id uuid,
  name text,
  deleted_at timestamptz,
  purge_after timestamptz,
  row_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.id, t.kind, t.object_id, t.name, t.deleted_at, t.purge_after, t.row_count
  FROM public.trash_items t
  WHERE t.user_id = auth.uid()
  ORDER BY t.deleted_at DESC
  LIMIT 1000
$$;

-- Delete one trash entry for good, or all of the caller's with NULL.
CREATE OR REPLACE FUNCTION public.empty_trash(p_trash_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to empty the trash.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.trash_items t
  WHERE t.user_id = v_uid AND (p_trash_id IS NULL OR t.id = p_trash_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    BEGIN
      INSERT INTO public.audit_events (user_id, action, resource_type, resource_name, resource_id, detail)
      VALUES (v_uid, 'trash.empty', 'trash', '', NULL, jsonb_build_object('entries', v_n, 'one', p_trash_id IS NOT NULL));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN v_n;
END;
$$;

-- The daily pass: what has been in the trash past its time is deleted for
-- good. The server calls this; nobody's browser can.
CREATE OR REPLACE FUNCTION public.purge_expired_trash()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.trash_items t WHERE t.purge_after < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.trash_kinds() FROM public, anon;
REVOKE ALL ON FUNCTION public.trash_retention() FROM public, anon;
REVOKE ALL ON FUNCTION public.trash_object(text, uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.restore_trash(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.my_trash() FROM public, anon;
REVOKE ALL ON FUNCTION public.empty_trash(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.purge_expired_trash() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trash_kinds() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trash_retention() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trash_object(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_trash(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_trash() TO authenticated;
GRANT EXECUTE ON FUNCTION public.empty_trash(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_trash() TO service_role;
