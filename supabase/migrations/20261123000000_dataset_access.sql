-- Who can read a dataset, told to the dataset's owner (R519).
--
-- A dataset is shared by an administrator (Admin → IAM → Access), and a grant
-- row is read whole only by superadmins: R492 had to stop grantees reading the
-- mask on their own grant, and nothing was added for the person whose data it
-- is. So the owner of a dataset could not see who else reads it, or under
-- which row filter and which hidden columns. The dataset's page shows them.
--
-- dataset_access(id): the grants on one dataset, for its owner and nobody
-- else. To anyone else it returns no rows, the same answer as for a dataset
-- nobody has been given, so it is not a way to learn that a dataset exists,
-- or that it is shared. The owner sees the mask's terms (they are the owner's
-- own column names) and the filter; for a person, their name and email, for a
-- group its name and how many are in it. Read-only: grants are still made and
-- changed in IAM.
--
-- Additive: one new function, nothing changed or dropped.

CREATE OR REPLACE FUNCTION public.dataset_access(p_dataset_id uuid)
RETURNS TABLE (
  grant_id uuid,
  principal_type text,
  principal_id uuid,
  name text,
  email text,
  member_count integer,
  row_filter jsonb,
  column_mask text[],
  granted_at timestamptz,
  granted_by_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    g.id,
    g.principal_type,
    g.principal_id,
    CASE
      WHEN g.principal_type = 'group' THEN grp.name
      ELSE NULLIF(btrim(COALESCE(NULLIF(btrim(p.display_name), ''),
                                 concat_ws(' ', p.first_name, p.last_name))), '')
    END,
    CASE WHEN g.principal_type = 'user' THEN u.email::text END,
    CASE
      WHEN g.principal_type = 'group' THEN (
        SELECT count(*)::integer FROM public.iam_group_members m WHERE m.group_id = g.principal_id)
    END,
    g.row_filter,
    COALESCE(
      ARRAY(SELECT btrim(x) FROM unnest(g.column_mask) AS x WHERE btrim(x) <> ''),
      '{}'::text[]),
    g.created_at,
    NULLIF(btrim(COALESCE(NULLIF(btrim(cp.display_name), ''),
                          concat_ws(' ', cp.first_name, cp.last_name))), '')
  FROM public.iam_resource_grants g
  JOIN public.user_data_tables t ON t.id = g.resource_id
  LEFT JOIN public.iam_groups grp ON g.principal_type = 'group' AND grp.id = g.principal_id
  LEFT JOIN public.profiles p ON g.principal_type = 'user' AND p.user_id = g.principal_id
  LEFT JOIN auth.users u ON g.principal_type = 'user' AND u.id = g.principal_id
  LEFT JOIN public.profiles cp ON cp.user_id = g.created_by
  WHERE g.resource_type = 'data_table'
    AND g.resource_id = p_dataset_id
    AND auth.uid() IS NOT NULL
    AND t.user_id = auth.uid()
  ORDER BY g.created_at, g.id;
$$;

REVOKE ALL ON FUNCTION public.dataset_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dataset_access(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.dataset_access(uuid) IS
  'The grants on one dataset, for its owner only (R519). Anyone else gets no rows.';
