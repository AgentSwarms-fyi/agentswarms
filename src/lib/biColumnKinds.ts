// What a column's NAME, and its values, say about it. Pure and
// dependency-free, so both the BI agent and the table widget (loaded by public
// pages) use it.

/**
 * Is this column already an average, rate or ratio — something whose values
 * must not be added together?
 *
 * Judged from the column NAME because that is what the result carries: by the
 * time rows come back, `AVG(x) AS avg_salary` and `SUM(x) AS total_salary` are
 * both just a numeric column, and the aggregate that produced them is gone.
 *
 * Deliberately conservative. A false positive costs a sum nobody wanted; a
 * false negative is the bug this exists to stop, where a meaningless total is
 * offered as authoritative and then read out as "the average".
 */
export function isPreAggregated(column: string): boolean {
  const c = column.toLowerCase();
  return (
    /(^|_)(avg|average|mean|median)($|_)/.test(c) ||
    /(^|_)(rate|ratio|pct|percent|percentage|share|margin|score|index)($|_)/.test(c) ||
    /_per_/.test(c) ||
    /(^|_)per_/.test(c)
  );
}

/**
 * Is this column a running total, whose last value is the total so far (R512)?
 * By name: running, cumulative, cum, ytd, mtd, qtd, wtd, to_date. Adding one
 * up counts every earlier step again, so a narrative takes its latest value.
 */
export function isRunningTotal(column: string): boolean {
  const c = column.toLowerCase().replace(/[\s-]+/g, "_");
  return /(^|_)(running|cumulative|cum|cume|ytd|mtd|qtd|wtd|to_date|todate)($|_)/.test(c);
}

/**
 * Whether a percent format's numbers are ratios (R512), read from the values:
 * every present value between -1 and 1, with a fraction among them. A margin
 * returned as 0.14 printed "0.14%" under a Percent format. A column of 0s and
 * 1s says nothing either way and is left as written.
 */
export function readsAsRatios(rows: Record<string, unknown>[], columns: string[]): boolean {
  let seen = false;
  let fraction = false;
  for (const r of rows) {
    for (const c of columns) {
      const v = r[c];
      const n =
        typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n)) continue;
      seen = true;
      if (Math.abs(n) > 1) return false;
      if (!Number.isInteger(n)) fraction = true;
    }
  }
  return seen && fraction;
}
