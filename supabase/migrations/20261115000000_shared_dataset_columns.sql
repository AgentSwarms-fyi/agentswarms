-- A dataset shared under a column mask no longer names its masked columns to
-- the grantee (R491).
--
-- Since 20260766000000 the ROWS of a shared dataset go only through
-- shared_dataset_rows(), which applies the grants' row filters and column masks
-- inside Postgres. The dataset's own row in user_data_tables did not: the
-- "Shared data tables are readable" policy (20260720000000) served it to the
-- grantee whole, and its `columns` is the OWNER's list. So
--   GET /rest/v1/user_data_tables?select=columns
-- named every column a grant masks, and the browser passed that list on
-- (sqlEngine.ts, for a share whose row filter admits no rows) into the SQL
-- page's and BI's prompts. R489 fixed the server's own listings; this is the
-- database half.
--
-- 1. The mask, defined once in SQL by the app's rule (intersectColumnMasks in
--    src/lib/biDashboards.ts): each grant's mask is read trimmed and without
--    regard to case; masks INTERSECT across the grants that apply to the
--    caller, directly or through a group, so one grant with an empty mask hides
--    nothing; no applicable grant is NULL, and NULL serves nothing.
-- 2. shared_dataset_rows() uses it. It compared mask and key case-sensitively
--    and untrimmed, so a mask typed "Salary" over a column "salary" served the
--    salaries to the grantee's browser while every server path hid them. Same
--    signature, same return type, same row filters.
-- 3. shared_dataset_columns(id): a dataset's columns as the caller may see
--    them. shared_datasets(): every dataset shared with the caller, with its
--    identifying fields and its columns through the mask.
-- 4. The policy split. A share whose mask hides nothing from the caller has
--    nothing to leak, so its row stays directly readable, as before. A share
--    with a mask is read only through (3).
--
-- Backward compatible for one release (expand/contract): nothing is dropped or
-- renamed and no signature or return type changes, so there is no
-- `-- contract:` line. The previous release reads its own datasets, samples and
-- unmasked shares exactly as before. What its direct read no longer returns is
-- a masked share's row, so its listings leave that dataset out instead of
-- naming the masked columns: it fails closed, on exactly the rows that leaked.
-- Owners and samples are unchanged.

-- ── 1. The mask ─────────────────────────────────────────────────────────────
-- Not callable by any client: it takes the user as an argument, and a mask is
-- a list of column names. The functions below call it as its owner, with
-- auth.uid().
CREATE OR REPLACE FUNCTION public.dataset_grant_mask(_table_id uuid, _uid uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH g AS (
    SELECT gr.id,
           ARRAY(
             SELECT DISTINCT lower(btrim(x, E' \t\r\n\f\v'))
             FROM unnest(COALESCE(gr.column_mask, '{}'::text[])) AS x
             WHERE btrim(x, E' \t\r\n\f\v') <> ''
           ) AS terms
    FROM public.iam_resource_grants gr
    WHERE gr.resource_type = 'data_table'
      AND gr.resource_id = _table_id
      AND (
        (gr.principal_type = 'user' AND gr.principal_id = _uid)
        OR (gr.principal_type = 'group' AND gr.principal_id IN (
              SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = _uid))
      )
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM g) THEN NULL
    -- A term every applicable grant names. A grant with an empty mask names
    -- none, so then nothing is hidden.
    ELSE COALESCE(
      (SELECT array_agg(s.t ORDER BY s.t)
       FROM (SELECT t FROM g, unnest(g.terms) AS t
             GROUP BY t
             HAVING count(DISTINCT g.id) = (SELECT count(*) FROM g)) s),
      '{}'::text[])
  END;
$$;

-- `columns` without the masked ones, matched without regard to case. An entry
-- is a {name, type} object (or, in old rows, a bare name).
CREATE OR REPLACE FUNCTION public.dataset_columns_unmasked(_columns jsonb, _mask text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _mask IS NULL OR jsonb_typeof(_columns) IS DISTINCT FROM 'array' THEN '[]'::jsonb
    WHEN cardinality(_mask) = 0 THEN _columns
    ELSE COALESCE(
      (SELECT jsonb_agg(e.c ORDER BY e.ord)
       FROM jsonb_array_elements(_columns) WITH ORDINALITY AS e(c, ord)
       -- An entry with no name to compare is dropped: NULL = ANY(...) is NULL.
       WHERE NOT (lower(COALESCE(e.c ->> 'name', e.c #>> '{}')) = ANY (_mask))),
      '[]'::jsonb)
  END;
$$;

REVOKE ALL ON FUNCTION public.dataset_grant_mask(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.dataset_columns_unmasked(jsonb, text[]) FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. The rows, by the same mask ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shared_dataset_rows(_table_id uuid)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  direct boolean;
  mask text[];
  any_unfiltered boolean;
BEGIN
  IF uid IS NULL THEN RETURN; END IF;

  SELECT (t.user_id = uid OR t.is_sample) INTO direct
  FROM public.user_data_tables t
  WHERE t.id = _table_id;
  IF direct IS NULL THEN RETURN; END IF;           -- no such table

  -- Owners and shared samples: unrestricted, same as the direct policy.
  IF direct THEN
    RETURN QUERY SELECT r.row FROM public.user_data_rows r WHERE r.table_id = _table_id;
    RETURN;
  END IF;

  mask := public.dataset_grant_mask(_table_id, uid);
  IF mask IS NULL THEN RETURN; END IF;             -- no applicable grant

  SELECT bool_or(gr.row_filter IS NULL) INTO any_unfiltered
  FROM public.iam_resource_grants gr
  WHERE gr.resource_type = 'data_table'
    AND gr.resource_id = _table_id
    AND (
      (gr.principal_type = 'user' AND gr.principal_id = uid)
      OR (gr.principal_type = 'group' AND gr.principal_id IN (
            SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = uid))
    );

  RETURN QUERY
  SELECT CASE
           WHEN cardinality(mask) = 0 THEN r.row
           ELSE r.row - ARRAY(SELECT k FROM jsonb_object_keys(r.row) AS k WHERE lower(k) = ANY (mask))
         END
  FROM public.user_data_rows r
  WHERE r.table_id = _table_id
    -- Under a mask, a row that is not an object has no keys to remove: leave it out.
    AND (cardinality(mask) = 0 OR jsonb_typeof(r.row) = 'object')
    AND (
      COALESCE(any_unfiltered, false)
      OR EXISTS (
        SELECT 1
        FROM public.iam_resource_grants gr
        WHERE gr.resource_type = 'data_table'
          AND gr.resource_id = _table_id
          AND (
            (gr.principal_type = 'user' AND gr.principal_id = uid)
            OR (gr.principal_type = 'group' AND gr.principal_id IN (
                  SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = uid))
          )
          AND gr.row_filter IS NOT NULL
          AND r.row ->> (gr.row_filter ->> 'column') IN (
                SELECT jsonb_array_elements_text(gr.row_filter -> 'values'))
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.shared_dataset_rows(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shared_dataset_rows(uuid) TO authenticated, service_role;

-- ── 3. The columns, and the list ────────────────────────────────────────────
-- A dataset's columns as the caller may see them: all of them for its owner and
-- for a sample, the unmasked ones for a grantee, NULL for anyone else.
CREATE OR REPLACE FUNCTION public.shared_dataset_columns(_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  t record;
  mask text[];
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  SELECT d.user_id, d.is_sample, d.columns INTO t
  FROM public.user_data_tables d
  WHERE d.id = _table_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.is_sample OR t.user_id = uid THEN RETURN t.columns; END IF;
  mask := public.dataset_grant_mask(_table_id, uid);
  IF mask IS NULL THEN RETURN NULL; END IF;        -- no applicable grant
  RETURN public.dataset_columns_unmasked(t.columns, mask);
END;
$$;

-- Every dataset shared with the caller: not theirs, not a sample, under at least
-- one grant that applies to them. The fields a listing names a dataset by, and
-- its columns through the mask. Callers merge this with their direct read.
CREATE OR REPLACE FUNCTION public.shared_datasets()
RETURNS TABLE (
  id uuid,
  name text,
  user_id uuid,
  is_sample boolean,
  source_filename text,
  columns jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  data_loaded_at timestamptz,
  parquet_rows integer,
  parquet_bytes bigint,
  rows_sealed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.id, d.name, d.user_id, d.is_sample, d.source_filename,
         public.dataset_columns_unmasked(d.columns, m.mask),
         d.created_at, d.updated_at, d.data_loaded_at,
         d.parquet_rows, d.parquet_bytes, d.rows_sealed
  FROM public.user_data_tables d
  CROSS JOIN LATERAL (SELECT public.dataset_grant_mask(d.id, auth.uid()) AS mask) m
  WHERE auth.uid() IS NOT NULL
    AND NOT d.is_sample
    AND d.user_id IS DISTINCT FROM auth.uid()
    AND d.id IN (
      SELECT gr.resource_id
      FROM public.iam_resource_grants gr
      WHERE gr.resource_type = 'data_table'
        AND (
          (gr.principal_type = 'user' AND gr.principal_id = auth.uid())
          OR (gr.principal_type = 'group' AND gr.principal_id IN (
                SELECT gm.group_id FROM public.iam_group_members gm WHERE gm.user_id = auth.uid()))
        )
    )
    AND m.mask IS NOT NULL
  ORDER BY d.name;
$$;

REVOKE ALL ON FUNCTION public.shared_dataset_columns(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shared_dataset_columns(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.shared_datasets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shared_datasets() TO authenticated, service_role;

-- ── 4. The policy split ─────────────────────────────────────────────────────
-- True when the caller holds a grant on the dataset and that grant's mask hides
-- nothing. It says only that, never which columns, so the policy can call it
-- as the caller.
CREATE OR REPLACE FUNCTION public.shared_dataset_unmasked(_table_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(cardinality(public.dataset_grant_mask(_table_id, auth.uid())) = 0, false);
$$;

REVOKE ALL ON FUNCTION public.shared_dataset_unmasked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shared_dataset_unmasked(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Shared data tables are readable" ON public.user_data_tables;
DROP POLICY IF EXISTS "Shared data tables are readable when nothing is masked" ON public.user_data_tables;
-- Own rows and samples are the other policy's ("Anyone can view samples or own
-- tables"); the cheap comparisons keep this one from asking about them.
CREATE POLICY "Shared data tables are readable when nothing is masked"
  ON public.user_data_tables FOR SELECT
  TO authenticated
  USING (NOT is_sample AND user_id <> auth.uid() AND public.shared_dataset_unmasked(id));
