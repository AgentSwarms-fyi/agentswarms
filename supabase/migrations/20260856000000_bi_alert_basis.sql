-- BI alerts can evaluate a forecast, not only the last refresh.
--
-- basis = 'actual' is the rule as before: an aggregate over the widget's
-- stored rows. basis = 'forecast' evaluates the same aggregate over the next
-- `horizon` projected periods of a single-series line/area widget — from the
-- shared forecaster, or from the registry forecast model attached to the
-- widget — so "notify me when projected revenue for the next 3 months drops
-- below X" is a rule rather than a glance.
ALTER TABLE public.bi_alerts
  ADD COLUMN IF NOT EXISTS basis text NOT NULL DEFAULT 'actual'
    CHECK (basis IN ('actual', 'forecast')),
  ADD COLUMN IF NOT EXISTS horizon integer;

COMMENT ON COLUMN public.bi_alerts.basis IS
  'actual = aggregate over the refreshed rows; forecast = aggregate over the next `horizon` projected periods of the widget''s series.';
COMMENT ON COLUMN public.bi_alerts.horizon IS
  'Periods ahead a forecast-basis alert looks at. NULL for actual-basis alerts.';
