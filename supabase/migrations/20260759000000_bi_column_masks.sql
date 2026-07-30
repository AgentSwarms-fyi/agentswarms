-- Column-level security for shared BI dashboards.
--
-- A dashboard grant can now hide columns (`column_mask`) as well as filter
-- rows (`row_filter`). Enforcement is server-side, which forces one structural
-- change: a grantee whose grant carries ANY restriction may no longer read
-- bi_widget_results directly over PostgREST — RLS can gate rows but cannot
-- reshape them, so a direct read would hand over the very columns the mask
-- exists to hide. Restricted grantees are served by a server function that
-- applies the row filter and drops masked columns before anything leaves the
-- server; unrestricted grantees keep the fast direct-read path.
--
-- This deliberately TIGHTENS row_filter as well: previously a row-filtered
-- grantee could read stored results directly and the filter was applied
-- client-side — a devtools-level bypass. Restricted means restricted.

ALTER TABLE public.iam_resource_grants
  ADD COLUMN IF NOT EXISTS column_mask text[] NOT NULL DEFAULT '{}';

-- True when the user holds at least one applicable grant WITHOUT restrictions.
-- Union semantics match the rest of IAM: one unrestricted grant (direct or via
-- any group) means the user may read everything, so masked grants alongside it
-- change nothing.
CREATE OR REPLACE FUNCTION public.has_unrestricted_resource_access(rtype text, rid uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.iam_resource_grants g
    WHERE g.resource_type = rtype
      AND g.resource_id = rid
      AND g.row_filter IS NULL
      AND COALESCE(array_length(g.column_mask, 1), 0) = 0
      AND (
        (g.principal_type = 'user' AND g.principal_id = uid)
        OR (
          g.principal_type = 'group'
          AND g.principal_id IN (
            SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = uid
          )
        )
      )
  );
$$;

DROP POLICY IF EXISTS "Grantees read shared widget results" ON public.bi_widget_results;

CREATE POLICY "Unrestricted grantees read shared widget results"
  ON public.bi_widget_results FOR SELECT
  USING (public.has_unrestricted_resource_access('bi_dashboard', dashboard_id, auth.uid()));
