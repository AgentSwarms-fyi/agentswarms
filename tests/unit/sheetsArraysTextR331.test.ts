// Arrays, text and sheets Excel has (R331).
//
// FOUND IN R329's inventory: WRAPROWS, WRAPCOLS, EXPAND, ARRAYTOTEXT,
// VALUETOTEXT, SHEET, SHEETS, AREAS, NORMINV, NORMSINV, NORMSDIST and the
// byte functions (LENB, LEFTB…) were #NAME?. SHEET() also needs the tabs'
// order, which the engine was never told when tabs were dragged.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS, LIFTS } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

// First!A1:B3 is the ARRAYTOTEXT page's example: TRUE, an error; 1234.01234,
// Seattle; Hello, 1123. Second!A1 holds =SHEET(). Spot names Third!A1.
const book = () =>
  new WorkbookEngine(
    [
      {
        id: "a",
        name: "First",
        kind: "grid",
        grid: {
          cells: {
            "0,0": { i: "TRUE" },
            "0,1": { i: "=1/0" },
            "1,0": { i: "1234.01234" },
            "1,1": { i: "Seattle" },
            "2,0": { i: "Hello" },
            "2,1": { i: "1123" },
          },
        },
      },
      { id: "b", name: "Second", kind: "grid", grid: { cells: { "0,0": { i: "=SHEET()" } } } },
      { id: "c", name: "Third", kind: "grid", grid: { cells: {} } },
    ],
    undefined,
    { names: [{ name: "Spot", ref: "Third!$A$1" }] },
  );
const e = book();
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("a", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const NA = { err: "#N/A" };

const NEW = [
  ...["WRAPROWS", "WRAPCOLS", "EXPAND", "ARRAYTOTEXT", "VALUETOTEXT", "SHEET", "SHEETS", "AREAS"],
  ...["NORMINV", "NORMSINV", "NORMSDIST", "LENB", "LEFTB", "RIGHTB", "MIDB", "FINDB", "SEARCHB"],
  "REPLACEB",
];

describe("each is known, has help, and goes into a file as Excel names it", () => {
  it.each(NEW)("%s", (name) => {
    expect(FUNCTIONS[name]).toBeTypeOf("function");
    expect(FUNCTION_HELP[name]?.sig.startsWith(`${name}(`)).toBe(true);
  });
  it("with _xlfn. on the ones Excel added after 2007", () => {
    expect(toFileFormula('=SHEET()+SHEETS()&ARRAYTOTEXT(A1:B2)&VALUETOTEXT(1)&LENB("a")')).toBe(
      '_xlfn.SHEET()+_xlfn.SHEETS()&_xlfn.ARRAYTOTEXT(A1:B2)&_xlfn.VALUETOTEXT(1)&LENB("a")',
    );
  });
});

describe("folding and growing arrays", () => {
  it.each([
    [
      '=WRAPROWS({"A","B","C","D","E","F","G"}, 3)',
      [
        ["A", "B", "C"],
        ["D", "E", "F"],
        ["G", NA, NA],
      ],
    ],
    [
      '=WRAPROWS({"A","B","C","D","E","F","G"}, 3, "x")',
      [
        ["A", "B", "C"],
        ["D", "E", "F"],
        ["G", "x", "x"],
      ],
    ],
    [
      '=WRAPCOLS({"A","B","C","D","E","F","G"}, 3)',
      [
        ["A", "D", "G"],
        ["B", "E", NA],
        ["C", "F", NA],
      ],
    ],
    [
      '=WRAPCOLS({"A","B","C","D","E","F","G"}, 3, "x")',
      [
        ["A", "D", "G"],
        ["B", "E", "x"],
        ["C", "F", "x"],
      ],
    ],
    // A column folds the same way as a row.
    [
      '=WRAPROWS(SEQUENCE(7), 3, "-")',
      [
        [1, 2, 3],
        [4, 5, 6],
        [7, "-", "-"],
      ],
    ],
    ["=WRAPROWS({1,2,3}, 5)", [[1, 2, 3, NA, NA]]],
    // A blank cell in the vector stays blank; only past its end is padded.
    [
      "=WRAPROWS(A1:A4, 3)",
      [
        [true, 1234.01234, "Hello"],
        [null, NA, NA],
      ],
    ],
    [
      "=EXPAND({1,2;3,4}, 3, 3)",
      [
        [1, 2, NA],
        [3, 4, NA],
        [NA, NA, NA],
      ],
    ],
    [
      '=EXPAND({1,2;3,4}, 3, 3, "-")',
      [
        [1, 2, "-"],
        [3, 4, "-"],
        ["-", "-", "-"],
      ],
    ],
    // A size left out keeps the array's.
    [
      "=EXPAND({1,2;3,4}, , 3, 0)",
      [
        [1, 2, 0],
        [3, 4, 0],
      ],
    ],
    [
      "=EXPAND({1,2;3,4}, 3, , 0)",
      [
        [1, 2],
        [3, 4],
        [0, 0],
      ],
    ],
    ["=EXPAND(7, 2, 1, 0)", [[7], [0]]],
  ])("%s", (f, want) => {
    expect(at(f)).toEqual(want);
  });

  it.each([
    ["=WRAPROWS({1,2;3,4}, 2)", "#VALUE!"],
    ["=WRAPROWS({1,2}, 0)", "#NUM!"],
    ["=WRAPCOLS({1,2}, -1)", "#NUM!"],
    ["=EXPAND({1,2;3,4}, 1, 2)", "#VALUE!"],
    ["=EXPAND({1,2;3,4}, 2, 1)", "#VALUE!"],
    ["=EXPAND(1, 2000, 2000)", "#NUM!"],
    ["=WRAPROWS({1,2})", "#N/A"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("values as text", () => {
  it.each([
    // The ARRAYTOTEXT page's own example, with #DIV/0! for its #VALUE!.
    ["=ARRAYTOTEXT(A1:B3, 0)", "TRUE, #DIV/0!, 1234.01234, Seattle, Hello, 1123"],
    ["=ARRAYTOTEXT(A1:B3)", "TRUE, #DIV/0!, 1234.01234, Seattle, Hello, 1123"],
    ["=ARRAYTOTEXT(A1:B3, 1)", '{TRUE,#DIV/0!;1234.01234,"Seattle";"Hello",1123}'],
    ['=ARRAYTOTEXT({1,2;"a",TRUE}, 1)', '{1,2;"a",TRUE}'],
    ["=ARRAYTOTEXT(1/3)", "0.333333333333333"],
    ["=VALUETOTEXT(A1)", "TRUE"],
    ["=VALUETOTEXT(A2)", "1234.01234"],
    ["=VALUETOTEXT(A3)", "Hello"],
    ["=VALUETOTEXT(A3, 1)", '"Hello"'],
    ["=VALUETOTEXT(B1, 1)", "#DIV/0!"],
    // A quote in strict text is doubled, as in a formula.
    ['=VALUETOTEXT("a""b", 1)', '"a""b"'],
    ['=VALUETOTEXT({1,"a"}, 1)', [["1", '"a"']]],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual(want);
  });

  it.each([
    ["=ARRAYTOTEXT({1,2}, 2)", "#VALUE!"],
    ['=VALUETOTEXT(1, "x")', "#VALUE!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("outside double-byte languages a byte is a character, as in Excel", () => {
    expect(at('=LENB("abc")')).toBe(3);
    expect(at('=LEFTB("abcdef", 2)')).toBe("ab");
    expect(at('=RIGHTB("abc")')).toBe("c");
    expect(at('=MIDB("abcdef", 2, 3)')).toBe("bcd");
    expect(at('=FINDB("c", "abc")')).toBe(3);
    expect(at('=SEARCHB("C", "abc")')).toBe(3);
    expect(at('=REPLACEB("abc", 2, 1, "X")')).toBe("aXc");
    expect(at('=LENB({"a","bc"})')).toEqual([[1, 2]]);
  });
});

describe("sheets", () => {
  it.each([
    ["=SHEET()", 1],
    ["=SHEET(Second!A1)", 2],
    ['=SHEET("Third")', 3],
    ['=SHEET("third")', 3],
    ["=SHEET(Spot)", 3],
    ["=SHEET(B2)", 1],
    ["=SHEETS()", 3],
    ["=SHEETS(Third!A1:B2)", 1],
    ["=AREAS(B2:D4)", 1],
    ["=AREAS(Spot)", 1],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });

  it.each([
    ['=SHEET("Nope")', "#N/A"],
    ["=SHEET(5)", "#VALUE!"],
    ["=SHEETS(5)", "#REF!"],
    ["=AREAS(5)", "#VALUE!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("follow the tabs when they are dragged", () => {
    const w = book();
    expect(w.getValue("b", 0, 0)).toBe(2);
    w.setSheetOrder(["b", "a", "c"]);
    expect(w.getValue("b", 0, 0)).toBe(1);
    expect(w.evaluateAt("a", 9, 9, "=SHEET()")).toBe(2);
    expect(w.listSheets().map((s) => s.name)).toEqual(["Second", "First", "Third"]);
    // An order that leaves a sheet out keeps it, after the rest.
    w.setSheetOrder(["c"]);
    expect(w.listSheets().map((s) => s.name)).toEqual(["Third", "Second", "First"]);
    expect(w.getValue("b", 0, 0)).toBe(2);
  });

  it("count a new sheet, and lose a removed one", () => {
    const w = book();
    w.addSheet({ id: "d", name: "Fourth", kind: "grid", grid: { cells: {} } });
    expect(w.evaluateAt("a", 9, 9, "=SHEETS()")).toBe(4);
    w.removeSheet("a");
    expect(w.getValue("b", 0, 0)).toBe(1);
  });
});

describe("the old names of the normal distribution", () => {
  it.each([
    ["=NORMSDIST(1)", 0.841344746],
    ["=NORMSINV(0.908789)", 1.333334673],
    ["=NORMINV(0.908789, 40, 1.5)", 42.000002],
  ])("%s is %s", (f, want) => {
    expect(at(f) as number).toBeCloseTo(want, 6);
  });
  it("refuse what the new ones refuse, and lift", () => {
    expect(at("=NORMINV(0, 0, 1)")).toEqual({ err: "#NUM!" });
    expect(at("=NORMSINV(1)")).toEqual({ err: "#NUM!" });
    expect(at("=NORMSDIST({0,1})")).toEqual([[0.5, expect.closeTo(0.841344746, 6)]]);
    for (const name of ["NORMSDIST", "NORMINV", "VALUETOTEXT", "LENB"])
      expect(LIFTS.has(name)).toBe(true);
    for (const name of ["ARRAYTOTEXT", "WRAPROWS", "EXPAND", "SHEET"])
      expect(LIFTS.has(name)).toBe(false);
  });
});
