-- Enterprise BI P1: row-level security on dashboard shares, dashboard
-- version history, and usage analytics.

-- ── 1. Row-level security on shared dashboards ──────────────────────────
-- A grant may carry a row filter ({ "column": "Region", "values": ["EMEA"] });
-- viewers covered by such grants see only matching rows in every widget
-- whose snapshot contains that column. A grant without a filter means
-- unrestricted rows (the pre-existing behaviour). Enforced at render via
-- the grants the viewer can already read through the "applies to me" RLS
-- policy on iam_resource_grants.
ALTER TABLE public.iam_resource_grants
  ADD COLUMN row_filter jsonb;

-- ── 2. Dashboard version history ────────────────────────────────────────
CREATE TABLE public.bi_dashboard_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES public.bi_dashboards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text,
  name text NOT NULL,
  widgets jsonb NOT NULL,
  layout jsonb NOT NULL,
  filters jsonb NOT NULL DEFAULT '[]'::jsonb,
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_dashboard_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their dashboard versions" ON public.bi_dashboard_versions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_bi_dashboard_versions_dash
  ON public.bi_dashboard_versions(dashboard_id, created_at DESC);

-- ── 3. Usage analytics ──────────────────────────────────────────────────
ALTER TABLE public.bi_dashboards
  ADD COLUMN view_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_viewed_at timestamptz;

-- Signed-in viewers (owners + grantees) stamp views through this definer
-- fn — they can't UPDATE the owner's row directly. Public/embed views are
-- stamped server-side with the service role.
CREATE OR REPLACE FUNCTION public.bi_touch_view(_dashboard_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.bi_dashboards
  SET view_count = view_count + 1, last_viewed_at = now()
  WHERE id = _dashboard_id
    AND (user_id = auth.uid() OR public.has_resource_access('bi_dashboard', id, auth.uid()));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bi_touch_view(uuid) FROM anon;
