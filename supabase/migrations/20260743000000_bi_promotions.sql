-- Dev→prod content promotion: publish a dashboard's current state into a
-- target (e.g. "Production") workspace as a tracked copy. The copy is a normal
-- dashboard owned by the promoter and placed in the target workspace, linked
-- back to its source so a later promotion re-syncs the same copy instead of
-- creating duplicates.

CREATE TABLE public.bi_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_dashboard_id uuid NOT NULL REFERENCES public.bi_dashboards(id) ON DELETE CASCADE,
  target_dashboard_id uuid NOT NULL REFERENCES public.bi_dashboards(id) ON DELETE CASCADE,
  target_workspace_id uuid NOT NULL REFERENCES public.bi_workspaces(id) ON DELETE CASCADE,
  promoted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One prod copy per (source, target workspace) — re-promotion updates it.
  UNIQUE (source_dashboard_id, target_workspace_id)
);
CREATE INDEX idx_bi_promotions_source ON public.bi_promotions(source_dashboard_id);
CREATE INDEX idx_bi_promotions_target ON public.bi_promotions(target_dashboard_id);

ALTER TABLE public.bi_promotions ENABLE ROW LEVEL SECURITY;
-- The promoter (and superadmins) manage promotion links; members of the target
-- workspace can see that a link exists (so a "promoted" badge can render).
CREATE POLICY "Promotions managed by promoter" ON public.bi_promotions
  FOR ALL
  USING (promoted_by = auth.uid() OR public.is_superadmin(auth.uid()))
  WITH CHECK (promoted_by = auth.uid());
CREATE POLICY "Promotions visible to target workspace" ON public.bi_promotions
  FOR SELECT USING (public.can_access_workspace(target_workspace_id, auth.uid()));

CREATE TRIGGER update_bi_promotions_updated_at
BEFORE UPDATE ON public.bi_promotions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Harden dashboard placement ────────────────────────────────────────────
-- Previously a user could set bi_dashboards.workspace_id to ANY workspace on
-- insert/update (the owner check didn't validate workspace access), which would
-- inject a dashboard into a workspace they don't belong to (its members would
-- then see it via the workspace read policy). Require the target workspace to be
-- one the user can actually access. Personal dashboards (NULL) are unaffected.
DROP POLICY "Users manage their own dashboards" ON public.bi_dashboards;
CREATE POLICY "Users manage their own dashboards" ON public.bi_dashboards
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (workspace_id IS NULL OR public.can_access_workspace(workspace_id, auth.uid()))
  );
