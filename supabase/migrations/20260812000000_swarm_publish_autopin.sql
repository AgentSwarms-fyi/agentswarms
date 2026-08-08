-- Pin a swarm the moment it becomes deployable.
--
-- Publishing only helps if it happens BEFORE the first caller arrives. If a new
-- API key left the swarm unpinned, the very first edit after minting it would
-- reach production — the exact bug this feature exists to prevent, just moved
-- one step later.
--
-- This lives in the database rather than in the two places that currently
-- create deployments (a server function for keys, a direct client insert for
-- schedules) because those are two layers that can drift apart, and a third
-- write path added later would silently miss the pin.
--
-- Only pins when nothing is pinned yet: republishing is an explicit, deliberate
-- act, so minting a second key must NOT quietly roll out the current draft.

CREATE OR REPLACE FUNCTION public.pin_swarm_on_deploy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.swarms s
  SET published_nodes = s.nodes,
      published_edges = s.edges,
      published_at = now(),
      published_by = s.user_id
  WHERE s.id = NEW.swarm_id
    AND s.published_nodes IS NULL
    -- SECURITY DEFINER bypasses RLS, so ownership is re-checked here by hand.
    -- Without this, anyone able to insert a key row naming someone else's
    -- swarm_id would cause a write to that owner's row.
    AND s.user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pin_swarm_on_deploy() IS
  'Publishes the current graph when a swarm first gains an API key or schedule.';

DROP TRIGGER IF EXISTS pin_swarm_on_api_key ON public.swarm_api_keys;
CREATE TRIGGER pin_swarm_on_api_key
  AFTER INSERT ON public.swarm_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.pin_swarm_on_deploy();

DROP TRIGGER IF EXISTS pin_swarm_on_schedule ON public.swarm_schedules;
CREATE TRIGGER pin_swarm_on_schedule
  AFTER INSERT ON public.swarm_schedules
  FOR EACH ROW EXECUTE FUNCTION public.pin_swarm_on_deploy();
