// One formula, one row: a grid sheet and a table sheet give the same answer
// (R198).
//
// FOUND IN R198, sweep 4 ("two surfaces, two answers"). A grid sheet runs a
// formula in the browser's engine; a table sheet's calculated column compiles
// the same Excel to DuckDB SQL. A probe ran 75 formulas over the same seven
// rows both ways. Among what it found, in the workbook "R198 blanks": with
// bob's amount blank, the grid said "bob: " and AVERAGE(B2,1) = 1 (as Excel
// does) and the table sheet said "bob: 0" and 0.5 — the compiler read a blank
// as 0 outside arithmetic too.
//
// This test keeps the probe: every formula below must agree row by row, on a
// real DuckDB. A formula leaves the list only for a difference the docs
// state (a table column has no error values; text cannot be blank) or one
// queued in ADVERSARIAL_QUEUE with its reason.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { isError } from "@/lib/sheets/formula/values";
import { compileColumnFormula, type CompileContext } from "@/lib/sheets/sql/compile";

const ROWS: { n: number | null; s: string | null }[] = [
  { n: 2.5, s: "  a   b  " },
  { n: -2.5, s: "Abc" },
  { n: 2.675, s: "x" },
  { n: null, s: null },
  { n: 0, s: "hello world" },
  { n: 1234567.891, s: "ecole" },
  { n: -0.5, s: "abc" },
];

/** Formulas the two engines must answer alike on every row. */
const AGREE = [
  // a blank in text is "" (R198)
  '=[@s]&": "&[@n]',
  "=CONCAT([@s],[@n])",
  '=TEXTJOIN("-",TRUE,[@s],[@n])',
  '=TEXTJOIN("-",FALSE,[@s],[@n])',
  '=[@n]&""',
  "=LEN([@n])",
  // a blank reference is ignored by MIN, MAX and AVERAGE (R198)
  "=AVERAGE([@n],1)",
  "=AVERAGE([@n],[@s],1)",
  "=MIN([@n],1)",
  "=MAX([@n],-1)",
  "=MIN([@n])",
  "=MAX([@n])",
  "=SUM([@n],1)",
  // arithmetic reads a blank as 0, as Excel does
  "=[@n]*2+1",
  "=ROUND([@n],0)",
  "=ROUND([@n],2)",
  "=ROUNDUP([@n],0)",
  "=ROUNDDOWN([@n],0)",
  "=INT([@n])",
  "=TRUNC([@n])",
  "=MOD([@n],2)",
  "=ABS([@n])",
  "=SIGN([@n])",
  "=CEILING([@n],1)",
  "=FLOOR([@n],1)",
  "=POWER([@n],2)",
  "=TRIM([@s])",
  "=LEN([@s])",
  "=LOWER([@s])",
  "=LEFT([@s],2)",
  "=RIGHT([@s],2)",
  "=MID([@s],2,2)",
  '=SUBSTITUTE([@s],"a","x")',
  '=EXACT([@s],"Abc")',
  '=[@s]="abc"',
  '=REPT("x",2)',
  '=IF([@n]>1,"hi","lo")',
  "=ISBLANK([@n])",
  "=ISNUMBER([@n])",
  "=AND([@n]>0,[@n]<3)",
];

let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

const cx = {
  columns: [
    { name: "n", kind: "number" },
    { name: "s", kind: "text" },
  ],
  self: "t",
  row: "p",
  selfName: "T",
  table: () => undefined,
} as unknown as CompileContext;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  const lit = (v: string | number | null) =>
    v === null ? "NULL" : typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);
  const values = ROWS.map((r, i) => `(${i}, ${lit(r.n)}::DOUBLE, ${lit(r.s)}::VARCHAR)`).join(", ");
  await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES ${values}) v(id, n, s)`);
});
afterAll(() => conn?.closeSync());

/** A value as a person reads it, the same for both engines. */
function shown(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  if (isError(v)) return "(error)";
  if (typeof v === "number") return String(Math.round(v * 1e9) / 1e9);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

async function table(formula: string): Promise<string[]> {
  const { sql } = compileColumnFormula(formula, cx);
  const r = await conn.runAndReadAll(`SELECT p.id, ${sql} AS v FROM t p ORDER BY p.id`);
  return r.getRowObjectsJson().map((row) => shown(row.v));
}

function grid(formula: string): string[] {
  const cells: Record<string, { i: string }> = {};
  ROWS.forEach((r, i) => {
    if (r.n !== null) cells[`${i},0`] = { i: String(r.n) };
    if (r.s !== null) cells[`${i},1`] = { i: `'${r.s}` };
    cells[`${i},2`] = {
      i: formula.replace(/\[@(n|s)\]/g, (_m, c: string) => `${c === "n" ? "A" : "B"}${i + 1}`),
    };
  });
  const e = new WorkbookEngine([{ id: "g", name: "G", kind: "grid", grid: { cells } }]);
  return ROWS.map((_r, i) => shown(e.getValue("g", i, 2)));
}

describe("a grid sheet and a table sheet", () => {
  it.each(AGREE)("agree on %s, row by row", async (formula) => {
    expect(await table(formula)).toEqual(grid(formula));
  });

  it("show the blank row as Excel does, in the case R198 found in the UI", async () => {
    expect((await table('=[@s]&": "&[@n]'))[3]).toBe(": ");
    expect((await table("=AVERAGE([@n],1)"))[3]).toBe("1");
    expect((await table("=MIN([@n],1)"))[3]).toBe("1");
  });

  it("say #NUM! for MROUND with signs that differ, as Excel does", async () => {
    // NaN is what a table cell shows as #NUM! (values.ts), as for (-2.5)^0.5.
    const { sql } = compileColumnFormula("=MROUND([@n],0.5)", cx);
    const r = await conn.runAndReadAll(`SELECT isnan(${sql}) AS bad FROM t p ORDER BY p.id`);
    const bad = r.getRowObjectsJson().map((row) => row.bad);
    expect(bad).toEqual([false, true, false, false, false, false, true]);
    expect(grid("=MROUND([@n],0.5)")[1]).toBe("(error)");
  });
});
