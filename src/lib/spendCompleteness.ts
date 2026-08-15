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
