// Scalar functions the prep compiler emits that AlaSQL does not ship.
//
// Pure — it takes the alasql module as an argument and has no imports of its
// own — so the differential harness can register exactly what production
// registers. An adapter that skipped these would report SPLIT_PART as broken
// when it works fine in the app, which is a false alarm and erodes trust in
// the whole suite.

let prepFnsRegistered = false;
/**
 * Scalar functions the prep compiler emits that AlaSQL doesn't ship.
 * Registered once per process, on the shared module object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPrepFns(alasql: any): void {
  if (prepFnsRegistered) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = alasql.fn as Record<string, (...args: any[]) => unknown>;
  const toDate = (v: unknown): Date | null => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  fn.SPLIT_PART = (s, d, n) => {
    if (s == null) return null;
    const parts = String(s).split(String(d ?? ""));
    const i = Number(n);
    return i >= 1 && i <= parts.length ? parts[i - 1] : null;
  };
  fn.split_part = fn.SPLIT_PART;
  const year = (v: unknown) => {
    const d = toDate(v);
    return d ? d.getFullYear() : null;
  };
  const month = (v: unknown) => {
    const d = toDate(v);
    return d ? d.getMonth() + 1 : null;
  };
  const day = (v: unknown) => {
    const d = toDate(v);
    return d ? d.getDate() : null;
  };
  fn.YEAR = year;
  fn.year = year;
  fn.MONTH = month;
  fn.month = month;
  fn.DAY = day;
  fn.day = day;
  fn.DATE_TRUNC = (u, v) => {
    const d = toDate(v);
    if (!d || typeof u !== "string") return null;
    const y = d.getFullYear();
    const m = d.getMonth();
    switch (u.toLowerCase()) {
      case "year":
        return `${y}-01-01`;
      case "quarter":
        return `${y}-${pad(Math.floor(m / 3) * 3 + 1)}-01`;
      case "month":
        return `${y}-${pad(m + 1)}-01`;
      case "day":
        return `${y}-${pad(m + 1)}-${pad(d.getDate())}`;
      default:
        return null;
    }
  };
  fn.date_trunc = fn.DATE_TRUNC;
  const date = (v: unknown) => {
    const d = toDate(v);
    return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
  };
  fn.DATE = date;
  fn.date = date;
  prepFnsRegistered = true;
}
