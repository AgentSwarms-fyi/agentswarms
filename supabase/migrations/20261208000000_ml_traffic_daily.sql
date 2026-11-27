-- Drift over time (R548).
--
-- The hourly live-traffic check (R545) keeps only its LATEST verdict per
-- version, which answers "is it drifting now" and not "since when". This
-- keeps one row per version per day, the day's last verdict, so the model
-- page can draw drift as a line beside the batch runs' own figures.
--
-- Counts and scores only, as the latest verdict is: no value a caller sent.
-- Additive only.

CREATE TABLE IF NOT EXISTS public.ml_traffic_daily (
  version_id uuid NOT NULL REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  day date NOT NULL,
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  -- The model's owner.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requests integer NOT NULL CHECK (requests >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  -- Highest per-feature PSI over the 24 hours the day's last check read.
  score double precision,
  features jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, day)
);

CREATE INDEX IF NOT EXISTS idx_ml_traffic_daily_model_day
  ON public.ml_traffic_daily(model_id, day DESC);

ALTER TABLE public.ml_traffic_daily ENABLE ROW LEVEL SECURITY;

-- The owner reads their own; only the server writes.
DROP POLICY IF EXISTS "owner reads daily traffic" ON public.ml_traffic_daily;
CREATE POLICY "owner reads daily traffic"
  ON public.ml_traffic_daily FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE public.ml_traffic_daily IS
  'One live-traffic drift verdict per model version per day, the day''s last (R548).';
