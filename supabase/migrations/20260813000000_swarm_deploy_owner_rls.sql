-- Cross-tenant deployment rows: an authenticated user could create an API key
-- or a schedule pointing at SOMEONE ELSE'S swarm.
--
-- The RLS policies only asserted `auth.uid() = user_id` — that the row belongs
-- to you — and never that the swarm it names does. `createSwarmApiKey` checks
-- ownership, but that check lives in a server function the client is not
-- obliged to use: the anon key is public by design, so a direct PostgREST
-- insert bypassed it entirely.
--
-- Exploit path, verified against a live instance before this migration:
--   1. Attacker inserts a swarm_api_keys row naming the victim's swarm_id, with
--      a key_hash they chose.
--   2. Attacker calls POST /api/swarm/run with the matching raw key.
--   3. The endpoint looks the key up by hash and runs `key.swarm_id`, returning
--      the victim's swarm output to the attacker.
-- The schedules table gave the same access on a timer.
--
-- Swarms are not an IAM-shareable resource type (see the
-- iam_resource_grants_resource_type_check constraint), so there is no
-- legitimate case for deploying a swarm you do not own, and the policy can
-- simply require ownership.

-- Remediation first: any existing row naming a swarm the row's owner does not
-- own was created through the hole above. An API key is a live credential, so
-- these are removed rather than left in place.
DO $$
DECLARE
  removed_keys integer;
  removed_scheds integer;
BEGIN
  DELETE FROM public.swarm_api_keys k
  USING public.swarms s
  WHERE s.id = k.swarm_id AND s.user_id <> k.user_id;
  GET DIAGNOSTICS removed_keys = ROW_COUNT;

  DELETE FROM public.swarm_schedules sc
  USING public.swarms s
  WHERE s.id = sc.swarm_id AND s.user_id <> sc.user_id;
  GET DIAGNOSTICS removed_scheds = ROW_COUNT;

  RAISE NOTICE 'swarm deploy RLS remediation: % api key(s), % schedule(s) removed',
    removed_keys, removed_scheds;
END $$;

DROP POLICY IF EXISTS "Users manage their own swarm api keys" ON public.swarm_api_keys;
CREATE POLICY "Users manage their own swarm api keys" ON public.swarm_api_keys
  FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.swarms s
      WHERE s.id = swarm_api_keys.swarm_id AND s.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.swarms s
      WHERE s.id = swarm_api_keys.swarm_id AND s.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users manage their own swarm schedules" ON public.swarm_schedules;
CREATE POLICY "Users manage their own swarm schedules" ON public.swarm_schedules
  FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.swarms s
      WHERE s.id = swarm_schedules.swarm_id AND s.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.swarms s
      WHERE s.id = swarm_schedules.swarm_id AND s.user_id = auth.uid()
    )
  );

-- The subquery runs per row on every list/insert; without this it is a seq scan
-- of swarms each time.
CREATE INDEX IF NOT EXISTS idx_swarms_id_user ON public.swarms(id, user_id);
