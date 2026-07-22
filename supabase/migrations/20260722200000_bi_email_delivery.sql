-- Email delivery for BI monitoring:
--   - bi_alerts.email_enabled: fired alerts also email the dashboard owner
--     (in-app notifications continue regardless).
--   - bi_schedules.email_report: each scheduled refresh emails the owner an
--     HTML digest built from the fresh widget snapshots.
-- Sending uses the instance mailer (RESEND_API_KEY or SMTP_*); when neither
-- is configured the refresh engine logs and skips gracefully.

ALTER TABLE public.bi_alerts
  ADD COLUMN email_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.bi_schedules
  ADD COLUMN email_report boolean NOT NULL DEFAULT false;
