-- What actually happened to an online prediction (R551).
--
-- A batch run can be measured against real outcomes: its scored table is
-- joined to the table where the answers land. An online request (the API, a
-- warm endpoint) leaves no table to join, so a model answering online could
-- never be told it had stopped being right. The caller now reports the real
-- answer for a row it was given, against the prediction_id it got back, and
-- the platform measures the model's own metric over the last thirty days of
-- those answers, as it measures a batch run.
--
-- Additive, and one widening: an online evaluation is about a window of
-- requests, not one run, so ml_evaluations.prediction_id may now be null for
-- it (never for a batch evaluation, which the check below holds).

CREATE TABLE IF NOT EXISTS public.ml_outcomes (
  prediction_id uuid NOT NULL REFERENCES public.ml_predictions(id) ON DELETE CASCADE,
  -- Which row of that request, from 0, in the order the rows were sent.
  row_index integer NOT NULL CHECK (row_index >= 0 AND row_index < 10000),
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  -- The model's owner, who reads them.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The key that reported it, and whose key that is: only the owner's own
  -- answers may start the owner's workflows.
  api_key_id uuid REFERENCES public.ml_api_keys(id) ON DELETE SET NULL,
  reported_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- What the model answered then, copied from the request's stored result,
  -- and what really happened. Text: a label, or a number as written.
  predicted text NOT NULL CHECK (length(predicted) <= 500),
  actual text NOT NULL CHECK (length(actual) <= 500),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Reported again, the later answer replaces the earlier.
  PRIMARY KEY (prediction_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_ml_outcomes_version_recent
  ON public.ml_outcomes(version_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_outcomes_recent
  ON public.ml_outcomes(received_at DESC);

ALTER TABLE public.ml_outcomes ENABLE ROW LEVEL SECURITY;

-- The owner reads; only the server writes, after checking the reporting key.
DROP POLICY IF EXISTS "owner reads outcomes" ON public.ml_outcomes;
CREATE POLICY "owner reads outcomes"
  ON public.ml_outcomes FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE public.ml_outcomes IS
  'Real answers reported for rows of online predictions, against the prediction they came from (R551).';

-- An evaluation is of one batch run, or of a window of online requests.
ALTER TABLE public.ml_evaluations
  ALTER COLUMN prediction_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'batch'
    CHECK (source IN ('batch', 'online')),
  -- For an online evaluation: how many days of answers it measured.
  ADD COLUMN IF NOT EXISTS window_days integer CHECK (window_days IS NULL OR window_days > 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ml_evaluations_batch_has_prediction'
  ) THEN
    ALTER TABLE public.ml_evaluations
      ADD CONSTRAINT ml_evaluations_batch_has_prediction
      CHECK (source = 'online' OR prediction_id IS NOT NULL);
  END IF;
END $$;

-- The newest online evaluation per version, which the hourly pass reads.
CREATE INDEX IF NOT EXISTS idx_ml_evaluations_online
  ON public.ml_evaluations(version_id, created_at DESC)
  WHERE source = 'online';
