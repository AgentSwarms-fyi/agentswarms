// LAMBDA and the functions that take one (R328).
//
// FOUND IN THE GAP REVIEW: LAMBDA was #NAME?. A workbook that defined its own
// functions (a named LAMBDA such as =DOUBLE(B2), or MAP, REDUCE, BYROW) came
// in showing only the values Excel last saved, and never recomputed when an
// input changed. LET could not hold a function, LAMBDA(x, x*2)(3) did not
// parse, and a download wrote LET's names bare where Excel wants _xlpm.x.
import { describe, expect, it } from "vitest";

import { WorkbookEngine, type GridData, type SheetDef } from "@/lib/sheets/engine";
import { parseFormula } from "@/lib/sheets/formula/parser";
import type { Value } from "@/lib/sheets/formula/values";
import {
  computable,
  computableNames,
  fromFileFormula,
  readXlsx,
  toFileFormula,
  writeXlsx,
} from "@/lib/sheets/xlsx";
import { lambdaPreview, type DefinedName } from "@/lib/sheets/definedNames";

const cells = (m: Record<string, string>): GridData["cells"] =>
  Object.fromEntries(Object.entries(m).map(([k, i]) => [k, { i }]));

// A1:A3 = 1, 2, 3; B1:C2 = 1 2 / 3 4.
const defs = (): SheetDef[] => [
  {
    id: "s",
    name: "S",
    kind: "grid",
    grid: {
      cells: cells({
        "0,0": "1",
        "1,0": "2",
        "2,0": "3",
        "0,1": "1",
        "0,2": "2",
        "1,1": "3",
        "1,2": "4",
      }),
    },
  },
];
// Not FACT, ISEVEN or ISODD: those are Excel's own functions, which a call
// reaches first, so a test through them would never reach the name.
const NAMES: DefinedName[] = [
  { name: "DOUBLE", ref: "LAMBDA(x, x*2)" },
  { name: "MYFACT", ref: "LAMBDA(n, IF(n<2, 1, n*MYFACT(n-1)))" },
  { name: "EVENP", ref: "LAMBDA(n, IF(n=0, TRUE, ODDP(n-1)))" },
  { name: "ODDP", ref: "LAMBDA(n, IF(n=0, FALSE, EVENP(n-1)))" },
  { name: "FOREVER", ref: "LAMBDA(n, FOREVER(n+1))" },
  { name: "SEVEN", ref: "7" },
  { name: "SUMTO", ref: "LAMBDA(n, IF(n=0, 0, n+SUMTO(n-1)))" },
  { name: "SUMTO2", ref: "LAMBDA(n, acc, IF(n=0, acc, SUMTO2(n-1, acc+n)))" },
];
const e = new WorkbookEngine(defs(), undefined, { names: NAMES });
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
/** Evaluated at J10, clear of the data; a one-cell answer as its value. */
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};

describe("a LAMBDA called where it is written", () => {
  it.each([
    ["=LAMBDA(x, x*2)(3)", 6],
    ["=LAMBDA(x, y, x+y)(1, 2)", 3],
    // a and b read as columns only before a colon.
    ["=LAMBDA(a, b, a*b)(4, 5)", 20],
    ["=LAMBDA(temp, (5/9)*(temp-32))(212)", 100],
    ["=LAMBDA(r, SUM(r))(A1:A3)", 6],
    ["=LAMBDA(x, LAMBDA(y, x+y))(1)(2)", 3],
    ["=LAMBDA(x, [y], IF(ISOMITTED(y), x, x+y))(1)", 1],
    ["=LAMBDA(x, [y], IF(ISOMITTED(y), x, x+y))(1, 2)", 3],
    ["=LAMBDA(x, [y], ISOMITTED(y))(1, )", true],
    ["=LAMBDA(x, [y], ISOMITTED(x))(1)", false],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual(want);
  });

  it("is #CALC! when nothing calls it, as Excel shows it", () => {
    expect(at("=LAMBDA(x, x*2)")).toEqual({ err: "#CALC!" });
  });

  it.each([
    ["=LAMBDA(x, x)(1, 2)", "#VALUE!"],
    ["=LAMBDA(x, y, x)(1)", "#VALUE!"],
    ["=LAMBDA(x, x, 1)(1, 2)", "#VALUE!"],
    ["=LAMBDA(1, 2)(3)", "#VALUE!"],
    ["=LAMBDA()", "#VALUE!"],
    ["=(5)(3)", "#VALUE!"],
    ["=LAMBDA(x, x)(1)(2)", "#VALUE!"],
    ["=LAMBDA(x, 1/0)(1)", "#DIV/0!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("a LAMBDA given a name by LET", () => {
  it.each([
    ["=LET(f, LAMBDA(x, x*2), f(5))", 10],
    ["=LET(n, 3, f, LAMBDA(x, x*n), f(2))", 6],
    ["=LET(f, LAMBDA(x, x+1), g, LAMBDA(x, f(x)*10), g(1))", 20],
    ["=LET(f, LAMBDA(x, x*2), MAP(A1:A3, f))", [[2], [4], [6]]],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual(want);
  });

  it("sees the names given before it, not after, as in Excel", () => {
    expect(at("=LET(f, LAMBDA(x, x*y), y, 3, f(2))")).toEqual({ err: "#NAME?" });
  });

  it("and a name holding a value can't be called", () => {
    expect(at("=LET(f, 5, f(3))")).toEqual({ err: "#VALUE!" });
    expect(at("=NOSUCHFUNCTION(3)")).toEqual({ err: "#NAME?" });
  });
});

describe("the functions that take a LAMBDA", () => {
  it.each([
    ["=MAP(A1:A3, LAMBDA(x, x*10))", [[10], [20], [30]]],
    [
      "=MAP(B1:C2, B1:C2, LAMBDA(x, y, x*y))",
      [
        [1, 4],
        [9, 16],
      ],
    ],
    ["=REDUCE(0, A1:A3, LAMBDA(a, v, a+v))", 6],
    ["=REDUCE(1, B1:C2, LAMBDA(a, v, a*v))", 24],
    ['=REDUCE("", {"a","b","c"}, LAMBDA(a, v, a&v))', "abc"],
    ["=REDUCE(, A1:A3, LAMBDA(a, v, a+v))", 6],
    ["=SCAN(0, {1,2,3}, LAMBDA(a, v, a+v))", [[1, 3, 6]]],
    ["=SCAN(0, A1:A3, LAMBDA(a, v, a+v))", [[1], [3], [6]]],
    ["=BYROW(B1:C2, LAMBDA(r, SUM(r)))", [[3], [7]]],
    ["=BYCOL(B1:C2, LAMBDA(c, MAX(c)))", [[3, 4]]],
    ["=BYROW(B1:C2, LAMBDA(r, COLUMNS(r)))", [[2], [2]]],
    ["=BYCOL(B1:C2, LAMBDA(c, ROWS(c)))", [[2, 2]]],
    [
      "=MAKEARRAY(2, 3, LAMBDA(r, c, r*c))",
      [
        [1, 2, 3],
        [2, 4, 6],
      ],
    ],
    ["=SUM(MAP(A1:A3, LAMBDA(x, x^2)))", 14],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual(want);
  });

  it.each([
    ["=MAP(A1:A3, B1:C2, LAMBDA(x, y, x))", "#VALUE!"],
    // The smaller first: without the check it would read only the corner it shares.
    ["=MAP(A1:A2, B1:C2, LAMBDA(x, y, x))", "#VALUE!"],
    ["=MAP(A1:A3, 5)", "#VALUE!"],
    ["=MAP(A1:A3)", "#VALUE!"],
    ["=MAKEARRAY(0, 2, LAMBDA(r, c, 1))", "#VALUE!"],
    ["=MAKEARRAY(2000, 2000, LAMBDA(r, c, 1))", "#NUM!"],
    ["=BYROW(B1:C2)", "#VALUE!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("each call in MAP gives one value: an array there is #CALC!", () => {
    expect(at("=MAP({1,2}, LAMBDA(x, {1,2}))")).toEqual([[{ err: "#CALC!" }, { err: "#CALC!" }]]);
  });
});

describe("a workbook name that holds a LAMBDA", () => {
  it.each([
    ["=DOUBLE(21)", 42],
    ["=DOUBLE(A3)+1", 7],
    ["=MYFACT(5)", 120],
    ["=EVENP(10)", true],
    ["=ODDP(7)", true],
    ["=MAP(A1:A3, DOUBLE)", [[2], [4], [6]]],
    ["=double(2)", 4],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual(want);
  });

  it("stops a recursion that never ends at #NUM!", () => {
    expect(at("=FOREVER(1)")).toEqual({ err: "#NUM!" });
  });

  it("goes as deep as Excel: 1,024 / (parameters + 1) calls", () => {
    // SUMTO(510) is 511 calls; Excel computes it and is #NUM! at SUMTO(511).
    expect(at("=SUMTO(510)")).toBe(130305);
    expect(at("=SUMTO(511)")).toEqual({ err: "#NUM!" });
    // Two parameters: 341 calls.
    expect(at("=SUMTO2(339, 0)")).toBe(57630);
    expect(at("=SUMTO2(340, 0)")).toEqual({ err: "#NUM!" });
  });

  it("but a name holding a value can't be called", () => {
    expect(at("=SEVEN(1)")).toEqual({ err: "#VALUE!" });
  });

  it("recomputes when an input changes, and is not an unknown function", () => {
    const w = new WorkbookEngine(
      [
        {
          id: "s",
          name: "S",
          kind: "grid",
          grid: { cells: cells({ "0,0": "4", "0,1": "=DOUBLE(A1)" }) },
        },
      ],
      undefined,
      { names: NAMES },
    );
    expect(w.getValue("s", 0, 1)).toBe(8);
    expect(w.unknownFunctions("s", 0, 1)).toEqual([]);
    w.setInputs("s", [{ row: 0, col: 0, input: "10" }]);
    expect(w.getValue("s", 0, 1)).toBe(20);
  });
});

describe("Name Manager", () => {
  it("shows a LAMBDA name's parameters, not the #CALC! of a function nobody called", () => {
    expect(lambdaPreview("LAMBDA(x, x*2)")).toBe("LAMBDA(x)");
    expect(lambdaPreview("=LAMBDA(x, [y], x)")).toBe("LAMBDA(x, [y])");
    expect(lambdaPreview("LAMBDA(42)")).toBe("LAMBDA()");
    expect(lambdaPreview("LAMBDA(1, 2)")).toBeNull();
    expect(lambdaPreview("Sheet1!$A$1")).toBeNull();
    expect(lambdaPreview("LAMBDA(x, x)(3)")).toBeNull();
  });
});

describe("a cell holding a LAMBDA", () => {
  it("shows #CALC!, and another cell can't call it through the reference", () => {
    const w = new WorkbookEngine([
      {
        id: "s",
        name: "S",
        kind: "grid",
        grid: {
          cells: cells({
            "0,0": "=LAMBDA(x, x*2)",
            "0,1": "=(A1)(3)",
            "0,2": "=LET(f, LAMBDA(x, x), f(1))",
          }),
        },
      },
    ]);
    const a1 = w.getValue("s", 0, 0) as { err: string; fn?: unknown };
    expect(a1).toMatchObject({ err: "#CALC!" });
    expect(a1.fn).toBeUndefined();
    expect(w.getValue("s", 0, 1)).toMatchObject({ err: "#CALC!" });
    // f is the formula's own name, not a function this engine lacks.
    expect(w.unknownFunctions("s", 0, 2)).toEqual([]);
    expect(w.getValue("s", 0, 2)).toBe(1);
  });
});

describe("the parser", () => {
  it("reads a call on a call, and on brackets", () => {
    expect(parseFormula("LAMBDA(x,x)(1)")).toMatchObject({
      k: "invoke",
      fn: { k: "call", name: "LAMBDA" },
      args: [{ k: "num", v: 1 }],
    });
    expect(parseFormula("(A1)(2,)")).toMatchObject({
      k: "invoke",
      fn: { k: "cell" },
      args: [{ k: "num", v: 2 }, { k: "empty" }],
    });
  });
});

describe("in a file", () => {
  it.each([
    ["=LET(x,1,x+1)", "_xlfn.LET(_xlpm.x,1,_xlpm.x+1)"],
    // XlsxWriter's own example.
    ["=LAMBDA(temp,(5/9)*(temp-32))(32)", "_xlfn.LAMBDA(_xlpm.temp,(5/9)*(_xlpm.temp-32))(32)"],
    ["=MAP(A1:A3,LAMBDA(x,x*2))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2))"],
    ["=LET(f,LAMBDA(x,x*2),f(3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2),_xlpm.f(3))"],
    [
      "=LAMBDA(x,[y],ISOMITTED(y))(1)",
      "_xlfn.LAMBDA(_xlpm.x,[_xlpm.y],_xlfn.ISOMITTED(_xlpm.y))(1)",
    ],
    // The x after the LET is a workbook name: it stays bare.
    ["=LET(x,1,x)+x", "_xlfn.LET(_xlpm.x,1,_xlpm.x)+x"],
    [
      "=REDUCE(0,A1:A3,LAMBDA(a,v,a+v))",
      "_xlfn.REDUCE(0,A1:A3,_xlfn.LAMBDA(_xlpm.a,_xlpm.v,_xlpm.a+_xlpm.v))",
    ],
    ["=DOUBLE(2)", "DOUBLE(2)"],
  ])("%s goes out as %s, and comes back", (f, file) => {
    expect(toFileFormula(f)).toBe(file);
    expect(`=${fromFileFormula(file)}`).toBe(f);
  });

  it("computes here: a LAMBDA, its helpers and the names that hold one", () => {
    expect(computable("=LAMBDA(x,x*2)(3)")).toBe(true);
    expect(computable("=LET(f,LAMBDA(x,x*2),f(3))")).toBe(true);
    expect(computable("=MAP(A1:A3,LAMBDA(x,[y],ISOMITTED(y)))")).toBe(true);
    expect(computable("=LET(f,LAMBDA(x,x*y),f(1))")).toBe(false);
    expect(computable("=LAMBDA(1,2)(3)")).toBe(false);
    expect(computable("=g(1)")).toBe(false);
    expect(computable("=DOUBLE(1)", new Set(["double"]))).toBe(true);
    const known = computableNames([
      ...NAMES,
      { name: "X", ref: "Y" },
      { name: "Y", ref: "X" },
      { name: "BROKEN", ref: "LAMBDA(n, NOSUCHFN(n))" },
      { name: "CALLSBROKEN", ref: "LAMBDA(n, BROKEN(n))" },
      { name: "USESDOUBLE", ref: "DOUBLE(SEVEN)" },
    ]);
    expect([...known].sort()).toEqual(
      [
        "double",
        "myfact",
        "forever",
        "evenp",
        "oddp",
        "seven",
        "sumto",
        "sumto2",
        "usesdouble",
      ].sort(),
    );
  });

  it("round trip: a named LAMBDA comes back and computes, not Excel's saved value", async () => {
    const book: SheetDef[] = [
      {
        id: "s",
        name: "S",
        kind: "grid",
        grid: { cells: cells({ "0,0": "4", "0,1": "=DOUBLE(A1)", "0,2": "=MYFACT(A1)" }) },
      },
    ];
    const names: DefinedName[] = [NAMES[0], NAMES[1]];
    const w = new WorkbookEngine(book, undefined, { names });
    const buf = await writeXlsx(
      [
        {
          kind: "grid" as const,
          name: "S",
          grid: w.snapshot("s")!,
          value: (r: number, c: number) => w.getValue("s", r, c),
        },
      ],
      { names },
    );
    const back = await readXlsx(buf, { maxCells: 1000 });
    expect(back.names.map((d) => [d.name, d.ref.replace(/\s/g, "")])).toEqual([
      ["DOUBLE", "LAMBDA(x,x*2)"],
      ["MYFACT", "LAMBDA(n,IF(n<2,1,n*MYFACT(n-1)))"],
    ]);
    const g = back.sheets[0].grid;
    expect(g.cells["0,1"]).toMatchObject({ i: "=DOUBLE(A1)" });
    expect(g.cells["0,1"].c).toBeUndefined();
    const r = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: g }], undefined, {
      names: back.names,
    });
    r.setInputs("s", [{ row: 0, col: 0, input: "5" }]);
    expect(r.getValue("s", 0, 1)).toBe(10);
    expect(r.getValue("s", 0, 2)).toBe(120);
  });
});
