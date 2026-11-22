-- R526: a forecast for each series, beside the total.
--
-- A forecasting model may name a series column (region, product, store): the
-- trainer then forecasts each of its values on its own, the largest first, as
-- well as the total. Without this column a forecast is one series, as before,
-- and the app stores the column only when it is set, so a database without
-- this migration still takes single-series forecasts.
ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS series_column text;

ALTER TABLE public.ml_models
  DROP CONSTRAINT IF EXISTS ml_models_series_column_check;
ALTER TABLE public.ml_models
  ADD CONSTRAINT ml_models_series_column_check
  CHECK (
    series_column IS NULL
    OR (task = 'forecast' AND length(series_column) BETWEEN 1 AND 128)
  );

COMMENT ON COLUMN public.ml_models.series_column IS
  'Forecasting: one forecast per value of this column, beside the total (R526).';
