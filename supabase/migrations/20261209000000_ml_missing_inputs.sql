-- Inputs that stop arriving (R549).
--
-- Drift measures the values that arrived. A feed that stops sending a field
-- reads as stable there while every row is scored on a filled-in value, so
-- the hourly live-traffic check now also counts how often each feature
-- arrived empty, against how often it was empty in training, and tells the
-- owner once a day when one arrives empty far more often.
--
-- Its own claim column: a version that drifts and loses a field on the same
-- day raises both alerts, neither holding the other back.
--
-- Additive only.

ALTER TABLE public.ml_traffic_checks
  -- The features arriving empty markedly more often than in training:
  -- [{feature, rate, training}], largest rise first. [] when every feature
  -- arrived about as often as in training; null when too few rows to say.
  ADD COLUMN IF NOT EXISTS missing jsonb,
  -- Claimed with a conditional update: at most one alert a day per version.
  ADD COLUMN IF NOT EXISTS missing_alerted_at timestamptz;

COMMENT ON COLUMN public.ml_traffic_checks.missing IS
  'Features arriving empty in live traffic markedly more often than in training (R549).';
