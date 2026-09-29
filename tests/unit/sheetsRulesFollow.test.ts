// R149. A sheet's rules hold formulas too: a validation list's source
// (=Lists!$A$1:$A$3) and a conditional format's formula. Inserting rows moved
// them, but three other changes rewrote the cells only:
//   - renaming a sheet: a list over it came up "empty" and refused its own
//     values ("Not allowed here");
//   - Insert/Delete cells: a list over the moved cells lost one and showed a
//     blank;
//   - an import that had to rename a sheet.
// Everything that rewrites formulas now goes through mapGridFormulas.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WorkbookEngine, type GridData, type SheetDef } from "@/lib/sheets/engine";
import { renameSheetInFormula, renameTableInFormula } from "@/lib/sheets/formula/shift";
import { isMatrix, type Scalar } from "@/lib/sheets/formula/values";
import { mapGridFormulas, renameSheetsInGrid } from "@/lib/sheets/ops";
import { adjustFormulaForShift, shiftCellsGrid } from "@/lib/sheets/shiftCells";
import { listItems, type DvEnv, type Validation } from "@/lib/sheets/validation";

const cells = (m: Record<string, string>): GridData["cells"] =>
  Object.fromEntries(Object.entries(m).map(([k, i]) => [k, { i }]));

/** The list rule's environment, as the editor builds it (useSheetRules). */
const dvEnv = (e: WorkbookEngine, sheetId: string): DvEnv => ({
  evaluate: (f, r, c) => {
    const v = e.evaluateAt(sheetId, r, c, f);
    return (isMatrix(v) ? (v[0]?.[0] ?? null) : v) as Scalar;
  },
  rangeValues: (ref, r, c) => {
    const v = e.evaluateAt(sheetId, r, c, ref.startsWith("=") ? ref : `=${ref}`, { array: true });
    return (isMatrix(v) ? v.flat() : [v]) as Scalar[];
  },
});

const list = (source: string, at: string): Validation => ({
  id: `v-${at}`,
  ranges: [at],
  rule: { kind: "list", source, dropdown: true },
  allowBlank: true,
});

describe("every formula of a sheet, cells' and rules'", () => {
  const grid: GridData = {
    cells: cells({ "0,0": "=Other!A1*2", "1,0": "plain", "2,0": "'=Other!A1" }),
    cond: [
      {
        id: "c",
        ranges: ["A1:A5"],
        rule: { kind: "formula", formula: "=A1>Other!$B$1", style: { bold: true } },
      },
    ],
    validations: [list("=Other!$A$1:$A$3", "B2")],
  } as GridData;
  const rename = (f: string) => renameSheetInFormula(f, "Other", "Renamed");

  it("rewrites the cells' formulas, the rules' formulas and a list's source", () => {
    const out = mapGridFormulas(grid, rename);
    expect(out.cells["0,0"].i).toBe("=Renamed!A1*2");
    expect((out.cond![0].rule as { formula: string }).formula).toBe("=A1>Renamed!$B$1");
    expect((out.validations![0].rule as { source: string }).source).toBe("=Renamed!$A$1:$A$3");
  });
  it("leaves text alone, even text that looks like a formula", () => {
    const out = mapGridFormulas(grid, rename);
    expect(out.cells["1,0"]).toBe(grid.cells["1,0"]);
    expect(out.cells["2,0"]).toBe(grid.cells["2,0"]);
  });
  it("hands back the same grid when nothing changed", () => {
    expect(mapGridFormulas(grid, (f) => f)).toBe(grid);
    expect(mapGridFormulas(grid, (f) => renameSheetInFormula(f, "Nope", "X"))).toBe(grid);
  });
  it("a table sheet renamed: a rule over its column follows", () => {
    const g: GridData = {
      cells: {},
      cond: [
        {
          id: "t",
          ranges: ["B2:B9"],
          rule: { kind: "formula", formula: "=B2>AVERAGE(Orders[amount])", style: { bold: true } },
        },
      ],
    } as GridData;
    const out = mapGridFormulas(g, (f) => renameTableInFormula(f, "Orders", "Sales"));
    expect((out.cond![0].rule as { formula: string }).formula).toBe("=B2>AVERAGE(Sales[amount])");
  });
});

describe("the UI round, in the engine", () => {
  // Sheet1: B2 a list over Sheet2!A1:A3, C2 =COUNTA(Sheet2!A1:A3); E1:E3 x y z,
  // B5 a list over $E$1:$E$3, D5 =COUNTA(E1:E3)&" "&E1. Sheet2: North South West.
  const defs = (): SheetDef[] => [
    {
      id: "s1",
      name: "Sheet1",
      kind: "grid",
      grid: {
        cells: cells({
          "1,2": "=COUNTA(Sheet2!A1:A3)",
          "0,4": "x",
          "1,4": "y",
          "2,4": "z",
          "4,3": '=COUNTA(E1:E3)&" "&E1',
        }),
        validations: [list("=Sheet2!$A$1:$A$3", "B2"), list("=$E$1:$E$3", "B5")],
      },
    },
    {
      id: "s2",
      name: "Sheet2",
      kind: "grid",
      grid: { cells: cells({ "0,0": "North", "1,0": "South", "2,0": "West" }) },
    },
  ];
  const items = (e: WorkbookEngine, at: string, row: number, col: number) =>
    listItems(
      e.snapshot("s1")!.validations!.find((v) => v.ranges[0] === at)!,
      dvEnv(e, "s1"),
      row,
      col,
    );

  it("renaming the list's sheet: the list still offers its values", () => {
    const e = new WorkbookEngine(defs());
    expect(items(e, "B2", 1, 1)).toEqual(["North", "South", "West"]);
    // What renaming a sheet does (useWorkbook's renameTabLocal).
    for (const s of e.listSheets()) {
      const g = e.snapshot(s.id)!;
      const next = mapGridFormulas(g, (f) => renameSheetInFormula(f, "Sheet2", "Regions"));
      if (next !== g) e.replaceGrid(s.id, next);
    }
    e.renameSheet("s2", "Regions");
    expect(e.getValue("s1", 1, 2)).toBe(3);
    expect(items(e, "B2", 1, 1)).toEqual(["North", "South", "West"]);
  });
  it("as it was: the cells followed and the list came up empty", () => {
    const e = new WorkbookEngine(defs());
    const g = e.snapshot("s1")!;
    const cellsOnly = {
      ...g,
      cells: mapGridFormulas({ cells: g.cells }, (f) =>
        renameSheetInFormula(f, "Sheet2", "Regions"),
      ).cells,
    };
    e.replaceGrid("s1", cellsOnly);
    e.renameSheet("s2", "Regions");
    expect(e.getValue("s1", 1, 2)).toBe(3);
    expect(items(e, "B2", 1, 1)).toEqual([]);
  });
  it("cells shifted down under a list's source: the list follows them", () => {
    const e = new WorkbookEngine(defs());
    expect(items(e, "B5", 4, 1)).toEqual(["x", "y", "z"]);
    // What Insert cells → Shift cells down at E1 does (WorkbookEditor's shiftCells).
    const range = { r0: 0, c0: 4, r1: 0, c1: 4 };
    for (const s of e.listSheets()) {
      const g = e.snapshot(s.id)!;
      const shifted = s.id === "s1" ? shiftCellsGrid(g, range, "down") : g;
      const next = mapGridFormulas(shifted, (f) =>
        adjustFormulaForShift(f, s.name, "Sheet1", range, "down"),
      );
      if (next !== g) e.replaceGrid(s.id, next);
    }
    e.recalcAll();
    expect(e.getValue("s1", 4, 3)).toBe("3 x");
    expect(
      (e.snapshot("s1")!.validations!.find((v) => v.ranges[0] === "B5")!.rule as { source: string })
        .source,
    ).toBe("=$E$2:$E$4");
    expect(items(e, "B5", 4, 1)).toEqual(["x", "y", "z"]);
  });
});

describe("an import that renames a sheet", () => {
  it("renames it in the rules as in the cells", () => {
    const g: GridData = {
      cells: cells({ "0,0": "='It''s'!A1" }),
      validations: [list("='It''s'!$A$1:$A$3", "B2")],
    } as GridData;
    const out = renameSheetsInGrid(g, [{ from: "It's", to: "Its" }]);
    expect(out.cells["0,0"].i).toBe("=Its!A1");
    expect((out.validations![0].rule as { source: string }).source).toBe("=Its!$A$1:$A$3");
  });
});

describe("every path that rewrites formulas goes through mapGridFormulas", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("renaming a sheet or a table", () => {
    const src = read("src/components/sheets/useWorkbook.ts");
    const body = src.slice(src.indexOf("const renameTabLocal"), src.indexOf("const addNamesLocal"));
    expect(body).toMatch(/mapGridFormulas\(g, rewrite\)/);
    expect(body).not.toMatch(/engine\.setInputs\(/);
  });
  it("Insert/Delete cells, rows and columns, and a name renamed", () => {
    const ed = read("src/components/sheets/WorkbookEditor.tsx");
    expect(ed).toMatch(
      /mapGridFormulas\(shifted, \(f\) =>\s*adjustFormulaForShift\(f, s\.name, target, range, dir\),?\s*\)/,
    );
    expect(ed).toMatch(
      /mapGridFormulas\(shifted, \(f\) =>\s*adjustFormula\(f, s\.name, target, axis, at, count\),?\s*\)/,
    );
    expect(ed).toMatch(/mapGridFormulas\(g, fn\)/);
  });
  it("an import that renames a sheet", () => {
    expect(read("src/components/sheets/ImportFileDialog.tsx")).toMatch(
      /renamed\.length \? renameSheetsInGrid\(s\.grid, renamed\) : s\.grid/,
    );
  });
  it("the Name box reads what it holds when Enter is pressed", () => {
    // Its state from the last render could lag the keys (seen driving it fast):
    // Enter then read "", the focus stayed, and the next word was taken as a name.
    expect(read("src/components/sheets/WorkbookEditor.tsx")).toContain(
      'if (e.key === "Enter") nameBoxEnter(e.currentTarget.value);',
    );
  });
});
