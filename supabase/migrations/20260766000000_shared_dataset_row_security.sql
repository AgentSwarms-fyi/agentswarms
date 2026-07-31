-- Row- and column-level security for SHARED datasets.
--
-- BI dashboard grants already support row filters and column masks, but
-- data_table grants were all-or-nothing: the same person could be given a
-- masked dashboard and, separately, the whole underlying table. Worse, the
-- old policy let a grantee read `user_data_rows` DIRECTLY, so any mask applied
-- in application code would have been cosmetic — the REST API would still
-- serve the hidden columns.
--
-- So the fix is at the database: grantees no longer select raw rows at all.
-- They call shared_dataset_rows(), a SECURITY DEFINER function that applies
-- the grants' row filters and column masks before anything leaves Postgres.
-- Owners and samples are unaffected and keep the direct, fast path.

-- 1. Revoke direct row access for grantees. Table METADATA stays readable
--    (the "Shared data tables are readable" policy is untouched) so shared
--    datasets still appear in pickers with their schema.
DROP POLICY IF EXISTS "Shared data rows are readable" ON public.user_data_rows;

-- 2. The governed read path.
--
-- Semantics match the BI share model exactly:
--   * column mask = INTERSECTION across the grants that apply to this caller
--     (a column is hidden only when EVERY route to the data hides it);
--   * row filter  = UNION (a row is visible when ANY applicable grant allows
--     it, and one unfiltered grant means all rows).
-- Both are deliberate: a user who holds two grants should never end up with
-- LESS access than either grant alone gives them.
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
  effective_mask text[] := NULL;   -- NULL = no grant seen yet
  any_unfiltered boolean := false;
  first_grant boolean := true;
  g record;
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

  IF NOT public.has_resource_access('data_table', _table_id, uid) THEN RETURN; END IF;

  FOR g IN
    SELECT gr.row_filter, COALESCE(gr.column_mask, '{}'::text[]) AS column_mask
    FROM public.iam_resource_grants gr
    WHERE gr.resource_type = 'data_table'
      AND gr.resource_id = _table_id
      AND (
        (gr.principal_type = 'user' AND gr.principal_id = uid)
        OR (gr.principal_type = 'group' AND gr.principal_id IN (
              SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = uid))
      )
  LOOP
    IF first_grant THEN
      effective_mask := g.column_mask;
      first_grant := false;
    ELSE
      SELECT COALESCE(array_agg(x), '{}'::text[]) INTO effective_mask
      FROM unnest(effective_mask) AS x
      WHERE x = ANY (g.column_mask);
    END IF;
    IF g.row_filter IS NULL THEN any_unfiltered := true; END IF;
  END LOOP;

  RETURN QUERY
  SELECT CASE
           WHEN effective_mask IS NULL OR array_length(effective_mask, 1) IS NULL THEN r.row
           ELSE r.row - effective_mask
         END
  FROM public.user_data_rows r
  WHERE r.table_id = _table_id
    AND (
      any_unfiltered
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

REVOKE ALL ON FUNCTION public.shared_dataset_rows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shared_dataset_rows(uuid) TO authenticated;
