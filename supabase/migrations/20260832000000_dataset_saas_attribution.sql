-- Where a synced dataset CAME FROM, as a fact rather than a display string.
--
-- Connector-synced tables land in user_data_tables like any upload, which is
-- deliberate: sync and upload share one ingest path so a synced dataset cannot
-- behave differently to an uploaded one. The side effect is that the Data
-- Catalog filed seven Salesforce tables under "Local tables", because local
-- storage was the only thing it knew about them.
--
-- The provenance was already recorded — source_filename holds "Salesforce ·
-- opportunities" — but as text for a human to read, not something the catalog
-- can group by. Parsing that string back out would be inventing structure from
-- a label; the connection id is the fact.
--
-- Storage stays exactly where it is. This changes only what the catalog can
-- say about it.

ALTER TABLE public.user_data_tables
  ADD COLUMN IF NOT EXISTS saas_connection_id uuid
    REFERENCES public.saas_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS saas_stream text;

CREATE INDEX IF NOT EXISTS idx_user_data_tables_saas_conn
  ON public.user_data_tables(saas_connection_id)
  WHERE saas_connection_id IS NOT NULL;

-- BACKFILL for datasets synced before this column existed.
--
-- Matched on the two facts the sync already writes: the dataset name is
-- prefixed with the connection name (datasetNameFor), and source_filename
-- carries "<Provider> · <stream>". Both must agree, and the owner must match,
-- so a user's own upload that happens to be called "acme_leads" is not
-- adopted by a connection called "acme".
UPDATE public.user_data_tables t
SET saas_connection_id = c.id,
    saas_stream = NULLIF(split_part(t.source_filename, ' · ', 2), '')
FROM public.saas_connections c
WHERE t.saas_connection_id IS NULL
  AND t.user_id = c.user_id
  AND t.source_filename LIKE '% · %'
  AND t.name LIKE c.name || '\_%';
