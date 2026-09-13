-- Serving a feature view from a store that answers in milliseconds.
--
-- THE MIGRATION THAT CREATED FEATURE VIEWS ARGUED AGAINST MATERIALISING, and
-- it was right about what it was arguing against. Its point was that a SQL
-- model already builds the feature table on a schedule, tests its key and
-- records its lineage, so a second pipeline here would duplicate all of that
-- badly. Nothing below builds features. The offline table is still whatever
-- built it, and this holds the LATEST ROW PER KEY of that table for serving.
--
-- What changed is a measurement. A governed lakehouse statement on this stack
-- costs ~130 ms before it reads a row — min of 300 audited statements, p50
-- 336 ms — because the access check ahead of it is a round trip to a hosted
-- Postgres. A dashboard can pay that. A prediction asking for one customer's
-- six numbers pays it on every single call. The same key out of valkey is
-- ~2 ms, and 200 keys at once are 5 ms.
--
-- Nothing here is a source of truth. Every miss, every stale entry and every
-- unreachable server falls back to the lakehouse and answers correctly, just
-- slower. That is what makes a cache tolerable in a component whose own header
-- says a feature store that quietly picks one of two rows is worse than one
-- that refuses.
ALTER TABLE public.feature_views
  ADD COLUMN IF NOT EXISTS online_enabled boolean NOT NULL DEFAULT false,
  -- When the last refresh finished. The read path compares this against the
  -- staleness limit; null means nothing has been written yet.
  ADD COLUMN IF NOT EXISTS online_refreshed_at timestamptz,
  -- Keys written, and rows the source held when the refresh reached the end of
  -- it. `online_rows < online_source_rows`, or a null source count, is a store
  -- that holds PART of its view — which it is allowed to do, and must say.
  ADD COLUMN IF NOT EXISTS online_rows integer,
  ADD COLUMN IF NOT EXISTS online_source_rows integer,
  -- Why the last refresh failed, in the owner's words. Kept on the row rather
  -- than only in logs: the person who has to fix a duplicate key is looking at
  -- the panel, not at a container.
  ADD COLUMN IF NOT EXISTS online_error text,
  -- Null means the instance default (FEATURE_STORE_STALE_MINUTES). A view over
  -- a table rebuilt nightly wants a different number from one rebuilt every
  -- five minutes, and only its owner knows which.
  ADD COLUMN IF NOT EXISTS online_max_staleness_minutes integer
    CHECK (online_max_staleness_minutes IS NULL OR online_max_staleness_minutes BETWEEN 1 AND 43200);

COMMENT ON COLUMN public.feature_views.online_enabled IS
  'Serve lookups from the online store when it holds fresh rows for this view. Off means every lookup reads the lakehouse, which is what happened before the store existed.';
COMMENT ON COLUMN public.feature_views.online_max_staleness_minutes IS
  'How old the stored rows may be before the read path stops trusting them and reads the lakehouse instead. Null uses the instance default.';

-- Turning online serving on changes WHERE a prediction's numbers come from, so
-- it belongs with the other blast-radius columns the trigger already watches.
-- The refresh timestamps deliberately do NOT fire it: a refresh every five
-- minutes would bury the audit trail it shares with every other resource.
DROP TRIGGER IF EXISTS audit_feature_views ON public.feature_views;
CREATE TRIGGER audit_feature_views
  AFTER INSERT OR DELETE OR UPDATE OF
    schema_name, table_name, key_columns, feature_columns, timestamp_column, online_enabled
  ON public.feature_views
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('feature_view');
