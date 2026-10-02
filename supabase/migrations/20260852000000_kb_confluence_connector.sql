-- Confluence joins the knowledge-base connector kinds.
--
-- Drive, Notion, SharePoint, Dropbox and a public website could feed a
-- knowledge base; the enterprise wiki where most companies keep their
-- runbooks, ADRs and policies could not. One connector covers Cloud
-- (atlassian.net, email + API token) and Data Center (any other host, a
-- personal access token); the credential form is decided by the host, and
-- validation says which one to paste.
ALTER TABLE public.kb_sources
  DROP CONSTRAINT IF EXISTS kb_sources_kind_check;
ALTER TABLE public.kb_sources
  ADD CONSTRAINT kb_sources_kind_check
  CHECK (kind IN ('manual','pdf','csv','url','github','gdrive','notion','sharepoint','dropbox','web','confluence'));
