-- VA-2026-10-25-13 (execution_traces portion): a signed-in user could DELETE
-- their own trace rows, or UPDATE cost_usd = 0, over PostgREST -- because the
-- table's RLS was a single "Users manage own traces" FOR ALL policy. The monthly
-- budget a superadmin caps is measured on SUM(execution_traces.cost_usd) (see
-- budgetSpend.server.ts), so erasing or zeroing rows defeated the cap.
--
-- The app records every trace as the SERVICE ROLE -- the AI-gateway usage path,
-- the chat and python-notebook routes, the reprice sweep and the embed-retention
-- purge all write with supabaseAdmin (the three sites that still used the
-- caller's client are moved to supabaseAdmin in the same change). Clients
-- therefore never need to write this table. So split the FOR ALL policy into
-- owner-only SELECT -- the Traces page and the per-user budget read both rely on
-- reading own rows -- and leave NO INSERT/UPDATE/DELETE policy: the service role
-- bypasses RLS, so the absence of a client write policy is the lock.
--
-- The swarm_runs half of this finding is tracked separately: those writes come
-- from the browser bundle (the in-page swarm tracer and the cancel path), which
-- cannot hold the service-role key, so it needs a server-function refactor
-- rather than a policy change -- and swarm_runs does not feed the budget cap.

DROP POLICY IF EXISTS "Users manage own traces" ON public.execution_traces;

CREATE POLICY "Owners read own traces"
  ON public.execution_traces
  FOR SELECT
  USING (auth.uid() = user_id);

-- Prove the result on apply, so a bad push fails here rather than shipping: the
-- blanket FOR ALL policy is gone, there is no client INSERT/UPDATE/DELETE (or
-- FOR ALL) policy, and exactly one SELECT policy remains.
DO $$
DECLARE
  n_write integer;
  n_select integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'execution_traces'
      AND policyname = 'Users manage own traces'
  ) THEN
    RAISE EXCEPTION 'trace lockdown: the blanket FOR ALL policy is still present';
  END IF;

  SELECT count(*) INTO n_write FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'execution_traces'
      AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE');
  IF n_write <> 0 THEN
    RAISE EXCEPTION 'trace lockdown: execution_traces has % client write policy(ies); writes must be service-role only', n_write;
  END IF;

  SELECT count(*) INTO n_select FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'execution_traces' AND cmd = 'SELECT';
  IF n_select <> 1 THEN
    RAISE EXCEPTION 'trace lockdown: expected exactly one SELECT policy on execution_traces, found %', n_select;
  END IF;
END $$;
