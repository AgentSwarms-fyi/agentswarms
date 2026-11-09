-- pg_cron only where it exists (R467); the function below is created either
-- way. 20261113000000 unschedules the job: retention is the app's.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron is not available on this server (%); no cleanup job scheduled', SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION public.cleanup_old_observability_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.swarm_run_edges WHERE created_at < now() - INTERVAL '30 days';
  DELETE FROM public.swarm_run_steps WHERE created_at < now() - INTERVAL '30 days';
  DELETE FROM public.swarm_runs WHERE started_at < now() - INTERVAL '30 days';
  DELETE FROM public.execution_traces WHERE created_at < now() - INTERVAL '30 days';
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-old-observability-data');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'cleanup-old-observability-data',
      '0 3 * * *',
      $$ SELECT public.cleanup_old_observability_data(); $$
    );
  END IF;
END $outer$;