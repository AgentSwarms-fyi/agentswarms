// What a column's NAME says about its values. Pure and dependency-free, so
// both the BI agent and the table widget (loaded by public pages) use it.

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
