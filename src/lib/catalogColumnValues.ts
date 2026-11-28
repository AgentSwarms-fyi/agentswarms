// Values a catalog column keeps (R556).
//
// A crawl profiles a column from a sample of its rows and keeps three of the
// values it read: one `sample`, and for numbers a `min` and `max`. The catalog
// is metadata, and it can be shared read-only with people who have no access
// to the data itself, so a column that holds personal data keeps none of them.
// The column's own finding (`pii_evidence`) is counts, never values.
//
// This is the application's half. The database applies the same rule to every
// write (migration 20261213000000), and also to columns covered by one of the
// owner's lakehouse mask rules or tables under a row filter, which only it can
// see.

/** The profile fields that are values read from the data. */
export const COLUMN_VALUE_FIELDS = ["sample", "min", "max"] as const;

/** The tag an owner writes to say a column is personal, however it is spelled. */
export const PERSONAL_TAG = "pii";

/**
 * True when the catalog keeps no value of this column: it was judged to hold
 * personal data, or its owner tagged it `pii`.
 */
export function keepsNoValues(c: { pii?: boolean; tags?: unknown }): boolean {
  if (c.pii === true) return true;
  return (
    Array.isArray(c.tags) &&
    c.tags.some((t) => typeof t === "string" && t.trim().toLowerCase() === PERSONAL_TAG)
  );
}

/** The column without the values read from its data. */
export function withoutValues<C extends object>(c: C): C {
  const out = { ...c } as Record<string, unknown>;
  for (const f of COLUMN_VALUE_FIELDS) delete out[f];
  return out as C;
}

/** The column as the catalog may keep it. */
export function keepableColumn<C extends { pii?: boolean; tags?: unknown }>(c: C): C {
  return keepsNoValues(c) ? withoutValues(c) : c;
}
