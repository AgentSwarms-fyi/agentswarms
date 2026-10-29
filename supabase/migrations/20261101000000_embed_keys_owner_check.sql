-- R402 — VA-2026-10-25-32: an embed key must name a resource its owner owns.
--
-- embed_keys' only policy asserted `auth.uid() = user_id` (the KEY is yours),
-- never that the agent, swarm, BI dashboard or AI analyst the key NAMES is
-- yours — the hole ml_api_keys and mcp_app_keys had until R375. A signed-in
-- client could insert a key naming someone else's resource, or point an
-- existing key at one with an UPDATE. Not reachable today: every loader
-- (api/embed, api/embed.chat, api/embed.analyst, the viewer functions)
-- re-checks the resource's owner against the key's user_id and answers
-- "no longer exists". This puts the same rule where the row is written, so
-- the next loader cannot forget it.
--
-- The ownership check is on WITH CHECK only (INSERT and UPDATE). USING stays
-- "the key is yours": resource_id has no foreign key (it names one of four
-- tables), so a key outlives the resource it named, and its owner must still
-- see it to delete it. Such a key serves nothing — every loader 404s.

-- ── 1. Remediation: a key naming someone else's resource ───────────────────
-- A key is a live credential, so remove rather than keep (as R375 did). A key
-- whose resource no longer exists is left for its owner to see and delete.
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM public.embed_keys k
  WHERE (k.resource_type = 'agent'
         AND EXISTS (SELECT 1 FROM public.agents a
                     WHERE a.id = k.resource_id AND a.user_id <> k.user_id))
     OR (k.resource_type = 'swarm'
         AND EXISTS (SELECT 1 FROM public.swarms s
                     WHERE s.id = k.resource_id AND s.user_id <> k.user_id))
     OR (k.resource_type = 'bi_dashboard'
         AND EXISTS (SELECT 1 FROM public.bi_dashboards d
                     WHERE d.id = k.resource_id AND d.user_id <> k.user_id))
     OR (k.resource_type = 'ai_analyst'
         AND EXISTS (SELECT 1 FROM public.ai_analysts x
                     WHERE x.id = k.resource_id AND x.user_id <> k.user_id));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'embed_keys cross-owner remediation: % key(s) removed', removed;
END $$;

-- ── 2. The policy ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage their own embed keys" ON public.embed_keys;
CREATE POLICY "Users manage their own embed keys"
  ON public.embed_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND CASE resource_type
      WHEN 'agent' THEN EXISTS (
        SELECT 1 FROM public.agents a
        WHERE a.id = embed_keys.resource_id AND a.user_id = auth.uid())
      WHEN 'swarm' THEN EXISTS (
        SELECT 1 FROM public.swarms s
        WHERE s.id = embed_keys.resource_id AND s.user_id = auth.uid())
      WHEN 'bi_dashboard' THEN EXISTS (
        SELECT 1 FROM public.bi_dashboards d
        WHERE d.id = embed_keys.resource_id AND d.user_id = auth.uid())
      WHEN 'ai_analyst' THEN EXISTS (
        SELECT 1 FROM public.ai_analysts x
        WHERE x.id = embed_keys.resource_id AND x.user_id = auth.uid())
      ELSE false
    END
  );

-- ── 3. Prove the policy is the one written above ────────────────────────────
-- A later migration that recreates it without the ownership check — or adds a
-- second, permissive policy beside it (policies are OR-ed) — would reopen the
-- hole; this fails loudly here instead. pg_policies is what PostgREST enforces.
DO $$
DECLARE p record;
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'embed_keys') <> 1 THEN
    RAISE EXCEPTION 'security hardening: expected exactly one policy on embed_keys';
  END IF;
  SELECT qual, with_check INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'embed_keys';
  IF p.with_check IS NULL
     OR position('agents' in p.with_check) = 0
     OR position('swarms' in p.with_check) = 0
     OR position('bi_dashboards' in p.with_check) = 0
     OR position('ai_analysts' in p.with_check) = 0 THEN
    RAISE EXCEPTION 'security hardening: embed_keys policy lacks the resource-ownership check';
  END IF;
  -- The four branches are a CASE: an OR at the top level would let the
  -- key-owner test alone admit a key naming someone else's resource. Matched
  -- as a word: Postgres prints `... OR` and the CASE on the next line, so a
  -- search for ' OR ' with a space on each side misses it (it did, here).
  IF p.with_check ~ '\mOR\M' THEN
    RAISE EXCEPTION 'security hardening: embed_keys policy combines its checks with OR';
  END IF;
END $$;
