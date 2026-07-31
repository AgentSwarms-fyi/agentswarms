// Deterministic datasets for the differential harness.
//
// Chosen for the values that make SQL engines disagree, not for realism:
// NULL vs empty string, numbers stored as strings, negatives and zero,
// duplicate join keys, a row whose join key matches nothing, unicode, and a
// date column stored as text (which is how this app stores dates).
import type { LoadedTable } from "@/utils/tools/sql.server";

export const orders: LoadedTable = {
  name: "orders",
  columns: [
    { name: "id", type: "number" },
    { name: "customer_id", type: "number" },
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
    { name: "day", type: "date" },
  ],
  rows: [
    { id: 1, customer_id: 1, region: "EMEA", amount: 100, day: "2026-01-15" },
    { id: 2, customer_id: 1, region: "EMEA", amount: 250.5, day: "2026-02-01" },
    { id: 3, customer_id: 2, region: "APAC", amount: 0, day: "2026-02-14" },
    { id: 4, customer_id: 2, region: "APAC", amount: -40, day: "2026-03-02" },
    { id: 5, customer_id: 3, region: null, amount: 75, day: "2026-03-19" },
    { id: 6, customer_id: 3, region: "", amount: null, day: "2026-04-01" },
    { id: 7, customer_id: 99, region: "AMER", amount: 310, day: "2026-04-20" },
    { id: 8, customer_id: 1, region: "AMER", amount: 310, day: "2026-05-05" },
    { id: 9, customer_id: 4, region: "Zürich", amount: 12.25, day: "2026-05-30" },
  ],
};

export const customers: LoadedTable = {
  name: "customers",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
    { name: "tier", type: "string" },
  ],
  rows: [
    { id: 1, name: "Acme", tier: "gold" },
    { id: 2, name: "Beta", tier: "silver" },
    { id: 3, name: "Gamma", tier: "gold" },
    { id: 4, name: "Zürich GmbH", tier: null },
  ],
};

/** Numbers arriving as strings — the shape a CSV upload actually produces
 *  before coercion, and a classic source of engine disagreement. */
export const loose: LoadedTable = {
  name: "loose",
  columns: [
    { name: "k", type: "string" },
    { name: "n", type: "number" },
  ],
  rows: [
    { k: "a", n: "10" },
    { k: "b", n: "2" },
    { k: "c", n: 3 },
  ],
};

export const ALL_TABLES: LoadedTable[] = [orders, customers, loose];

/** Fresh deep copies — an engine that mutates its input must not poison the
 *  next engine's run, which would turn a real bug into a passing test. */
export function freshTables(): LoadedTable[] {
  return ALL_TABLES.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({ ...c })),
    rows: t.rows.map((r) => ({ ...r })),
  }));
}
