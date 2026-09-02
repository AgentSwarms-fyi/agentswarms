// Deterministic bytes for provenance: the one place where "the same thing"
// must always serialise the same way.
//
// Two features depend on it and would both be quietly wrong without it. A
// passport's signature is taken over these bytes, so a document assembled in a
// different order must not sign differently. A replay compares a result read
// today against a digest taken when the answer was given, so two identical
// result sets must not hash differently because a driver returned columns in
// another order.
//
// Deliberately free of server imports: it is pure, so both the tool layer
// (which hashes results mid-request) and the provenance layer can use it
// without dragging Supabase into the module graph.
import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level and no incidental whitespace.
 *
 * JSON.stringify preserves INSERTION order, which means two runs that built the
 * same object differently produce different bytes. A signature that depends on
 * property order is one that fails for reasons unrelated to tampering.
 *
 * Arrays keep their order: in a result set, and in a list of data reads, the
 * order is part of what happened.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * A short fingerprint of a query result, stored on the audit row at read time.
 *
 * This is what makes replay mean anything. Re-running a query later proves only
 * that the query runs; comparing the new result against the digest recorded at
 * the time proves whether the answer's data was what the record says it was.
 *
 * Truncated to 16 hex characters (64 bits). That is a fingerprint for
 * change-detection, not a security boundary — it lives on an append-only audit
 * row the user already owns, and nothing authenticates on it. The passport's
 * signature is the tamper-evidence; this is only ever compared to itself.
 */
export function resultDigest(rows: unknown): string {
  return createHash("sha256").update(canonicalJson(rows)).digest("hex").slice(0, 16);
}
