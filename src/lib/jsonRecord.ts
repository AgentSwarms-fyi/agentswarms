// Reading a JSON column as the object it is meant to hold (R347).
//
// Supabase types a json column as `Json`, which may be an array, a string or
// null as well as an object. Code that reads fields from one used to cast it
// to `Record<string, any>`, which let any read through unchecked. These say
// what the reader is entitled to: an object's fields, each `unknown` until it
// is checked.

/** A plain JSON object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The object a JSON value holds, or {} when it holds anything else. */
export function recordOf(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** A field read as text: the string it holds, or "" when it holds anything else. */
export function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
