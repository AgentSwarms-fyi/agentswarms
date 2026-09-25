// Insert cells and Delete cells, as Excel's: only the block's rows (or
// columns) move, formulas that point at the moved cells follow, one that
// pointed into deleted cells shows #REF!, and a range follows only when it
// lies wholly in the band that moves.

import { describe, expect, it } from "vitest";

import { parseRangeA1 } from "@/lib/sheets/a1";
import type { GridData } from "@/lib/sheets/engine";
import { adjustFormulaForShift, shiftCellsGrid, shiftProblem } from "@/lib/sheets/shiftCells";

const R = (a: string) => parseRangeA1(a)!;
const grid = (cells: Record<string, string>): GridData => {
  const out: GridData = { cells: {} };
  for (const [ref, i] of Object.entries(cells)) {
    const r = R(ref);
    out.cells[`${r.r0},${r.c0}`] = { i };
  }
  return out;
};
const at = (g: GridData, ref: string) => {
  const r = R(ref);
  return g.cells[`${r.r0},${r.c0}`]?.i;
};

describe("moving the cells", () => {
  it("shift right moves only the block's rows", () => {
    const g = grid({ B2: "b2", C2: "c2", B4: "b4" });
    const out = shiftCellsGrid(g, R("B2:B3"), "right");
    expect([at(out, "B2"), at(out, "C2"), at(out, "D2"), at(out, "B4")]).toEqual([
      undefined,
      "b2",
      "c2",
      "b4",
    ]);
  });

  it("shift down moves only the block's columns", () => {
    const g = grid({ B2: "b2", B3: "b3", C2: "c2" });
    const out = shiftCellsGrid(g, R("B2:B3"), "down");
    expect([at(out, "B2"), at(out, "B4"), at(out, "B5"), at(out, "C2")]).toEqual([
      undefined,
      "b2",
      "b3",
      "c2",
    ]);
  });

  it("delete, shift left drops the block and closes the gap", () => {
    const g = grid({ A2: "a2", B2: "b2", C2: "c2", D2: "d2", B5: "b5" });
    const out = shiftCellsGrid(g, R("B2:C2"), "left");
    expect([at(out, "A2"), at(out, "B2"), at(out, "C2"), at(out, "B5")]).toEqual([
      "a2",
      "d2",
      undefined,
      "b5",
    ]);
  });

  it("delete, shift up", () => {
    const g = grid({ B2: "b2", B3: "b3", B4: "b4", C3: "c3" });
    const out = shiftCellsGrid(g, R("B2:B3"), "up");
    expect([at(out, "B2"), at(out, "B3"), at(out, "C3")]).toEqual(["b4", undefined, "c3"]);
  });

  it("rules and merges wholly in the band move; others stay", () => {
    const g: GridData = {
      cells: {},
      merges: ["C2:D2", "C5:D6"],
      cond: [{ id: "a", ranges: ["C2:E2"], rule: { kind: "blank", style: {} } }],
      validations: [{ id: "v", ranges: ["C1:C9"], rule: { kind: "list", items: ["x"] } }],
    };
    const out = shiftCellsGrid(g, R("B2:B2"), "right");
    expect(out.merges).toEqual(["D2:E2", "C5:D6"]);
    expect(out.cond![0].ranges).toEqual(["D2:F2"]);
    expect(out.validations![0].ranges).toEqual(["C1:C9"]);
  });

  it("refuses to cut a merged cell in two", () => {
    const g: GridData = { cells: {}, merges: ["C2:C3"] };
    expect(shiftProblem(g, R("B2:B2"), "right")).toMatch(/merged cell C2:C3/);
    expect(shiftProblem(g, R("B2:B3"), "right")).toBeNull();
  });

  it("refuses to push cells past the sheet's last column or row", () => {
    const g: GridData = { cells: { "1,16383": { i: "edge" }, "1048575,2": { i: "floor" } } };
    expect(shiftProblem(g, R("B2:B2"), "right")).toMatch(/past the edge/);
    // Another row's last cell does not stop it.
    expect(shiftProblem(g, R("B3:B3"), "right")).toBeNull();
    expect(shiftProblem(g, R("C5:C5"), "down")).toMatch(/past the edge/);
    // Deleting only closes up.
    expect(shiftProblem(g, R("B2:B2"), "left")).toBeNull();
  });
});

describe("formulas follow", () => {
  const f = (input: string, block: string, dir: "right" | "down" | "left" | "up", sheet = "S") =>
    adjustFormulaForShift(input, sheet, "S", R(block), dir);

  it("a reference to a moved cell moves; others stay", () => {
    expect(f("=C2+C5+A2", "B2:B3", "right")).toBe("=D2+C5+A2");
    expect(f("=$C$2*2", "B2:B3", "right")).toBe("=$D$2*2");
    expect(f("=B4+C2", "B2:C3", "down")).toBe("=B6+C4");
  });

  it("a reference into deleted cells is #REF!", () => {
    expect(f("=B2+D2", "B2:C2", "left")).toBe("=#REF!+B2");
  });

  it("a range follows only when it lies wholly in the band", () => {
    expect(f("=SUM(C2:E2)", "B2:B2", "right")).toBe("=SUM(D2:F2)");
    expect(f("=SUM(C1:C9)", "B2:B2", "right")).toBe("=SUM(C1:C9)");
    expect(f("=SUM(A2:E2)", "B2:B2", "right")).toBe("=SUM(A2:F2)");
    expect(f("=SUM(C:C)", "B2:B2", "right")).toBe("=SUM(C:C)");
  });

  it("another sheet's references follow when they name this one", () => {
    expect(adjustFormulaForShift("=S!C2+C2", "Other", "S", R("B2:B2"), "right")).toBe("=S!D2+C2");
  });
});
