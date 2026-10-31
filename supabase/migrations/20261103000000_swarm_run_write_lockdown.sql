-- Swarm run records are read-only to signed-in clients (R421, VA-2026-10-25-31,
-- VA-2026-10-25-48).
--
-- swarm_runs, swarm_run_steps and swarm_run_edges were `FOR ALL` to their
-- owner, because the canvas tracer wrote them from the browser. A user could
-- therefore delete a run, set its total_cost_usd to 0 or rewrite its steps
-- over PostgREST at any time, and the Traces page, the audit counts and evals
-- would report what they wrote. (The budget cap is measured on
-- execution_traces, locked the same way by 20261027000000.)
--
-- The canvas tracer and the cancel buttons now go through server functions
-- (src/utils/observability/swarmTrace.functions.ts) that write as the service
-- role after checking ownership and that the run is still open; the headless
-- executor already wrote as the service role. So the owner keeps SELECT and
-- loses every write, and the service role (which bypasses RLS) is the only
-- writer.
--
-- swarm_run_checkpoints (VA-48) is the worse of the four. It is the state a
-- parked run resumes from (`ctx`, the nodes done and skipped), only the
-- executor writes it, and it was `FOR ALL` to its owner too: between an
-- approver's decision and the resume, the run's owner could rewrite the values
-- the approved step goes on to send, so an approval no longer covered what
-- happened after it.
--
-- ORDER: start the R421 build BEFORE applying this. The previous build writes
-- these rows with the signed-in user's session, which this policy refuses; in
-- between, canvas runs would go untraced and Cancel would not record.

DROP POLICY IF EXISTS "Users manage own swarm runs" ON public.swarm_runs;
DROP POLICY IF EXISTS "Users manage own swarm run steps" ON public.swarm_run_steps;
DROP POLICY IF EXISTS "Users manage own swarm run edges" ON public.swarm_run_edges;
DROP POLICY IF EXISTS "Users manage own swarm run checkpoints" ON public.swarm_run_checkpoints;
DROP POLICY IF EXISTS "Owners read their swarm runs" ON public.swarm_runs;
DROP POLICY IF EXISTS "Owners read their swarm run steps" ON public.swarm_run_steps;
DROP POLICY IF EXISTS "Owners read their swarm run edges" ON public.swarm_run_edges;
DROP POLICY IF EXISTS "Owners read their swarm run checkpoints" ON public.swarm_run_checkpoints;

CREATE POLICY "Owners read their swarm runs"
  ON public.swarm_runs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Owners read their swarm run steps"
  ON public.swarm_run_steps FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Owners read their swarm run edges"
  ON public.swarm_run_edges FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Owners read their swarm run checkpoints"
  ON public.swarm_run_checkpoints FOR SELECT USING (auth.uid() = user_id);

-- Belt and braces: with no write policy RLS already refuses, but a policy added
-- later by mistake would not be enough on its own without these grants.
REVOKE INSERT, UPDATE, DELETE ON public.swarm_runs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.swarm_run_steps FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.swarm_run_edges FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.swarm_run_checkpoints FROM anon, authenticated;

-- Prove it on apply: per table, no client write policy (or FOR ALL), exactly
-- one SELECT policy and it keys on the owner, and no write grant to a client
-- role. A push that does not leave all of that true fails here.
DO $$
DECLARE
  t text;
  n_write integer;
  n_select integer;
  q text;
BEGIN
  FOREACH t IN ARRAY ARRAY['swarm_runs', 'swarm_run_steps', 'swarm_run_edges',
                           'swarm_run_checkpoints'] LOOP
    SELECT count(*) INTO n_write FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE');
    IF n_write <> 0 THEN
      RAISE EXCEPTION 'swarm run lockdown: % has % client write policy(ies)', t, n_write;
    END IF;
    SELECT count(*), max(qual) INTO n_select, q FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND cmd = 'SELECT';
    IF n_select <> 1 THEN
      RAISE EXCEPTION 'swarm run lockdown: expected one SELECT policy on %, found %', t, n_select;
    END IF;
    IF position('auth.uid()' in q) = 0 OR position('user_id' in q) = 0 OR q ~ '\mOR\M' THEN
      RAISE EXCEPTION 'swarm run lockdown: the SELECT policy on % is not owner-only: %', t, q;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = t
        AND grantee IN ('anon', 'authenticated')
        AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
    ) THEN
      RAISE EXCEPTION 'swarm run lockdown: a client role still holds a write grant on %', t;
    END IF;
  END LOOP;
END $$;
