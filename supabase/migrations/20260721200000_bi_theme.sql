-- Dashboard theming: background image (compressed data URL), font choice,
-- and per-widget appearance (stored inside the widgets jsonb). One jsonb
-- column keeps the public page, PDF export and sharing working unchanged.
ALTER TABLE public.bi_dashboards
  ADD COLUMN IF NOT EXISTS theme jsonb NOT NULL DEFAULT '{}'::jsonb;
