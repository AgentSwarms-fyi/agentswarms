// Inserted rows and columns take the formats of their neighbours (R169), as
// Excel's default "Format Same As Above" / "Same As Left". Before: a row
// inserted under a dollar-and-bold row came in plain, so a price typed into
// it showed 12.5 beside $10.00.

import { describe, expect, it } from "vitest";
import type { GridData } from "@/lib/sheets/engine";
import { moveCells } from "@/lib/sheets/ops";
import { shiftCellsGrid } from "@/lib/sheets/shiftCells";

const money = '"$"#,##0.00';
const grid = (): GridData => ({
  cells: {
    "0,0": { i: "Item", s: { b: true, bg: "#dbeafe" } },
    "0,1": { i: "Price", s: { b: true, bg: "#dbeafe" } },
    "1,0": { i: "Pens" },
    "1,1": { i: "10", f: money, s: { bd: { b: { s: "thin", c: "#000000" } } } },
    "2,0": { i: "Ink" },
    "2,1": { i: "4", f: money },
  },
});

describe("an inserted row", () => {
  it("takes the formats of the row above, not its values", () => {
    const g = moveCells(grid(), "rows", 2, 2);
    expect(g.cells["2,1"]).toEqual({
      i: "",
      f: money,
      s: { bd: { b: { s: "thin", c: "#000000" } } },
    });
    expect(g.cells["3,1"]).toEqual(g.cells["2,1"]);
    expect(g.cells["2,0"]).toBeUndefined();
    expect(g.cells["4,1"]).toEqual({ i: "4", f: money });
  });
  it("at the top takes the formats of the row below", () => {
    const g = moveCells(grid(), "rows", 0, 1);
    expect(g.cells["0,0"]).toEqual({ i: "", s: { b: true, bg: "#dbeafe" } });
    expect(g.cells["1,0"]).toEqual({ i: "Item", s: { b: true, bg: "#dbeafe" } });
  });
  it("leaves a note, a link and a saved value behind", () => {
    const g0 = grid();
    g0.cells["1,1"] = { ...g0.cells["1,1"], n: "Asha:\nCheck", l: "https://example.com", c: 10 };
    const g = moveCells(g0, "rows", 2, 1);
    expect(Object.keys(g.cells["2,1"]).sort()).toEqual(["f", "i", "s"]);
  });
  it("keeps a copied style apart from the one it came from", () => {
    const g = moveCells(grid(), "rows", 2, 1);
    expect(g.cells["2,1"].s).not.toBe(g.cells["1,1"].s);
  });
});

describe("an inserted column", () => {
  it("takes the formats of the column to its left", () => {
    const g = moveCells(grid(), "cols", 2, 1);
    expect(g.cells["0,2"]).toEqual({ i: "", s: { b: true, bg: "#dbeafe" } });
    expect(g.cells["2,2"]).toEqual({ i: "", f: money });
  });
  it("at the left edge takes the formats of the column to its right", () => {
    const g = moveCells(grid(), "cols", 0, 1);
    expect(g.cells["0,0"]).toEqual({ i: "", s: { b: true, bg: "#dbeafe" } });
    expect(g.cells["1,0"]).toBeUndefined();
    expect(g.cells["0,1"]).toEqual({ i: "Item", s: { b: true, bg: "#dbeafe" } });
  });
});

describe("Insert cells", () => {
  it("shifted down, the new cells take the formats of the cells above them", () => {
    const g = shiftCellsGrid(grid(), { r0: 2, c0: 1, r1: 2, c1: 1 }, "down");
    expect(g.cells["2,1"]).toEqual({
      i: "",
      f: money,
      s: { bd: { b: { s: "thin", c: "#000000" } } },
    });
    expect(g.cells["3,1"]).toEqual({ i: "4", f: money });
    expect(g.cells["2,0"]).toEqual({ i: "Ink" });
  });
  it("leaves the cells beside the block alone", () => {
    const g0 = grid();
    g0.cells["1,0"] = { i: "Pens", s: { i: true } };
    const g = shiftCellsGrid(g0, { r0: 2, c0: 1, r1: 2, c1: 1 }, "down");
    expect(g.cells["2,0"]).toEqual({ i: "Ink" });
  });
  it("shifted right, the new cells take the formats of the cells to their left", () => {
    const g = shiftCellsGrid(grid(), { r0: 0, c0: 1, r1: 0, c1: 1 }, "right");
    expect(g.cells["0,1"]).toEqual({ i: "", s: { b: true, bg: "#dbeafe" } });
    expect(g.cells["0,2"]).toEqual({ i: "Price", s: { b: true, bg: "#dbeafe" } });
    expect(g.cells["1,1"]).toEqual(grid().cells["1,1"]);
  });
});

describe("a deletion", () => {
  it("adds nothing", () => {
    expect(Object.keys(moveCells(grid(), "rows", 1, -1).cells).sort()).toEqual([
      "0,0",
      "0,1",
      "1,0",
      "1,1",
    ]);
    const up = shiftCellsGrid(grid(), { r0: 1, c0: 1, r1: 1, c1: 1 }, "up");
    expect(Object.keys(up.cells).sort()).toEqual(["0,0", "0,1", "1,0", "1,1", "2,0"]);
  });
});
