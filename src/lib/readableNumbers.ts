// Numbers as a reader reads them, for text and tables that show query results
// as they came back (R512): the AI Analyst's findings, its step tables, and
// the result tables in a saved answer's PDF. A query returns sales as
// 474150.48440000083; the findings, copying the facts, printed 474150.4844.

const TWO_DECIMALS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** One number: two decimals and separators from 1 up, four decimals below. */
function readable(n: number): string {
  return Math.abs(n) >= 1 ? TWO_DECIMALS.format(n) : String(Number(n.toFixed(4)));
}

/**
 * Long decimals in a write-up, set as a reader reads them.
 *
 * A number of 1 or more takes at most two decimals and thousands separators;
 * a smaller one keeps four decimals, so a rate of 0.1247 stays as exact as the
 * facts gave it. Only numbers with three or more decimals change: integers
 * (years, ids), dates, times and version strings are left as written. The
 * prose is English, so the separators are too.
 */
export function readableDecimals(text: string): string {
  return text.replace(
    /(?<![\w.,:/-])(-?\d+)\.(\d{3,})(?![\w.:/])/g,
    (m, int: string, frac: string) => {
      const v = Number(`${int}.${frac}`);
      if (!Number.isFinite(v)) return m;
      if (Math.abs(v) >= 1) return TWO_DECIMALS.format(v);
      return frac.length > 4 ? readable(v) : m;
    },
  );
}

/**
 * A result table's cell: a decimal as readableDecimals sets it, so
 * 474150.48440000083 reads 474,150.48. Integers stay as stored (a year, an
 * id), and so does anything that is not a number.
 */
export function readableCell(v: unknown): string {
  if (v === null || v === undefined) return "null";
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^-?\d+\.\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || Number.isInteger(n)) return String(v);
  return readable(n);
}
