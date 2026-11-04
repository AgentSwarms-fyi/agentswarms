-- Partial index for the pass that seals model call traces kept before R448
-- (observability/sealedTraces.server.ts).
--
-- The pass looks for the rows with no body_sealed marker in their request
-- payload, every hour, on the instance's fastest-growing table. Once the older
-- rows are done it finds next to nothing, and without this index it reads the
-- whole table to find that out. The pass works without it, more slowly.
CREATE INDEX IF NOT EXISTS idx_execution_traces_unsealed
  ON public.execution_traces (id)
  WHERE user_id IS NOT NULL
    AND request_payload ->> 'body_sealed' IS NULL
    AND request_payload ->> 'redacted' IS NULL;
