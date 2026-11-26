-- Drift on live traffic (R545).
--
-- A batch run measures drift on the rows it scored. A warm endpoint answers a
-- row at a time, so the traffic a served model sees was never measured. Each
-- online request now keeps the COUNTS of its rows against the training bins on
-- its own prediction row (input.profile; no schema change, and no value a
-- caller sent). The platform clock sums the last day of them per version every
-- hour; this table holds that verdict, and when the version last alerted, so
-- a drifting version alerts once a day rather than once an hour.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS public.ml_traffic_checks (
  -- One row per version that answered traffic: the latest verdict.
  version_id uuid PRIMARY KEY REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  -- The model's owner, who is told.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  window_hours integer NOT NULL CHECK (window_hours BETWEEN 1 AND 720),
  requests integer NOT NULL CHECK (requests >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  -- Highest per-feature PSI, and every feature's, highest first.
  score double precision,
  features jsonb,
  -- The same over the owner's own requests (theirs and their API keys'):
  -- only that can start the owner's workflows.
  owner_row_count integer NOT NULL DEFAULT 0 CHECK (owner_row_count >= 0),
  owner_score double precision,
  -- Claimed with a conditional update: at most one alert a day per version.
  alerted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ml_traffic_checks_model
  ON public.ml_traffic_checks(model_id);

ALTER TABLE public.ml_traffic_checks ENABLE ROW LEVEL SECURITY;

-- The owner reads their own; only the server writes.
DROP POLICY IF EXISTS "owner reads traffic checks" ON public.ml_traffic_checks;
CREATE POLICY "owner reads traffic checks"
  ON public.ml_traffic_checks FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE public.ml_traffic_checks IS
  'Latest live-traffic drift verdict per model version, and when it last alerted (R545).';

-- The window read: a model's online requests, newest first.
CREATE INDEX IF NOT EXISTS idx_ml_predictions_rows_recent
  ON public.ml_predictions(model_id, created_at DESC)
  WHERE kind = 'rows';
