-- A knowledge base can be fed by a website, kept in sync.
--
-- The platform could already ingest ONE page (kind='url') and one GitHub repo.
-- It could not index a documentation site: a hundred pages, discovered from a
-- sitemap or by following same-site links, re-checked on a schedule so a
-- changed page is re-embedded and a removed page is dropped. That is the most
-- common "connect my knowledge" request there is, and it needs no credential
-- at all -- which the existing connector path did not allow for.
--
-- 'web' joins the connector kinds. The sync engine's credential requirement is
-- relaxed only for connectors that declare themselves credential-free; every
-- other kind keeps failing loudly on missing credentials, for the reason
-- written where that check lives.
ALTER TABLE public.kb_sources
  DROP CONSTRAINT IF EXISTS kb_sources_kind_check;
ALTER TABLE public.kb_sources
  ADD CONSTRAINT kb_sources_kind_check
  CHECK (kind IN ('manual','pdf','csv','url','github','gdrive','notion','sharepoint','dropbox','web'));
