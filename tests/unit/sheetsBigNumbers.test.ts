// Numbers at the edges of what Excel shows: eleven whole digits, past 15
// digits, and a quotient a hair from a whole number (R201).
//
// FOUND IN R201, driven in the workbook "R201 big numbers": a table sheet
// showed 12345678901.005 as "1.234567890e+1" (about 12) and the grid as ####;
// CEILING(0.0000000001,1) and CEILING(5.0000000001,1) were 0 and 5 in both a
// grid and a table, where Excel says 1 and 6; the grid's
// CEILING(12345678901.005,1) was …901; TEXT(1.5E+21,"0") was "1" in the grid;
// and TEXT(12345678901234567,"#,##0") ended …568 in both, where Excel shows
// 15 digits and zeros, …600.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { excelFixed, formatValue } from "@/lib/sheets/format";
import { formatGeneral } from "@/lib/sheets/formula/values";
import { compileColumnFormula, type CompileContext } from "@/lib/sheets/sql/compile";

/** 12345678901234567 as stored: the nearest double, which ends in 8. */
const LONG = 12345678901234568;

let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

const cx = {
  columns: [
    { name: "n", kind: "number" },
    { name: "s", kind: "number" },
  ],
  self: "t",
  row: "p",
  selfName: "T",
  table: () => undefined,
} as unknown as CompileContext;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
});
afterAll(() => conn?.closeSync());

function value(formula: string): unknown {
  const e = new WorkbookEngine([
    { id: "g", name: "G", kind: "grid", grid: { cells: { "0,0": { i: formula } } } },
  ]);
  return e.getValue("g", 0, 0);
}

/** A fixed spread: quotients near whole numbers, amounts with cents, tiny and huge. */
function values(): number[] {
  const out: number[] = [];
  let seed = 11;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let k = 1; k < 200; k++) out.push(k / 10, (k * 5) / 100, -(k * 3) / 10, k * 0.1 * 3);
  for (let k = 0; k < 200; k++)
    out.push(Number((rand() * 10 ** Math.floor(rand() * 13)).toFixed(3)));
  for (let k = 0; k < 200; k++) out.push((rand() - 0.5) * 10 ** Math.floor(rand() * 44 - 22));
  out.push(1e-10, 5.0000000001, 12345678901.005, 1.5e21, LONG, -1.5e21, 0);
  return out;
}

async function sqlColumn(formula: string, rows: [number, number][]): Promise<unknown[]> {
  const { sql } = compileColumnFormula(formula, cx);
  const vals = rows.map(([n, s], i) => `(${i}, ${String(n)}::DOUBLE, ${s}::DOUBLE)`).join(", ");
  const r = await conn.runAndReadAll(
    `SELECT ${sql} AS v FROM (VALUES ${vals}) p(id, n, s) ORDER BY id`,
  );
  return r.getRowObjectsJson().map((row) => row.v);
}

describe("General, as a cell and a table column show a number", () => {
  it("writes eleven whole digits out, as an eleven-digit whole number is", () => {
    expect(formatGeneral(12345678901.005)).toBe("12345678901");
    expect(formatGeneral(-12345678901.5)).toBe("-12345678902");
    expect(formatGeneral(12345678901)).toBe("12345678901");
    expect(formatGeneral(1234567890.5)).toBe("1234567891");
  });

  it("goes to scientific where toPrecision would, never with a cut exponent", () => {
    expect(formatGeneral(1.5e-7)).toBe("1.5E-07");
    expect(formatGeneral(2.5e-8)).toBe("2.5E-08");
    expect(formatGeneral(99999999999.5)).toBe("1E+11");
    expect(formatGeneral(123456789012.5)).toBe("1.23457E+11");
    expect(formatGeneral(1e-10)).toBe("1E-10");
    expect(formatGeneral(0.000001)).toBe("0.000001");
    expect(formatGeneral(0.5)).toBe("0.5");
  });
});

describe("number formats past 15 digits", () => {
  it("show 15 digits and then zeros, as Excel does", () => {
    expect(excelFixed(LONG, 0)).toBe("12345678901234600");
    expect(excelFixed(123456789012345.67, 2)).toBe("123456789012346.00");
    expect(excelFixed(-1.5e21, 0)).toBe("-1500000000000000000000");
    expect(formatValue(LONG, "#,##0")).toBe("12,345,678,901,234,600");
    expect(value('=TEXT(1.5E+21,"0")')).toBe("1500000000000000000000");
  });
});

describe("CEILING and FLOOR read the quotient at 15 digits", () => {
  it("in the grid", () => {
    expect(value("=CEILING(0.0000000001,1)")).toBe(1);
    expect(value("=CEILING(5.0000000001,1)")).toBe(6);
    expect(value("=CEILING(12345678901.005,1)")).toBe(12345678902);
    expect(value("=CEILING.MATH(5.0000000001)")).toBe(6);
    // R176's cases still hold: the quotient a hair under a whole number.
    expect(value("=FLOOR(0.3,0.1)")).toBe(0.3);
    expect(value("=FLOOR(4.35,0.05)")).toBe(4.35);
  });

  it("in a table sheet, as the grid does, over every value", async () => {
    const steps = [1, 0.1, 0.05, 0.01, 3];
    const rows: [number, number][] = values().map((n, i) => [n, steps[i % steps.length]]);
    const ref = (n: number, s: number, up: boolean) => {
      const q = Number((n / s).toPrecision(15));
      return (up ? Math.ceil(q) : Math.floor(q)) * s;
    };
    const same = (a: unknown, b: number) =>
      Number(Number(a).toPrecision(15)) === Number(b.toPrecision(15));
    for (const [fn, up] of [
      ["CEILING", true],
      ["FLOOR", false],
    ] as const) {
      const got = await sqlColumn(`=${fn}([@n],[@s])`, rows);
      expect(got).toHaveLength(rows.length);
      const want = rows.map(([n, s]) => ref(n, s, up));
      const wrong = got.map((g, i) => ({ g, w: want[i] })).filter((r) => !same(r.g, r.w));
      expect(wrong).toEqual([]);
    }
    // The cases found in the UI are among the rows, and come out as Excel's.
    const found = await sqlColumn("=CEILING([@n],[@s])", [
      [1e-10, 1],
      [5.0000000001, 1],
      [12345678901.005, 1],
    ]);
    expect(found.map(Number)).toEqual([1, 6, 12345678902]);
  });
});

describe("TEXT in a table sheet, as the grid formats", () => {
  it.each(["0", "0.00", "#,##0", "#,##0.00"])("writes %s as the grid does", async (code) => {
    const rows: [number, number][] = values()
      .filter((n) => Math.abs(n) < 1e38)
      .map((n) => [n, 0]);
    const got = await sqlColumn(`=TEXT([@n],"${code}")`, rows);
    // Some rows are past 15 digits, so the 15-digit path is held too.
    expect(rows.filter(([n]) => Math.abs(n) >= 1e15).length).toBeGreaterThan(10);
    const wrong = rows
      .map(([n], i) => ({ n, sql: got[i], grid: formatValue(n, code) }))
      .filter((r) => r.sql !== r.grid);
    expect(wrong).toEqual([]);
  });
});
