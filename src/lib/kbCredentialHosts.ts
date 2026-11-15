// Where each knowledge-base connector sends its credentials (R494).
//
// A credential picked as a secret shared with the source's owner resolves only
// when its owner allowed every one of these hosts. Fixed per provider, except
// Confluence, whose site is the source's own setting. The connectors' calls
// are in src/utils/kb/connectors.server.ts and confluence.server.ts; keep the
// two in step.

const FIXED: Record<string, readonly string[]> = {
  gdrive: ["https://oauth2.googleapis.com", "https://www.googleapis.com"],
  notion: ["https://api.notion.com"],
  sharepoint: ["https://login.microsoftonline.com", "https://graph.microsoft.com"],
  dropbox: ["https://api.dropboxapi.com", "https://content.dropboxapi.com"],
};

/**
 * The hosts a source of this kind sends its credentials to, as URLs. Empty
 * when they are not known yet (a Confluence source with no site URL): then
 * only the owner's own secrets resolve.
 */
export function kbCredentialHosts(kind: string, config: Record<string, unknown>): string[] {
  if (kind === "confluence") {
    const site = typeof config.site_url === "string" ? config.site_url.trim() : "";
    return site ? [site] : [];
  }
  return [...(FIXED[kind] ?? [])];
}
