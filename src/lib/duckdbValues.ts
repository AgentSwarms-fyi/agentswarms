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
