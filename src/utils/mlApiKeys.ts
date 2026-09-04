// ML model API key format and hashing.
//
// Pure module (no `.server` suffix, no imports) so the public routes, the
// key-management server functions and the unit tests share one definition of
// what a key looks like — the same arrangement as notebook keys.

/** Prefix that makes a leaked key recognisable in logs and secret scanners. */
export const ML_KEY_PREFIX = "mlk_";

/** What a key may do. A key is minted for one model and one or more scopes. */
export const ML_KEY_SCOPES = ["predict", "train", "read"] as const;
export type MlKeyScope = (typeof ML_KEY_SCOPES)[number];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a new plaintext key. Shown to the owner once and never stored. */
export function generateMlApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ML_KEY_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** SHA-256 of the plaintext, hex encoded — what actually lives in the database. */
export async function hashMlApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Display stub for the UI — enough to tell two keys apart, not enough to use. */
export function mlKeyPrefix(key: string): string {
  return key.slice(0, ML_KEY_PREFIX.length + 6);
}

/** Shape check before we spend a database round trip on a lookup. */
export function looksLikeMlApiKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(ML_KEY_PREFIX) &&
    key.length >= ML_KEY_PREFIX.length + 16 &&
    key.length <= 120
  );
}
