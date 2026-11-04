-- Partial indexes for the pass that seals swarm run traces kept before R449
-- (observability/sealedRuns.server.ts).
--
-- The pass looks for what is not yet sealed, every hour, on tables that only
-- grow. Once the older rows are done it finds next to nothing, and without these
-- it reads each table to find that out. It works without them, more slowly.
CREATE INDEX IF NOT EXISTS idx_swarm_run_steps_unsealed
  ON public.swarm_run_steps (id)
  WHERE input ->> 'body_sealed' IS NULL;

CREATE INDEX IF NOT EXISTS idx_swarm_runs_input_unsealed
  ON public.swarm_runs (id)
  WHERE input_prompt NOT LIKE 'ck1:%';

CREATE INDEX IF NOT EXISTS idx_swarm_runs_output_unsealed
  ON public.swarm_runs (id)
  WHERE final_output NOT LIKE 'ck1:%';

CREATE INDEX IF NOT EXISTS idx_swarm_run_edges_unsealed
  ON public.swarm_run_edges (id)
  WHERE payload_preview NOT LIKE 'ck1:%';
