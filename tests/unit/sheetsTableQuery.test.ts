// Sheets: the SQL behind a table sheet — its source, calculated columns,
// sort, filters and pivots — run on a real DuckDB.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildTableRelation,
  describeFilter,
  lakehouseInputs,
  pageSql,
  selectAllSql,
  TableQueryError,
  valuesSql,
  type OtherTable,
  type TableConfig,
} from "@/lib/sheets/sql/tableQuery";

let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  await conn.run("CREATE SCHEMA sales");
  await conn.run(`CREATE TABLE sales.orders AS SELECT * FROM (VALUES
    (1, 'West', 'alice', 10.0, DATE '2024-01-05'),
    (2, 'east', 'bob', 20.0, DATE '2024-02-10'),
    (3, 'West', 'alice', 5.0, DATE '2024-02-11'),
    (4, 'North', NULL, 7.5, NULL),
    (5, 'East', 'carol', 2.5, DATE '2024-03-01')
  ) v(id, region, customer, amount, day)`);
});
afterAll(() => conn?.closeSync());

const orders = (over: Partial<TableConfig> = {}): TableConfig => ({
  source: { kind: "lakehouse", schema: "sales", table: "orders" },
  columns: [
    { name: "id", type: "INTEGER" },
    { name: "region", type: "VARCHAR" },
    { name: "customer", type: "VARCHAR" },
    { name: "amount", type: "DECIMAL(3,1)" },
    { name: "day", type: "DATE" },
  ],
  calculated: [],
  sort: [],
  filters: [],
  hidden: [],
  widths: {},
  ...over,
});

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
}

describe("a page of a table sheet", () => {
  it("sorts text without case, filters, and keeps the total", async () => {
    const cfg = orders({
      sort: [{ column: "region", desc: false }],
      filters: [{ column: "amount", op: "ge", value: "5" }],
    });
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const r = await rows(pageSql(rel, cfg, { offset: 0, limit: 2 }));
    expect(r.map((x) => [x.region, x.id, Number(x.__total)])).toEqual([
      ["east", 2, 4],
      ["North", 4, 4],
    ]);
    const next = await rows(pageSql(rel, cfg, { offset: 2, limit: 2 }));
    // Ties (two West rows) keep the table's own order: paging never repeats a row.
    expect(next.map((x) => x.id)).toEqual([1, 3]);
  });

  it("calculated columns chain, and one that cannot compile is empty with the reason", async () => {
    const cfg = orders({
      calculated: [
        { name: "double", formula: "=[@amount]*2" },
        { name: "share", formula: "=[@double]/SUM([double])" },
        { name: "oops", formula: "=A1+1" },
      ],
    });
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const oops = rel.columns.find((c) => c.name === "oops");
    expect(oops?.error).toMatch(/grid cells like A1/);
    const r = await rows(pageSql(rel, cfg, { offset: 0, limit: 5 }));
    expect(r.map((x) => x.double)).toEqual([20, 40, 10, 15, 5]);
    expect((r[1].share as number).toFixed(4)).toBe("0.4444");
    expect(r[0].oops).toBeNull();
  });

  it("a formula that fails on some row can be named and left empty", async () => {
    const cfg = orders({ calculated: [{ name: "bad", formula: "=[@amount]" }] });
    const rel = buildTableRelation(cfg, { name: "Orders", broken: { bad: "fails on row 4" } });
    expect(rel.columns.find((c) => c.name === "bad")?.error).toBe("fails on row 4");
    const r = await rows(pageSql(rel, cfg, { offset: 0, limit: 1 }));
    expect(r[0].bad).toBeNull();
  });

  it("the value list for a filter counts every row, under the OTHER filters", async () => {
    const cfg = orders({
      filters: [
        { column: "region", op: "in", values: ["West"] },
        { column: "amount", op: "gt", value: "6" },
      ],
    });
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const r = await rows(valuesSql(rel, cfg, "region"));
    expect(r.map((x) => [x.v, Number(x.n)])).toEqual([
      ["east", 1],
      ["North", 1],
      ["West", 1],
    ]);
    expect(describeFilter(cfg.filters[0])).toBe("region in West");
  });

  it("filters: blanks, contains (with % taken literally), dates, and bad values refused", async () => {
    const run = async (f: TableConfig["filters"]) => {
      const cfg = orders({ filters: f });
      const rel = buildTableRelation(cfg, { name: "Orders" });
      return (await rows(pageSql(rel, cfg, { offset: 0, limit: 10 }))).map((x) => x.id);
    };
    expect(await run([{ column: "customer", op: "blank" }])).toEqual([4]);
    expect(await run([{ column: "customer", op: "contains", value: "AL" }])).toEqual([1, 3]);
    expect(await run([{ column: "customer", op: "contains", value: "%" }])).toEqual([]);
    expect(await run([{ column: "day", op: "lt", value: "2024-02-11" }])).toEqual([1, 2]);
    expect(await run([{ column: "region", op: "in", values: [], blanks: false }])).toEqual([]);
    await expect(run([{ column: "amount", op: "gt", value: "lots" }])).rejects.toThrow(
      /not a number/,
    );
    await expect(run([{ column: "gone", op: "blank" }])).rejects.toThrow(TableQueryError);
  });

  it("saving leaves hidden columns out and keeps the sheet's order", async () => {
    const cfg = orders({
      hidden: ["customer", "day"],
      sort: [{ column: "amount", desc: true }],
    });
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const r = await rows(selectAllSql(rel, cfg));
    expect(Object.keys(r[0])).toEqual(["id", "region", "amount"]);
    expect(r.map((x) => x.id)).toEqual([2, 1, 4, 3, 5]);
  });
});

describe("pivots", () => {
  const book = (extra: Record<string, TableConfig>) => {
    const all = new Map<string, OtherTable>([
      ["orders", { name: "Orders", config: orders() }],
      ...Object.entries(extra).map(([n, c]) => [n.toLowerCase(), { name: n, config: c }] as const),
    ]);
    return (n: string) => all.get(n.toLowerCase());
  };

  it("groups another table sheet's rows and totals them, in key order", async () => {
    const pivot: TableConfig = {
      ...orders(),
      source: {
        kind: "pivot",
        from: "Orders",
        rows: ["customer"],
        values: [
          { column: "amount", agg: "sum" },
          { column: "id", agg: "count" },
        ],
      },
      columns: [],
    };
    const rel = buildTableRelation(pivot, { name: "ByCustomer", others: book({}) });
    expect(rel.columns.map((c) => [c.name, c.kind])).toEqual([
      ["customer", "text"],
      ["sum_amount", "number"],
      ["count_id", "number"],
    ]);
    const r = await rows(pageSql(rel, pivot, { offset: 0, limit: 10 }));
    expect(r.map((x) => [x.customer, x.sum_amount, Number(x.count_id)])).toEqual([
      ["alice", 15, 2],
      ["bob", 20, 1],
      ["carol", 2.5, 1],
      [null, 7.5, 1],
    ]);
  });

  it("with no grouping it is one row of grand totals, and a pivot of itself is refused", async () => {
    const total: TableConfig = {
      ...orders(),
      source: {
        kind: "pivot",
        from: "Orders",
        rows: [],
        values: [{ column: "amount", agg: "max" }],
      },
    };
    const rel = buildTableRelation(total, { name: "Totals", others: book({}) });
    const first = (await rows(pageSql(rel, total, { offset: 0, limit: 5 })))[0];
    expect(Number(first.max_amount)).toBe(20);
    const self: TableConfig = {
      ...orders(),
      source: { kind: "pivot", from: "Loop", rows: [], values: [{ column: "id", agg: "count" }] },
    };
    expect(() => buildTableRelation(self, { name: "Loop", others: book({ Loop: self }) })).toThrow(
      /circle/,
    );
  });

  it("names the lakehouse tables it reads, through pivots and lookups", () => {
    const customers: TableConfig = {
      ...orders(),
      source: { kind: "lakehouse", schema: "crm", table: "customers" },
    };
    const pivot: TableConfig = {
      ...orders(),
      source: {
        kind: "pivot",
        from: "Orders",
        rows: ["region"],
        values: [{ column: "id", agg: "count" }],
      },
      calculated: [
        { name: "tier", formula: '=XLOOKUP([@region], Customers[id], Customers[tier], "")' },
      ],
    };
    expect(lakehouseInputs(pivot, book({ Customers: customers })).sort()).toEqual([
      "crm.customers",
      "sales.orders",
    ]);
  });
});
