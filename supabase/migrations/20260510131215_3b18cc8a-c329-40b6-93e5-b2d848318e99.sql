CREATE EXTENSION IF NOT EXISTS pg_cron;

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

SELECT cron.schedule(
  'cleanup-old-observability-data',
  '0 3 * * *',
  $$ SELECT public.cleanup_old_observability_data(); $$
);