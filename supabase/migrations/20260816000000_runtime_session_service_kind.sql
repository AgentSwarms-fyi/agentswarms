-- Let an MCP server actually start.
--
-- notebook_runtime_sessions.kind has been CHECK (kind IN ('interactive',
-- 'batch')) since 20260730000000. The MCP Builder, added later in
-- 20260756000000, runs each server as a session of kind 'service' — its own
-- migration header says so, and mcpApps/service.server.ts writes exactly that
-- — but nothing ever widened the constraint to accept it.
--
-- So pressing Deploy has never once worked on any deployment. Postgres refuses
-- the insert and the UI shows the raw constraint violation:
--
--   new row for relation "notebook_runtime_sessions" violates check
--   constraint "notebook_runtime_sessions_kind_check"
--
-- It went unnoticed because nobody had pressed Deploy: the one MCP app on this
-- instance sits at 0 tools with an inactive dot, and /mcp reports 0 connected
-- servers — which reads as "not set up yet" rather than "cannot be set up".
--
-- Same shape as 20260742000000, which widened catalog_sources.kind for the
-- Iceberg REST catalog.
ALTER TABLE public.notebook_runtime_sessions
  DROP CONSTRAINT IF EXISTS notebook_runtime_sessions_kind_check;

ALTER TABLE public.notebook_runtime_sessions
  ADD CONSTRAINT notebook_runtime_sessions_kind_check
  CHECK (kind IN ('interactive', 'batch', 'service'));
