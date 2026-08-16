// What an MCP API key is allowed to call, said out loud.
//
// MEASURED: the key list rendered the allow-list as
//
//   {k.tool_allowlist.length ? ` · ${k.tool_allowlist.length} tools` : ""}
//
// so a key narrowed to three tools read "· 3 tools", and a key that can call
// EVERY tool the server exposes read nothing at all. The proxy agrees with that
// encoding — `allowed.length > 0` is what gates tools/call, so an empty list
// means unrestricted — but the screen inverted its meaning. The most powerful
// key on the page was the one with no scope shown, and an operator auditing
// their keys saw the unrestricted one as the entry with LESS information rather
// than more reach:
//
//   prod-key      abc123… · 42 calls              ← can call anything
//   readonly-key  def456… · 7 calls · 3 tools     ← can call three things
//
// Same shape as the swarm SQL table allow-list found in Module 3: empty means
// "everything", and empty rendered as silence. A scope is either stated or it
// is being hidden; there is no third option that leaves the reader informed.

/** How a key's tool scope should read in a list. */
export function toolScopeLabel(allowlist: readonly string[] | null | undefined): string {
  const n = allowlist?.length ?? 0;
  // Never blank: the unrestricted case is the one that most needs saying.
  if (n === 0) return "all tools";
  return n === 1 ? "1 tool" : `${n} tools`;
}

/**
 * True when the key can call anything the server exposes.
 *
 * Exported separately so a caller can style the unrestricted case differently
 * without re-deriving the rule and risking the two drifting apart.
 */
export function isUnrestrictedKey(allowlist: readonly string[] | null | undefined): boolean {
  return (allowlist?.length ?? 0) === 0;
}
