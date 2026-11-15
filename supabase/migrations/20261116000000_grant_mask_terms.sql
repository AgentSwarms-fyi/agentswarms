-- A grantee no longer reads the terms of a mask on their own grant (R492).
--
-- A column mask is a list of column (or field) names. R491 stopped a shared
-- dataset's own row from naming its masked columns to the grantee, and left the
-- grant row that carries the mask: "Users can view applicable grants"
-- (20260720000000) let the grantee, and every member of a group it names, read
-- their grant rows whole, so
--   GET /rest/v1/iam_resource_grants?select=column_mask
-- named the very columns the mask exists to hide, for every kind of resource a
-- mask applies to (data_table, bi_dashboard, semantic_model, ontology). So did a
-- filter on the column (`?column_mask=cs.{salary}`), one yes or no at a time.
--
-- 1. my_resource_grants(): the caller's applicable grants, directly or through
--    a group, with the row filter and whether the grant masks anything, and
--    never the mask's terms. What a grantee's own client legitimately needs
--    from its grants (a dashboard page's row filters) is all there.
-- 2. The policy split, as R491's: a grant that masks nothing has nothing to
--    leak, so the grantee still reads it directly, as before. A grant with a
--    mask is read directly only by superadmins ("Superadmins manage grants",
--    FOR ALL, unchanged), which is the IAM console's read, and by the service
--    role, which is every enforcement path's: the server applies a mask, and
--    the database's own functions (shared_dataset_rows() and the rest) read it
--    as their owner.
--
-- Why a policy and not column privileges: a column GRANT is role-wide, and
-- superadmins are `authenticated` too; and the previous release reads
-- column_mask with the user's JWT (restrictSharedDataset, for an agent's
-- sql_query), which a revoked column fails with 42501 for every grantee,
-- unmasked grants included. Under the policy that read still works for a grant
-- that masks nothing, and for one that masks it finds no grant and serves
-- nothing: it fails closed, on exactly the rows that leaked.
--
-- Backward compatible for one release (expand/contract): nothing is dropped or
-- renamed but a policy, and no signature or return type changes, so there is
-- no `-- contract:` line.

-- ── 1. The caller's grants, without the terms ───────────────────────────────
CREATE OR REPLACE FUNCTION public.my_resource_grants(
  _resource_type text DEFAULT NULL,
  _resource_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  resource_type text,
  resource_id uuid,
  principal_type text,
  principal_id uuid,
  row_filter jsonb,
  -- The grant hides at least one column: a term that is not blank, the way
  -- every enforcement path reads a mask. Never which.
  masked boolean,
  created_by uuid,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id, g.resource_type, g.resource_id, g.principal_type, g.principal_id,
         g.row_filter,
         EXISTS (
           SELECT 1 FROM unnest(COALESCE(g.column_mask, '{}'::text[])) AS x
           WHERE btrim(x, E' \t\r\n\f\v') <> ''
         ),
         g.created_by, g.created_at
  FROM public.iam_resource_grants g
  WHERE auth.uid() IS NOT NULL
    AND (_resource_type IS NULL OR g.resource_type = _resource_type)
    AND (_resource_ids IS NULL OR g.resource_id = ANY (_resource_ids))
    AND (
      (g.principal_type = 'user' AND g.principal_id = auth.uid())
      OR (g.principal_type = 'group' AND g.principal_id IN (
            SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = auth.uid()))
    )
  ORDER BY g.created_at, g.id;
$$;

REVOKE ALL ON FUNCTION public.my_resource_grants(text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_resource_grants(text, uuid[]) TO authenticated, service_role;

-- ── 2. The policy split ─────────────────────────────────────────────────────
-- The principal test is the old policy's. Superadmins are not named here: the
-- FOR ALL policy beside this one already serves them every row, masks and all.
-- Any mask at all, blank terms included, keeps a row out of the direct read:
-- the cheapest rule that cannot serve a term.
DROP POLICY IF EXISTS "Users can view applicable grants" ON public.iam_resource_grants;
DROP POLICY IF EXISTS "Users can view applicable grants that mask nothing" ON public.iam_resource_grants;
CREATE POLICY "Users can view applicable grants that mask nothing"
  ON public.iam_resource_grants FOR SELECT
  TO authenticated
  USING (
    COALESCE(cardinality(column_mask), 0) = 0
    AND (
      (principal_type = 'user' AND principal_id = auth.uid())
      OR (principal_type = 'group' AND principal_id IN (
            SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = auth.uid()))
    )
  );
