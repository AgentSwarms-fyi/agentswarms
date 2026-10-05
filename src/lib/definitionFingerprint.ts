// A fingerprint of what an editor saves (sweep 9).
//
// Where runs, deploys or certification also write a row, `updated_at` moves
// with nobody editing and cannot tell a page that someone else saved the
// definition (R284 named the tables). The save compares the definition
// instead: the server fingerprints the stored definition fields when it hands
// a row to the page, the page sends that fingerprint back with its save, and
// the server refuses the save when the stored definition's fingerprint no
// longer matches (R285).

/**
 * JSON with object keys sorted at every depth, and undefined fields left out,
 * so a definition reads the same after a `jsonb` round trip, which reorders
 * keys.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // An undefined field stays undefined, which JSON.stringify leaves out.
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 of the canonical JSON, as hex. */
export async function fingerprintOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
