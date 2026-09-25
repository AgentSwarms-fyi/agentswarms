// Sheets: grid formulas over table sheets. =SUMIFS(Orders[amount], …) is
// sent to the server as the function, the columns by name and the other
// arguments' values; the server writes it back as formula text and compiles
// it with the table compiler. Here: the request the engine builds, the text
// the server rebuilds, the answer DuckDB gives, and the browser-side batching.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkbookEngine, type TableResolver } from "@/lib/sheets/engine";
import { PENDING, type TableCallRequest } from "@/lib/sheets/formula/evaluate";
import { renameTableInFormula } from "@/lib/sheets/formula/shift";
import { GridTableResolver } from "@/lib/sheets/gridTableResolver";
import { compileColumnFormula } from "@/lib/sheets/sql/compile";
import { callText, tablesOf } from "@/lib/sheets/sql/tableCalls";
import { workbookTables, type TableConfig } from "@/lib/sheets/sql/tableQuery";

function engineWith(resolver: TableResolver, cells: Record<string, string>) {
  const e = new WorkbookEngine(
    [
      {
        id: "g",
        name: "Sheet1",
        kind: "grid",
        grid: { cells: Object.fromEntries(Object.entries(cells).map(([k, i]) => [k, { i }])) },
      },
      { id: "t", name: "Orders", kind: "table" },
    ],
    resolver,
  );
  e.recalcAll();
  return e;
}

describe("the engine sends table calls, not rows", () => {
  it("SUMIFS over table columns becomes one request with the criterion's value", () => {
    const seen: TableCallRequest[] = [];
    const resolver: TableResolver = {
      resolve: () => 0,
      isTable: (n) => n.toLowerCase() === "orders",
      call: (req) => {
        seen.push(req);
        return 42;
      },
    };
    const e = engineWith(resolver, {
      "0,0": "West",
      "0,1": "=SUMIFS(Orders[amount], Orders[region], A1)",
    });
    expect(e.getValue("g", 0, 1)).toBe(42);
    expect(seen.at(-1)).toEqual({
      fn: "SUMIFS",
      args: [
        { col: { table: "Orders", column: "amount" } },
        { col: { table: "Orders", column: "region" } },
        { value: "West" },
      ],
    });
    // The criterion cell is a dependency like any other.
    e.setInput("g", 0, 0, "East");
    expect(seen.at(-1)?.args[2]).toEqual({ value: "East" });
  });

  it("INDEX(MATCH()) and VLOOKUP's whole table are sent whole", () => {
    const seen: TableCallRequest[] = [];
    const resolver: TableResolver = {
      resolve: () => 0,
      isTable: (n) => n.toLowerCase() === "orders",
      call: (req) => {
        seen.push(req);
        return "x";
      },
    };
    engineWith(resolver, {
      "0,0": "=INDEX(Orders[name], MATCH(7, Orders[id], 0))",
      "1,0": "=VLOOKUP(7, Orders, 2, FALSE)",
    });
    expect(seen).toContainEqual({
      fn: "INDEX",
      args: [
        { col: { table: "Orders", column: "name" } },
        {
          call: {
            fn: "MATCH",
            args: [{ value: 7 }, { col: { table: "Orders", column: "id" } }, { value: 0 }],
          },
        },
      ],
    });
    expect(seen).toContainEqual({
      fn: "VLOOKUP",
      args: [{ value: 7 }, { table: "Orders" }, { value: 2 }, { value: false }],
    });
  });

  it("shows #BUSY! while pending, an argument's error as the answer, and a direct column read as an explanation", () => {
    const resolver: TableResolver = {
      resolve: () => ({ err: "#VALUE!", detail: "whole column" }),
      isTable: (n) => n.toLowerCase() === "orders",
      call: () => PENDING,
    };
    const e = engineWith(resolver, {
      "0,0": "=SUM(Orders[amount])",
      "1,0": "=SUMIFS(Orders[amount], Orders[region], 1/0)",
      "2,0": "=Orders[amount]",
    });
    expect(e.getValue("g", 0, 0)).toMatchObject({ err: "#BUSY!" });
    expect(e.getValue("g", 1, 0)).toMatchObject({ err: "#DIV/0!" });
    expect(e.getValue("g", 2, 0)).toMatchObject({ err: "#VALUE!" });
  });

  it("a table rename follows into formulas, VLOOKUP's table name included", () => {
    expect(
      renameTableInFormula("=SUM(Orders[amount])+VLOOKUP(1,Orders,2)", "orders", "Sales"),
    ).toBe("=SUM(Sales[amount])+VLOOKUP(1,Sales,2)");
  });
});

describe("the server rebuilds the call as text", () => {
  it("quotes values and escapes column names", () => {
    expect(
      callText({
        fn: "SUMIFS",
        args: [
          { col: { table: "Orders", column: "unit price" } },
          { col: { table: "Orders", column: "note[1]" } },
          { value: 'say "hi"' },
        ],
      }),
    ).toBe(`SUMIFS(Orders[unit price],Orders[note'[1']],"say ""hi""")`);
    expect(callText({ fn: "COUNTIF", args: [{ table: "T" }, { value: -5 }] })).toBe(
      "COUNTIF(T,(-5))",
    );
    expect(callText({ fn: "SUM", args: [{ value: null }, { value: true }] })).toBe('SUM("",TRUE)');
    expect(() => callText({ fn: "SUM); DROP", args: [] })).toThrow(/not a function name/);
    expect(
      tablesOf({ fn: "X", args: [{ col: { table: "A", column: "c" } }, { table: "b" }] }),
    ).toEqual(["a", "b"]);
  });
});

describe("and DuckDB answers it", () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("CREATE SCHEMA sales");
    await conn.run(`CREATE TABLE sales.orders AS SELECT * FROM (VALUES
      (1, 'West', 10.5), (2, 'east', 20.0), (3, 'West', NULL)) v(id, region, amount)`);
  });
  afterAll(() => conn?.closeSync());

  const orders: TableConfig = {
    source: { kind: "lakehouse", schema: "sales", table: "orders" },
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "region", type: "VARCHAR" },
      { name: "amount", type: "DOUBLE" },
    ],
    calculated: [{ name: "double", formula: "=[@amount]*2" }],
    sort: [{ column: "id", desc: true }],
    filters: [{ column: "region", op: "eq", value: "east" }],
    hidden: [],
    widths: {},
  };

  async function answer(req: TableCallRequest): Promise<unknown> {
    const tables = workbookTables((n) =>
      n.toLowerCase() === "orders" ? { name: "Orders", config: orders } : undefined,
    );
    const { sql } = compileColumnFormula(`=${callText(req)}`, {
      columns: [],
      self: "(SELECT 1)",
      row: "p",
      table: tables.resolve,
    });
    const r = await conn.runAndReadAll(`WITH ${tables.ctes.join(",\n")}\nSELECT ${sql} AS v`);
    return r.getRowObjectsJson()[0].v;
  }

  it("totals a table's column — every row, not the sheet's filtered view — including calculated columns", async () => {
    expect(
      await answer({ fn: "SUM", args: [{ col: { table: "Orders", column: "amount" } }] }),
    ).toBe(30.5);
    expect(
      await answer({ fn: "SUM", args: [{ col: { table: "Orders", column: "double" } }] }),
    ).toBe(61);
    expect(
      await answer({
        fn: "SUMIFS",
        args: [
          { col: { table: "Orders", column: "amount" } },
          { col: { table: "Orders", column: "region" } },
          { value: "west" },
        ],
      }),
    ).toBe(10.5);
  });

  it("looks a value up", async () => {
    expect(
      await answer({
        fn: "XLOOKUP",
        args: [
          { value: 2 },
          { col: { table: "Orders", column: "id" } },
          { col: { table: "Orders", column: "region" } },
        ],
      }),
    ).toBe("east");
  });
});

describe("the browser batches and forgets", () => {
  it("asks once for the calls of one recalculation and answers from the cache after", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (calls: { key: string; req: TableCallRequest }[]) =>
      Object.fromEntries(calls.map((c, i) => [c.key, { v: i + 1 }])),
    );
    const onAnswers = vi.fn();
    const r = new GridTableResolver({ isTable: () => true, fetch, onAnswers, onError: () => {} });
    const a: TableCallRequest = { fn: "SUM", args: [{ col: { table: "Orders", column: "a" } }] };
    const b: TableCallRequest = { fn: "SUM", args: [{ col: { table: "Orders", column: "b" } }] };
    expect(r.call(a)).toBe(PENDING);
    expect(r.call(b)).toBe(PENDING);
    expect(r.call(a)).toBe(PENDING);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toHaveLength(2);
    expect(onAnswers).toHaveBeenCalledWith(["orders"]);
    expect(r.call(a)).toBe(1);
    expect(r.call(b)).toBe(2);
    // The table changed: the answers are gone and asked for again.
    r.invalidate("Orders");
    expect(r.call(a)).toBe(PENDING);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("drops an answer to a question asked before the table changed", async () => {
    vi.useFakeTimers();
    let release: (v: Record<string, { v: number }>) => void = () => {};
    let n = 0;
    const fetch = vi.fn(
      (calls: { key: string }[]) =>
        new Promise<Record<string, { v: number }>>((res) => {
          n++;
          if (n === 1) release = res;
          else res(Object.fromEntries(calls.map((c) => [c.key, { v: 99 }])));
        }),
    );
    const r = new GridTableResolver({
      isTable: () => true,
      fetch,
      onAnswers: () => {},
      onError: () => {},
    });
    const a: TableCallRequest = { fn: "SUM", args: [{ col: { table: "T", column: "a" } }] };
    r.call(a);
    await vi.advanceTimersByTimeAsync(50);
    r.invalidate("T");
    release({ [JSON.stringify(a)]: { v: 1 } });
    await vi.runAllTimersAsync();
    expect(r.call(a)).toBe(99);
    vi.useRealTimers();
  });
});
