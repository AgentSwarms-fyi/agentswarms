-- The floor under a data-parallel slice, as a setting rather than a constant.
--
-- 25,000 is where the measurement stopped punishing the split, but it is a
-- line drawn on a smooth curve rather than a discovered threshold, and the
-- right place for it depends on the data: a dataset with few columns and a
-- simple boundary learns from far fewer rows than one with two hundred
-- features. Every other ML limit on this instance is adjustable and this one
-- decides whether a fit happens at all, so it is adjustable too.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_parallel_min_rows integer;

COMMENT ON COLUMN public.notebook_runtime_settings.ml_parallel_min_rows IS
  'Rows each worker must still get before the trainer will split a dataset across containers. Below it the trainer samples the old way instead. Default 25000, measured: at 25k a slice costs about half a point of F1 against a single fit, at 2.5k it costs three points.';
