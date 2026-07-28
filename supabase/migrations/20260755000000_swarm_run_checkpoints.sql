-- Durable swarm runs: checkpoint after every node so a run survives the
-- process that started it.
--
-- Until now a run lived entirely in one process's memory. A deploy, a crash or
-- a container move mid-run lost it with no way to continue — and there was no
-- way to park a run waiting for a human, because there was nothing to park.
--
-- swarm_runs already holds the immutable half of a run (the graph snapshot, the
-- input, who owns it). This table holds the MUTABLE half: how far the run got
-- and what it knows. Splitting it this way keeps the observability row stable
-- while the execution state is rewritten after every node.

CREATE TABLE IF NOT EXISTS public.swarm_run_checkpoints (
  -- One checkpoint per run, overwritten in place: the point is where the run is
  -- NOW, not how it got there (swarm_run_steps is the history).
  run_id uuid PRIMARY KEY REFERENCES public.swarm_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Flow state: the variable map every node reads and writes, plus the value an
  -- unconnected downstream node falls back to.
  ctx jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_output text NOT NULL DEFAULT '',

  -- Progress. Nodes already done are not re-run on resume; re-running an agent
  -- call or an HTTP POST would double-charge and double-send.
  completed_node_ids text[] NOT NULL DEFAULT '{}',
  level_index integer NOT NULL DEFAULT 0,

  -- Routing decisions already taken. Without these a resumed run would treat
  -- every branch as live and execute paths the condition had ruled out — an
  -- approval branch AND its bypass, for example.
  skipped_node_ids text[] NOT NULL DEFAULT '{}',
  dead_edge_ids text[] NOT NULL DEFAULT '{}',

  -- Where the run came from, so a resumed run keeps its identity.
  source text NOT NULL DEFAULT 'api',
  depth integer NOT NULL DEFAULT 0,

  -- Set when the run is parked at a human-approval node (see the approval work
  -- that builds on this). NULL means the run stopped for another reason.
  suspended_node_id text,
  suspended_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- "Which runs are parked waiting for me?" is the only query that isn't by id.
CREATE INDEX IF NOT EXISTS idx_swarm_run_checkpoints_suspended
  ON public.swarm_run_checkpoints(user_id, suspended_at DESC)
  WHERE suspended_node_id IS NOT NULL;

ALTER TABLE public.swarm_run_checkpoints ENABLE ROW LEVEL SECURITY;

-- Same ownership rule as swarm_runs. The executor writes with the service role
-- and so does not depend on this policy.
CREATE POLICY "Users manage own swarm run checkpoints"
  ON public.swarm_run_checkpoints FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_swarm_run_checkpoints_updated_at
  BEFORE UPDATE ON public.swarm_run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- swarm_runs.status is free-text (no CHECK), so 'suspended' needs no schema
-- change — but every consumer that switches on status must tolerate it.
COMMENT ON COLUMN public.swarm_runs.status IS
  'running | success | error | suspended. suspended = parked at an approval node with a checkpoint.';
