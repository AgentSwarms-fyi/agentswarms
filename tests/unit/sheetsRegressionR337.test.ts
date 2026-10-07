// LINEST and LOGEST, and TREND and GROWTH on the same fit (R337).
//
// FOUND IN R329's inventory: LINEST and LOGEST were #NAME?. TREND and GROWTH
// came from formula.js, which fits one x: TREND flattened several x columns
// into one, and GROWTH could not drop a collinear column as Excel does.
//
// Excel's values come from four pages in its documentation (LINEST's three
// examples, LOGEST's, GROWTH's and TREND's) and from Microsoft's GROWTH
// article, whose collinear example shows Excel 2003's LOGEST table cell by
// cell. The other values come from an independent oracle: least squares in
// exact fractions, in Python, written apart from this engine.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

const cells: Record<string, { i: string }> = {};
const column = (c: number, from: number, values: (number | string)[]) =>
  values.forEach((v, r) => (cells[`${from + r},${c}`] = { i: String(v) }));
// LINEST's Example 1 in A2:B5.
column(0, 1, [1, 9, 5, 7]);
column(1, 1, [0, 4, 2, 3]);
// Example 2 in D1:E6.
column(3, 0, [1, 2, 3, 4, 5, 6]);
column(4, 0, [3100, 4500, 4400, 5400, 7500, 8100]);
// Example 3, the office buildings, in G2:K12.
column(6, 1, [2310, 2333, 2356, 2379, 2402, 2425, 2448, 2471, 2494, 2517, 2540]);
column(7, 1, [2, 2, 3, 3, 2, 4, 2, 2, 3, 4, 2]);
column(8, 1, [2, 2, 1.5, 2, 3, 2, 1.5, 2, 3, 4, 3]);
column(9, 1, [20, 12, 33, 43, 53, 23, 99, 34, 23, 55, 22]);
column(
  10,
  1,
  [142000, 144000, 151000, 150000, 139000, 169000, 126000, 142900, 163000, 169000, 149000],
);
// LOGEST's and GROWTH's months and units in M2:N7.
column(12, 1, [11, 12, 13, 14, 15, 16]);
column(13, 1, [33100, 47300, 69000, 102000, 150000, 220000]);
// TREND's months and revenue in P2:Q13.
column(15, 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
column(
  16,
  1,
  [133890, 135000, 135790, 137300, 138130, 139100, 139900, 141120, 141890, 143230, 144000, 145290],
);
// The GROWTH article: y = EXP(1…5) in S2:S6, its B and C (C = B + 1) in T2:U6.
column(18, 1, ["=EXP(1)", "=EXP(2)", "=EXP(3)", "=EXP(4)", "=EXP(5)"]);
column(19, 1, [1, 3, 4, 6, 7]);
column(20, 1, [2, 4, 5, 7, 8]);
// W1:X3 with a blank, a text and an error among the y's.
column(22, 0, [1, "", 3]);
column(23, 0, [1, 2, 3]);
column(24, 0, [1, "n/a", 3]);
column(25, 0, [1, "=1/0", 3]);
// AB1:AC11: a cubic's x's at 1000…1010, and y's, for the page's x^COLUMN($A:$C).
column(27, 0, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]);
column(28, 0, [3, 7, 4, 9, 12, 8, 15, 14, 20, 18, 25]);

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 40, 30, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
/** Within `rel` of `want` (relative), or exactly 0. */
const near = (got: unknown, want: number, rel = 1e-9) => {
  expect(typeof got, JSON.stringify(got)).toBe("number");
  if (want === 0) expect(got).toBe(0);
  else expect(Math.abs((got as number) / want - 1), `${got} vs ${want}`).toBeLessThan(rel);
};
/** A table of numbers, or `{ err }` where the table holds an error. */
const table = (got: unknown, want: (number | string)[][], rel = 1e-9) => {
  expect(Array.isArray(got), JSON.stringify(got)).toBe(true);
  const rows = got as unknown[][];
  expect(rows.map((r) => r.length)).toEqual(want.map((r) => r.length));
  want.forEach((row, i) =>
    row.forEach((w, j) => {
      if (typeof w === "string") expect(rows[i][j]).toEqual({ err: w });
      else near(rows[i][j], w, rel);
    }),
  );
};
const NA = "#N/A";

describe("LINEST: its page's examples", () => {
  it("Example 1: slope 2 and intercept 1, an empty const counting as TRUE", () => {
    table(at("=LINEST(A2:A5,B2:B5,,FALSE)"), [[2, 1]]);
  });

  it("Example 2: the ninth month's sales are $11,000", () => {
    near(at("=SUM(LINEST(E1:E6, D1:D6)*{9,1})"), 11000);
  });

  it("Example 3: the office buildings' whole table, column A as the page prints it", () => {
    const got = at("=LINEST(K2:K12,G2:J12,TRUE,TRUE)");
    table(got, [
      [-234.2371645, 2553.210660391538, 12529.768167086751, 27.641387366020286, 52317.83050729132],
      [13.26801148, 530.6691519303783, 400.0668381939531, 5.429374041545315, 12237.361602862353],
      [0.996747993, 970.5784629285062, NA, NA, NA],
      [459.7536742, 6, NA, NA, NA],
      [1732393319, 5652135.31620397, NA, NA, NA],
    ]);
  });

  it("Example 5: each slope over its standard error is the page's t (5.1, 31.3, 4.8, 17.7)", () => {
    const [m, se] = at("=LINEST(K2:K12,G2:J12,TRUE,TRUE)") as number[][];
    // The table runs m4…m1; the page lists floor space (m1) first.
    const t = [3, 2, 1, 0].map((j) => Math.round(Math.abs(m[j] / se[j]) * 10) / 10);
    expect(t).toEqual([5.1, 31.3, 4.8, 17.7]);
  });

  it("Example 4: F and df give the page's FDIST probability, 1.37E-7", () => {
    const [, , , [F, df]] = at("=LINEST(K2:K12,G2:J12,TRUE,TRUE)") as number[][];
    near(at(`=FDIST(${F},4,${df})`), 1.37e-7, 5e-3);
  });

  it("the page's collinear case: all-zero y's on all-one x's give 0, where SLOPE is #DIV/0!", () => {
    table(at("=LINEST({0;0;0},{1;1;1})"), [[0, 0]]);
    expect(at("=SLOPE({0;0;0},{1;1;1})")).toEqual({ err: "#DIV/0!" });
  });
});

describe("LOGEST, GROWTH and TREND: their pages' examples", () => {
  it("LOGEST: 1.46328 and 495.305", () => {
    const got = at("=LOGEST(N2:N7,M2:M7, TRUE, FALSE)") as number[][];
    expect(got.length).toBe(1);
    near(got[0][0], 1.46328, 5e-6);
    near(got[0][1], 495.305, 5e-6);
    // The oracle's: e to LINEST of ln y.
    near(got[0][0], Math.exp(0.3806775035522524));
    near(got[0][1], Math.exp(6.205173270395239));
  });

  it("LOGEST's statistics are LINEST's of ln y", () => {
    table(at("=LOGEST(N2:N7,M2:M7,TRUE,TRUE)"), [
      [Math.exp(0.3806775035522524), Math.exp(6.205173270395239)],
      [0.002633402891425114, 0.035834282435718345],
      [0.9998086197758176, 0.011016314665073235],
      [20896.801099419466, 4],
      [2.5360188299385644, 0.00048543675519963054],
    ]);
  });

  it("GROWTH: the page's fitted units and months 17 and 18", () => {
    const fitted = at("=GROWTH(N2:N7,M2:M7)") as number[][];
    expect(fitted.map((r) => Math.round(r[0]))).toEqual([
      32618, 47729, 69841, 102197, 149542, 218822,
    ]);
    near(fitted[0][0], 32618.20377353983);
    near(fitted[5][0], 218821.87621459606);
    const ahead = at("=GROWTH(N2:N7,M2:M7,{17;18})") as number[][];
    expect(ahead.map((r) => Math.round(r[0]))).toEqual([320197, 468536]);
    near(ahead[1][0], 468536.05418404884);
  });

  it("TREND: the page's projected revenue for months 13 to 17", () => {
    const got = at("=TREND(Q2:Q13,P2:P13,{13;14;15;16;17})") as number[][];
    expect(got.map((r) => Math.round(r[0]))).toEqual([146172, 147190, 148208, 149226, 150244]);
    near(got[0][0], 146171.51515151514);
    near(got[4][0], 150244.24242424243);
  });
});

describe("collinear x's: Microsoft's GROWTH article, Excel 2003 and later", () => {
  it("LOGEST drops C (C = B + 1 beside the constant): coefficient 1, error 0, df 3", () => {
    table(
      at("=LOGEST(S2:S6,T2:U6,TRUE,TRUE)"),
      [
        [1, 1.9307233720034, 1.26724101129183],
        [0, 0.043859649122807, 0.206652964726136],
        [0.986842105263158, 0.209426954145848, NA],
        [225, 3, NA],
        [9.86842105263158, 0.131578947368421, NA],
      ],
      1e-12,
    );
  });

  it("GROWTH predicts 472.432432563203 and 3400.16400895377, as with B alone", () => {
    table(
      at("=GROWTH(S2:S6,T2:U6,{9,11;12,14},TRUE)"),
      [[472.432432563203], [3400.16400895377]],
      1e-12,
    );
    table(at("=GROWTH(S2:S6,T2:T6,{9;12},TRUE)"), [[472.432432563203], [3400.16400895377]], 1e-12);
  });

  it("LINEST of ln y gives the dropped column 0 and 0", () => {
    const [m, se] = at("=LINEST(LN(S2:S6),T2:U6,TRUE,TRUE)") as number[][];
    expect([m[0], se[0]]).toEqual([0, 0]);
  });
});

describe("the arguments, as LINEST's page describes them", () => {
  it("const FALSE: b is 0, seb is #N/A, and the sums are about 0 (the oracle's table)", () => {
    table(at("=LINEST(A2:A5,B2:B5,FALSE,TRUE)"), [
      [2.310344827586207, 0],
      [0.11778104328689193, NA],
      [0.992263483642794, 0.6342703292561561],
      [384.77142857142854, 3],
      [154.79310344827587, 1.206896551724138],
    ]);
  });

  it("without x's they are 1, 2, 3…", () => {
    table(at("=LINEST({3;5;7})"), [[2, 1]]);
    table(at("=LINEST({3,5,7})"), [[2, 1]]);
  });

  it("y in a column: each column of x's is a variable, and the table runs mn…m1, b", () => {
    // y = 1 + 2·x1 + 3·x2
    table(at("=LINEST({9;8;19;18;29},{1,2;2,1;3,4;4,3;5,6})"), [[3, 2, 1]], 1e-12);
  });

  it("y in a row: each row of x's is a variable", () => {
    table(at("=LINEST({9,8,19,18,29},{1,2,3,4,5;2,1,4,3,6})"), [[3, 2, 1]], 1e-12);
  });

  it("one variable may take any shape, the y's and x's alike", () => {
    table(at("=LINEST({1,2;3,4},{2,4;6,8})"), [[0.5, 0]]);
  });

  it("x's that do not line up are #REF!", () => {
    expect(at("=LINEST({1;2;3},{1;2})")).toEqual({ err: "#REF!" });
    expect(at("=LINEST({1;2;3},{1,2,3})")).toEqual({ err: "#REF!" });
    expect(at("=LINEST({1,2;3,4},{1,2,3,4})")).toEqual({ err: "#REF!" });
  });

  it("a blank, text or TRUE among the values is #VALUE!, and an error is itself", () => {
    expect(at("=LINEST(W1:W3,X1:X3)")).toEqual({ err: "#VALUE!" });
    expect(at("=LINEST(Y1:Y3,X1:X3)")).toEqual({ err: "#VALUE!" });
    expect(at("=LINEST({1;TRUE;3},X1:X3)")).toEqual({ err: "#VALUE!" });
    expect(at("=LINEST(X1:X3,W1:W3)")).toEqual({ err: "#VALUE!" });
    expect(at("=LINEST(Z1:Z3,X1:X3)")).toEqual({ err: "#DIV/0!" });
  });

  it("LOGEST and GROWTH take y's above 0 only", () => {
    expect(at("=LOGEST({1;0;3})")).toEqual({ err: "#NUM!" });
    expect(at("=GROWTH({1;-2;3})")).toEqual({ err: "#NUM!" });
  });

  it("LOGEST with const FALSE fits y = m^x: b is 1", () => {
    const [[m, b]] = at("=LOGEST({2;4;8},{1;2;3},FALSE)") as number[][];
    near(m, 2, 1e-12);
    expect(b).toBe(1);
  });

  it("two points leave no degrees of freedom: the errors cannot be computed (#NUM!)", () => {
    const got = at("=LINEST({1;3},{1;2},TRUE,TRUE)") as unknown[][];
    near(got[0][0], 2, 1e-12);
    near(got[0][1], -1, 1e-12);
    expect(got[1]).toEqual([{ err: "#NUM!" }, { err: "#NUM!" }]);
    expect(got[3][1]).toBe(0);
  });

  it("is too few or too many arguments: #N/A", () => {
    expect(at("=LINEST()")).toEqual({ err: "#N/A" });
    expect(at("=LINEST(A2:A5,B2:B5,TRUE,TRUE,1)")).toEqual({ err: "#N/A" });
  });
});

describe("TREND and GROWTH on LINEST's fit", () => {
  it("several x columns: each row of the new x's is one point (formula.js flattened them)", () => {
    table(at("=TREND({9;8;19;18;29},{1,2;2,1;3,4;4,3;5,6},{6,7;0,0})"), [[34], [1]], 1e-12);
  });

  it("y in a row: each column of the new x's is one point", () => {
    table(at("=TREND({9,8,19,18,29},{1,2,3,4,5;2,1,4,3,6},{6,0;7,0})"), [[34, 1]], 1e-12);
  });

  it("without new x's they are the known x's", () => {
    table(at("=TREND({9;8;19;18;29},{1,2;2,1;3,4;4,3;5,6})"), [[9], [8], [19], [18], [29]], 1e-12);
    table(at("=TREND({3,5,7})"), [[3, 5, 7]], 1e-12);
  });

  it("new x's of the wrong width are #REF!", () => {
    expect(at("=TREND({9;8;19;18;29},{1,2;2,1;3,4;4,3;5,6},{6;7})")).toEqual({ err: "#REF!" });
    expect(at("=TREND({9,8,19,18,29},{1,2,3,4,5;2,1,4,3,6},{6,7})")).toEqual({ err: "#REF!" });
  });

  it("one variable: the new x's take any shape and the answer has it", () => {
    table(
      at("=TREND({3;5;7},{1;2;3},{4,5;6,7})"),
      [
        [9, 11],
        [13, 15],
      ],
      1e-12,
    );
  });

  it("const FALSE fits through the origin (the oracle's 17/7 · 4, and GROWTH's)", () => {
    near(at("=TREND({3;5;7},{1;2;3},4,FALSE)"), 68 / 7, 1e-12);
    near(at("=TREND({3;5;7},{1;2;3},4)"), 9, 1e-12);
    near(at("=GROWTH({6;12;24},{1;2;3},4,FALSE)"), 105.20639361262603, 1e-12);
  });

  it("a new x that is not a number is #VALUE!", () => {
    expect(at('=TREND({3;5;7},{1;2;3},{"a"})')).toEqual({ err: "#VALUE!" });
  });
});

describe("ROW and COLUMN of a range: every row and column, as LINEST's page needs", () => {
  it("ROW gives a column of row numbers and COLUMN a row of column numbers", () => {
    expect(at("=ROW(A3:A5)")).toEqual([[3], [4], [5]]);
    expect(at("=ROW(B2:D3)")).toEqual([[2], [3]]);
    expect(at("=COLUMN(B2:D3)")).toEqual([[2, 3, 4]]);
    expect(at("=COLUMN($A:$C)")).toEqual([[1, 2, 3]]);
    expect(at("=ROW(1000:1002)")).toEqual([[1000], [1001], [1002]]);
  });

  it("one cell, or none, is still one number", () => {
    expect(at("=ROW(A7)")).toBe(7);
    expect(at("=COLUMN(C7)")).toBe(3);
    expect(at("=ROW()")).toBe(41);
    expect(at("=COLUMN()")).toBe(31);
  });

  it("SUMPRODUCT((X1:X3=2)*ROW(X1:X3)) is the matching row, 2 (formula.js-era: 1)", () => {
    expect(at("=SUMPRODUCT((X1:X3=2)*ROW(X1:X3))")).toBe(2);
  });

  it("the page's polynomial form: a cubic at x = 1000…1010, near collinear, to the exact fit", () => {
    // From the oracle's exact fractions. Each column is made orthogonal twice:
    // once leaves these coefficients 1e-9 out, twice 1.4e-10.
    table(
      at("=LINEST(AC1:AC11,AB1:AB11^COLUMN($A:$C),TRUE,TRUE)"),
      [
        [0.016511266511266512, -49.68240093240093, 49832.91064491065, -16661772.832167832],
        [0.03256185229083089, 98.17402353667107, 98664.43127715576, 33052261.594595917],
        [0.9037139836108908, 2.559287019845576, NA, NA],
        [21.90002287805994, 7, NA, NA],
        [430.33216783216784, 45.84965034965035, NA, NA],
      ],
      5e-10,
    );
  });
});

describe("SLOPE's family where the data do not vary: #DIV/0!, as their pages say", () => {
  const div0 = { err: "#DIV/0!" };
  const na = { err: "#N/A" };

  it("SLOPE, INTERCEPT and FORECAST where the x's do not vary (formula.js: #NUM!)", () => {
    for (const f of [
      "=SLOPE({1;2;3},{1;1;1})",
      "=INTERCEPT({1;2;3},{1;1;1})",
      "=INTERCEPT({0;0;0},{1;1;1})",
      "=FORECAST(2,{1;2;3},{1;1;1})",
      "=FORECAST.LINEAR(2,{1;2;3},{1;1;1})",
    ])
      expect(at(f), f).toEqual(div0);
  });

  it("CORREL, PEARSON and RSQ where either list does not vary, and RSQ of one point", () => {
    for (const f of [
      "=CORREL({1;2;3},{1;1;1})",
      "=CORREL({1;1;1},{1;2;3})",
      "=PEARSON({1;2;3},{1;1;1})",
      "=PEARSON({1;1;1},{1;2;3})",
      "=RSQ({1;2;3},{1;1;1})",
      "=RSQ({1;1;1},{1;2;3})",
      "=RSQ({1},{2})",
    ])
      expect(at(f), f).toEqual(div0);
  });

  it("no pairs at all: #N/A, but CORREL's page says #DIV/0!", () => {
    for (const f of [
      '=SLOPE({"a";"b"},{"c";"d"})',
      '=INTERCEPT({"a";"b"},{"c";"d"})',
      '=FORECAST(1,{"a";"b"},{"c";"d"})',
      '=RSQ({"a";"b"},{"c";"d"})',
      '=PEARSON({"a";"b"},{"c";"d"})',
    ])
      expect(at(f), f).toEqual(na);
    expect(at('=CORREL({"a";"b"},{"c";"d"})')).toEqual(div0);
  });

  it("where the data vary nothing changes: FORECAST.LINEAR's page, 10.607253", () => {
    near(at("=FORECAST.LINEAR(30,{6;7;9;15;21},{20;28;31;38;40})"), 10.607253, 1e-7);
    expect(at("=SLOPE({1;1;1},{1;2;3})")).toBe(0);
    near(at("=CORREL({3;2;4;5;6},{9;7;12;15;17})"), 0.997054486, 1e-9);
  });
});

describe("the four in the workbook", () => {
  it("are functions with help, and a file keeps their names as they are", () => {
    for (const name of ["LINEST", "LOGEST", "TREND", "GROWTH"]) {
      expect(FUNCTIONS[name], name).toBeTypeOf("function");
      expect(FUNCTION_HELP[name]?.sig, name).toMatch(new RegExp(`^${name}\\(`));
      expect(toFileFormula(`=${name}(A1:A3)`)).toBe(`${name}(A1:A3)`);
    }
  });
});
