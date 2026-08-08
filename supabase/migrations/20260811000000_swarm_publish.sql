-- Draft vs published: a deployed swarm serves a PINNED graph, not whatever is
-- currently on the canvas.
--
-- Before this, editing a swarm changed what its API keys and schedules served
-- the instant you pressed Save — mid-experiment, at 3am, to production callers.
-- Version history made that recoverable, not preventable.
--
-- The canvas keeps editing `nodes`/`edges` (the draft). Headless runs read
-- `published_nodes`/`published_edges` when a snapshot exists.
--
-- BACKWARDS COMPATIBILITY, on purpose: swarms deployed before this migration
-- have keys but no snapshot. Refusing to run them would break live callers on
-- upgrade, so the resolver falls back to the live graph and the UI says so.
-- The backfill below publishes the current graph for every swarm that ALREADY
-- has a key or a schedule, so existing deployments become pinned at exactly
-- what they are serving today — no behaviour change at the moment of upgrade,
-- and isolation from the next edit onwards.

ALTER TABLE public.swarms
  ADD COLUMN IF NOT EXISTS published_nodes jsonb,
  ADD COLUMN IF NOT EXISTS published_edges jsonb,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid,
  -- The swarm_versions row this snapshot came from, when it was published from
  -- one. Nullable: publishing the current canvas does not require a version.
  ADD COLUMN IF NOT EXISTS published_version_id uuid;

COMMENT ON COLUMN public.swarms.published_nodes IS
  'Graph served by API keys and schedules. NULL = not published; headless runs fall back to the live graph.';

-- Pin every swarm that is already deployed to what it serves right now.
UPDATE public.swarms s
SET published_nodes = s.nodes,
    published_edges = s.edges,
    published_at = now(),
    published_by = s.user_id
WHERE s.published_nodes IS NULL
  AND (
    EXISTS (SELECT 1 FROM public.swarm_api_keys k WHERE k.swarm_id = s.id)
    OR EXISTS (SELECT 1 FROM public.swarm_schedules sc WHERE sc.swarm_id = s.id)
  );
