-- R317: a decision resumes its swarm run once.
--
-- FOUND IN R317. The approvals inbox wrote a decision over whatever the
-- approval held, and every decision then resumed the run. Two tabs (or two
-- approvers) pressing Approve on one approval both resumed it, and everything
-- after the approval ran twice. The inbox now decides only a pending approval,
-- and the resume claims the approval here before it runs: a second resume of
-- the same decision finds it claimed and runs nothing.
ALTER TABLE public.approvals
  ADD COLUMN IF NOT EXISTS resumed_at timestamptz;

COMMENT ON COLUMN public.approvals.resumed_at IS
  'When the swarm run behind this approval was resumed with its decision. Claimed once, by the first resume; released if that resume ran nothing (R317).';
