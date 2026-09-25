// Sheets: a grid range saved to the lakehouse. The first row names the
// columns, each column gets the type its values share, and the values are
// what the sheet computed.
import { describe, expect, it } from "vitest";

import { WorkbookEngine, type SheetDef } from "@/lib/sheets/engine";
import { columnIdentifier, exportRows, inferType, rangeToTable } from "@/lib/sheets/export";
import { suggestTableName } from "@/lib/sheets/names";

function sheet(cells: Record<string, { i: string; f?: string }>): WorkbookEngine {
  const def: SheetDef = { id: "s1", name: "Sheet1", kind: "grid", grid: { cells } };
  const e = new WorkbookEngine([def]);
  e.recalcAll();
  return e;
}

const getter = (e: WorkbookEngine) => (r: number, c: number) => ({
  v: e.getValue("s1", r, c),
  input: e.getInput("s1", r, c),
});

describe("column names", () => {
  it("turns headers into identifiers and keeps them unique", () => {
    const taken = new Set<string>();
    expect(columnIdentifier("Unit Price ($)", 0, taken)).toBe("unit_price");
    expect(columnIdentifier("unit price", 1, taken)).toBe("unit_price_2");
    expect(columnIdentifier("", 2, taken)).toBe("column_3");
    expect(columnIdentifier("2024 Sales", 3, taken)).toBe("c_2024_sales");
    expect(columnIdentifier("Région", 4, taken)).toBe("r_gion");
  });

  it("suggests a sheet name formulas can use", () => {
    expect(suggestTableName("sales_orders_2024", new Set())).toBe("SalesOrders2024");
    expect(suggestTableName("orders", new Set(["orders"]))).toBe("Orders2");
    expect(suggestTableName("a1", new Set())).toBe("A1_");
  });
});

describe("types", () => {
  const v = (x: number | string | boolean | null, f?: string) => ({
    v: x,
    input: f ? { i: String(x), f } : undefined,
  });

  it("whole numbers, decimals, booleans, and text when they are mixed", () => {
    expect(inferType([v(1), v(2), v(null)])).toBe("BIGINT");
    expect(inferType([v(1), v(2.5)])).toBe("DOUBLE");
    expect(inferType([v(true), v(false)])).toBe("BOOLEAN");
    expect(inferType([v(1), v("x")])).toBe("VARCHAR");
    expect(inferType([v(null)])).toBe("VARCHAR");
  });

  it("numbers shown as dates are dates, with a time when they have one", () => {
    expect(inferType([v(45321, "yyyy-mm-dd")])).toBe("DATE");
    expect(inferType([v(45321.5, "yyyy-mm-dd hh:mm")])).toBe("TIMESTAMP");
    expect(inferType([v(45321, "yyyy-mm-dd"), v(12)])).toBe("BIGINT");
  });
});

describe("a range as a table", () => {
  it("reads computed values, typed dates and skips empty rows", () => {
    const e = sheet({
      "0,0": { i: "Region" },
      "0,1": { i: "Amount" },
      "0,2": { i: "Day" },
      "0,3": { i: "Double" },
      "1,0": { i: "West" },
      "1,1": { i: "10.5" },
      "1,2": { i: "=DATE(2024,1,31)" },
      "1,3": { i: "=B2*2" },
      "2,0": { i: "East" },
      "2,1": { i: "20" },
      "2,2": { i: "2024-02-15", f: "yyyy-mm-dd" },
      "2,3": { i: "=B3*2" },
    });
    const range = { r0: 0, c0: 0, r1: 5, c1: 3 };
    const t = rangeToTable(range, getter(e));
    expect(t.columns).toEqual([
      { header: "Region", name: "region", type: "VARCHAR" },
      { header: "Amount", name: "amount", type: "DOUBLE" },
      { header: "Day", name: "day", type: "DATE" },
      // 21 and 40: whole numbers, so whole-number storage.
      { header: "Double", name: "double", type: "BIGINT" },
    ]);
    expect(t.rows).toEqual([
      ["West", 10.5, "2024-01-31", 21],
      ["East", 20, "2024-02-15", 40],
    ]);
  });

  it("a column typed as text keeps what the cell shows; one that does not fit is blank", () => {
    const e = sheet({
      "0,0": { i: "Pct" },
      "1,0": { i: "0.125", f: "0.0%" },
      "2,0": { i: "=1/0" },
    });
    const range = { r0: 0, c0: 0, r1: 2, c1: 0 };
    expect(exportRows(range, getter(e), [{ type: "VARCHAR" }])).toEqual([["12.5%"]]);
    expect(exportRows(range, getter(e), [{ type: "BOOLEAN" }])).toEqual([]);
  });
});
