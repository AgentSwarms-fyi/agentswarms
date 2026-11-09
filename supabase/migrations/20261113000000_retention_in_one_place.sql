-- R467: one retention rule for runs and traces, on every database.
--
-- Two pg_cron jobs from 20260510 delete every swarm run (with its steps and
-- edges) and every execution trace older than 30 days, nightly at 03:00. They
-- read no setting. The app's own retention (utils/observability/retention.server,
-- hourly, on the scheduler) is the rule the product documents:
--   - iam_settings.trace_retention_days, 0 by default: keep everything;
--   - a trace that carries a decision_id is evidence, kept at least
--     iam_settings.provenance_retention_days (183 by default, the EU AI Act
--     Article 26(6) deployer floor).
-- The jobs overrode both on every Supabase database: an admin who chose 365
-- days, or the default, kept 30, and the evidence behind an answer went with it.
-- A database without pg_cron (Amazon RDS without it preloaded, a plain
-- Postgres) never had the jobs, so the same app kept different histories
-- depending on where it ran.
--
-- So the jobs go, wherever they exist. Nothing is deleted by this; what changes
-- is that nothing older than 30 days is deleted unless trace_retention_days says
-- so. To keep the old behaviour, set trace retention to 30 days
-- (Admin -> IAM -> Settings). cleanup_old_observability_data() stays, unused.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job
     WHERE jobname IN ('purge-old-swarm-runs', 'cleanup-old-observability-data');
  END IF;
END $$;
