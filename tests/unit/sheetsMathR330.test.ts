// Math and engineering functions Excel has (R330).
//
// FOUND IN R329's inventory: these were #NAME?. formula.js has most of them,
// but its ISO.CEILING was wrong in 4 of the 6 cases on Excel's page, its
// ERF(lower, upper) ignored the lower limit (ERF(0,1) was about 0), its
// ERFC(5) was right to 5 digits, and its BESSELJ took a negative order and
// did not truncate a fractional one. Every value below is from the
// function's page in Excel's documentation unless it says otherwise.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { erf, erfc, FUNCTIONS, LIFTS } from "@/lib/sheets/formula/functions";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import type { Value } from "@/lib/sheets/formula/values";
import { toFileFormula } from "@/lib/sheets/xlsx";

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells: {} } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const close = (got: unknown, want: unknown, digits = 8) => {
  if (typeof want === "number") {
    expect(typeof got, String(got)).toBe("number");
    expect(got as number).toBeCloseTo(want, digits);
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got), JSON.stringify(got)).toBe(true);
    (want as unknown[]).forEach((w, i) => close((got as unknown[])[i], w, digits));
  } else expect(got).toEqual(want);
};

const NEW = [
  ...["ACOSH", "ASINH", "ATANH", "ACOT", "ACOTH", "COT", "COTH", "CSC", "CSCH", "SEC", "SECH"],
  ...["FACTDOUBLE", "MULTINOMIAL", "SERIESSUM", "SQRTPI", "CEILING.PRECISE", "FLOOR.PRECISE"],
  ...["ISO.CEILING", "DELTA", "GESTEP", "ERF", "ERF.PRECISE", "ERFC", "ERFC.PRECISE", "MUNIT"],
  ...["BESSELI", "BESSELJ", "BESSELK", "BESSELY", "MDETERM", "MINVERSE"],
];

describe("each is known, has help, and goes into a file as Excel names it", () => {
  it.each(NEW)("%s", (name) => {
    expect(FUNCTIONS[name]).toBeTypeOf("function");
    expect(FUNCTION_HELP[name]?.sig).toMatch(new RegExp(`^${name.replace(".", "\\.")}\\(`));
  });
  it("with _xlfn. on the ones Excel added after 2007", () => {
    expect(toFileFormula("=COT(1)+ERF.PRECISE(1)+SUM(MUNIT(2))+ISO.CEILING(1)")).toBe(
      "_xlfn.COT(1)+_xlfn.ERF.PRECISE(1)+SUM(_xlfn.MUNIT(2))+ISO.CEILING(1)",
    );
  });
});

describe("trigonometry", () => {
  it.each([
    ["=ACOSH(1)", 0],
    ["=ACOSH(10)", 2.993222846],
    ["=ASINH(-2.5)", -1.647231146],
    ["=ASINH(10)", 2.99822295],
    ["=ATANH(0.76159416)", 1.00000001],
    ["=ATANH(-0.1)", -0.100335348],
    ["=ACOT(2)", 0.463647609],
    // ACOT is in 0 to π.
    ["=ACOT(-2)", 2.677945045],
    ["=ACOTH(6)", 0.168236118],
    ["=COT(30)", -0.156119952],
    ["=COT(45)", 0.617369624],
    ["=COTH(2)", 1.037314721],
    ["=CSC(15)", 1.537780562],
    ["=CSCH(1.5)", 0.469642441],
    ["=SEC(45)", 1.903594407],
    ["=SECH(45)", 5.72504e-20],
  ])("%s is %s", (f, want) => {
    close(at(f), want);
  });

  it.each([
    ["=ACOSH(0.5)", "#NUM!"],
    ["=ATANH(1)", "#NUM!"],
    ["=ACOTH(0.5)", "#NUM!"],
    ["=COT(0)", "#DIV/0!"],
    ["=CSC(0)", "#DIV/0!"],
    ["=COTH(0)", "#DIV/0!"],
    ["=CSCH(0)", "#DIV/0!"],
    ["=COT(2^27)", "#NUM!"],
    ["=SEC(-2^27)", "#NUM!"],
    ['=SEC("x")', "#VALUE!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("rounding and factorials", () => {
  it.each([
    ["=CEILING.PRECISE(4.3)", 5],
    ["=CEILING.PRECISE(-4.3)", -4],
    ["=CEILING.PRECISE(4.3, 2)", 6],
    ["=CEILING.PRECISE(4.3, -2)", 6],
    ["=CEILING.PRECISE(-4.3, 2)", -4],
    ["=CEILING.PRECISE(-4.3, -2)", -4],
    ["=ISO.CEILING(4.3)", 5],
    ["=ISO.CEILING(-4.3)", -4],
    ["=ISO.CEILING(4.3, 2)", 6],
    ["=ISO.CEILING(4.3, -2)", 6],
    ["=ISO.CEILING(-4.3, 2)", -4],
    ["=ISO.CEILING(-4.3, -2)", -4],
    ["=ISO.CEILING(4.3, 0)", 0],
    ["=FLOOR.PRECISE(-3.2, -1)", -4],
    ["=FLOOR.PRECISE(3.2, 1)", 3],
    ["=FLOOR.PRECISE(-3.2, 1)", -4],
    ["=FLOOR.PRECISE(3.2, -1)", 3],
    ["=FLOOR.PRECISE(3.2)", 3],
    ["=FACTDOUBLE(6)", 48],
    ["=FACTDOUBLE(7)", 105],
    ["=FACTDOUBLE(7.9)", 105],
    ["=FACTDOUBLE(0)", 1],
    // Defined as 1, as in Excel; below it is #NUM!.
    ["=FACTDOUBLE(-1)", 1],
    ["=MULTINOMIAL(2, 3, 4)", 1260],
    ["=MULTINOMIAL({2,3}, 4)", 1260],
    ["=SQRTPI(1)", 1.772453851],
    ["=SQRTPI(2)", 2.506628275],
    ["=DELTA(5, 4)", 0],
    ["=DELTA(5, 5)", 1],
    ["=DELTA(0.5, 0)", 0],
    ["=DELTA(0)", 1],
    ["=GESTEP(5, 4)", 1],
    ["=GESTEP(5, 5)", 1],
    ["=GESTEP(-4, -5)", 1],
    ["=GESTEP(-1)", 0],
    // cos(π/4) by its series, the page's own example.
    ["=SERIESSUM(PI()/4, 0, 2, {1,-0.5,0.0416666666666667,-0.00138888888888889})", 0.707103215],
  ])("%s is %s", (f, want) => {
    close(at(f), want);
  });

  it.each([
    ["=FACTDOUBLE(-2)", "#NUM!"],
    ["=MULTINOMIAL(-1, 2)", "#NUM!"],
    ["=SQRTPI(-1)", "#NUM!"],
    ['=DELTA("a", 1)', "#VALUE!"],
    ['=SERIESSUM(2, 1, 1, {1,"x"})', "#VALUE!"],
    // Two arguments, not CEILING.MATH's three.
    ["=CEILING.PRECISE(-4.3, 2, 1)", "#N/A"],
    ["=FLOOR.PRECISE(3.2, 1, 1)", "#N/A"],
    ["=SERIESSUM(2, 1)", "#N/A"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("the error function", () => {
  it.each([
    ["=ERF(0.745)", 0.70792892],
    ["=ERF(1)", 0.842700793],
    // FOUND IN R330: formula.js gave ERF(0,1) as about 0, ignoring the lower limit.
    ["=ERF(0, 1)", 0.842700793],
    ["=ERF(1, 2)", 0.152621472],
    ["=ERF(-1)", -0.842700793],
    ["=ERF.PRECISE(0.745)", 0.70792892],
    ["=ERF.PRECISE(1)", 0.842700793],
    ["=ERFC(1)", 0.15729921],
    ["=ERFC.PRECISE(1)", 0.15729921],
    ["=ERFC(-1)", 1.842700793],
  ])("%s is %s", (f, want) => {
    close(at(f), want);
  });

  it("is right to about 16 digits, far out too", () => {
    // Reference values from 20 digits, as the nearest double.
    expect(erf(1)).toBeCloseTo(0.8427007929497149, 15);
    expect(erf(2)).toBeCloseTo(0.9953222650189527, 15);
    expect(Math.abs(erfc(2) / 0.004677734981047266 - 1)).toBeLessThan(1e-14);
    // FOUND IN R330: formula.js's ERFC(5) was 1.53743684e-12.
    expect(Math.abs(erfc(5) / 1.537459794428035e-12 - 1)).toBeLessThan(1e-14);
    expect(Math.abs(erfc(10) / 2.088487583762545e-45 - 1)).toBeLessThan(1e-14);
    expect(erf(1e-10)).toBeCloseTo(1.1283791670955126e-10, 24);
  });
});

describe("Bessel functions", () => {
  it.each([
    ["=BESSELI(1.5, 1)", 0.981666428],
    ["=BESSELJ(1.9, 2)", 0.329925829],
    ["=BESSELK(1.5, 1)", 0.277387804],
    ["=BESSELY(2.5, 1)", 0.145918138],
    // The order is truncated: J₁(1), not J₁.₉(1).
    ["=BESSELJ(1, 1.9)", 0.440050586],
  ])("%s is %s", (f, want) => {
    close(at(f), want);
  });

  it.each([
    ["=BESSELJ(1, -1)", "#NUM!"],
    ["=BESSELI(1, -1)", "#NUM!"],
    ["=BESSELK(0, 1)", "#NUM!"],
    ['=BESSELJ("x", 1)', "#VALUE!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("matrices", () => {
  it.each([
    ["=MDETERM({3,6,1;1,1,0;3,10,2})", 1],
    ["=MDETERM({3,6;1,1})", -3],
    ["=MDETERM({1,3,8,5;1,3,6,1;1,1,1,0;7,3,10,2})", 88],
    ["=MDETERM({1,2;2,4})", 0],
    ["=MDETERM(5)", 5],
    [
      "=MINVERSE({4,-1;2,0})",
      [
        [0, 0.5],
        [-1, 2],
      ],
    ],
    [
      "=MINVERSE({1,2,1;3,4,-1;0,2,0})",
      [
        [0.25, 0.25, -0.75],
        [0, 0, 0.5],
        [0.75, -0.25, -0.25],
      ],
    ],
    [
      "=MMULT(MINVERSE({2,1;1,3}), {2,1;1,3})",
      [
        [1, 0],
        [0, 1],
      ],
    ],
    [
      "=MUNIT(3)",
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    ],
    ["=SUM(MUNIT(4))", 4],
  ])("%s is %s", (f, want) => {
    close(at(f), want, 10);
  });

  it.each([
    ["=MINVERSE({1,2;2,4})", "#NUM!"],
    ["=MINVERSE({1,2,3})", "#VALUE!"],
    ['=MDETERM({1,"a";2,3})', "#VALUE!"],
    ["=MDETERM({1,2,3;4,5,6})", "#VALUE!"],
    ["=MUNIT(0)", "#VALUE!"],
    ["=MUNIT(1001)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("over a range, as R329's", () => {
  it("each function of one value lifts", () => {
    for (const name of NEW.filter(
      (n) => !["MULTINOMIAL", "SERIESSUM", "MUNIT", "MDETERM", "MINVERSE"].includes(n),
    ))
      expect(LIFTS.has(name), name).toBe(true);
    expect(LIFTS.has("MDETERM")).toBe(false);
  });
  it.each([
    ["=COT({30,45})", [[-0.156119952, 0.617369624]]],
    ["=ERF({0,1})", [[0, 0.842700793]]],
    ["=FACTDOUBLE({6,7})", [[48, 105]]],
    // SERIESSUM lifts x, not its coefficients.
    ["=SERIESSUM({1,2}, 1, 1, {1,1})", [[2, 6]]],
  ])("%s is %s", (f, want) => {
    close(at(f), want);
  });
});
