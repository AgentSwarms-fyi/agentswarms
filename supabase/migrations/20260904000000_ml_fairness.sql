-- Does the model treat groups differently?
--
-- Two questions, and they are genuinely different. SELECTION RATE asks how
-- often each group gets the favourable answer and needs no ground truth, so it
-- can be checked the moment a batch runs — it is the one employment and
-- lending law is written about. ERROR RATES ask whether the model is WRONG
-- more often for one group, which needs the real outcomes and therefore rides
-- on the same join ml_evaluations makes. A model can have identical selection
-- rates and still be far worse at one group, so both are recorded.

-- ── What to compare, and what counts as the good answer ────────────────────
ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS sensitive_columns text[],
  ADD COLUMN IF NOT EXISTS favourable_label text;

COMMENT ON COLUMN public.ml_models.sensitive_columns IS
  'Columns to compare groups by in a fairness check. Present in the scored table. NULL means this model is not checked.';
COMMENT ON COLUMN public.ml_models.favourable_label IS
  'The predicted label that counts as the good outcome. NAMED BY A PERSON, never inferred: which label is favourable is a fact about the world ("approved" yes, "fraud" no, "churn" depends who is asking) and a guess would end up in a compliance report.';

-- ── One check ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_fairness_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  prediction_id uuid NOT NULL REFERENCES public.ml_predictions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- One row per sensitive column, because two columns are two comparisons and
  -- averaging them would hide the one that matters.
  column_name text NOT NULL,
  favourable_label text,

  -- Lowest group's selection rate over the highest's. NULL when fewer than two
  -- groups were large enough to compare.
  disparate_impact double precision,
  -- Largest true-positive-rate gap between groups, where outcomes were known.
  equal_opportunity_gap double precision,
  lowest_group text,
  -- 'even' | 'review' | 'unmeasurable'. Deliberately not 'fair' or 'unfair':
  -- that is a judgement about a context this platform cannot see.
  verdict text CHECK (verdict IS NULL OR verdict IN ('even', 'review', 'unmeasurable')),

  -- Every group, including ones too small to judge and the '(not recorded)'
  -- group. Hiding a small group is how a real problem stays invisible.
  groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  /* A plain-English reading, when one was asked for. WRITTEN BY A MODEL from
     the numbers above and never allowed to compute one — see
     src/utils/ml/fairness.server.ts. */
  narrative text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ml_fairness_model_idx
  ON public.ml_fairness_checks (model_id, created_at DESC);

ALTER TABLE public.ml_fairness_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own fairness checks"
  ON public.ml_fairness_checks FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Model owners read fairness checks of their models"
  ON public.ml_fairness_checks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.ml_models m
      WHERE m.id = ml_fairness_checks.model_id AND m.user_id = auth.uid()
    )
  );

-- ── The knob ───────────────────────────────────────────────────────────────
-- Four fifths is the threshold the US EEOC's Uniform Guidelines use as prima
-- facie evidence of adverse impact. It is a rule of thumb with no statistical
-- claim behind it and it is not the standard everywhere, so it is a default
-- rather than a law, and a deployment may hold itself to more.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_fairness_min_ratio double precision;

COMMENT ON COLUMN public.notebook_runtime_settings.ml_fairness_min_ratio IS
  'Selection-rate ratio below which a fairness check asks for review. Default 0.8, the four-fifths rule. Env: ML_FAIRNESS_MIN_RATIO.';
