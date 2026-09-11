-- Ground truth: is the model still RIGHT?
--
-- Drift (PSI, ml_ops) answers whether the rows arriving now LOOK like the rows
-- the model trained on. That is a warning, not a verdict — inputs can shift
-- while accuracy holds, and inputs can sit still while the world changes under
-- the label. The only way to know a model is still right is to wait for the
-- real answer and compare.
--
-- So a model may name an OUTCOME SOURCE: a table where the answers turn up,
-- keyed so a scored row can find its own. An evaluation joins one prediction
-- run's output table to it and recomputes that model's OWN training metric on
-- the rows that have an answer yet.

-- ── Where the answers turn up ───────────────────────────────────────────────
-- {schema, table, key_columns[], outcome_column}. Shaped like ml_models.source
-- and read the same way: access to the schema is checked as the model's OWNER
-- every time an evaluation runs, never trusted from this document.
ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS outcome_source jsonb;

COMMENT ON COLUMN public.ml_models.outcome_source IS
  'Optional {schema, table, key_columns, outcome_column} naming where real outcomes land, so accuracy can be recomputed after the fact. NULL means this model is not evaluated against ground truth.';

-- ── One measurement ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  -- The run whose output table was measured. A prediction may be evaluated
  -- more than once as more answers arrive, so this is not unique.
  prediction_id uuid NOT NULL REFERENCES public.ml_predictions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The model's own primary metric, recomputed. `metric_name` is stored rather
  -- than inferred so a row stays readable if the trainer's choice ever changes.
  metric_name text NOT NULL,
  metric_value double precision NOT NULL,
  -- What the same metric was on the validation split when this version was
  -- trained. NULL when the version recorded none (an externally registered
  -- model, say), which makes decay unanswerable rather than zero.
  baseline_value double precision,
  -- (baseline - current) / |baseline|, sign-normalised so POSITIVE is always
  -- worse whichever direction the metric points.
  decay_ratio double precision,
  verdict text CHECK (verdict IS NULL OR verdict IN ('stable', 'degraded', 'improved')),

  -- Coverage. A metric over 6% of the scored rows is not the model's metric;
  -- it is the metric of whoever answered first, and they are rarely a random
  -- sample. Both numbers are kept so the reader can judge that themselves.
  matched_rows integer NOT NULL,
  scored_rows integer NOT NULL,

  -- accuracy / class count, or mae / r2 — whatever the task also reports.
  extra jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ml_evaluations_model_idx
  ON public.ml_evaluations (model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ml_evaluations_prediction_idx
  ON public.ml_evaluations (prediction_id);

ALTER TABLE public.ml_evaluations ENABLE ROW LEVEL SECURITY;

-- The same shape as ml_predictions: a row belongs to whoever caused it, and
-- the model's owner sees every evaluation of their model.
CREATE POLICY "Users manage their own ML evaluations"
  ON public.ml_evaluations FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Model owners read evaluations of their models"
  ON public.ml_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.ml_models m
      WHERE m.id = ml_evaluations.model_id AND m.user_id = auth.uid()
    )
  );

-- ── The knob ───────────────────────────────────────────────────────────────
-- Env-configurable like every other limit, with no hard cap: what counts as
-- "worse enough to tell somebody" is a property of the model's job, not of
-- this platform. 0.10 = ten per cent worse than the validation score.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_decay_alert_ratio double precision;

COMMENT ON COLUMN public.notebook_runtime_settings.ml_decay_alert_ratio IS
  'Relative degradation against a version''s training metric at which an evaluation raises ml.decay.alert. Default 0.10 (ten per cent worse). Env: ML_DECAY_ALERT_RATIO.';
