// API key format and hashing for published MCP servers.
//
// Pure module (no `.server` suffix, no imports) so the edge route, the
// management server functions and the tests can all share it — `.server.ts`
// files are import-protected. Deliberately the same shape as
// `src/utils/notebookApiKeys.ts`: one credential format to reason about, one
// place to change it.

/** Prefix that makes a leaked key recognisable in logs and secret scanners. */
export const MCP_KEY_PREFIX = "mcps_";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a new plaintext key. Shown to the owner once and never stored. */
export function generateMcpApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return MCP_KEY_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * SHA-256 of the plaintext, hex encoded — what actually lives in the database.
 *
 * Web Crypto rather than node:crypto so this works unchanged on Workers as well
 * as Node, which is the whole reason the module is dependency-free.
 */
export async function hashMcpApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Display stub for the UI — enough to tell two keys apart, not enough to use. */
export function mcpKeyPrefix(key: string): string {
  return key.slice(0, MCP_KEY_PREFIX.length + 6);
}

/** Shape check before we spend a database round trip on a lookup. */
export function looksLikeMcpApiKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(MCP_KEY_PREFIX) &&
    key.length >= MCP_KEY_PREFIX.length + 16 &&
    key.length <= 120
  );
}

/**
 * Turn a name into the public path segment, with random entropy appended.
 *
 * The suffix is not decoration: slugs are the only thing that distinguishes one
 * tenant's public endpoint from another's, so two users who both call their
 * server "github" must not collide — and neither should be able to guess or
 * squat the other's URL by choosing a name.
 */
export function generateMcpSlug(name: string): string {
  const base =
    (name || "server")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${base}-${suffix}`;
}
