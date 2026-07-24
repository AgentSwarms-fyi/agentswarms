-- Encrypt MCP server bearer tokens at rest.
--
-- mcp_servers.auth_token was a plaintext TEXT column, written directly from the
-- browser and read back to it. New/edited servers now store the token AES-GCM
-- encrypted (same scheme as provider_credentials / user_secrets) in
-- auth_token_enc, written by a server function that holds PROVIDER_CREDS_SECRET;
-- the plaintext column is left in place only so existing rows keep working
-- (read-both) until they're re-saved. Neither column is sent to the client.
alter table public.mcp_servers
  add column if not exists auth_token_enc jsonb;

comment on column public.mcp_servers.auth_token_enc is
  'AES-GCM encrypted bearer token {ciphertext, iv}. Supersedes the plaintext auth_token; readers fall back to auth_token for rows saved before this migration.';
