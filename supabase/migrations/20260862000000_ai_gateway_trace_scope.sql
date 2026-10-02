-- The gateway's first live turn wrote no trace: every insert failed with
-- "violates check constraint execution_traces_cost_scope_type_valid".
--
-- 20260750 named that constraint _valid; 20260861 dropped a constraint named
-- _check (which did not exist), added a new one under that name, and left the
-- original in place still listing only the two older scope types. The turn
-- ran, the model answered, the caller was billed by the provider - and the
-- row that budgets are measured from, that audits agent.chat, that
-- Observability shows, was refused. A trace that fails to write is spend the
-- monthly cap cannot see, which is exactly the failure 20260750 was written
-- to prevent.
--
-- One constraint, under the original name, listing all three.
ALTER TABLE public.execution_traces
  DROP CONSTRAINT IF EXISTS execution_traces_cost_scope_type_valid;
ALTER TABLE public.execution_traces
  DROP CONSTRAINT IF EXISTS execution_traces_cost_scope_type_check;
ALTER TABLE public.execution_traces
  ADD CONSTRAINT execution_traces_cost_scope_type_valid
  CHECK (cost_scope_type IS NULL OR cost_scope_type IN ('embed_key', 'swarm_api_key', 'gateway_key'));
