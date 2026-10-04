// Excel functions a grid answered #NAME? for, each checked against the answer
// Excel's documentation gives (R258, from the Sheets queue's formula.js row).
//
// Where an answer can be recomputed from first principles it is, here in the
// test, so a check does not rest on a remembered decimal: BINOM.DIST is
// C(10,6)/2^10, a t-distribution with one degree of freedom is the Cauchy
// distribution, and so on. The rest are the worked examples on Microsoft's
// function pages.
//
// One function was NOT registered from the library: formula.js's T.DIST
// answers #NUM! for every input, so registering it would have shipped a
// function that always fails. The family is built on its legacy TDIST, which
// is right.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";

const COLS: Record<string, unknown[]> = {
  A: [10, 7, 9, 2, "Not available"],
  B: [0, 0.2, 0.5, 0.4, true],
  C: [false, 0.2, 0.5, 0.4, 0.8],
  D: [4, 5, 6, 7, 2, 3, 4, 5, 1, 2, 3],
  E: [6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49],
  F: [13, 12, 11, 8, 4, 3, 2, 1, 1, 1],
  G: [1, 2, 3, 6, 6, 6, 7, 8, 9],
};

function engine() {
  const cells: Record<string, { i: string }> = {};
  Object.entries(COLS).forEach(([col, vals], c) =>
    vals.forEach((v, r) => {
      cells[`${r},${c}`] = {
        i: typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v),
      };
    }),
  );
  return new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells } }]);
}
const e = engine();
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string): unknown => {
  // Row 30, column Z: below and beside every input.
  const v = plain(e.evaluateAt("s", 29, 25, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const n = (f: string) => at(f) as number;

describe("no longer #NAME?", () => {
  it.each([
    "AVERAGEA",
    "MAXA",
    "MINA",
    "TRIMMEAN",
    "MMULT",
    "QUARTILE.EXC",
    "PERCENTRANK",
    "PERCENTRANK.INC",
    "PERCENTRANK.EXC",
    "BINOM.DIST",
    "BINOMDIST",
    "TDIST",
    "T.DIST",
    "T.DIST.RT",
    "T.DIST.2T",
    "BITAND",
    "BITOR",
    "BITXOR",
    "BITLSHIFT",
    "BITRSHIFT",
    "COMPLEX",
    "TYPE",
    "ERROR.TYPE",
  ])("%s is a function", (name) => {
    expect(FUNCTION_NAMES).toContain(name);
  });
});

describe("Excel's documented answers", () => {
  it("AVERAGEA, MAXA and MINA count text as 0 and TRUE as 1 from a range", () => {
    expect(n("=AVERAGEA(A1:A5)")).toBeCloseTo(5.6, 12); // (10+7+9+2+0)/5
    expect(n("=MAXA(B1:B5)")).toBe(1);
    expect(n("=MINA(C1:C5)")).toBe(0);
  });

  it("TRIMMEAN drops 20% from the ends", () => {
    // 11 values, 20% -> 2 dropped, one each end; the middle nine sum to 34.
    expect(n("=TRIMMEAN(D1:D11,0.2)")).toBeCloseTo(34 / 9, 12);
  });

  it("MMULT multiplies two arrays and spills the product", () => {
    expect(at("=MMULT({1,3;7,2},{2,0;0,2})")).toEqual([
      [2, 6],
      [14, 4],
    ]);
  });

  it("QUARTILE.EXC on Excel's example data", () => {
    expect(n("=QUARTILE.EXC(E1:E11,1)")).toBe(15);
    expect(n("=QUARTILE.EXC(E1:E11,3)")).toBe(43);
  });

  it("PERCENTRANK truncates to three digits, as Excel does (0.555, not 0.556)", () => {
    // (values below x) / (n-1), interpolated between neighbours for a value not in the list.
    for (const f of ["PERCENTRANK", "PERCENTRANK.INC"]) {
      expect(n(`=${f}(F1:F10,2)`)).toBe(0.333); // 3/9
      expect(n(`=${f}(F1:F10,4)`)).toBe(0.555); // 5/9 = 0.5556, truncated
      expect(n(`=${f}(F1:F10,8)`)).toBe(0.666); // 6/9
      expect(n(`=${f}(F1:F10,5)`)).toBe(0.583); // between 4 and 8
    }
  });

  it("PERCENTRANK.EXC on Excel's example data", () => {
    expect(n("=PERCENTRANK.EXC(G1:G9,7)")).toBe(0.7);
    expect(n("=PERCENTRANK.EXC(G1:G9,5.43)")).toBe(0.381);
  });

  it("BINOM.DIST is the binomial probability", () => {
    expect(n("=BINOM.DIST(6,10,0.5,FALSE)")).toBe(210 / 1024); // C(10,6)/2^10
    expect(n("=BINOMDIST(6,10,0.5,FALSE)")).toBe(210 / 1024);
  });

  it("the T.DIST family: one degree of freedom is the Cauchy distribution", () => {
    const cauchy = 0.5 + Math.atan(60) / Math.PI;
    expect(n("=T.DIST(60,1,TRUE)")).toBeCloseTo(cauchy, 9);
    expect(n("=T.DIST.RT(60,1)")).toBeCloseTo(1 - cauchy, 9);
    expect(n("=T.DIST.2T(60,1)")).toBeCloseTo(2 * (1 - cauchy), 9);
    // Density at 8 with 3 df: Gamma(2) / (sqrt(3 pi) Gamma(1.5)) * (1 + 64/3)^-2
    const pdf =
      (1 / (Math.sqrt(3 * Math.PI) * (Math.sqrt(Math.PI) / 2))) * Math.pow(1 + 64 / 3, -2);
    expect(n("=T.DIST(8,3,FALSE)")).toBeCloseTo(pdf, 12);
  });

  it("T.DIST is symmetric, and refuses what Excel refuses", () => {
    expect(n("=T.DIST(-2,5,TRUE)") + n("=T.DIST(2,5,TRUE)")).toBeCloseTo(1, 12);
    expect(at("=T.DIST(1,0,TRUE)")).toEqual({ err: "#NUM!" });
    expect(at("=T.DIST.2T(-1,2)")).toEqual({ err: "#NUM!" });
  });

  it("the BIT functions", () => {
    expect(n("=BITAND(13,25)")).toBe(9); // 01101 & 11001
    expect(n("=BITOR(23,10)")).toBe(31);
    expect(n("=BITXOR(5,3)")).toBe(6);
    expect(n("=BITLSHIFT(4,2)")).toBe(16);
    expect(n("=BITRSHIFT(13,2)")).toBe(3);
  });

  it("COMPLEX writes Excel's text form", () => {
    expect(at("=COMPLEX(3,4)")).toBe("3+4i");
    expect(at('=COMPLEX(3,4,"j")')).toBe("3+4j");
    expect(at("=COMPLEX(0,1)")).toBe("i");
  });

  it("TYPE: 1 number (and a blank), 2 text, 4 logical, 16 error, 64 array", () => {
    expect(n("=TYPE(1)")).toBe(1);
    expect(n("=TYPE(Z1)")).toBe(1);
    expect(n('=TYPE("x")')).toBe(2);
    expect(n("=TYPE(TRUE)")).toBe(4);
    expect(n("=TYPE(1/0)")).toBe(16);
    expect(n("=TYPE({1,2;3,4})")).toBe(64);
  });

  it("ERROR.TYPE numbers the classic errors, and is #N/A for a value", () => {
    expect(n("=ERROR.TYPE(1/0)")).toBe(2);
    expect(n('=ERROR.TYPE("a"+1)')).toBe(3);
    expect(n("=ERROR.TYPE(SQRT(-1))")).toBe(6);
    expect(n("=ERROR.TYPE(NA())")).toBe(7);
    expect(at("=ERROR.TYPE(1)")).toEqual({ err: "#N/A" });
  });
});
