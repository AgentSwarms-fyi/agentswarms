// Rounding to a multiple, GCD and LCM, and the base conversions, as Excel
// computes them (R176). Before: FLOOR(0.3,0.1) was 0.2 and FLOOR(4.35,0.05)
// 4.3 (the quotient landed a hair under a whole number); FLOOR(2.5,-2) was 4
// and CEILING(2.5,-2) 2 where Excel gives #NUM!; GCD(12.5,5) was 2.5 and
// LCM(4.9,6.2) 30.38 (Excel truncates: 1 and 12); GCD(-4,6) 2 (Excel #NUM!);
// DEC2HEX(255) was "ff"; HEX2BIN, BIN2HEX, OCT2HEX and DEC2OCT were #NAME?.

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { compileColumnFormula, type CompileContext } from "@/lib/sheets/sql/compile";

function at(formula: string): unknown {
  const grid: GridData = { cells: { "5,5": { i: formula } } };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  return e.getValue("s", 5, 5);
}

describe("FLOOR and CEILING to a multiple", () => {
  it("land on the multiple a decimal step names", () => {
    expect(at("=FLOOR(0.3,0.1)")).toBe(0.3);
    expect(at("=FLOOR(2.3,0.1)")).toBe(2.3);
    expect(at("=FLOOR(4.35,0.05)")).toBe(4.35);
    expect(at("=CEILING(1.1,0.1)")).toBe(1.1);
    expect(at("=CEILING(4.36,0.05)")).toBe(4.4);
    expect(at("=FLOOR(4.36,0.05)")).toBe(4.35);
    expect(at("=CEILING(10,3)")).toBe(12);
    expect(at("=FLOOR(10,3)")).toBe(9);
  });
  it("follow Excel's signs: #NUM! for a positive number with a negative step", () => {
    expect(at("=CEILING(2.5,-2)")).toMatchObject({ err: "#NUM!" });
    expect(at("=FLOOR(2.5,-2)")).toMatchObject({ err: "#NUM!" });
    expect(at("=CEILING(-2.5,2)")).toBe(-2);
    expect(at("=CEILING(-2.5,-2)")).toBe(-4);
    expect(at("=FLOOR(-2.5,2)")).toBe(-4);
    expect(at("=FLOOR(-2.5,-2)")).toBe(-2);
    expect(at("=CEILING(2.5,0)")).toBe(0);
    expect(at("=FLOOR(2.5,0)")).toMatchObject({ err: "#DIV/0!" });
  });
  it("CEILING.MATH and FLOOR.MATH: the step's sign ignored, the mode turns negatives", () => {
    expect(at("=FLOOR.MATH(0.3,0.1)")).toBe(0.3);
    expect(at("=CEILING.MATH(2.5,-2)")).toBe(4);
    expect(at("=CEILING.MATH(-5.5)")).toBe(-5);
    expect(at("=CEILING.MATH(-5.5,2,-1)")).toBe(-6);
    expect(at("=FLOOR.MATH(-5.5)")).toBe(-6);
    expect(at("=FLOOR.MATH(-5.5,2,-1)")).toBe(-4);
    expect(at("=FLOOR.MATH(24.3,5)")).toBe(20);
    // The mode turns only negative numbers.
    expect(at("=CEILING.MATH(5.5,2,-1)")).toBe(6);
    expect(at("=FLOOR.MATH(5.5,2,-1)")).toBe(4);
  });
});

describe("GCD and LCM", () => {
  it("truncate to whole numbers, and refuse negatives", () => {
    expect(at("=GCD(12.5,5)")).toBe(1);
    expect(at("=LCM(4.9,6.2)")).toBe(12);
    expect(at("=GCD(24,36,60)")).toBe(12);
    expect(at("=LCM(4,6,10)")).toBe(60);
    expect(at("=GCD(-4,6)")).toMatchObject({ err: "#NUM!" });
    expect(at("=LCM(0,6)")).toBe(0);
    expect(at("=GCD(0,0)")).toBe(0);
    expect(at("=LCM(0,0)")).toBe(0);
    expect(at("=GCD({12,18})")).toBe(6);
  });
});

describe("base conversions", () => {
  it("write hexadecimal in capitals", () => {
    expect(at("=DEC2HEX(255)")).toBe("FF");
    expect(at("=DEC2HEX(255,4)")).toBe("00FF");
    expect(at("=DEC2HEX(-1)")).toBe("FFFFFFFFFF");
    expect(at("=BASE(255,16)")).toBe("FF");
    expect(at("=BASE(35,36)")).toBe("Z");
  });
  it("include the octal and the direct binary-hex ones", () => {
    expect(at("=DEC2OCT(8)")).toBe("10");
    expect(at('=OCT2DEC("17")')).toBe(15);
    expect(at('=HEX2BIN("F")')).toBe("1111");
    expect(at('=BIN2HEX("11111111")')).toBe("FF");
    expect(at('=OCT2HEX("17")')).toBe("F");
    expect(at('=HEX2OCT("FF")')).toBe("377");
    expect(at('=BIN2OCT("1111")')).toBe("17");
    expect(at('=OCT2BIN("17")')).toBe("1111");
  });
});

describe("in a table sheet's column", () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  const cx: CompileContext = {
    columns: [{ name: "id", kind: "number" }],
    self: "t",
    row: "p",
    selfName: "T",
    table: () => undefined,
  };
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("CREATE TABLE t AS SELECT 1 AS id");
  });
  afterAll(() => conn?.closeSync());
  const value = async (formula: string) => {
    const { sql } = compileColumnFormula(formula, cx);
    const r = await conn.runAndReadAll(`SELECT ${sql} AS v FROM t p`);
    return Number(r.getRowObjectsJson()[0].v);
  };
  it("FLOOR and CEILING land on the multiple too", async () => {
    expect(await value("=FLOOR(0.3,0.1)")).toBeCloseTo(0.3, 12);
    expect(await value("=FLOOR(4.35,0.05)")).toBeCloseTo(4.35, 12);
    expect(await value("=CEILING(1.1,0.1)")).toBeCloseTo(1.1, 12);
    expect(await value("=CEILING.MATH(2.5,-2)")).toBe(4);
  });
});
