// Excel's 1900 date system in a grid and a table sheet (R205).
//
// FOUND IN R205, driven in the workbook "R205 1900 dates": YEAR, MONTH and
// DAY of a blank cell were 1899, 12 and 30 (Excel: 1900, 1, 0);
// TEXT(1,"yyyy-mm-dd") was 1899-12-31 (Excel: 1900-01-01);
// DATE(1900,3,1)-DATE(1900,2,28) was 1 (Excel: 2, across its 1900-02-29);
// DATEDIF over that pair was 0 (Excel: 2). Every serial counted from
// 1899-12-30, which is Excel's count only from 1900-03-01 (serial 61).
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { dateSerial, serialParts } from "@/lib/sheets/formula/values";
import { compileColumnFormula, type CompileContext } from "@/lib/sheets/sql/compile";

function value(formula: string): unknown {
  const e = new WorkbookEngine([
    { id: "g", name: "G", kind: "grid", grid: { cells: { "0,0": { i: formula } } } },
  ]);
  return e.getValue("g", 0, 0);
}

describe("serials", () => {
  it("count as Excel counts, its 1900-02-29 included", () => {
    expect(dateSerial(1900, 1, 1)).toBe(1);
    expect(dateSerial(1900, 2, 28)).toBe(59);
    expect(dateSerial(1900, 2, 29)).toBe(60);
    expect(dateSerial(1900, 3, 1)).toBe(61);
    expect(dateSerial(2024, 1, 1)).toBe(45292);
    expect(dateSerial(1900, 1, 1, 12)).toBe(1.5);
  });

  it("read back the same way, serial 0 as 1900-01-00", () => {
    const ymd = (s: number) => {
      const p = serialParts(s);
      return [p.y, p.m, p.d, p.dow];
    };
    expect(ymd(0)).toEqual([1900, 1, 0, 6]);
    expect(ymd(1)).toEqual([1900, 1, 1, 0]);
    expect(ymd(59)).toEqual([1900, 2, 28, 2]);
    expect(ymd(60)).toEqual([1900, 2, 29, 3]);
    expect(ymd(61)).toEqual([1900, 3, 1, 4]);
    expect(ymd(45292)).toEqual([2024, 1, 1, 1]);
    expect(serialParts(1.5).h).toBe(12);
    for (let s = 1; s < 400; s++) {
      const p = serialParts(s);
      expect(dateSerial(p.y, p.m, p.d)).toBe(s);
    }
  });
});

describe("the grid", () => {
  it("answers as Excel does around 1900-02-29 and for a blank", () => {
    expect(value("=YEAR(Z9)")).toBe(1900);
    expect(value("=MONTH(Z9)")).toBe(1);
    expect(value("=DAY(Z9)")).toBe(0);
    expect(value('=TEXT(1,"yyyy-mm-dd")')).toBe("1900-01-01");
    expect(value('=TEXT(60,"yyyy-mm-dd")')).toBe("1900-02-29");
    expect(value("=DATE(1900,3,1)-DATE(1900,2,28)")).toBe(2);
    expect(value('=DATEDIF(DATE(1900,2,28),DATE(1900,3,1),"d")')).toBe(2);
    expect(value('=DATEDIF(DATE(1900,3,1),DATE(1900,3,2),"d")')).toBe(1);
    expect(value("=WEEKDAY(60)")).toBe(4);
    // A start after the end is #NUM!; the calendar units still go to formula.js.
    expect(value('=ISERROR(DATEDIF(DATE(2024,3,1),DATE(2024,2,28),"D"))')).toBe(true);
    expect(value('=DATEDIF(DATE(2024,1,31),DATE(2024,3,1),"m")')).toBe(1);
    // Later dates are as they were.
    expect(value('=DATEDIF(DATE(2024,2,28),DATE(2024,3,1),"d")')).toBe(2);
    expect(value("=DATE(2024,1,1)*1")).toBe(45292);
  });
});

describe("a table sheet", () => {
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  const cx = {
    columns: [
      { name: "d", kind: "date" },
      { name: "n", kind: "number" },
    ],
    self: "t",
    row: "p",
    selfName: "T",
    table: () => undefined,
  } as unknown as CompileContext;

  beforeAll(async () => {
    conn = await (await DuckDBInstance.create(":memory:")).connect();
  });
  afterAll(() => conn?.closeSync());

  async function column(formula: string): Promise<unknown[]> {
    const { sql } = compileColumnFormula(formula, cx);
    const r = await conn.runAndReadAll(
      `SELECT ${sql} AS v FROM (VALUES (1, DATE '1900-01-01', 1::DOUBLE), (2, DATE '1900-02-28', 59), (3, DATE '1900-03-01', 61), (4, DATE '2024-01-01', 45292)) p(id, d, n) ORDER BY id`,
    );
    return r.getRowObjectsJson().map((row) => row.v);
  }

  it("counts a date as the grid does", async () => {
    expect((await column("=[@d]*1")).map(Number)).toEqual([1, 59, 61, 45292]);
  });

  it("reads a serial as the grid does", async () => {
    expect(await column('=TEXT([@n],"yyyy-mm-dd")')).toEqual([
      "1900-01-01",
      "1900-02-28",
      "1900-03-01",
      "2024-01-01",
    ]);
  });
});
