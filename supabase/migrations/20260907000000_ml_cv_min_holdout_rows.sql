-- When is a holdout big enough that cross-validation is not worth paying for?
--
-- Selection never reads the holdout any more; it scores candidates inside the
-- training rows instead. HOW it scores them is a cost decision, and the thing
-- that decides is how noisy a single inner split would be — which is a
-- question about the size of the holdout, not the size of the training set.
--
-- Above this many held-out rows the score is already pinned tightly enough
-- that k-fold would multiply every fit by k to buy almost nothing, so one
-- inner split is used. Below it, k-fold earns its cost.

ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_cv_min_holdout_rows integer;

COMMENT ON COLUMN public.notebook_runtime_settings.ml_cv_min_holdout_rows IS
  'Holdout rows at or above which model selection uses a single inner split rather than k-fold cross-validation. Default 2000. Time-ordered data always uses time-series folds regardless.';
