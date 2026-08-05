-- Partial index for the reprice sweep (observability/reprice.server.ts).
--
-- Traces whose model had no known price are stamped
-- request_payload.pricing_missing = true and recorded at cost 0. The sweep
-- re-prices them once the tables learn the model (an alias mapping, a price
-- refresh), which means scanning for exactly that marker on the instance's
-- fastest-growing table — without this index that is a sequential scan per
-- maintenance pass, forever, mostly finding nothing.
CREATE INDEX IF NOT EXISTS idx_execution_traces_pricing_missing
  ON public.execution_traces ((request_payload ->> 'pricing_missing'))
  WHERE request_payload ->> 'pricing_missing' = 'true';
