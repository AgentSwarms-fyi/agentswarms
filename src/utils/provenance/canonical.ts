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
 * The fingerprint format. Bumped whenever the bytes below change shape.
 *
 * A digest is compared for EQUALITY, and inequality raises the loudest alarm
 * this system has: "the record and the data disagree". A format change would
 * make every previously recorded digest mismatch — firing that alarm on every
 * historical read at once, for a reason that has nothing to do with the data.
 * So the format is stamped into the value, and a reader that does not
 * recognise it reports UNKNOWN rather than a mismatch.
 */
const DIGEST_FORMAT = "v1";

/**
 * A query result reduced to the thing that is actually being fingerprinted:
 * these columns, in this order, holding these values, in these rows.
 *
 * FOUND FROM THE UI, and the reason this function exists at all. The digest
 * used to be taken over whatever shape the calling code happened to hold.
 * `executeWarehouseQuery` returns rows as OBJECTS keyed by column name
 * (`toObjects`), while `runLakehouseStatement` returns them as ARRAYS of
 * cells. The tool recorded one shape and replay computed the other, so every
 * lakehouse read replayed as "does NOT match the record" — a false accusation
 * of tampering, fired 100% of the time, on data nothing had touched.
 *
 * Normalising here means neither caller has to know or care which shape it is
 * holding, which is the only way two code paths stay agreed over time.
 */
export function normalizeResult(
  columns: readonly string[],
  rows: readonly unknown[],
): { columns: string[]; rows: unknown[][] } {
  const cols = [...columns];
  return {
    columns: cols,
    rows: rows.map((r) =>
      Array.isArray(r) ? [...r] : cols.map((c) => (r as Record<string, unknown>)?.[c]),
    ),
  };
}

/**
 * A short fingerprint of a query result, stored on the audit row at read time.
 *
 * This is what makes replay mean anything. Re-running a query later proves only
 * that the query runs; comparing the new result against the digest recorded at
 * the time proves whether the answer's data was what the record says it was.
 *
 * Column NAMES are part of it: a query whose columns were renamed did not
 * return the same answer, even if every value is identical. Column types are
 * not — they are reported differently by different code paths and would make
 * the digest depend on the route rather than the result.
 *
 * Truncated to 16 hex characters (64 bits). That is a fingerprint for
 * change-detection, not a security boundary — it lives on an append-only audit
 * row the user already owns, and nothing authenticates on it. The passport's
 * signature is the tamper-evidence; this is only ever compared to itself.
 */
export function resultDigest(columns: readonly string[], rows: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(canonicalJson(normalizeResult(columns, rows)))
    .digest("hex")
    .slice(0, 16);
  return `${DIGEST_FORMAT}:${hash}`;
}

/**
 * Can this recorded digest be compared to one we compute today?
 *
 * False for anything written in a format this build does not produce. The
 * caller must then report the comparison as unknown — never as a mismatch.
 */
export function isComparableDigest(recorded: string | null): boolean {
  return typeof recorded === "string" && recorded.startsWith(`${DIGEST_FORMAT}:`);
}
