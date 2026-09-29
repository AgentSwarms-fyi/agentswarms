// One order for text, in a sort, a lookup and a comparison (R167). Before:
// the ribbon's Sort put numbers inside text in value order (A2 before A10),
// while =SORT(), MATCH and VLOOKUP go letter by letter (A10 before A2), as
// Excel does. After the ribbon's sort, an approximate VLOOKUP took the wrong
// row: VLOOKUP("A10", …, TRUE) gave A1's value.

import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { compareForSort, sortEdits } from "@/lib/sheets/filter";
import { compareText } from "@/lib/sheets/formula/values";

const KEYS = ["A10", "A2", "A1", "B1", "A20", "A3"];
const EXCEL = ["A1", "A10", "A2", "A20", "A3", "B1"];

describe("the order of text", () => {
  it("is Excel's: character by character, case aside", () => {
    expect([...KEYS].sort(compareForSort)).toEqual(EXCEL);
    expect(compareText("apple", "APPLE")).toBe(0);
    expect(compareText("Item 10", "Item 9")).toBeLessThan(0);
  });
  it("numbers, then text, then TRUE and FALSE, then errors, then blanks, as before", () => {
    const mixed = ["b", true, null, 3, { err: "#N/A" as const }, "A"];
    expect([...mixed].sort(compareForSort)).toEqual([3, "A", "b", true, { err: "#N/A" }, null]);
  });
});

function engineOf(cells: Record<string, string>) {
  const grid: GridData = { cells: {} };
  for (const [k, i] of Object.entries(cells)) grid.cells[k] = { i };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  return e;
}

describe("the ribbon's sort, and the lookups after it", () => {
  // A1:B6 the keys and their numbers; D1:D3 approximate lookups; F1 =SORT().
  const cells: Record<string, string> = {};
  KEYS.forEach((k, r) => {
    cells[`${r},0`] = k;
    cells[`${r},1`] = String(Number(k.slice(1)) * (k.startsWith("B") ? 100 : 1));
  });
  cells["0,3"] = '=VLOOKUP("A10",A1:B6,2,TRUE)';
  cells["1,3"] = '=VLOOKUP("A3",A1:B6,2,TRUE)';
  cells["2,3"] = '=MATCH("A20",A1:A6,1)';
  cells["0,5"] = "=SORT(A1:A6)";
  const e = engineOf(cells);
  const edits = sortEdits(
    { r0: 0, c0: 0, r1: 5, c1: 1 },
    [{ col: 0 }],
    { value: (r, c) => e.getValue("s", r, c), input: (r, c) => e.getInput("s", r, c) },
    false,
  );
  e.setInputs(
    "s",
    edits.map((x) => ({ row: x.row, col: x.col, input: x.input, format: x.format })),
  );
  it("sorts as =SORT() does", () => {
    const sorted = [0, 1, 2, 3, 4, 5].map((r) => e.getValue("s", r, 0));
    expect(sorted).toEqual(EXCEL);
    expect([0, 1, 2, 3, 4, 5].map((r) => e.getValue("s", r, 5))).toEqual(EXCEL);
  });
  it("and the approximate lookups find their own rows", () => {
    expect(e.getValue("s", 0, 3)).toBe(10);
    expect(e.getValue("s", 1, 3)).toBe(3);
    expect(e.getValue("s", 2, 3)).toBe(4);
  });
});
