// Whether a spend figure is the whole story.
//
// A total built by summing cost_usd is only as complete as the rows under it.
// When a model has no known price the call is recorded at 0 — honestly flagged
// on the row, but a SUM cannot carry a flag, so the total silently under-counts
// and looks authoritative doing it.
//
// MEASURED, which is why this exists: 116 calls to moonshotai/kimi-k3 carrying
// 132,117 tokens showed $0.00 everywhere. The Traces page said "unpriced" on
// each row; the dashboard, the analytics page and the spend panel each showed a
// confident $0.00 total. The row-level honesty was already there and never
// reached the numbers people actually look at.
//
// One module so every surface uses the same words. Pure — no imports — because
// four components and the tests all read it.

/** A row that may or may not have had a known price. */
export type PricedRow = {
  cost_usd?: number | string | null;
  /** Postgres `->>` returns text, so this arrives as "true", not true. */
  pricing_missing?: string | boolean | null;
};

export type SpendTotal = {
  /** Sum of what IS known, in USD. Never includes a guess for the rest. */
  total: number;
  /** How many rows contributed no amount because nothing knew their rate. */
  unpricedRows: number;
  /** True when the total is a floor rather than the answer. */
  partial: boolean;
};

/** Postgres `->>` yields text; a boolean survives a direct column read. */
function isUnpriced(row: PricedRow): boolean {
  return row.pricing_missing === true || row.pricing_missing === "true";
}

/**
 * Total the rows, and say how much of the picture is missing.
 *
 * A row that is flagged unpriced counts toward `unpricedRows` even if its
 * cost_usd is somehow non-zero, because the flag is the statement about
 * whether the figure can be trusted.
 */
export function sumSpend(rows: readonly PricedRow[]): SpendTotal {
  let total = 0;
  let unpricedRows = 0;
  for (const row of rows) {
    const amount = Number(row.cost_usd ?? 0);
    if (Number.isFinite(amount)) total += amount;
    if (isUnpriced(row)) unpricedRows += 1;
  }
  return { total, unpricedRows, partial: unpricedRows > 0 };
}

/**
 * Format a total so a reader can tell "this is the amount" from "this is at
 * least the amount".
 *
 * The `+?` suffix is deliberately the same mark the Traces page already uses on
 * a partial turn, so the two surfaces do not teach different vocabularies for
 * the same fact.
 */
export function formatSpend(t: SpendTotal, fractionDigits = 2): string {
  return `$${t.total.toFixed(fractionDigits)}${t.partial ? "+?" : ""}`;
}

/**
 * The sentence explaining a partial total, or null when there is nothing to
 * explain.
 *
 * Returns null rather than an empty string so a caller cannot accidentally
 * render an always-present tooltip that says nothing — an explanation that
 * appears even when everything is priced trains people to ignore it.
 */
export function spendCaveat(t: SpendTotal): string | null {
  if (!t.partial) return null;
  const calls = t.unpricedRows === 1 ? "1 call" : `${t.unpricedRows} calls`;
  return (
    `At least this much: ${calls} used a model with no known price and contributed $0. ` +
    `Refresh the price catalog (npm run prices:refresh) so those calls can be re-priced.`
  );
}

/**
 * A total that arrived already summed, plus how many calls went unpriced.
 *
 * `unpricedRows` null means the count could not be established, which is NOT
 * the same as zero: the total is a floor either way, and only the explanation
 * for it is missing. The gate reads it the same way — budgetGuard's `partial`
 * is `unpriced === null || unpriced > 0` — and having the rule in one place is
 * what stops the display and the enforcement from disagreeing about whether a
 * figure is the answer or a lower bound.
 */
export function floorTotal(total: number, unpricedRows: number | null): SpendTotal {
  return {
    total,
    unpricedRows: unpricedRows ?? 0,
    partial: unpricedRows === null || unpricedRows > 0,
  };
}

export type SpendTrend = {
  /** Percent change, or null when the two totals cannot honestly be compared. */
  pct: number | null;
  /** Why there is no percentage, or null when there is one. */
  caveat: string | null;
};

/**
 * Week-over-week change between two spend totals — or nothing, when the two
 * cannot be compared.
 *
 * A total built from rows with unknown prices is a FLOOR, and the difference
 * between two floors is not a floor: it can be wrong in either direction. A
 * week with many unpriced calls measured against one without shows a drop that
 * never happened, and a percentage is read as a fact about the business rather
 * than about the price catalogue.
 *
 * This matters more than the totals it compares. `formatSpend` can mark a total
 * "+?" and stay useful; a trend has no such half-state — the arrow points down
 * or it does not — so when the inputs are partial the honest output is no
 * percentage at all, with the reason in its place.
 */
export function spendTrend(last: SpendTotal, prev: SpendTotal): SpendTrend {
  if (last.partial || prev.partial) {
    const n = last.unpricedRows + prev.unpricedRows;
    return {
      pct: null,
      caveat:
        `No week-over-week figure: ${n === 1 ? "1 call" : `${n} calls`} across the two weeks ` +
        `used a model with no known price, so the two totals are floors and their ` +
        `difference could point either way.`,
    };
  }
  if (prev.total <= 0) {
    return {
      pct: null,
      caveat: "No week-over-week figure: the previous week recorded no spend to compare against.",
    };
  }
  return { pct: ((last.total - prev.total) / prev.total) * 100, caveat: null };
}
