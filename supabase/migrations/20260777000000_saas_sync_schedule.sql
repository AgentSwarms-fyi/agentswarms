-- Scheduled syncing for SaaS sources.
--
-- `next_sync_at` is the claim token as well as the due time: the scheduler
-- pushes it forward with a conditional UPDATE and only proceeds if that update
-- matched a row, so two app instances polling the same second cannot both sync
-- one source. Without it, a source on hourly sync run by three instances is
-- synced three times an hour — each a full replace of the dataset.

ALTER TABLE public.saas_connections
  ADD COLUMN IF NOT EXISTS sync_schedule text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS next_sync_at timestamptz;

ALTER TABLE public.saas_connections
  DROP CONSTRAINT IF EXISTS saas_connections_sync_schedule_check;

ALTER TABLE public.saas_connections
  ADD CONSTRAINT saas_connections_sync_schedule_check
  CHECK (sync_schedule IN ('manual', 'hourly', 'daily', 'weekly'));

-- The scheduler's only query: due, non-manual, oldest first.
CREATE INDEX IF NOT EXISTS idx_saas_connections_due
  ON public.saas_connections (next_sync_at)
  WHERE sync_schedule <> 'manual';
