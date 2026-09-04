-- ML platform, milestone 2: predictions, data preparation, tuning.
--
-- A prediction run is the inference counterpart of a training job: a sandbox
-- loads a registered artifact (refusing one whose bytes do not hash to the
-- registry's digest), scores rows from a lakehouse table or a small payload,
-- and writes a lakehouse table back or returns the rows. It carries its own
-- decision id ('ml_prediction'), so a batch of predictions has a passport
-- like an answer, and it is audited as a data read (ml.predict_query) with a
-- result digest so it can be replayed and compared.

CREATE TABLE public.ml_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.ml_models(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.ml_model_versions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- 'batch' scores a lakehouse table into a lakehouse table; 'rows' scores a
  -- small payload (the try-it form, the ml_predict agent tool) and returns it.
  kind text NOT NULL DEFAULT 'batch' CHECK (kind IN ('batch', 'rows')),
  via text NOT NULL DEFAULT 'ui',
  input jsonb NOT NULL,
  output jsonb,
  row_count integer,
  session_id uuid,
  decision_id uuid,
  result jsonb,
  logs text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX ml_predictions_model_idx ON public.ml_predictions (model_id, created_at DESC);
CREATE INDEX ml_predictions_live_idx ON public.ml_predictions (status)
  WHERE status IN ('queued', 'running');

ALTER TABLE public.ml_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own ML predictions"
  ON public.ml_predictions FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- A grantee's own prediction runs are theirs (user_id); the model's owner
-- may also see every run made with their model, read-only.
CREATE POLICY "Model owners can read predictions made with their models"
  ON public.ml_predictions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.ml_models m WHERE m.id = model_id AND m.user_id = auth.uid()));

-- Data preparation lives on the model (it describes the training set) and is
-- pinned into each version's config at train time, alongside the tuning mode.
ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS prep jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ml_models.prep IS
  'Data preparation: {where, sql, impute, scale, encoding, class_weight, target_clip, drop_columns}. Pinned into ml_model_versions.config.prep when a version trains.';
