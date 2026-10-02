-- ML platform: clustering, anomaly detection and recommendation join
-- classification, regression and forecasting.
--
-- Two of the new tasks have no target column (a clustering finds the groups;
-- an anomaly detector scores every row), and recommendation is defined by a
-- user column and an item column rather than a target. The task CHECK is
-- replaced whole, so every task must be listed.

ALTER TABLE public.ml_models DROP CONSTRAINT IF EXISTS ml_models_task_check;
ALTER TABLE public.ml_models
  ADD CONSTRAINT ml_models_task_check
  CHECK (task IN ('classification', 'regression', 'forecast', 'clustering', 'anomaly', 'recommendation'));

ALTER TABLE public.ml_models ALTER COLUMN target_column DROP NOT NULL;

ALTER TABLE public.ml_models
  -- recommendation: who interacted with what, and optionally how much
  ADD COLUMN IF NOT EXISTS user_column text,
  ADD COLUMN IF NOT EXISTS item_column text,
  ADD COLUMN IF NOT EXISTS rating_column text,
  -- clustering: NULL = pick k by silhouette
  ADD COLUMN IF NOT EXISTS n_clusters integer,
  -- anomaly detection: expected share of anomalies; NULL = the detector's own estimate
  ADD COLUMN IF NOT EXISTS contamination double precision;

-- A target-less task still needs a target to be absent, and a predicting task
-- still needs one present: keep that honest at the row level.
ALTER TABLE public.ml_models DROP CONSTRAINT IF EXISTS ml_models_target_by_task;
ALTER TABLE public.ml_models
  ADD CONSTRAINT ml_models_target_by_task
  CHECK (
    (task IN ('classification', 'regression', 'forecast') AND target_column IS NOT NULL)
    OR (task IN ('clustering', 'anomaly'))
    OR (task = 'recommendation' AND user_column IS NOT NULL AND item_column IS NOT NULL)
  );

COMMENT ON COLUMN public.ml_models.user_column IS 'Recommendation: the column identifying who interacted.';
COMMENT ON COLUMN public.ml_models.item_column IS 'Recommendation: the column identifying what was interacted with.';
COMMENT ON COLUMN public.ml_models.rating_column IS 'Recommendation: optional strength of the interaction; NULL = implicit (every row counts once).';
COMMENT ON COLUMN public.ml_models.n_clusters IS 'Clustering: fixed number of groups; NULL = chosen by silhouette score.';
COMMENT ON COLUMN public.ml_models.contamination IS 'Anomaly detection: expected share of anomalies (0.001-0.5); NULL = automatic.';
