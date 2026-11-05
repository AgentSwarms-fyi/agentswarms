-- Lets the pass seal the approval requests kept before R450, and keeps it cheap.
--
-- approvals_structural_immutable refuses any change to a payload, the service
-- role's included, because a payload can name what an approval acts on: a model
-- version, for a promotion (VA-2026-10-25-04). A swarm step's payload names
-- nothing. It holds the text of the step before the approval, and the
-- pass (sealedInbox.server.ts) has to replace that text with its sealed form.
--
-- So the trigger allows exactly that and nothing else: the service role, on a
-- swarm step, from a value not yet sealed to one that is. Every other change is
-- refused as before, so a promotion's payload is as immutable as it was, and no
-- client can use this. The app works without this migration: new requests are
-- sealed when they are raised, and older ones stay as they are until it runs.
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
     OR (
       NEW.payload IS DISTINCT FROM OLD.payload
       AND NOT (
         current_user = 'service_role'
         AND OLD.action_type = 'swarm_step'
         AND NOT (OLD.payload ? 'ck1:sealed')
         AND NEW.payload ? 'ck1:sealed'
       )
     ) THEN
    RAISE EXCEPTION 'An approval''s identity and routing cannot be changed after it is created';
  END IF;
  RETURN NEW;
END;
$$;

-- The pass looks for what is not yet sealed, every hour. Once the older rows are
-- done it finds next to nothing, and without these it reads each table to find
-- that out. It works without them, more slowly.
CREATE INDEX IF NOT EXISTS idx_approvals_unsealed
  ON public.approvals (id)
  WHERE description NOT LIKE 'ck1:%';

CREATE INDEX IF NOT EXISTS idx_notifications_unsealed
  ON public.notifications (id)
  WHERE title NOT LIKE 'ck1:%';
