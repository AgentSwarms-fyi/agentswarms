-- Streamed-row staging: webhook pushes land here (per pipeline, appended by
-- the ingest endpoint under the pipeline's trigger token), and an "ingest"
-- source node drains them in micro-batches. Rows already durably loaded are
-- deleted on the NEXT run — same at-least-once shape as CDC slot consumption.
CREATE TABLE IF NOT EXISTS public.etl_ingest_events (
  id bigserial PRIMARY KEY,
  pipeline_id uuid NOT NULL REFERENCES public.etl_pipelines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS etl_ingest_events_pipeline_idx
  ON public.etl_ingest_events (pipeline_id, id);

ALTER TABLE public.etl_ingest_events ENABLE ROW LEVEL SECURITY;

-- Owner may inspect the backlog; writes and drains are server-side only.
CREATE POLICY "Users read own etl ingest events"
  ON public.etl_ingest_events FOR SELECT
  USING (auth.uid() = user_id);
