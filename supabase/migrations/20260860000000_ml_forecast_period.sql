-- ML platform: a forecast's period is a choice, not a guess.
--
-- The trainer inferred the granularity from the gaps between timestamps, so
-- a table of dated orders became a daily series and "3 periods" meant three
-- days - which nobody had asked for and nothing on screen said. The model
-- now records the period it forecasts at; 'auto' keeps the inference.
ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS period text NOT NULL DEFAULT 'auto'
    CHECK (period IN ('auto', 'hour', 'day', 'week', 'month', 'quarter'));

COMMENT ON COLUMN public.ml_models.period IS
  'Forecast granularity: hour, day, week, month, quarter, or auto (inferred from the timestamps).';
