-- Human-in-the-loop approvals routed to IAM users/groups, + cancellable runs.
--
-- Two related changes for the swarm canvas:
--
-- 1. Approval routing. The approval node used to create a row only its owner
--    (the person running the swarm) could see and decide. Now the node can
--    target a set of IAM users and/or groups as approvers. Those approvers
--    (who are NOT the owner) get email + in-app notifications and can decide
--    the approval. The owner keeps access for backwards compatibility — when
--    no approvers are chosen, behaviour is exactly as before (owner decides).
--
-- 2. Run cancellation. `swarm_runs.cancel_requested` lets a "Recent runs" tab
--    (in any browser tab) signal the originating tab's in-browser orchestrator
--    to abort a run it is still driving.

-- ── Approval routing columns ────────────────────────────────────────────────
ALTER TABLE public.approvals
  ADD COLUMN IF NOT EXISTS swarm_run_id uuid,
  ADD COLUMN IF NOT EXISTS approver_user_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS approver_group_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS decided_by uuid,
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- SECURITY DEFINER so it can be used inside RLS policies without recursion:
-- it reads iam_group_members directly, bypassing that table's own policies.
CREATE OR REPLACE FUNCTION public.is_swarm_approver(
  p_user_ids uuid[],
  p_group_ids uuid[],
  uid uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    uid = ANY (COALESCE(p_user_ids, '{}'::uuid[]))
    OR EXISTS (
      SELECT 1 FROM public.iam_group_members m
      WHERE m.user_id = uid
        AND m.group_id = ANY (COALESCE(p_group_ids, '{}'::uuid[]))
    );
$$;

-- Additional permissive policies (OR'd with the existing owner-only "Users
-- manage own approvals" FOR ALL policy). Designated approvers can read and
-- decide the approvals routed to them.
CREATE POLICY "Approvers can view routed approvals"
  ON public.approvals FOR SELECT
  USING (public.is_swarm_approver(approver_user_ids, approver_group_ids, auth.uid()));

CREATE POLICY "Approvers can decide routed approvals"
  ON public.approvals FOR UPDATE
  USING (public.is_swarm_approver(approver_user_ids, approver_group_ids, auth.uid()))
  WITH CHECK (public.is_swarm_approver(approver_user_ids, approver_group_ids, auth.uid()));

-- ── Run cancellation flag ───────────────────────────────────────────────────
ALTER TABLE public.swarm_runs
  ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
