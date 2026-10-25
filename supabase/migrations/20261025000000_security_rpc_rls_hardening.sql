-- Security assessment 2026-10-25: authorization hardening for SECURITY DEFINER
-- RPCs and for two API-key tables whose RLS keyed only on the row's own owner.
--
-- Two classes of bug, both reachable by any signed-in account over PostgREST
-- (the anon/authenticated keys are public by design, so a server function that
-- "only the service role calls" is still callable directly unless revoked, and
-- an RLS policy that checks only `user_id` does not stop a row that NAMES a
-- resource owned by someone else):
--
--   VA-2026-10-25-03/09 — SECURITY DEFINER functions that take an id/uid as an
--     argument and read or write other users' rows, never revoked from client
--     roles. A superseding migration that re-creates a function under a new
--     signature reverts EXECUTE to PUBLIC, which is how most of these regressed.
--
--   VA-2026-10-25-05/06 — ml_api_keys and mcp_app_keys RLS asserted only
--     `auth.uid() = user_id` (that the row is yours), never that the model/app
--     the row NAMES is also yours. Same hole swarm_api_keys had, fixed in
--     20260813000000_swarm_deploy_owner_rls.sql; these two tables were missed.
--
-- The app calls every function below as the service role (supabaseAdmin), which
-- keeps its Supabase-default EXECUTE grant after a revoke from the client roles
-- — exactly as 20260878000000_ml_training_shards.sql already does for the
-- 3-arg ml_job_record_shard.

-- ── 1. Revoke client access to service-only SECURITY DEFINER RPCs ────────────
-- By name, every overload, so a function re-created under a new signature is
-- covered too (that is what re-exposed ml_job_record_shard and ml_job_advance_
-- phase). Every caller in the app uses supabaseAdmin (service_role); the two
-- seed functions are also called by handle_new_user_bi_samples, which is
-- SECURITY DEFINER and so calls them as their owner. service_role is GRANTed
-- explicitly rather than trusted to keep a default grant, and the block then
-- PROVES the result, failing the migration if any of it did not take.
DO $$
DECLARE
  names text[] := ARRAY[
    -- Cross-tenant READ: filters on the p_user_id ARGUMENT, not auth.uid().
    'match_gateway_cache',
    'increment_gateway_cache_hit',
    -- Cross-tenant WRITE to ml_training_jobs / ml_deployments by id argument.
    'ml_job_record_shard',
    'ml_job_advance_phase',
    'increment_ml_deployment_use',
    'record_ml_shadow_result',
    'record_ml_canary_result',
    -- Seed demo content into another account by _uid argument.
    'seed_bi_sample_dashboards',
    'seed_bi_sample_extras'
  ];
  r record;
  missing text[];
  still_open text := '';
BEGIN
  -- A name that matches nothing would revoke nothing, silently.
  SELECT array_agg(x) INTO missing
  FROM unnest(names) AS x
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = x
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'security hardening: no function named %', missing;
  END IF;

  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (names)
  LOOP
    IF has_function_privilege('anon', r.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      still_open := still_open || r.fn::text || ' ';
    END IF;
    IF NOT has_function_privilege('service_role', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'security hardening: service_role cannot execute %', r.fn;
    END IF;
  END LOOP;
  IF still_open <> '' THEN
    RAISE EXCEPTION 'security hardening: still callable by a client role: %', still_open;
  END IF;
  RAISE NOTICE 'security hardening: % function name(s) revoked from client roles', cardinality(names);
END $$;

-- ── 2. ml_api_keys: the named model must be the caller's ─────────────────────
-- Remediation first: a key naming a model its owner does not own was planted
-- through the hole. A key is a live credential, so remove rather than keep.
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM public.ml_api_keys k
  USING public.ml_models m
  WHERE m.id = k.model_id AND m.user_id <> k.user_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'ml_api_keys cross-owner remediation: % key(s) removed', removed;
END $$;

DROP POLICY IF EXISTS "Users manage own ml api keys" ON public.ml_api_keys;
CREATE POLICY "Users manage own ml api keys"
  ON public.ml_api_keys FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.ml_models m
      WHERE m.id = ml_api_keys.model_id AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.ml_models m
      WHERE m.id = ml_api_keys.model_id AND m.user_id = auth.uid()
    )
  );
CREATE INDEX IF NOT EXISTS idx_ml_models_id_user ON public.ml_models(id, user_id);

-- ── 3. mcp_app_keys: the named app must be the caller's, and a client key may
--      never be marked internal (is_internal is managed, not issued) ──────────
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM public.mcp_app_keys k
  USING public.mcp_apps a
  WHERE a.id = k.app_id AND a.user_id <> k.user_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'mcp_app_keys cross-owner remediation: % key(s) removed', removed;
END $$;

-- A client must not be able to self-issue an INTERNAL key even on its own app:
-- an internal key reaches servers marked private, and is created only by the
-- app registering itself (via the service role, which bypasses this CHECK).
DROP POLICY IF EXISTS "Users manage own mcp app keys" ON public.mcp_app_keys;
CREATE POLICY "Users manage own mcp app keys"
  ON public.mcp_app_keys FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.mcp_apps a
      WHERE a.id = mcp_app_keys.app_id AND a.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND is_internal = false
    AND EXISTS (
      SELECT 1 FROM public.mcp_apps a
      WHERE a.id = mcp_app_keys.app_id AND a.user_id = auth.uid()
    )
  );
CREATE INDEX IF NOT EXISTS idx_mcp_apps_id_user ON public.mcp_apps(id, user_id);

-- ── 4. Prove the two policies are the ones written above ─────────────────────
-- A later migration that recreates either policy without the ownership check
-- would reopen the hole; this fails loudly here instead, and pg_policies is
-- what PostgREST actually enforces.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT tablename, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (tablename, policyname) IN (
        ('ml_api_keys', 'Users manage own ml api keys'),
        ('mcp_app_keys', 'Users manage own mcp app keys')
      )
  LOOP
    -- Every condition must hold together: an OR anywhere would let the
    -- row-owner test alone admit a key naming someone else's model or app.
    IF position(' OR ' in p.qual) > 0 OR position(' OR ' in p.with_check) > 0 THEN
      RAISE EXCEPTION 'security hardening: % policy combines its checks with OR', p.tablename;
    END IF;
    IF p.tablename = 'ml_api_keys'
       AND (position('ml_models' in p.qual) = 0 OR position('ml_models' in p.with_check) = 0) THEN
      RAISE EXCEPTION 'security hardening: ml_api_keys policy lacks the model-ownership check';
    END IF;
    IF p.tablename = 'mcp_app_keys'
       AND (position('mcp_apps' in p.qual) = 0 OR position('mcp_apps' in p.with_check) = 0
            OR position('is_internal' in p.with_check) = 0) THEN
      RAISE EXCEPTION 'security hardening: mcp_app_keys policy lacks the app-ownership check';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND tablename IN ('ml_api_keys', 'mcp_app_keys')) <> 2 THEN
    RAISE EXCEPTION 'security hardening: expected exactly one policy on each key table';
  END IF;
END $$;
