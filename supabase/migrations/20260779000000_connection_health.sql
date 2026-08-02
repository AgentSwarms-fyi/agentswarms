-- Health checks and credential age for data connections.
--
-- TWO SEPARATE CLOCKS, AND THE DISTINCTION IS THE WHOLE POINT.
--
-- `updated_at` is maintained by a trigger on EVERY update, so the health pass
-- writing last_tested_at bumps it. It therefore cannot answer "how old is this
-- credential" — after this migration the health checker would make every
-- credential look freshly rotated, which is precisely backwards for a signal
-- meant to surface stale ones.
--
-- `credentials_rotated_at` is written by the application, and ONLY when the
-- stored secret actually changes. Saving a connection to rename it does not
-- touch it.
--
-- Backfilled to created_at rather than now(): a credential entered a year ago
-- is a year old, and defaulting to now() would silently reset every existing
-- connection's age to zero on deploy — hiding exactly the stale credentials
-- this is meant to reveal.

ALTER TABLE public.data_warehouse_connections
  ADD COLUMN IF NOT EXISTS credentials_rotated_at timestamptz;

UPDATE public.data_warehouse_connections
  SET credentials_rotated_at = created_at
  WHERE credentials_rotated_at IS NULL;

ALTER TABLE public.saas_connections
  ADD COLUMN IF NOT EXISTS credentials_rotated_at timestamptz;

UPDATE public.saas_connections
  SET credentials_rotated_at = created_at
  WHERE credentials_rotated_at IS NULL;

-- App sources record a SYNC result (last_sync_*) but had no way to record a
-- cheap auth probe. Those are different questions: a source can authenticate
-- fine and still have had no sync scheduled, and a sync can fail for reasons
-- that have nothing to do with the credential. The health pass needs its own
-- columns or it would have to corrupt the sync history to report anything.
ALTER TABLE public.saas_connections
  ADD COLUMN IF NOT EXISTS last_test_status text,
  ADD COLUMN IF NOT EXISTS last_test_error text,
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;

-- The health pass picks the least-recently-checked rows. Without an index that
-- is a full scan of every active connection on every pass, forever.
CREATE INDEX IF NOT EXISTS idx_dw_connections_health
  ON public.data_warehouse_connections(last_tested_at NULLS FIRST)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_saas_connections_health
  ON public.saas_connections(last_tested_at NULLS FIRST)
  WHERE is_active;
