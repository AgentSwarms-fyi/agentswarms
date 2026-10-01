// One rounding rule and one way to write a number, in a grid and in a table
// sheet's SQL (R200).
//
// FOUND IN R200, from R199's second probe, driven in the workbook "R200 table
// rounding": a table sheet's calculated columns said ROUND(1.005,2) = 1,
// TEXT(1.005,"0.00") = "1.00", 0.01+0.075 joined into text
// "0.08499999999999999", and PROPER("o'neil 2-way") "O'neil 2-way", where the
// grid beside it and Excel say 1.01, "1.01", "0.085" and "O'Neil 2-Way". The
// grid had its own: TRUNC(0.29,2) was 0.28.
//
// Both engines now take Excel's 15 significant digits and shift them as text
// (format.ts excelRound; compile.ts excelRoundSql), and write a number as
// text the same way (values.ts numberText; compile.ts numberTextSql). The
// sweeps below hold the SQL to the TypeScript over thousands of values.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { excelRound } from "@/lib/sheets/format";
import { numberText } from "@/lib/sheets/formula/values";
import { compileColumnFormula, type CompileContext } from "@/lib/sheets/sql/compile";

let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

const cx = {
  columns: [
    { name: "n", kind: "number" },
    { name: "d", kind: "number" },
  ],
  self: "t",
  row: "p",
  selfName: "T",
  table: () => undefined,
} as unknown as CompileContext;

/** A fixed spread of doubles: decimals with a 5 to round, sums, tiny and huge. */
function values(): number[] {
  const out: number[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let k = 0; k < 600; k++) out.push((k * 7 + 5) / 1000, -(k * 13 + 5) / 1000);
  for (let k = 0; k < 300; k++)
    out.push(Number((rand() * 10 ** Math.floor(rand() * 14)).toFixed(3)));
  for (let k = 0; k < 300; k++) out.push((rand() - 0.5) * 10 ** Math.floor(rand() * 40 - 20));
  for (let k = 1; k < 100; k++) out.push(k / 100 + (k * 3) / 1000, 0.1 * k, 1 / k);
  out.push(0, 1e15, 999999999999999.9, 1e-9, 9.99999999999999e-10, 1.5e21, 2e-10, 12345678901.005);
  return out;
}

async function sqlColumn(formula: string, rows: [number, number][]): Promise<unknown[]> {
  const { sql } = compileColumnFormula(formula, cx);
  const vals = rows.map(([n, d], i) => `(${i}, ${String(n)}::DOUBLE, ${d}::DOUBLE)`).join(", ");
  const r = await conn.runAndReadAll(
    `SELECT ${sql} AS v FROM (VALUES ${vals}) p(id, n, d) ORDER BY id`,
  );
  return r.getRowObjectsJson().map((row) => row.v);
}

beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
});
afterAll(() => conn?.closeSync());

describe("excelRound", () => {
  it("rounds the 15 digits Excel keeps, half away from zero", () => {
    expect(excelRound(2.675, 2, "half")).toBe(2.68);
    expect(excelRound(-2.675, 2, "half")).toBe(-2.68);
    expect(excelRound(1.005, 2, "half")).toBe(1.01);
    expect(excelRound(0.01 + 0.075, 2, "half")).toBe(0.09);
    expect(excelRound(12345678901.005, 2, "half")).toBe(12345678901.01);
    expect(excelRound(1234.5678, -2, "half")).toBe(1200);
    expect(excelRound(2.5, 0, "half")).toBe(3);
    expect(excelRound(-2.5, 0, "half")).toBe(-3);
  });

  it("does not round up what is below the half in 15 digits", () => {
    // The old absolute 1e-9 guard rounded this up.
    expect(excelRound(2.674999999999, 2, "half")).toBe(2.67);
    expect(excelRound(2.67499999999999, 2, "half")).toBe(2.67);
  });

  it("rounds up and down from the same digits", () => {
    expect(excelRound(0.1 + 0.2, 1, "up")).toBe(0.3);
    expect(excelRound(3.2, 0, "up")).toBe(4);
    expect(excelRound(-3.2, 0, "up")).toBe(-4);
    expect(excelRound(0.29, 2, "down")).toBe(0.29);
    expect(excelRound(4.35, 2, "down")).toBe(4.35);
    expect(excelRound(-3.9, 0, "down")).toBe(-3);
  });

  it("leaves what has nothing to round, and the non-finite, alone", () => {
    expect(excelRound(2.5, 400, "half")).toBe(2.5);
    expect(excelRound(1.5e21, 2, "half")).toBe(1.5e21);
    expect(excelRound(2.5, -400, "half")).toBe(0);
    expect(excelRound(0, 2, "up")).toBe(0);
    expect(excelRound(Number.NaN, 2, "half")).toBeNaN();
  });
});

describe("the grid", () => {
  function value(formula: string): unknown {
    const e = new WorkbookEngine([
      { id: "g", name: "G", kind: "grid", grid: { cells: { "0,0": { i: formula } } } },
    ]);
    return e.getValue("g", 0, 0);
  }

  it("truncates as Excel does: TRUNC is ROUNDDOWN", () => {
    expect(value("=TRUNC(0.29,2)")).toBe(0.29);
    expect(value("=TRUNC(4.35,2)")).toBe(4.35);
    expect(value("=TRUNC(-2.7)")).toBe(-2);
    expect(value("=ROUNDUP(0.1+0.2,1)")).toBe(0.3);
  });

  it("rounds from the 15 digits, not with a fixed allowance for noise", () => {
    // The old guard added 1e-9 after scaling and rounded this up to 2.68.
    expect(value("=ROUND(2.674999999999,2)")).toBe(2.67);
    expect(value("=ROUND(2.675,2)")).toBe(2.68);
  });
});

describe("a table sheet's SQL, against the grid's TypeScript", () => {
  const xs = values();

  it.each([
    ["ROUND", "half"],
    ["ROUNDUP", "up"],
    ["ROUNDDOWN", "down"],
    ["TRUNC", "down"],
  ] as const)("%s rounds every value as excelRound does", async (fn, mode) => {
    const rows: [number, number][] = xs.map((x, i) => [x, (i % 9) - 3]);
    const got = await sqlColumn(`=${fn}([@n],[@d])`, rows);
    const want = rows.map(([x, d]) => excelRound(x, d, mode));
    const wrong = rows
      .map(([x, d], i) => ({ x, d, sql: got[i], ts: want[i] }))
      .filter((r) => Number(r.sql) !== r.ts && !(Object.is(r.ts, -0) && Number(r.sql) === 0));
    expect(wrong).toEqual([]);
  });

  it("writes every value as text as numberText does", async () => {
    const rows: [number, number][] = xs.map((x) => [x, 0]);
    const got = await sqlColumn('=[@n]&""', rows);
    const wrong = rows
      .map(([x], i) => ({ x, sql: got[i], ts: numberText(x) }))
      .filter((r) => r.sql !== r.ts);
    expect(wrong).toEqual([]);
  });

  it("takes the same rule through a long argument, bound once by a lambda", async () => {
    // × 1 is exact; the argument is long enough that it is not written out
    // ten times but read once (compile.ts writtenOut).
    const long = "[@n]*1*1*1*1*1*1*1*1*1*1";
    expect(compileColumnFormula(`=ROUND(${long},[@d])`, cx).sql).toContain("lambda xr_a");
    expect(compileColumnFormula(`=(${long})&""`, cx).sql).toContain("lambda xt_v");
    const rows: [number, number][] = xs.slice(0, 400).map((x, i) => [x, (i % 5) - 1]);
    const rounded = await sqlColumn(`=ROUND(${long},[@d])`, rows);
    // + 0 makes -0 and 0 one value, as a cell shows them.
    expect(rounded.map((v) => Number(v) + 0)).toEqual(
      rows.map(([x, d]) => excelRound(x, d, "half") + 0),
    );
    const text = await sqlColumn(`=(${long})&""`, rows);
    expect(text).toEqual(rows.map(([x]) => numberText(x)));
  });

  it("formats TEXT with the same rounding", async () => {
    const got = await sqlColumn('=TEXT([@n],"0.00")', [
      [1.005, 0],
      [2.675, 0],
      [0.01 + 0.075, 0],
      [-2.675, 0],
    ]);
    expect(got).toEqual(["1.01", "2.68", "0.09", "-2.68"]);
  });
});
