// How a DuckDB value becomes a JavaScript value.
//
// DELIBERATELY BROWSER-SAFE AND ENGINE-AGNOSTIC. DuckDB now runs in two
// places — `utils/data/duckdb.server` on the server via @duckdb/node-api, and
// `lib/browserDuckdb` in the browser via WebAssembly — and both must hand the
// same value back to the rest of the app. A second copy of these rules is a
// divergence waiting to happen, and divergence between those two engines is
// precisely the bug this whole change exists to remove.
//
// It lives in lib/ rather than utils/data because utils/data/duckdb.server
// references @duckdb/node-api, a native module; importing that file from
// browser code would drag node bindings into the client bundle.

/**
 * The time zone every DuckDB engine in the app runs in (R195).
 *
 * The browser engine took the viewer's zone and the server engines took the
 * container's, so `current_date` and a TIMESTAMPTZ cast to DATE came back a
 * day apart in the Workbench and in a scheduled refresh over the same data.
 * Every engine sets this when it starts: the browser engine and the local
 * dataset engine (`utils/data/duckdb.server`) and the lakehouse engine
 * (`utils/lakehouse/core.server`).
 */
export const ENGINE_TIME_ZONE = "UTC";

/**
 * Convert a DuckDB value into something JSON-serialisable.
 *
 * This is not cosmetic. COUNT(*) comes back as a BigInt, which JSON.stringify
 * throws on outright, and DECIMAL comes back as an object that stringifies to
 * "[object Object]" — either would surface as a broken widget or a 500 rather
 * than a wrong number, but both are failures.
 */
export function toJsValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    // Beyond 2^53 a Number silently loses precision. A string is ugly but
    // honest; a wrong total is neither.
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  // DECIMAL / HUGEINT / DATE / TIMESTAMP arrive as objects with a faithful
  // toString(). Prefer the numeric reading when there is one.
  const s = String(v);
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : s;
}

/** A temporal column, as the browser engine's Arrow schema describes it (R197). */
export type TemporalKind = "date" | "timestamp" | "timestamptz";

/**
 * Whether an Arrow field type is a DATE, a TIMESTAMP or a TIMESTAMPTZ.
 *
 * Read from the type's id (Date 8, Timestamp 10, and the unit-specific ids
 * -13/-14 and -15 to -18) and, as a fallback, from its name ("Date32<DAY>",
 * "Timestamp<MICROSECOND, UTC>"), so a change of arrow version that moves one
 * does not quietly turn dates back into numbers.
 */
export function arrowTemporalKind(type: unknown): TemporalKind | null {
  if (!type || typeof type !== "object") return null;
  const t = type as { typeId?: unknown; timezone?: unknown };
  const id = typeof t.typeId === "number" ? t.typeId : null;
  const name = String(type);
  if (id === 8 || id === -13 || id === -14 || /^Date/.test(name)) return "date";
  if (id === 10 || (id !== null && id <= -15 && id >= -18) || /^Timestamp/.test(name)) {
    return t.timezone ? "timestamptz" : "timestamp";
  }
  return null;
}

/**
 * An epoch-millisecond value from the browser engine, written the way the
 * server engine writes the same column.
 *
 * FOUND IN R197. Arrow hands DATE and TIMESTAMP to JavaScript as epoch
 * milliseconds, and the browser engine passed them on: the Workbench showed
 * `1640995200000` where the server engine shows `2022-01-01`, a CSV export
 * wrote the number, and a chart labelled the two differently. Both engines
 * run in UTC (R195), so the UTC fields are the engine's own.
 */
export function formatTemporal(ms: number, kind: TemporalKind): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (kind === "date") return day;
  const milli = d.getUTCMilliseconds();
  const frac = milli ? `.${p(milli, 3).replace(/0+$/, "")}` : "";
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${frac}`;
  return `${day} ${time}${kind === "timestamptz" ? "+00" : ""}`;
}
