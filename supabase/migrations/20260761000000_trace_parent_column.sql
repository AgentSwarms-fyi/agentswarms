-- Promote the parent/child trace link to a real column.
--
-- Tool-round traces have always carried their parent chat turn's id, but only
-- inside request_payload jsonb — invisible to indexes, to the /traces UI, and
-- to the OTel exporter, which therefore emitted every LLM call as a separate
-- single-span trace instead of one distributed trace per chat turn.
--
-- Deliberately NOT a foreign key: traces are ephemeral telemetry with batched
-- retention purges, and a self-referencing FK would make those purges order-
-- sensitive for no benefit. A dangling parent id after a purge is harmless —
-- readers treat "parent not found" as "render standalone".

ALTER TABLE public.execution_traces
  ADD COLUMN IF NOT EXISTS parent_trace_id uuid;

CREATE INDEX IF NOT EXISTS idx_execution_traces_parent
  ON public.execution_traces(parent_trace_id) WHERE parent_trace_id IS NOT NULL;

-- Backfill from the jsonb the rows already carry. Guarded by the key check so
-- the scan only touches rows that actually have the link.
UPDATE public.execution_traces
SET parent_trace_id = NULLIF(request_payload->>'parent_trace_id', '')::uuid
WHERE parent_trace_id IS NULL
  AND request_payload ? 'parent_trace_id'
  AND request_payload->>'parent_trace_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
