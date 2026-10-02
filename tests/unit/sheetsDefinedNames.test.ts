// R148. Named ranges (Excel's defined names). Sheets had none: an Excel
// model whose formulas used =SUM(Revenue)*TaxRate imported showing the value
// Excel last saved, said to "refer to something outside this workbook", and
// never changed when an input did; the import dropped the names without a
// word. Here: the names' rules, the engine computing with them, the moves
// they follow (rows inserted, cells shifted, a sheet or the name renamed),
// who sees which, and the round trip through an .xlsx.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_NAMES,
  adjustNames,
  nameProblem,
  nameTarget,
  namesFromWorkbookXml,
  namesProblem,
  namesShown,
  namesToWorkbookXml,
  qualifyRef,
  refForRange,
  renameNameInFormula,
  sheetsIn,
  valuePreview,
  type DefinedName,
} from "@/lib/sheets/definedNames";
import { workbookContext } from "@/lib/sheets/assistRuntime";
import { WorkbookEngine, type GridData, type SheetDef } from "@/lib/sheets/engine";
import { renameSheetInFormula } from "@/lib/sheets/formula/shift";
import { adjustFormula, mapRuleFormulas } from "@/lib/sheets/ops";
import { adjustFormulaForShift } from "@/lib/sheets/shiftCells";
import {
  addDefinedNames,
  computable,
  computableNames,
  readXlsx,
  writeXlsx,
} from "@/lib/sheets/xlsx";

const cells = (m: Record<string, string>): GridData["cells"] =>
  Object.fromEntries(Object.entries(m).map(([k, i]) => [k, { i }]));

// Data: B1 Revenue, B2:B4 10 20 30, E1 0.1. 'Q 3': A1 5.
const sheets = (): SheetDef[] => [
  {
    id: "d",
    name: "Data",
    kind: "grid",
    grid: {
      cells: cells({ "0,1": "Revenue", "1,1": "10", "2,1": "20", "3,1": "30", "0,4": "0.1" }),
    },
  },
  { id: "q", name: "Q 3", kind: "grid", grid: { cells: cells({ "0,0": "5" }) } },
];
const NAMES: DefinedName[] = [
  { name: "Revenue", ref: "Data!$B$2:$B$4", comment: "Monthly revenue" },
  { name: "Rate", ref: "Data!$E$1" },
  { name: "TaxRate", ref: "0.2" },
  { name: "Other", ref: "'Q 3'!$A$1" },
  { name: "Doubled", ref: "SUM(Revenue)*2" },
  { name: "Loop", ref: "Loop+1" },
  { name: "PingA", ref: "PingB" },
  { name: "PingB", ref: "PingA" },
];
const at = (e: WorkbookEngine, f: string) => e.evaluateAt("d", 20, 20, f);

describe("a name's rules, as Excel's", () => {
  it("takes letters, digits, periods and underscores, starting with a letter or _", () => {
    for (const ok of ["Revenue", "_x", "Tax.Rate", "Q3_total", "Ventes_Été"])
      expect(nameProblem(ok), ok).toBeNull();
    for (const bad of ["1abc", "has space", "a-b", "$B$2", "", "  "])
      expect(nameProblem(bad), bad).not.toBeNull();
  });
  it("refuses what reads as a cell, R1C1 or a value", () => {
    for (const bad of ["A1", "XFD1048576", "R1C1", "R", "C", "r2", "TRUE", "false"])
      expect(nameProblem(bad), bad).toMatch(/reads as a cell|value in Excel/);
  });
  it("is unique in any case", () => {
    expect(nameProblem("revenue", ["Revenue"])).toMatch(/already a name/);
    expect(nameProblem("Revenue2", ["Revenue"])).toBeNull();
  });
  it("a list is checked whole: names, references, how many", () => {
    expect(namesProblem(NAMES)).toBeNull();
    expect(
      namesProblem([
        { name: "A_", ref: "1" },
        { name: "a_", ref: "2" },
      ]),
    ).toMatch(/a_: There is already/);
    expect(namesProblem([{ name: "Bad", ref: "SUM(" }])).toMatch(/Bad: .*not a reference/);
    const many = Array.from({ length: MAX_NAMES + 1 }, (_, i) => ({ name: `n${i}_`, ref: "1" }));
    expect(namesProblem(many)).toMatch(/at most 1000/);
  });
});

describe("the engine computes with them", () => {
  const engine = () => new WorkbookEngine(sheets(), undefined, { names: NAMES });

  it("a range, a cell, a value, a quoted sheet, a name made of names", () => {
    const e = engine();
    expect(at(e, "=SUM(Revenue)")).toBe(60);
    expect(at(e, "=SUM(Revenue)*Rate")).toBe(6);
    expect(at(e, "=SUM(Revenue)*TaxRate")).toBe(12);
    expect(at(e, "=Other*2")).toBe(10);
    expect(at(e, "=Doubled")).toBe(120);
    expect(at(e, "=SUM(revenue)")).toBe(60); // names ignore case
  });
  it("wherever a reference is taken: INDEX, ROWS, OFFSET, SUMIFS, MATCH", () => {
    const e = engine();
    expect(at(e, "=ROWS(Revenue)")).toBe(3);
    expect(at(e, "=INDEX(Revenue,2)")).toBe(20);
    expect(at(e, "=OFFSET(Revenue,1,0,1,1)")).toBe(20);
    expect(at(e, '=SUMIFS(Revenue,Revenue,">15")')).toBe(50);
    expect(at(e, "=MATCH(30,Revenue,0)")).toBe(3);
    expect(at(e, "=ISREF(Revenue)")).toBe(true);
    expect(at(e, "=ISREF(TaxRate)")).toBe(false);
  });
  it("a name that uses itself says so; an unknown one is #NAME?", () => {
    const e = engine();
    expect(at(e, "=Loop")).toMatchObject({ err: "#CYCLE!" });
    expect(at(e, "=PingA")).toMatchObject({ err: "#CYCLE!" });
    expect(at(e, "=Missing*2")).toMatchObject({ err: "#NAME?" });
  });
  it("LET's own names come before the workbook's", () => {
    expect(at(engine(), "=LET(Revenue,5,Revenue*2)")).toBe(10);
  });
  it("a cell that uses one follows its inputs, and a redefinition", () => {
    const e = engine();
    e.setInputs("q", [{ row: 5, col: 0, input: "=SUM(Revenue)" }]);
    expect(e.getValue("q", 5, 0)).toBe(60);
    e.setInputs("d", [{ row: 1, col: 1, input: "100" }]);
    expect(e.getValue("q", 5, 0)).toBe(150);
    e.setDefinedNames(NAMES.map((d) => (d.name === "Revenue" ? { ...d, ref: "Data!$B$3" } : d)));
    expect(e.getValue("q", 5, 0)).toBe(20);
    e.setDefinedNames([]);
    expect(e.getValue("q", 5, 0)).toMatchObject({ err: "#NAME?" });
  });
  it("names given as it is built are there for its first computation", () => {
    const defs = sheets();
    defs[1].grid!.cells["5,0"] = { i: "=SUM(Revenue)*TaxRate" };
    expect(new WorkbookEngine(defs, undefined, { names: NAMES }).getValue("q", 5, 0)).toBe(12);
  });
  it("hands out the same list until the names change", () => {
    const e = engine();
    const a = e.definedNames();
    e.setInputs("d", [{ row: 9, col: 9, input: "1" }]);
    expect(e.definedNames()).toBe(a);
    e.setDefinedNames([NAMES[0]]);
    expect(e.definedNames()).not.toBe(a);
    expect(e.definedNames()).toEqual([NAMES[0]]);
  });
  it("what a name comes to, as the Name Manager shows it", () => {
    const e = engine();
    const show = (ref: string) => valuePreview(e.evaluateAt("d", 0, 0, `=${ref}`, { array: true }));
    expect(show("Data!$B$2:$B$4")).toBe("{10;20;30} (3×1)");
    expect(show("0.2")).toBe("0.2");
    expect(show('"West"')).toBe('"West"');
    expect(show("Nope!A1")).toBe("#REF!");
    expect(valuePreview([Array.from({ length: 20 }, (_, i) => i)])).toBe(
      "{0,1,2,3,4,5,6,7,8,9,10,11;…} (1×20)",
    );
  });
});

describe("the Name box and the Name Manager's references", () => {
  it("a selection's reference is absolute and says its sheet", () => {
    expect(refForRange("Data", { r0: 1, c0: 1, r1: 3, c1: 1 })).toBe("Data!$B$2:$B$4");
    expect(refForRange("Data", { r0: 0, c0: 4, r1: 0, c1: 4 })).toBe("Data!$E$1");
    expect(refForRange("Q 3", { r0: 0, c0: 0, r1: 0, c1: 0 })).toBe("'Q 3'!$A$1");
    expect(refForRange("It's", { r0: 0, c0: 0, r1: 1, c1: 1 })).toBe("'It''s'!$A$1:$B$2");
  });
  it("a typed reference without its sheet is on the active one", () => {
    expect(qualifyRef("B2:B9", "Data")).toBe("Data!B2:B9");
    expect(qualifyRef("=SUM(A1:A2)*2", "Q 3")).toBe("SUM('Q 3'!A1:A2)*2");
    expect(qualifyRef("Other!A1+B1", "Data")).toBe("Other!A1+Data!B1");
    expect(qualifyRef("0.2", "Data")).toBe("0.2");
    expect(qualifyRef('"A1"&Rate', "Data")).toBe('"A1"&Rate');
  });
  it("a name for cells goes to them; a name for a value goes nowhere", () => {
    expect(nameTarget("Data!$B$2:$B$4")).toEqual({
      sheet: "Data",
      range: { r0: 1, c0: 1, r1: 3, c1: 1 },
      wholeCols: undefined,
      wholeRows: undefined,
    });
    expect(nameTarget("'Q 3'!$A$1")?.sheet).toBe("Q 3");
    expect(nameTarget("Data!B:B")?.wholeCols).toBe(true);
    expect(nameTarget("0.2")).toBeNull();
    expect(nameTarget("B2")).toBeNull();
    expect(nameTarget("SUM(Data!B2:B4)")).toBeNull();
  });
});

describe("names move as formulas do", () => {
  // As the editor does it: the rewrite the cells get, for a formula on no sheet.
  const rows = (at: number, n: number) => (f: string) =>
    adjustFormula(f, "", "Data", "rows", at, n);

  it("rows inserted above a name's cells push it down; elsewhere, nothing moves", () => {
    const moved = adjustNames(NAMES, rows(0, 1));
    expect(moved.find((d) => d.name === "Revenue")!.ref).toBe("Data!$B$3:$B$5");
    expect(moved.find((d) => d.name === "Rate")!.ref).toBe("Data!$E$2");
    // Untouched names are the same objects (the page compares them).
    expect(moved.find((d) => d.name === "Other")).toBe(NAMES.find((d) => d.name === "Other"));
    expect(moved.find((d) => d.name === "TaxRate")).toBe(NAMES.find((d) => d.name === "TaxRate"));
    // The comment goes with it.
    expect(moved.find((d) => d.name === "Revenue")!.comment).toBe("Monthly revenue");
  });
  it("a reference without a sheet is not taken for the changed sheet's", () => {
    expect(adjustNames([{ name: "Bare", ref: "B2" }], rows(0, 1))[0].ref).toBe("B2");
  });
  it("rows deleted inside shrink it; deleting all of it is #REF!, which computes as such", () => {
    expect(adjustNames([NAMES[0]], rows(2, -1))[0].ref).toBe("Data!$B$2:$B$3");
    const gone = adjustNames([NAMES[0]], rows(1, -3));
    expect(gone[0].ref).toBe("#REF!");
    expect(at(new WorkbookEngine(sheets(), undefined, { names: gone }), "=SUM(Revenue)")).toEqual(
      expect.objectContaining({ err: "#REF!" }),
    );
  });
  it("cells shifted down under it take it along", () => {
    const moved = adjustNames([NAMES[0]], (f) =>
      adjustFormulaForShift(f, "", "Data", { r0: 0, c0: 1, r1: 0, c1: 1 }, "down"),
    );
    expect(moved[0].ref).toBe("Data!$B$3:$B$5");
  });
  it("a sheet renamed: the names into it say the new name", () => {
    const moved = adjustNames(NAMES, (f) => renameSheetInFormula(f, "Q 3", "Quarter 3"));
    expect(moved.find((d) => d.name === "Other")!.ref).toBe("'Quarter 3'!$A$1");
    expect(moved.find((d) => d.name === "Revenue")).toBe(NAMES[0]);
  });
  it("a name renamed: formulas, rule formulas and other names that use it follow", () => {
    const fn = (f: string) => renameNameInFormula(f, "Revenue", "Sales");
    expect(fn("=SUM(Revenue)*revenue2+REVENUE")).toBe("=SUM(Sales)*revenue2+Sales");
    expect(fn('="Revenue"&Revenue')).toBe('="Revenue"&Sales');
    // A function is not a name, even with the same letters.
    expect(renameNameInFormula("=SUM(Sum)", "Sum", "Total")).toBe("=SUM(Total)");
    expect(adjustNames(NAMES, fn).find((d) => d.name === "Doubled")!.ref).toBe("SUM(Sales)*2");
    const grid: GridData = {
      cells: {},
      cond: [
        {
          id: "c1",
          ranges: ["A1:A5"],
          rule: { kind: "formula", formula: "=A1>AVERAGE(Revenue)" },
          style: { bold: true },
        },
      ],
    } as unknown as GridData;
    const out = mapRuleFormulas(grid, fn);
    expect(out).not.toBe(grid);
    expect((out.cond![0].rule as { formula: string }).formula).toBe("=A1>AVERAGE(Sales)");
    expect(mapRuleFormulas(grid, (f) => f)).toBe(grid);
  });
});

describe("who sees which names", () => {
  const shownBut = (hidden: string[]) => (s: string) => !hidden.includes(s.toLowerCase());
  it("the sheets and table sheets a name reads", () => {
    expect(sheetsIn("SUM(Data!B2:B4)*'Q 3'!A1")).toEqual(["data", "q 3"]);
    expect(sheetsIn("SUM(Orders[amount])")).toEqual(["orders"]);
    expect(sheetsIn("0.2")).toEqual([]);
  });
  it("a viewer whose share leaves a sheet out is not told of names into it", () => {
    const names: DefinedName[] = [
      ...NAMES,
      { name: "Paid", ref: "SUM(Orders[amount])" },
      { name: "Gone", ref: "Deleted!$A$1" },
    ];
    const seen = namesShown(names, shownBut(["q 3", "orders"])).map((d) => d.name);
    expect(seen).not.toContain("Other");
    expect(seen).not.toContain("Paid");
    // A value, a name made of names, a name into a sheet no longer there: shown.
    expect(seen).toEqual(expect.arrayContaining(["Revenue", "TaxRate", "Doubled", "Gone"]));
    expect(namesShown(names, () => true)).toHaveLength(names.length);
  });
  it("the server filters with it, and only an editor saves names", () => {
    const src = readFileSync("src/utils/sheets.functions.ts", "utf8");
    const body = (name: string) => src.split(`export const ${name} = createServerFn`)[1] ?? "";
    // The whole call: the stored names, kept only where the caller's access shows each sheet.
    expect(body("sheetsGet")).toMatch(
      /names: namesShown\(\(wb\.names \?\? \[\]\) as unknown as DefinedName\[\], \(s\) =>\s*sheetShown\(access, s\),\s*\),/,
    );
    expect(body("sheetsSetNames")).toMatch(/requireAccess\([^)]*"edit"\)/);
    expect(body("sheetsSetNames")).toMatch(/namesProblem\(data\.names\)/);
    expect(body("sheetsImportGrids")).toMatch(/namesProblem\(data\.names\)/);
  });
  it("a version keeps the names, and restoring one brings them back", () => {
    expect(readFileSync("src/utils/sheets/versions.server.ts", "utf8")).toMatch(/names: \(wbRow/);
    const v = readFileSync("src/utils/sheetsVersions.functions.ts", "utf8");
    expect(v).toMatch(/\.\.\.\(v\.names \? \{ names: v\.names \} : \{\}\)/);
    expect(v).toMatch(/names: v\.names \?\? \[\]/);
  });
});

describe("the page keeps names with the workbook", () => {
  const src = readFileSync("src/components/sheets/useWorkbook.ts", "utf8");
  const between = (from: string, to: string) => {
    const a = src.indexOf(from);
    expect(a, from).toBeGreaterThan(-1);
    return src.slice(a, src.indexOf(to, a));
  };
  it("the engine is built with them, not given them after", () => {
    expect(src).toMatch(/new WorkbookEngine\(defs, resolver, \{ names: namesArgRef\.current/);
  });
  it("undoing an insert brings the names back as they were", () => {
    const s = between("const structural = useCallback", "const setNames = useCallback");
    expect(s).toMatch(/names: \{ before: namesBefore, after: namesAfter \}/);
    const r = between("const restore = ", "const undo = useCallback");
    expect(r).toMatch(/engine\.setDefinedNames\(entry\.names\[which\]/);
    expect(r).toMatch(/entry\.kind === "names"/);
  });
  it("renaming a sheet renames it in the names", () => {
    expect(between("const renameTabLocal", "const addNamesLocal")).toMatch(
      /adjustNames\(names, rewrite\)/,
    );
  });
  it("a file's names reach the engine before its sheets do", () => {
    const route = readFileSync("src/routes/_authenticated/sheets_.$workbookId.tsx", "utf8");
    const i = route.indexOf("wb.addNamesLocal(r.names)");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(route.indexOf("wb.addTabLocal(tab)", i));
  });
  it("the editor moves them with inserts, deletes and shifts, and renames them everywhere", () => {
    const ed = readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8");
    // A name lives on no sheet: "" as the formula's sheet, so only qualified references move.
    expect(ed).toContain('moveNames(eng, (f) => adjustFormula(f, "", target, axis, at, count));');
    expect(ed).toContain(
      'moveNames(eng, (f) => adjustFormulaForShift(f, "", target, range, dir));',
    );
    const rename = ed.slice(
      ed.indexOf("const changeNames = "),
      ed.indexOf("const nameBoxEnter = "),
    );
    expect(rename).toMatch(/renameNameInFormula\(f, renamed\.from, renamed\.to\)/);
    expect(rename).toMatch(/mapGridFormulas\(g, fn\)/);
    expect(rename).toMatch(/eng\.setDefinedNames\(adjustNames\(next, fn\), \{ recalc: false \}\)/);
  });
  it("an import sends the file's names, saying the sheets' names as they are here", () => {
    const d = readFileSync("src/components/sheets/ImportFileDialog.tsx", "utf8");
    expect(d).toMatch(
      /adjustNames\(parsed\.names \?\? \[\], \(f\) =>\s*renamed\.reduce\(\(out, r\) => renameSheetInFormula\(out, r\.from, r\.to\), f\)/,
    );
    expect(d).toMatch(/\.\.\.\(names\.length \? \{ names \} : \{\}\)/);
    // What the server kept goes to the page; what it had already stays its own.
    expect(d).toMatch(/names: names\.filter\(\(d\) => !skipped\.includes\(d\.name\)\)/);
  });
  it("the assistant is told the names", () => {
    const text = workbookContext({
      engine: new WorkbookEngine(sheets(), undefined, { names: NAMES }),
      workbookName: "Model",
      activeSheetId: "d",
      selection: "A1",
      focus: { row: 0, col: 0 },
    });
    expect(text).toMatch(/NAMES \(use in formulas by name/);
    expect(text).toMatch(/Revenue = Data!\$B\$2:\$B\$4 \(Monthly revenue\)/);
  });
});

describe("an .xlsx's names", () => {
  // ExcelJS loads once per worker, slowly under a full run; not the tests' time.
  beforeAll(async () => {
    await import("exceljs");
  }, 120_000);
  const fixture = () => {
    const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-names.xlsx"));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };

  it("are read from the workbook part: kept, left out and said why", () => {
    const xml =
      "<workbook><sheets/><definedNames>" +
      '<definedName name="Revenue" comment="Monthly &amp; more">Data!$B$2:$B$4</definedName>' +
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$E$9</definedName>' +
      '<definedName name="Helper" hidden="1">Data!$A$1</definedName>' +
      '<definedName name="Ext">[1]Prices!$A$1</definedName>' +
      '<definedName name="Two">Data!$B$2,Data!$B$4</definedName>' +
      '<definedName name="Local" localSheetId="0">Data!$E$1</definedName>' +
      '<definedName name="Local" localSheetId="1">\'Q 3\'!$A$1</definedName>' +
      '<definedName name="Cmp">Data!$A$1&lt;&gt;&quot;x&quot;</definedName>' +
      "</definedNames></workbook>";
    const r = namesFromWorkbookXml(xml);
    expect(r.names).toEqual([
      { name: "Revenue", ref: "Data!$B$2:$B$4", comment: "Monthly & more" },
      { name: "Local", ref: "Data!$E$1" },
      { name: "Cmp", ref: 'Data!$A$1<>"x"' },
    ]);
    expect(r.warnings.join("\n")).toMatch(/Ext points into another workbook/);
    expect(r.warnings.join("\n")).toMatch(/Two covers several areas/);
    expect(r.warnings.join("\n")).toMatch(/Local is defined for more than one sheet/);
  });

  it("come in with the file, and its formulas compute with them", async () => {
    const r = await readXlsx(fixture(), { maxCells: 200_000 });
    expect(r.names.map((d) => d.name)).toEqual(["Revenue", "Rate", "TaxRate", "Other", "Local"]);
    expect(r.names[0].comment).toBe("Monthly revenue");
    expect(r.warnings.join("\n")).toMatch(/Two covers several areas/);
    const data = r.sheets.find((s) => s.name === "Data")!;
    // Formulas over names compute here: no saved value kept for them...
    expect(data.grid.cells["2,3"]).toEqual({ i: "=SUM(Revenue)" });
    // ...but one over a name left out keeps Excel's, and is counted.
    expect(data.grid.cells["8,3"].c).toBe(40);
    expect(data.cachedFormulas).toBe(1);

    const e = new WorkbookEngine(
      r.sheets.map((s, i) => ({ id: `s${i}`, name: s.name, kind: "grid", grid: s.grid })),
      undefined,
      { names: r.names },
    );
    const col = (row: number) => e.getValue("s0", row, 3);
    expect([2, 3, 4, 5, 6, 7, 8].map(col)).toEqual([60, 6, 60, 12, 10, 10, 40]);
    expect(e.getValue("s1", 0, 1)).toBe(60);
    expect(e.getValue("s1", 1, 1)).toBe(3);
    // An input changes; everything that used a name follows (it did not).
    e.setInputs("s0", [{ row: 1, col: 1, input: "100" }]);
    expect([2, 3, 4, 5].map(col)).toEqual([150, 15, 150, 30]);
  });

  it("which formulas compute: LET's own names and the workbook's that compute", () => {
    expect(computable("=LET(x,1,x+1)")).toBe(true);
    expect(computable("=LET(x,1,y)")).toBe(false);
    expect(computable("=LET(x,1)")).toBe(false);
    expect(computable("=SUM(Revenue)")).toBe(false);
    expect(computable("=SUM(Revenue)", new Set(["revenue"]))).toBe(true);
    expect(computable("=SUM(REVENUE)", new Set(["Revenue"]))).toBe(true);
    const known = computableNames([
      { name: "A", ref: "Data!$A$1" },
      { name: "B", ref: "A*2" },
      { name: "C", ref: "Two+1" },
      { name: "X", ref: "Y" },
      { name: "Y", ref: "X" },
      { name: "F", ref: "NOSUCHFN(1)" },
    ]);
    expect([...known].sort()).toEqual(["a", "b"]);
  });

  it("go out with the workbook, in the file's sheet names and function prefixes", async () => {
    const long = "A sheet name much longer than Excel allows";
    const defs: SheetDef[] = [
      ...sheets(),
      { id: "l", name: long, kind: "grid", grid: { cells: cells({ "0,0": "7" }) } },
    ];
    const names: DefinedName[] = [
      NAMES[0],
      NAMES[2],
      NAMES[3],
      { name: "Long", ref: `'${long}'!$A$1` },
      { name: "Uniq", ref: "UNIQUE(Data!$B$2:$B$4)" },
    ];
    const e = new WorkbookEngine(defs, undefined, { names });
    const buf = await writeXlsx(
      defs.map((s) => ({
        kind: "grid" as const,
        name: s.name,
        grid: e.snapshot(s.id)!,
        value: (r: number, c: number) => e.getValue(s.id, r, c),
      })),
      { names },
    );
    const xml = strFromU8(unzipSync(new Uint8Array(buf))["xl/workbook.xml"]);
    expect(xml).toMatch(
      /<\/sheets><definedNames><definedName name="Revenue" comment="Monthly revenue">/,
    );
    expect(xml).toContain("_xlfn.UNIQUE(Data!$B$2:$B$4)");
    const back = await readXlsx(buf, { maxCells: 200_000 });
    const cut = back.sheets[2].name;
    expect(cut.length).toBeLessThanOrEqual(31);
    expect(back.names).toEqual([
      NAMES[0],
      NAMES[2],
      NAMES[3],
      { name: "Long", ref: `'${cut}'!$A$1` },
      { name: "Uniq", ref: "UNIQUE(Data!$B$2:$B$4)" },
    ]);
  });

  it("join a <definedNames> the writer already made, or start one", () => {
    const block = namesToWorkbookXml([{ name: "A_", ref: "1" }]);
    expect(block).toBe('<definedNames><definedName name="A_">1</definedName></definedNames>');
    expect(namesToWorkbookXml([])).toBe("");
    const into = addDefinedNames(
      '<sheets></sheets><definedNames><definedName name="_xlnm._FilterDatabase">x</definedName></definedNames>',
      [{ name: "A_", ref: "1" }],
    );
    expect(into).toBe(
      '<sheets></sheets><definedNames><definedName name="A_">1</definedName><definedName name="_xlnm._FilterDatabase">x</definedName></definedNames>',
    );
    expect(addDefinedNames("<sheets></sheets><definedNames/>", [{ name: "A_", ref: "1" }])).toBe(
      `<sheets></sheets>${block}`,
    );
    expect(addDefinedNames("<sheets></sheets><calcPr/>", [{ name: "A_", ref: "1" }])).toBe(
      `<sheets></sheets>${block}<calcPr/>`,
    );
  });
});
