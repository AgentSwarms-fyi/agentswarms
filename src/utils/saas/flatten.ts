// Flatten an API object into the flat row a dataset column can hold.
//
// Google Sheets returns flat rows already. Every other SaaS API does not:
// a Stripe charge nests `billing_details.address.country`, a Shopify order
// nests `customer.email` and carries an array of line items. The ingest path
// infers a column per top-level key, so a nested object handed to it straight
// becomes the string "[object Object]" — one useless column where a dozen
// usable ones should be, and no error to say so.
//
// Shared by every connector rather than written per API, because the decisions
// below are judgement calls that should not differ between sources.

/** How deep to descend before giving up and storing JSON. */
const MAX_DEPTH = 3;

/** Beyond this many columns a dataset stops being usable in a picker. */
const MAX_KEYS = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Flatten nested objects to `parent_child` keys.
 *
 * Choices worth stating, because each has a plausible alternative:
 *
 *   * UNDERSCORE, not dot. A dotted column name has to be quoted in every
 *     dialect and reads as a table qualifier in SQL — `SELECT customer.email`
 *     means something else entirely.
 *   * ARRAYS BECOME JSON TEXT, not columns. A Shopify order has N line items;
 *     exploding them into line_items_0_*, line_items_1_* makes the column set
 *     depend on the widest row in the sample, so two syncs of the same source
 *     can produce different schemas. The count is kept alongside, which is
 *     what most questions actually need.
 *   * DEPTH IS CAPPED and anything deeper is stored as JSON rather than
 *     dropped. Losing data silently is worse than an awkward column.
 *   * NULL is preserved, not stringified — the type inference downstream
 *     treats an empty string in a numeric column as no-number, and turning
 *     null into "null" would make every such column text.
 */
export function flattenRecord(
  input: Record<string, unknown>,
  opts: { maxDepth?: number; maxKeys?: number } = {},
): Record<string, unknown> {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxKeys = opts.maxKeys ?? MAX_KEYS;
  const out: Record<string, unknown> = {};

  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (Object.keys(out).length >= maxKeys) return;

    if (Array.isArray(value)) {
      out[prefix] = JSON.stringify(value);
      // The length is the part people filter and group on; digging it out of
      // a JSON string in SQL is possible but nobody does it.
      out[`${prefix}_count`] = value.length;
      return;
    }
    if (isPlainObject(value)) {
      if (depth >= maxDepth) {
        out[prefix] = JSON.stringify(value);
        return;
      }
      const entries = Object.entries(value);
      // An object with no keys is data too — recording it as an empty JSON
      // object keeps the column present rather than making it vanish for
      // rows that happen to be empty.
      if (entries.length === 0) {
        out[prefix] = "{}";
        return;
      }
      for (const [k, v] of entries) walk(v, prefix ? `${prefix}_${k}` : k, depth + 1);
      return;
    }
    out[prefix] = value ?? null;
  };

  for (const [k, v] of Object.entries(input)) walk(v, k, 1);
  return out;
}

/**
 * Seconds-since-epoch to an ISO date string.
 *
 * Stripe returns every timestamp as a Unix integer. Left alone it infers as a
 * number, so a date filter compares 1785600167 against '2026-08-01' and
 * silently matches nothing. Converting at the connector is the only place that
 * knows the field is a time at all.
 */
export function unixToIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Stripe uses seconds; anything already in milliseconds would land in the
  // year 56000 and is far more likely to be a mistake than a real date.
  const ms = v * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Rewrite the named Unix-timestamp fields of a flattened row into ISO text. */
export function isoifyTimestamps(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out = { ...row };
  for (const f of fields) {
    if (f in out) {
      const iso = unixToIso(out[f]);
      // A null result means it was not a usable timestamp; leave the original
      // rather than destroying a value we failed to understand.
      if (iso !== null) out[f] = iso;
    }
  }
  return out;
}
