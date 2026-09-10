-- Incremental sync for SaaS connectors.
--
-- Every sync was a full refresh: page the whole source, then replace the
-- dataset. That is the right semantic for a spreadsheet, where rows are edited
-- and deleted in place and there genuinely is no cursor — and it is untenable
-- for a Salesforce org or a Stripe account with millions of records, where
-- re-reading everything hourly burns the customer's rate limit for no new
-- information and takes longer than the interval it runs on.
--
-- Two things are needed to append instead: somewhere to remember how far we
-- got, and a way to fold new rows into an existing dataset by key.

-- ── Where a stream got to ───────────────────────────────────────────────────
--
-- Per (connection, stream) rather than per connection: a Stripe connection
-- syncing charges and customers has two independent high-water marks, and one
-- stream failing must not rewind the other.
CREATE TABLE IF NOT EXISTS public.saas_stream_state (
  connection_id uuid NOT NULL REFERENCES public.saas_connections(id) ON DELETE CASCADE,
  stream text NOT NULL,
  -- Denormalised from the connection so RLS can be expressed without a join,
  -- and so a row cannot outlive the grant that made it visible.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The high-water mark, as TEXT.
  --
  -- Deliberately not typed: one connector's cursor is an ISO timestamp,
  -- another's is a Unix second, another's is an opaque id. Comparison is the
  -- connector's job because only it knows which of those it asked for; storing
  -- a timestamptz here would force a lossy conversion on the two that are not.
  cursor_value text,
  -- Which field it came from, recorded so the run view can say WHY a sync
  -- returned nothing ("nothing changed since 2026-09-10") rather than leaving
  -- an empty result looking like a failure.
  cursor_field text,
  -- What the last incremental pass actually did. `rows_seen` is the count the
  -- connector yielded; a merge can turn 100 rows into 60 updates and 40
  -- inserts, and both numbers matter when a sync looks wrong.
  last_rows_seen integer NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  PRIMARY KEY (connection_id, stream)
);

CREATE INDEX IF NOT EXISTS idx_saas_stream_state_user
  ON public.saas_stream_state(user_id);

ALTER TABLE public.saas_stream_state ENABLE ROW LEVEL SECURITY;

-- Readable by the owner. Writes go through the service role in the sync
-- runner: a client that could set its own cursor could skip rows it did not
-- want synced, or force a full re-read of somebody's paid API quota.
DROP POLICY IF EXISTS "Users read own stream state" ON public.saas_stream_state;
CREATE POLICY "Users read own stream state"
  ON public.saas_stream_state FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.saas_stream_state IS
  'Per-stream high-water mark for incremental SaaS syncs. Owner-readable; written only by the sync runner.';

-- ── Folding new rows into an existing dataset ───────────────────────────────
--
-- The full-refresh path deletes every row of the target and moves the staging
-- rows over. An incremental pass cannot do that: it holds only what CHANGED,
-- so replacing would throw away every row that did not.
--
-- This is an upsert keyed on one field of the stored JSON. Delete the target
-- rows whose key appears in staging, then move staging across — which is the
-- same two statements the replace path uses, with the delete narrowed from
-- "everything" to "the ones being superseded".
--
-- SECURITY INVOKER, and both datasets checked against the SAME owner inside.
--
-- INVOKER rather than DEFINER because the only caller is the sync runner
-- holding the service role, which already sees every row: DEFINER would add
-- ambient privilege that nothing needs, and if the REVOKE below were ever
-- loosened it would hand a signed-in caller everyone's data instead of
-- limiting them to their own. The owner check is what stops a bug that passed
-- a foreign staging id from splicing one tenant's rows into another's.
CREATE OR REPLACE FUNCTION public.merge_dataset_rows(
  p_target uuid,
  p_staging uuid,
  p_key text
)
RETURNS TABLE (updated integer, inserted integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_staging_owner uuid;
  v_updated integer;
  v_total integer;
BEGIN
  SELECT user_id INTO v_owner FROM public.user_data_tables WHERE id = p_target;
  SELECT user_id INTO v_staging_owner FROM public.user_data_tables WHERE id = p_staging;
  IF v_owner IS NULL OR v_staging_owner IS NULL THEN
    -- Also fires for a dataset with no owner at all: `user_id` is nullable
    -- because SAMPLE datasets belong to nobody, and a sample is not something
    -- a connector may merge into.
    RAISE EXCEPTION 'merge_dataset_rows: unknown or unowned dataset';
  END IF;
  IF v_owner <> v_staging_owner THEN
    RAISE EXCEPTION 'merge_dataset_rows: datasets have different owners';
  END IF;

  -- A row whose key is NULL cannot be matched, so it can only ever be an
  -- insert. Excluding it from the delete stops one keyless row from wiping
  -- every other keyless row on each pass.
  WITH keys AS (
    SELECT DISTINCT (row ->> p_key) AS k
    FROM public.user_data_rows
    WHERE table_id = p_staging AND (row ->> p_key) IS NOT NULL
  ),
  gone AS (
    DELETE FROM public.user_data_rows t
    USING keys
    WHERE t.table_id = p_target AND (t.row ->> p_key) = keys.k
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_updated FROM gone;

  SELECT count(*)::integer INTO v_total
  FROM public.user_data_rows WHERE table_id = p_staging;

  UPDATE public.user_data_rows SET table_id = p_target WHERE table_id = p_staging;

  updated := v_updated;
  inserted := GREATEST(v_total - v_updated, 0);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_dataset_rows(uuid, uuid, text) FROM public, anon, authenticated;

COMMENT ON FUNCTION public.merge_dataset_rows(uuid, uuid, text) IS
  'Upsert staging rows into a dataset by one JSON key. Service role only; refuses datasets with different owners.';
