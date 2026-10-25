-- Approvals could be forged, and so acted on (VA-2026-10-25-04 and -07).
--
-- The "Users manage own approvals" FOR ALL policy let a client write ANY row
-- where user_id = auth.uid(): an already-"approved" one, naming someone else's
-- parked swarm run in swarm_run_id, or naming someone else's model in payload,
-- with the forger listed in approver_user_ids. The code that applies a model
-- promotion or resumes a swarm run then trusted the row's own status and
-- routing. Two changes close it: a client may create only a PENDING approval
-- for a run it owns, and an approval's identity and routing are immutable once
-- created, so neither a forged INSERT nor a later UPDATE can point an approval
-- at a resource its author does not own. Model promotions additionally
-- re-authorize against the model's configured approvers in code, because those
-- approvals are created by the service role and so bypass these policies.

DROP POLICY IF EXISTS "Users manage own approvals" ON public.approvals;

-- An owner reads their own approvals (the inbox shows them).
CREATE POLICY "Owners read their own approvals"
  ON public.approvals FOR SELECT
  USING (auth.uid() = user_id);

-- A client may create only a PENDING approval, and only for a swarm run it owns
-- (or none). It cannot write an already-approved row, and cannot name another
-- user's run. (Model-promotion approvals are created by the service role, which
-- bypasses RLS, so this does not affect them.)
CREATE POLICY "Owners create pending approvals for their own runs"
  ON public.approvals FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND status = 'pending'
    AND (
      swarm_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.swarm_runs r
        WHERE r.id = approvals.swarm_run_id AND r.user_id = auth.uid()
      )
    )
  );

-- The owner may decide ONLY a gate routed to nobody in particular — their own
-- self-serve pause. A gate with designated approvers is decided by them (the
-- pre-existing "Approvers can decide routed approvals" policy), never by the
-- owner, so the requester of a gated change cannot sign it off themselves.
CREATE POLICY "Owners decide their own un-routed approvals"
  ON public.approvals FOR UPDATE
  USING (
    auth.uid() = user_id
    AND cardinality(approver_user_ids) = 0
    AND cardinality(approver_group_ids) = 0
  )
  WITH CHECK (
    auth.uid() = user_id
    AND cardinality(approver_user_ids) = 0
    AND cardinality(approver_group_ids) = 0
  );

-- An owner may remove their own approval (cancel a request).
CREATE POLICY "Owners delete their own approvals"
  ON public.approvals FOR DELETE
  USING (auth.uid() = user_id);

-- An approval's identity and routing are fixed once created; only the decision
-- (status, decided_at, decided_by) and the resume claim (resumed_at) change.
-- This closes the other half: a designated approver — or the owner of an
-- un-routed gate — editing an existing approval's swarm_run_id, payload or
-- approver list to aim it at someone else's resource and then acting on it.
-- It applies to every writer, service role included; the app never changes
-- these columns on update.
CREATE OR REPLACE FUNCTION public.approvals_structural_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.swarm_run_id IS DISTINCT FROM OLD.swarm_run_id
     OR NEW.approver_user_ids IS DISTINCT FROM OLD.approver_user_ids
     OR NEW.approver_group_ids IS DISTINCT FROM OLD.approver_group_ids
     OR NEW.payload IS DISTINCT FROM OLD.payload THEN
    RAISE EXCEPTION 'An approval''s identity and routing cannot be changed after it is created';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approvals_structural_immutable ON public.approvals;
CREATE TRIGGER approvals_structural_immutable
  BEFORE UPDATE ON public.approvals
  FOR EACH ROW EXECUTE FUNCTION public.approvals_structural_immutable();

-- Prove the result: the old blanket policy is gone and the four narrower ones
-- and the trigger are in place, so a bad push fails here rather than shipping.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'approvals'
      AND policyname = 'Users manage own approvals'
  ) THEN
    RAISE EXCEPTION 'approval hardening: the blanket FOR ALL policy is still present';
  END IF;

  -- The pending-only, own-run INSERT policy: its WITH CHECK names both.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'approvals' AND cmd = 'INSERT'
      AND with_check LIKE '%status%' AND with_check LIKE '%swarm_runs%'
  ) THEN
    RAISE EXCEPTION 'approval hardening: the pending-only INSERT policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.approvals'::regclass
      AND tgname = 'approvals_structural_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'approval hardening: the immutability trigger is missing';
  END IF;
END $$;
