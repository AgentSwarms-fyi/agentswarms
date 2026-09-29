// Data → Remove duplicates (R153). Sheets had no way to drop repeated rows
// from a list: the Data tab had sort, filter and validation, and a list
// exported twice, or a sign-up sheet filled in again, had to be cleaned by
// hand, row by row. Excel's Remove Duplicates compares what cells show,
// ignoring case, and moves the rows below up within the range only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRangeA1 } from "@/lib/sheets/a1";
import { cellView } from "@/lib/sheets/cellView";
import { duplicateRows, removeRowsEdits } from "@/lib/sheets/dedupe";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { sortEdits, type RowEdit } from "@/lib/sheets/filter";
import { readXlsx } from "@/lib/sheets/xlsx";

let grid: GridData;

beforeAll(async () => {
  const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-dupes.xlsx"));
  const r = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
    maxCells: 1000,
  });
  grid = r.sheets[0].grid;
}, 60_000);

const LIST = parseRangeA1("A1:E8")!;

function open(g: GridData) {
  const engine = new WorkbookEngine([{ id: "s", name: "Contacts", grid: structuredClone(g) }]);
  return {
    engine,
    text: (r: number, c: number) =>
      cellView(engine.getValue("s", r, c), engine.getInput("s", r, c)).text,
    input: (r: number, c: number) => engine.getInput("s", r, c),
  };
}

/** The edits written as the editor writes them (useSheetRules' writeRows). */
function write(g: GridData, edits: RowEdit[]): GridData {
  const next = structuredClone(g);
  for (const e of edits) {
    const key = `${e.row},${e.col}`;
    if (!e.input && !e.format && !e.style && !e.link && !e.note) delete next.cells[key];
    else
      next.cells[key] = {
        i: e.input,
        ...(e.format ? { f: e.format } : {}),
        ...(e.style ? { s: e.style } : {}),
        ...(e.link ? { l: e.link } : {}),
        ...(e.note ? { n: e.note } : {}),
        ...(e.cached !== null && e.input.startsWith("=") ? { c: e.cached } : {}),
      };
  }
  return next;
}

describe("which rows repeat", () => {
  it("every column: the capitals repeat, the same date shown another way does not", () => {
    const { text } = open(grid);
    expect(text(3, 1)).toBe("ASHA@EXAMPLE.COM");
    expect(text(6, 3)).toBe("2026-03-08");
    expect(text(7, 3)).toBe("8 Mar 2026");
    // Rows 4 and 6 (Asha again, Ben again); Dev's second row shows its date otherwise.
    expect(duplicateRows(LIST, [0, 1, 2, 3, 4], true, text)).toEqual([3, 5]);
  });
  it("only the checked columns count", () => {
    const { text } = open(grid);
    expect(duplicateRows(LIST, [1], true, text)).toEqual([3, 5, 7]);
    expect(duplicateRows(LIST, [2], true, text)).toEqual([3, 5, 7]); // Lisbon, Porto, Braga again
  });
  it("without a header, the first row is data too", () => {
    const g: GridData = {
      cells: { "0,0": { i: "x" }, "1,0": { i: "X" }, "2,0": { i: "y" } },
    };
    const { text } = open(g);
    const r = parseRangeA1("A1:A3")!;
    expect(duplicateRows(r, [0], false, text)).toEqual([1]);
    expect(duplicateRows(r, [0], true, text)).toEqual([]);
  });
  it("what a cell shows: the number 1 and the text 1 repeat; 1 and 1.00 do not", () => {
    const g: GridData = {
      cells: {
        "0,0": { i: "1" },
        "1,0": { i: "'1" },
        "2,0": { i: "1", f: "0.00" },
      },
    };
    const { engine, text } = open(g);
    expect(engine.getValue("s", 1, 0)).toBe("1");
    expect(duplicateRows(parseRangeA1("A1:A3")!, [0], false, text)).toEqual([1]);
  });
});

describe("removing them", () => {
  it("moves the rows below up, formulas and notes with them, and empties the bottom", () => {
    const { text, input } = open(grid);
    const remove = duplicateRows(LIST, [0, 1, 2, 3, 4], true, text);
    const after = open(write(grid, removeRowsEdits(LIST, remove, true, input)));
    const names = [1, 2, 3, 4, 5, 6, 7].map((r) => after.text(r, 0));
    expect(names).toEqual(["Asha Rao", "Ben Ode", "Cleo Park", "Dev Iyer", "Dev Iyer", "", ""]);
    // Cleo's formula moved from row 5 to row 4, and counts her own email.
    expect(after.input(3, 4)?.i).toBe("=LEN(B4)");
    expect(after.text(3, 4)).toBe("16");
    // The note on Cleo's city went with it.
    expect(after.input(3, 2)?.n).toMatch(/Moved from Lisbon in April\./);
    expect(after.input(4, 2)?.n).toBeUndefined();
    // Formats move with their rows: Dev's second date still shown its own way.
    expect(after.text(5, 3)).toBe("8 Mar 2026");
    // The header stays, and so does everything outside the list.
    expect(after.text(0, 0)).toBe("Name");
    expect([1, 2, 3, 4, 5, 6, 7].map((r) => after.text(r, 6))).toEqual([
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
      "g7",
      "g8",
    ]);
  });
  it("touches only the range's columns", () => {
    const { text, input } = open(grid);
    const edits = removeRowsEdits(LIST, duplicateRows(LIST, [1], true, text), true, input);
    expect(new Set(edits.map((e) => e.col))).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(Math.min(...edits.map((e) => e.row))).toBe(1);
    expect(Math.max(...edits.map((e) => e.row))).toBe(7);
  });
  it("a sort still moves rows the same way", () => {
    const { engine, input } = open(grid);
    const edits = sortEdits(
      LIST,
      [{ col: 0, desc: true }],
      { value: (r, c) => engine.getValue("s", r, c), input },
      true,
    );
    const after = open(write(grid, edits));
    expect(after.text(1, 0)).toBe("Dev Iyer");
    expect(after.input(1, 4)?.i).toBe("=LEN(B2)");
  });
});

describe("the Data tab", () => {
  const rules = readFileSync("src/components/sheets/useSheetRules.tsx", "utf8");
  const dialog = readFileSync("src/components/sheets/DedupeDialog.tsx", "utf8");
  it("has Remove duplicates…, over the selection or the data around the active cell", () => {
    expect(rules).toMatch(
      /"Remove duplicates…",\s*<CopyMinus[^>]*\/>,\s*openDedupe,\s*"tool-dedupe"/,
    );
    expect(rules).toMatch(/const openDedupe = \(\) => \{[\s\S]{0,120}const block = dataBlock\(\);/);
  });
  it("refuses a range with merged cells, which cannot move up", () => {
    expect(rules).toMatch(
      /parseMerges\(grid\?\.merges\)\.some\(\(m\) => intersects\(m, block\)\)\) \{\s*toast\.error/,
    );
  });
  it("writes the removal as one step, re-filters, and says what it did", () => {
    expect(rules).toMatch(
      /writeRows\(removeRowsEdits\(block, remove, hasHeader, \(r, c\) => engine\.getInput\(tabId, r, c\)\)\);\s*if \(filter\) refilter\(\);/,
    );
    expect(rules).toMatch(/No duplicate rows in \$\{rangeA1\(block\)\}/);
    expect(rules).toMatch(
      /const writeRows = \(edits: RowEdit\[\]\) => \{\s*if \(!tabId\) return;\s*wb\.changeGrid/,
    );
  });
  it("a click on a ribbon tab leaves the keyboard in the grid, for Ctrl+Z after a tool", () => {
    const bar = readFileSync("src/components/sheets/SheetToolbar.tsx", "utf8");
    expect(bar).toMatch(
      /role="tab"[\s\S]{0,700}onMouseDown=\{\(e\) => e\.preventDefault\(\)\}\s*onClick=\{\(\) => setTab\(t\.id\)\}/,
    );
  });
  it("the dialog: headers, every column checked, nothing to do without one", () => {
    expect(dialog).toMatch(/useState\(guessHeader\)/);
    expect(dialog).toMatch(/useState<boolean\[\]>\(\(\) => columns\.map\(\(\) => true\)\)/);
    expect(dialog).toMatch(/disabled=\{chosen\.length === 0\}/);
    expect(dialog).toMatch(/My data has headers/);
  });
});
