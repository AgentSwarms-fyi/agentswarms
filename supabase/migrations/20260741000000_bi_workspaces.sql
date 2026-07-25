-- BI workspaces & folders: an optional organizational + sharing layer over
-- bi_dashboards. A workspace is a shared container whose members (users and/or
-- IAM groups) can SEE every dashboard placed in it — the same read-only sharing
-- model as IAM resource grants, but bulk and group-based. Folders give a tree
-- for organising dashboards inside a workspace or in a user's personal space.
--
-- Fully backward-compatible: dashboards keep workspace_id/folder_id NULL
-- (personal, owner-only — unchanged behaviour). Nothing is backfilled; the
-- feature is opt-in. Writes to a dashboard stay owner-only; workspace
-- membership only ever GRANTS READ, so it can never widen who can edit.

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE public.bi_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bi_workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.bi_workspaces(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, principal_type, principal_id)
);
CREATE INDEX idx_bi_workspace_members_ws ON public.bi_workspace_members(workspace_id);
CREATE INDEX idx_bi_workspace_members_principal
  ON public.bi_workspace_members(principal_type, principal_id);

CREATE TABLE public.bi_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL workspace_id = a personal folder owned by user_id.
  workspace_id uuid REFERENCES public.bi_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.bi_folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bi_folders_workspace ON public.bi_folders(workspace_id);
CREATE INDEX idx_bi_folders_user ON public.bi_folders(user_id);
CREATE INDEX idx_bi_folders_parent ON public.bi_folders(parent_id);

-- Placement columns on dashboards (both nullable = personal, ungrouped).
ALTER TABLE public.bi_dashboards
  ADD COLUMN workspace_id uuid REFERENCES public.bi_workspaces(id) ON DELETE SET NULL,
  ADD COLUMN folder_id uuid REFERENCES public.bi_folders(id) ON DELETE SET NULL;
CREATE INDEX idx_bi_dashboards_workspace ON public.bi_dashboards(workspace_id);
CREATE INDEX idx_bi_dashboards_folder ON public.bi_dashboards(folder_id);

-- ── Access helper (SECURITY DEFINER: bypasses RLS, so no policy recursion) ─────

CREATE OR REPLACE FUNCTION public.can_access_workspace(wid uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_superadmin(uid)
    OR EXISTS (SELECT 1 FROM public.bi_workspaces w WHERE w.id = wid AND w.created_by = uid)
    OR EXISTS (
      SELECT 1 FROM public.bi_workspace_members m
      WHERE m.workspace_id = wid
        AND (
          (m.principal_type = 'user' AND m.principal_id = uid)
          OR (
            m.principal_type = 'group'
            AND m.principal_id IN (
              SELECT gm.group_id FROM public.iam_group_members gm WHERE gm.user_id = uid
            )
          )
        )
    );
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.bi_workspaces ENABLE ROW LEVEL SECURITY;
-- Members (and the creator/superadmins) can see a workspace…
CREATE POLICY "Workspace visible to members" ON public.bi_workspaces
  FOR SELECT USING (public.can_access_workspace(id, auth.uid()));
-- …but only the creator (or a superadmin) manages it.
CREATE POLICY "Workspace insert by self" ON public.bi_workspaces
  FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY "Workspace update by owner" ON public.bi_workspaces
  FOR UPDATE USING (created_by = auth.uid() OR public.is_superadmin(auth.uid()))
  WITH CHECK (created_by = auth.uid() OR public.is_superadmin(auth.uid()));
CREATE POLICY "Workspace delete by owner" ON public.bi_workspaces
  FOR DELETE USING (created_by = auth.uid() OR public.is_superadmin(auth.uid()));

ALTER TABLE public.bi_workspace_members ENABLE ROW LEVEL SECURITY;
-- Anyone who can access the workspace can see its membership list…
CREATE POLICY "Members visible to workspace members" ON public.bi_workspace_members
  FOR SELECT USING (public.can_access_workspace(workspace_id, auth.uid()));
-- …but only the workspace creator (or a superadmin) edits membership.
CREATE POLICY "Members managed by workspace owner" ON public.bi_workspace_members
  FOR ALL
  USING (
    public.is_superadmin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.bi_workspaces w
      WHERE w.id = workspace_id AND w.created_by = auth.uid()
    )
  )
  WITH CHECK (
    public.is_superadmin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.bi_workspaces w
      WHERE w.id = workspace_id AND w.created_by = auth.uid()
    )
  );

ALTER TABLE public.bi_folders ENABLE ROW LEVEL SECURITY;
-- See personal folders you own, and folders in workspaces you can access.
CREATE POLICY "Folders visible" ON public.bi_folders
  FOR SELECT USING (
    user_id = auth.uid()
    OR (workspace_id IS NOT NULL AND public.can_access_workspace(workspace_id, auth.uid()))
    OR public.is_superadmin(auth.uid())
  );
-- Create only folders you own, and only in a workspace you can access.
CREATE POLICY "Folders insert by self" ON public.bi_folders
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (workspace_id IS NULL OR public.can_access_workspace(workspace_id, auth.uid()))
  );
CREATE POLICY "Folders update by owner" ON public.bi_folders
  FOR UPDATE USING (user_id = auth.uid() OR public.is_superadmin(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR public.is_superadmin(auth.uid()));
CREATE POLICY "Folders delete by owner" ON public.bi_folders
  FOR DELETE USING (user_id = auth.uid() OR public.is_superadmin(auth.uid()));

-- Widen dashboard visibility: members of a dashboard's workspace can READ it.
-- The existing owner (FOR ALL) and IAM-grant (SELECT) policies are untouched,
-- so this only ADDS read access and never affects who can write.
CREATE POLICY "Workspace dashboards are visible" ON public.bi_dashboards
  FOR SELECT USING (
    workspace_id IS NOT NULL AND public.can_access_workspace(workspace_id, auth.uid())
  );

CREATE TRIGGER update_bi_workspaces_updated_at
BEFORE UPDATE ON public.bi_workspaces
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
