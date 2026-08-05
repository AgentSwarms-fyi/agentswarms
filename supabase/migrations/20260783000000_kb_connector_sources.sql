-- KB connector sources: external providers (Google Drive, Notion, SharePoint,
-- Dropbox), scheduled ingestion, hash-based dedup, and source-based access
-- control.
--
-- Everything here EXTENDS the existing kb_sources / knowledge_documents model
-- that url/github ingestion already uses — same table, same RLS rows — so
-- nothing about the current RAG flow changes for existing documents. Every new
-- column has a default that reproduces today's behaviour.

-- 1) New provider kinds. The CHECK previously allowed only
--    manual/pdf/csv/url/github.
ALTER TABLE public.kb_sources
  DROP CONSTRAINT IF EXISTS kb_sources_kind_check;
ALTER TABLE public.kb_sources
  ADD CONSTRAINT kb_sources_kind_check
  CHECK (kind IN ('manual','pdf','csv','url','github','gdrive','notion','sharepoint','dropbox'));

-- 2) Status: add 'embedding_failed'.
--
--    Not new behaviour — /api/kb/ingest-url has written this status since the
--    embedding pipeline landed, but the constraint never allowed it, so that
--    UPDATE failed (unchecked) and a source whose embedding failed sat showing
--    'syncing' forever. The constraint now matches what the code writes.
ALTER TABLE public.kb_sources
  DROP CONSTRAINT IF EXISTS kb_sources_status_check;
ALTER TABLE public.kb_sources
  ADD CONSTRAINT kb_sources_status_check
  CHECK (status IN ('idle','syncing','ok','error','embedding_failed'));

-- 3) Scheduling — the exact saas_connections pattern: next_sync_at doubles as
--    the claim token (conditional UPDATE pushes it forward; only the instance
--    whose UPDATE matched runs the sync).
ALTER TABLE public.kb_sources
  ADD COLUMN IF NOT EXISTS sync_schedule text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS next_sync_at timestamptz;

ALTER TABLE public.kb_sources
  DROP CONSTRAINT IF EXISTS kb_sources_sync_schedule_check;
ALTER TABLE public.kb_sources
  ADD CONSTRAINT kb_sources_sync_schedule_check
  CHECK (sync_schedule IN ('manual','hourly','daily','weekly'));

CREATE INDEX IF NOT EXISTS idx_kb_sources_due
  ON public.kb_sources (next_sync_at)
  WHERE sync_schedule <> 'manual';

-- 4) Encrypted connector credentials, {ciphertext, iv} from
--    providers/crypto.server — the same shape saas_connections stores. Only
--    server routes write this column, and no UI query selects it.
ALTER TABLE public.kb_sources
  ADD COLUMN IF NOT EXISTS credentials jsonb;

-- 5) Access scope for documents ingested from this source.
--      'inherit'    — visible to whoever can see the KB (today's behaviour,
--                     and the default so existing sources are unchanged)
--      'private'    — visible only to the user who connected the source
--      'source_acl' — visible to principals mirrored from the provider's own
--                     sharing settings (per-document acl_principals below)
ALTER TABLE public.kb_sources
  ADD COLUMN IF NOT EXISTS access_scope text NOT NULL DEFAULT 'inherit';

ALTER TABLE public.kb_sources
  DROP CONSTRAINT IF EXISTS kb_sources_access_scope_check;
ALTER TABLE public.kb_sources
  ADD CONSTRAINT kb_sources_access_scope_check
  CHECK (access_scope IN ('inherit','private','source_acl'));

-- 6) Per-sync outcome the UI can render without parsing error strings.
ALTER TABLE public.kb_sources
  ADD COLUMN IF NOT EXISTS last_sync_stats jsonb;

-- 7) Dedup + ACL columns on documents.
--    external_id: the provider's stable id for the item (file id, page id).
--    content_hash: sha256 of the ingested text — an unchanged item is SKIPPED
--    on re-sync, so scheduled ingestion cannot duplicate documents or burn
--    embedding tokens re-indexing what didn't change.
--    acl_principals: lowercased emails (and 'domain:example.com' entries)
--    mirrored from the provider's sharing info when the source uses
--    access_scope='source_acl'.
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS acl_principals text[];

-- One document per remote item per source. Partial: manual uploads and legacy
-- rows have neither column and stay unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_source_external
  ON public.knowledge_documents (source_id, external_id)
  WHERE source_id IS NOT NULL AND external_id IS NOT NULL;
