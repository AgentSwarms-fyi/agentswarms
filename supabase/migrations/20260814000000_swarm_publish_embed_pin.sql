-- Embeds are a deployed surface too.
--
-- An embed key sits in someone else's web page. Of all the ways to run a swarm,
-- that is the one where "my last save went live instantly" is least acceptable,
-- and it was the surface the first publish migration missed: only API keys and
-- schedules pinned the graph.
--
-- embed_keys is polymorphic (agent | swarm | bi_dashboard), so this fires only
-- for swarm rows and joins on resource_id.

CREATE OR REPLACE FUNCTION public.pin_swarm_on_embed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.resource_type <> 'swarm' THEN
    RETURN NEW;
  END IF;
  UPDATE public.swarms s
  SET published_nodes = s.nodes,
      published_edges = s.edges,
      published_at = now(),
      published_by = s.user_id
  WHERE s.id = NEW.resource_id
    AND s.published_nodes IS NULL
    -- SECURITY DEFINER bypasses RLS; ownership is re-checked by hand. The
    -- embed resolver already refuses to serve a key whose owner does not own
    -- the resource, so a mismatched row is junk either way — but it must not
    -- be able to write to the row it names.
    AND s.user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pin_swarm_on_embed_key ON public.embed_keys;
CREATE TRIGGER pin_swarm_on_embed_key
  AFTER INSERT ON public.embed_keys
  FOR EACH ROW EXECUTE FUNCTION public.pin_swarm_on_embed();

-- Same backfill reasoning as the API-key migration: pin swarms that already
-- have an embed key to exactly what they serve today, so upgrading changes
-- nothing at the moment it is applied and isolates every edit after it.
UPDATE public.swarms s
SET published_nodes = s.nodes,
    published_edges = s.edges,
    published_at = now(),
    published_by = s.user_id
WHERE s.published_nodes IS NULL
  AND EXISTS (
    SELECT 1 FROM public.embed_keys k
    WHERE k.resource_type = 'swarm' AND k.resource_id = s.id AND k.user_id = s.user_id
  );
