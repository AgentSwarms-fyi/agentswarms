// Notebook API key format and hashing.
//
// Pure module (no `.server` suffix, no imports) so both the server routes and
// the key-management server functions can share it, and so the format rules are
// unit-testable — `.server.ts` files are import-protected.

/** Prefix that makes a leaked key recognisable in logs and secret scanners. */
export const NOTEBOOK_KEY_PREFIX = "nbk_";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a new plaintext key. Shown to the owner once and never stored. */
export function generateNotebookApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return NOTEBOOK_KEY_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * SHA-256 of the plaintext, hex encoded — what actually lives in the database.
 *
 * Web Crypto rather than node:crypto so this works unchanged on Workers as well
 * as Node, which is the whole reason the module is dependency-free.
 */
export async function hashNotebookApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Display stub for the UI — enough to tell two keys apart, not enough to use. */
export function notebookKeyPrefix(key: string): string {
  return key.slice(0, NOTEBOOK_KEY_PREFIX.length + 6);
}

/** Shape check before we spend a database round trip on a lookup. */
export function looksLikeNotebookApiKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(NOTEBOOK_KEY_PREFIX) &&
    key.length >= NOTEBOOK_KEY_PREFIX.length + 16 &&
    key.length <= 120
  );
}
