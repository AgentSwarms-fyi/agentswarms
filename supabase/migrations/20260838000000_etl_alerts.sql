-- Per-pipeline alert policy. Delivery rides the existing notification
-- chokepoint (in-app row + every connected Slack/Teams/Discord/webhook
-- channel); this column only decides WHEN a run outcome raises one.
ALTER TABLE public.etl_pipelines
  ADD COLUMN IF NOT EXISTS alerts jsonb NOT NULL
  DEFAULT '{"on_failure": true, "on_success": false, "on_recovery": true}'::jsonb;
