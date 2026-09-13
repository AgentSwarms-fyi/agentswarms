// The online feature store — the pure part: what is stored under what name,
// when it may be served, and when it must not be.
//
// NO IMPORTS, so the refresher, the read path and the tests read one set of
// rules.
//
// WHY THIS EXISTS AT ALL, since the feature-views migration argued against
// materialising anything and was right to: it is not a second copy of the
// feature pipeline, and nothing here builds features. The offline table is
// still whatever built it — a SQL model with its own schedule, tests and
// lineage — and this holds the LATEST ROW PER KEY of that table for serving.
//
// Measured on the stack that prompted it: a governed lakehouse statement costs
// ~130 ms before it reads a row (min of 300 audited statements; p50 336 ms),
// because the access check ahead of it is a round trip to a hosted Postgres. A
// dashboard can pay that. A prediction asking for one customer's six numbers
// cannot, and it pays it on every call.
//
// The whole design rests on one property: THE STORE IS NEVER AUTHORITATIVE.
// Every miss, every stale entry, every unreachable server falls back to the
// lakehouse and answers correctly, slower. That is what makes a cache
// acceptable in a component whose own header says a feature store that quietly
// picks one of two rows is worse than one that refuses.

/** Keys are namespaced so one server can hold several deployments' stores. */
export const STORE_PREFIX = "fv";

/** How many rows one refresh page reads. Bounded by the chokepoint's row cap. */
export const REFRESH_PAGE_ROWS = 50_000;

/** Rows one refresh will write before it stops and says it stopped. */
export const DEFAULT_MAX_KEYS = 500_000;

/** How old the values may be before the read path stops trusting them. */
export const DEFAULT_STALE_MINUTES = 60;

/**
 * What the store knows about its own contents.
 *
 * Written once per refresh, read on every lookup, and deliberately small: a
 * lookup that had to read a big object to decide whether to trust a small one
 * would have spent the latency it exists to save.
 */
export type OnlineMeta = {
  /** When the refresh that wrote these values finished. */
  refreshed_at: string;
  /** Keys written. */
  rows: number;
  /** Rows the source held, when the refresh got to the end of it. */
  source_rows: number | null;
  /**
   * The view's definition at refresh time. A view whose key columns, feature
   * columns, table or timestamp column changed is a DIFFERENT view, and rows
   * written under the old one answer with the old shape.
   */
  def: string;
};

/**
 * What the stored rows were built from.
 *
 * Not a hash: short, readable and exact, so an operator looking at a stale
 * store can see what it disagrees with. Order is fixed rather than sorted from
 * the object, because a key list is ordered — `(a, b)` and `(b, a)` are
 * different keys and must not fingerprint alike.
 */
export function viewDefinition(v: {
  schema_name: string;
  table_name: string;
  key_columns: string[];
  feature_columns: string[];
  timestamp_column: string | null;
}): string {
  return JSON.stringify([
    v.schema_name,
    v.table_name,
    v.key_columns,
    v.feature_columns,
    v.timestamp_column ?? null,
  ]);
}

/** Where one key's features live. `fingerprint` is featureViews' injective one. */
export function onlineKey(viewId: string, fingerprint: string): string {
  return `${STORE_PREFIX}:${viewId}:k:${fingerprint}`;
}

/** Where the meta for a view lives. */
export function metaKey(viewId: string): string {
  return `${STORE_PREFIX}:${viewId}:meta`;
}

/** Every key belonging to one view, for dropping it. */
export function viewKeyPattern(viewId: string): string {
  return `${STORE_PREFIX}:${viewId}:*`;
}

/** How old the stored values are, in minutes. Negative clock skew reads as 0. */
export function ageMinutes(meta: Pick<OnlineMeta, "refreshed_at">, now: Date): number {
  const written = Date.parse(meta.refreshed_at);
  if (!Number.isFinite(written)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - written) / 60_000);
}

/** Why the store may not answer this lookup, or null when it may. */
export type Refusal =
  | "no-meta"
  | "definition-changed"
  | "stale"
  /** The store is on, fresh and current — the key simply is not in it. */
  | "miss";

/**
 * May the store answer for this view at all?
 *
 * Separate from "is the key present", because the two mean different things to
 * an operator: a miss is a key nobody asked for before or one the refresh
 * could not fit, while the three refusals above mean the store as a whole is
 * not to be trusted and every key will fall through.
 */
export function storeRefusal(
  meta: OnlineMeta | null,
  currentDef: string,
  now: Date,
  maxStaleMinutes: number,
): Exclude<Refusal, "miss"> | null {
  if (!meta) return "no-meta";
  // Checked BEFORE staleness: a view that was edited is not merely old, and
  // telling somebody their store is stale when the real answer is that they
  // changed the key columns sends them to refresh it for ever.
  if (meta.def !== currentDef) return "definition-changed";
  if (ageMinutes(meta, now) > maxStaleMinutes) return "stale";
  return null;
}

/** What an operator is told about a refusal, in their terms. */
export function refusalMessage(r: Refusal, viewName: string): string {
  switch (r) {
    case "no-meta":
      return `${viewName} has not been refreshed into the online store yet — serving from the lakehouse.`;
    case "definition-changed":
      return `${viewName} changed since its last refresh, so the stored rows are the old shape — serving from the lakehouse until it is refreshed.`;
    case "stale":
      return `${viewName}'s online rows are older than its staleness limit — serving from the lakehouse.`;
    case "miss":
      return `Some keys were not in ${viewName}'s online store — those were read from the lakehouse.`;
  }
}

/**
 * Did the refresh hold the whole view?
 *
 * `source_rows` is null when the refresh stopped at the key cap without
 * reaching the end, which is itself the answer: it did not.
 */
export function isComplete(meta: Pick<OnlineMeta, "rows" | "source_rows">): boolean {
  return meta.source_rows !== null && meta.rows >= meta.source_rows;
}

/** What the panel says about a store that holds part of its view. */
export function completenessNote(meta: Pick<OnlineMeta, "rows" | "source_rows">): string | null {
  if (isComplete(meta)) return null;
  if (meta.source_rows === null) {
    return `Stopped at ${grouped(meta.rows)} keys. Keys past that are read from the lakehouse — raise the online key limit to hold them all.`;
  }
  return `Holds ${grouped(meta.rows)} of ${grouped(meta.source_rows)} keys. The rest are read from the lakehouse.`;
}

/**
 * Digit grouping that does not depend on where the server is.
 *
 * toLocaleString formats by the machine's locale, and this string is written
 * onto a row somebody else reads: on a machine resolving to en-IN a million
 * renders as "10,00,000", which is correct there and not what the next reader
 * expects. The same reason mlDataParallel groups its own numbers by hand.
 */
function grouped(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return (n < 0 ? "-" : "") + out;
}

/**
 * How long a stored key should live in the server itself.
 *
 * The read path already refuses anything past the staleness limit, so this is
 * not what makes a stale value safe. It is what stops an abandoned view's keys
 * from occupying the store for ever, and it is deliberately generous — a key
 * that expires while its meta still says fresh costs a fallback, not an error.
 */
export function keyTtlSeconds(maxStaleMinutes: number): number {
  return Math.max(60, Math.ceil(maxStaleMinutes * 60 * 2));
}

/**
 * The refresh's own accounting, kept here so the server loop cannot drift from
 * what the tests check.
 */
export type RefreshProgress = { written: number; pages: number; reachedEnd: boolean };

/** Should the refresh ask for another page? */
export function shouldContinue(p: RefreshProgress, maxKeys: number): boolean {
  return !p.reachedEnd && p.written < maxKeys;
}

/** Rows to ask for next, never more than the cap leaves room for. */
export function nextPageRows(p: RefreshProgress, maxKeys: number, pageRows: number): number {
  return Math.max(0, Math.min(pageRows, maxKeys - p.written));
}
