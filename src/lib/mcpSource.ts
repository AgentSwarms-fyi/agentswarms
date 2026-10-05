// What the MCP builder's editor autosaves, for a fingerprint of it (R290,
// sweep 9). Deploys, the idle reaper and tool approval write other columns of
// the app's row and move its updated_at, so the source itself is compared.

export function mcpSourceDefinition(app: {
  source_code?: string | null;
  requirements?: string | null;
}) {
  return { source_code: app.source_code ?? "", requirements: app.requirements ?? "" };
}
