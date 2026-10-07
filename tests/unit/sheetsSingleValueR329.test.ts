// Functions of single values given a range, and the values Excel's
// documentation refuses (R329).
//
// FOUND IN R329, looking for Excel's missing functions:
// - only a first list of functions lifted over arrays, so =SIN(A1:A3),
//   =SUM(SIN(A1:A3)), =PMT(r,n,-B2:B9) and some 160 others were #VALUE!, and
//   =GAMMA(A1:A3), =CEILING.MATH(A1:A3) and =IMABS(A1:A3) answered for the
//   first cell alone;
// - formula.js answered values Excel refuses: NORM.INV(0,0,1) was -141.4,
//   CHISQ.INV(1.1,2) 202, ROMAN(4000) "MMMM", ATAN2(0,0) 0, FACT(-1) #VALUE!;
// - holidays across a row (B1:C1, {46301,46302}) were #VALUE!.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { LIFTS } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";

// A1:A3 = 0, 0.5, 1. C1:D1 and C2:C3 hold the holidays 6 and 7 October 2026.
const e = new WorkbookEngine([
  {
    id: "s",
    name: "S",
    kind: "grid",
    grid: {
      cells: {
        "0,0": { i: "0" },
        "1,0": { i: "0.5" },
        "2,0": { i: "1" },
        "0,2": { i: "=DATE(2026,10,6)" },
        "0,3": { i: "=DATE(2026,10,7)" },
        "1,2": { i: "=DATE(2026,10,6)" },
        "2,2": { i: "=DATE(2026,10,7)" },
      },
    },
  },
]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
/** Evaluated at J10, clear of the data; a one-cell answer as its value. */
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const close = (got: unknown, want: unknown) => {
  if (typeof want === "number") {
    expect(typeof got).toBe("number");
    expect(got as number).toBeCloseTo(want, 6);
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got)).toBe(true);
    (want as unknown[]).forEach((w, i) => close((got as unknown[])[i], w));
  } else expect(got).toEqual(want);
};

describe("a function of one value given a range answers for each cell", () => {
  it.each([
    ["=SIN(A1:A3)", [[0], [0.479425538604203], [0.841470984807897]]],
    ["=SUM(SIN(A1:A3))", 1.320896523412],
    ["=GAMMA(A1:A3+1)", [[1], [0.886226925452758], [1]]],
    ["=NORM.S.DIST(A1:A3, TRUE)", [[0.5], [0.691462461274013], [0.841344746068543]]],
    ["=DEC2HEX(A1:A3*20)", [["0"], ["A"], ["14"]]],
    ["=EVEN(A1:A3*3)", [[0], [2], [4]]],
    ["=CEILING.MATH(A1:A3)", [[0], [1], [1]]],
    ['=IMABS({"3+4i","5"})', [[5, 5]]],
    ["=PMT(0.05/12, 360, -{100000,200000})", [[536.82162301214, 1073.64324602428]]],
    ["=COMBIN({4,5}, {2,3})", [[6, 10]]],
    ["=WEEKNUM(DATE(2026,1,{1,8}))", [[1, 2]]],
    ["=ADDRESS({1,2}, 1)", [["$A$1", "$A$2"]]],
    ["=ROUND(SUM(LOG(A2:A3*100, 10)), 6)", 3.69897],
    ["=FACT({3,-1})", [[6, { err: "#NUM!" }]]],
  ])("%s", (f, want) => {
    close(at(f), want);
  });

  it("a function of a list still takes the whole list", () => {
    expect(at("=GCD(A1:A3*4)")).toBe(2);
    expect(at("=NPV(0.1, {100,100})")).toBeCloseTo(173.553719, 5);
  });

  it("every function of one value lifts", () => {
    for (const name of [
      "SIN",
      "GAMMA",
      "NORM.INV",
      "PMT",
      "DEC2HEX",
      "IMABS",
      "TINV",
      "ERROR.TYPE",
    ])
      expect(LIFTS.has(name), name).toBe(true);
    for (const name of ["SUM", "GCD", "NPV", "IMSUM", "STDEV", "INDEX", "ROW", "TEXTJOIN"])
      expect(LIFTS.has(name), name).toBe(false);
  });
});

describe("working days", () => {
  // Monday 5 to Friday 9 October 2026, Tuesday and Wednesday holidays.
  it.each([
    ["=NETWORKDAYS(DATE(2026,10,5), DATE(2026,10,9), C1:D1)", 3],
    ["=NETWORKDAYS(DATE(2026,10,5), DATE(2026,10,9), C2:C3)", 3],
    ["=NETWORKDAYS(DATE(2026,10,5), DATE(2026,10,9), C2:C9)", 3],
    ["=NETWORKDAYS(DATE(2026,10,5), DATE(2026,10,9), DATE(2026,10,{6,7}))", 3],
    ["=NETWORKDAYS(DATE(2026,10,5), DATE(2026,10,9), 46301)", 4],
    ["=NETWORKDAYS(DATE(2026,10,9), DATE(2026,10,5), C1:D1)", -3],
    ["=NETWORKDAYS.INTL(DATE(2026,10,5), DATE(2026,10,9), 1, {46301,46302})", 3],
    ["=WORKDAY(DATE(2026,10,5), 3, {46301,46302})", 46307],
    ["=WORKDAY.INTL(DATE(2026,10,5), 3, 1, C1:D1)", 46307],
  ])("take holidays across a row: %s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });

  it("lift the start and end, not the holidays", () => {
    expect(at("=NETWORKDAYS(DATE(2026,10,{5,6}), DATE(2026,10,9), C1:D1)")).toEqual([[3, 2]]);
  });
});

describe("what Excel's documentation refuses", () => {
  it.each([
    ["=FACT(-1)", "#NUM!"],
    ["=PERMUT(-1, 1)", "#NUM!"],
    ["=PERMUT(2, 3)", "#NUM!"],
    ["=LOG(10, 1)", "#DIV/0!"],
    ["=ROMAN(4000)", "#VALUE!"],
    ["=ROMAN(-1)", "#VALUE!"],
    ["=BASE(-1, 2)", "#NUM!"],
    ["=QUOTIENT(1, 0)", "#DIV/0!"],
    ["=ATAN2(0, 0)", "#DIV/0!"],
    ["=NORM.S.INV(0)", "#NUM!"],
    ["=NORM.S.INV(1)", "#NUM!"],
    ["=NORM.INV(0, 0, 1)", "#NUM!"],
    ["=NORM.INV(1, 0, 1)", "#NUM!"],
    ["=NORM.INV(0.5, 0, 0)", "#NUM!"],
    ["=LOGNORM.INV(0, 0, 1)", "#NUM!"],
    ["=LOGNORM.INV(1, 0, 1)", "#NUM!"],
    ["=LOGNORM.INV(0.5, 0, 0)", "#NUM!"],
    ["=T.INV(0, 2)", "#NUM!"],
    ["=T.INV(0.5, 0.5)", "#NUM!"],
    ["=T.INV.2T(0, 2)", "#NUM!"],
    ["=T.INV.2T(1.5, 2)", "#NUM!"],
    ["=CHISQ.INV(-0.1, 2)", "#NUM!"],
    ["=CHISQ.INV(1.1, 2)", "#NUM!"],
    ["=CHISQ.INV(0.5, 0.5)", "#NUM!"],
    ["=CHISQ.INV.RT(1.1, 2)", "#NUM!"],
    ["=BETA.INV(0, 2, 3)", "#NUM!"],
    ["=BETA.INV(1.1, 2, 3)", "#NUM!"],
    ["=BETA.INV(0.5, 0, 3)", "#NUM!"],
    ["=EXPON.DIST(-1, 1, TRUE)", "#NUM!"],
    ["=EXPON.DIST(1, 0, TRUE)", "#NUM!"],
    ["=POISSON.DIST(-1, 1, TRUE)", "#NUM!"],
    ["=POISSON.DIST(1, -1, TRUE)", "#NUM!"],
    ["=WEIBULL.DIST(-1, 1, 1, TRUE)", "#NUM!"],
    ["=WEIBULL.DIST(1, 0, 1, TRUE)", "#NUM!"],
    ["=CONFIDENCE.NORM(0, 1, 10)", "#NUM!"],
    ["=CONFIDENCE.NORM(1, 1, 10)", "#NUM!"],
    ["=CONFIDENCE.NORM(0.05, 0, 10)", "#NUM!"],
    ["=CONFIDENCE.NORM(0.05, 1, 0)", "#NUM!"],
    // The old names follow the new ones.
    ["=LOGINV(0, 0, 1)", "#NUM!"],
    ["=TINV(0, 2)", "#NUM!"],
    ["=CHIINV(1.1, 2)", "#NUM!"],
    ["=BETAINV(0, 2, 3)", "#NUM!"],
    ["=CONFIDENCE(0, 1, 10)", "#NUM!"],
    ["=EXPONDIST(-1, 1, TRUE)", "#NUM!"],
    ["=POISSON(-1, 1, TRUE)", "#NUM!"],
    ["=WEIBULL(-1, 1, 1, TRUE)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  // The examples on the same pages, which must not change.
  it.each([
    ["=FACT(5)", 120],
    ["=PERMUT(100, 3)", 970200],
    ["=LOG(8, 2)", 3],
    ["=QUOTIENT(5, 2)", 2],
    ["=ATAN2(1, 1)", 0.785398163],
    ["=NORM.S.INV(0.908789)", 1.333334673],
    ["=NORM.INV(0.908789, 40, 1.5)", 42.000002],
    ["=LOGNORM.INV(0.039084, 3.5, 1.2)", 4.0000252],
    ["=T.INV(0.75, 2)", 0.8164966],
    ["=T.INV.2T(0.546449, 60)", 0.606533],
    ["=CHISQ.INV(0.93, 1)", 3.283020287],
    ["=CHISQ.INV.RT(0.050001, 10)", 18.30697346],
    ["=BETA.INV(0.685470581, 8, 10, 1, 3)", 2],
    ["=EXPON.DIST(0.2, 10, TRUE)", 0.864664717],
    ["=POISSON.DIST(2, 5, TRUE)", 0.124652],
    ["=WEIBULL.DIST(105, 20, 100, TRUE)", 0.929581],
    ["=CONFIDENCE.NORM(0.05, 2.5, 50)", 0.692952],
    ["=BINOM.INV(10, 0.5, 0)", 0],
  ])("%s is %s", (f, want) => {
    expect(at(f) as number).toBeCloseTo(want, 5);
  });

  it("names the value, and the rest of the text answers as before", () => {
    expect(at("=ROMAN(1999)")).toBe("MCMXCIX");
    expect(at("=BASE(7, 2)")).toBe("111");
    expect(at('=FACT("x")')).toEqual({ err: "#VALUE!" });
    const v = e.evaluateAt("s", 9, 9, "=NORM.INV(0, 0, 1)") as { detail?: string };
    expect(v.detail).toMatch(/probability/);
  });
});
