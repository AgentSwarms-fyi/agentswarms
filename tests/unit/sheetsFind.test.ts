// R150. Find and Replace, as Excel's. Sheets had neither: Ctrl+F in a sheet
// did nothing, and a browser's own find reads only the rows the grid draws,
// so SO-10200 in a 240-row Orders sheet could not be found at all. Here: the
// pattern (Excel's * ? ~), where it looks (what a cell shows, or what was
// typed), the order Find Next walks, what Replace changes, and that the
// editor wires Ctrl+F, Ctrl+H and one undo for Replace All.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cellView } from "@/lib/sheets/cellView";
import { WorkbookEngine, type SheetDef } from "@/lib/sheets/engine";
import {
  findAll,
  findPattern,
  nextHit,
  replaceInput,
  type FindOptions,
  type FindSource,
} from "@/lib/sheets/find";

const values = (e: WorkbookEngine, ids: [string, string][]): FindSource[] =>
  ids.map(([id, name]) => {
    const used = e.used(id);
    return {
      sheetId: id,
      sheet: name,
      rows: used.rows,
      cols: used.cols,
      text: (r, c) => cellView(e.getValue(id, r, c), e.getInput(id, r, c)).text || undefined,
    };
  });
const typed = (e: WorkbookEngine, ids: [string, string][]): FindSource[] =>
  values(e, ids).map((s) => ({
    ...s,
    text: (r: number, c: number) => e.getInput(s.sheetId, r, c)?.i || undefined,
  }));

describe("Excel's find pattern", () => {
  const m = (text: string, s: string, o: Partial<FindOptions> = {}) =>
    findPattern({ text, ...o })!.test(s);
  it("finds a part of the text, in any case unless asked", () => {
    expect(m("west", "North-West")).toBe(true);
    expect(m("west", "North-West", { matchCase: true })).toBe(false);
    expect(m("West", "North-West", { matchCase: true })).toBe(true);
  });
  it("* is any run, ? one character, ~ takes either as itself", () => {
    expect(m("S*01", "SO-10001")).toBe(true);
    expect(m("SO-1000?", "SO-10001")).toBe(true);
    expect(m("SO-100?", "SO-10001")).toBe(true); // a part: "SO-1000"
    expect(m("SO-100?", "SO-10001", { entireCell: true })).toBe(false);
    expect(m("5~*", "5*2")).toBe(true);
    expect(m("5~*", "52")).toBe(false);
    expect(m("~?", "why?")).toBe(true);
    expect(m("~?", "why")).toBe(false);
    expect(m("a~~b", "a~b")).toBe(true);
  });
  it("everything else is itself: . ( ) $ [ are not a regular expression's", () => {
    expect(m("a.b", "axb")).toBe(false);
    expect(m("a.b", "a.b")).toBe(true);
    expect(m("(x)", "f(x)")).toBe(true);
    expect(m("$5", "cost $5")).toBe(true);
    expect(m("[1]", "Book[1]")).toBe(true);
  });
  it("the entire cell, when asked", () => {
    expect(m("West", "North-West", { entireCell: true })).toBe(false);
    expect(m("west", "West", { entireCell: true })).toBe(true);
    expect(m("*West", "North-West", { entireCell: true })).toBe(true);
  });
  it("nothing to find is no pattern", () => {
    expect(findPattern({ text: "" })).toBeNull();
  });
});

describe("finding in a workbook", () => {
  // Orders: A1 Order, A2:A241 SO-10001…SO-10240; B2:B241 the amounts;
  // D1 =SEQUENCE(3)*100 spills 100 200 300. Notes: A1 "see SO-10200".
  const defs = (): SheetDef[] => {
    const cells: Record<string, { i: string; f?: string }> = { "0,0": { i: "Order" } };
    for (let i = 1; i <= 240; i++) {
      cells[`${i},0`] = { i: `SO-${10000 + i}` };
      cells[`${i},1`] = { i: String(i * 10), f: "$#,##0.00" };
    }
    cells["0,3"] = { i: "=SEQUENCE(3)*100" };
    return [
      { id: "o", name: "Orders", kind: "grid", grid: { cells } },
      { id: "n", name: "Notes", kind: "grid", grid: { cells: { "0,0": { i: "see SO-10200" } } } },
    ];
  };
  const opts = (text: string, o: Partial<FindOptions> = {}): FindOptions => ({
    text,
    lookIn: "values",
    ...o,
  });

  it("row 201 of 241, which the grid never draws until scrolled to", () => {
    const e = new WorkbookEngine(defs());
    const r = findAll(values(e, [["o", "Orders"]]), opts("SO-10200", { entireCell: true }));
    expect(r.hits).toEqual([{ sheetId: "o", sheet: "Orders", row: 200, col: 0, text: "SO-10200" }]);
  });
  it("values are what a cell shows; formulas are what was typed", () => {
    const e = new WorkbookEngine(defs());
    // B11 holds 110, shown $110.00.
    expect(findAll(values(e, [["o", "Orders"]]), opts("$110.00")).hits.map((h) => h.row)).toEqual([
      11,
    ]);
    expect(
      findAll(typed(e, [["o", "Orders"]]), opts("$110.00", { lookIn: "formulas" })).hits,
    ).toEqual([]);
    // A spilled answer has no typed text: found by its value, not as a formula.
    expect(findAll(values(e, [["o", "Orders"]]), opts("300", { entireCell: true })).hits).toEqual([
      expect.objectContaining({ row: 2, col: 3 }),
    ]);
    expect(
      findAll(typed(e, [["o", "Orders"]]), opts("SEQUENCE", { lookIn: "formulas" })).hits,
    ).toEqual([expect.objectContaining({ row: 0, col: 3, text: "=SEQUENCE(3)*100" })]);
  });
  it("row by row, sheet by sheet; a limit says there were more", () => {
    const e = new WorkbookEngine(defs());
    const both = values(e, [
      ["o", "Orders"],
      ["n", "Notes"],
    ]);
    const r = findAll(both, opts("SO-1020"));
    // SO-10200 … SO-10209 on Orders, then Notes' A1.
    expect(r.hits.map((h) => `${h.sheet}!${h.row},${h.col}`)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `Orders!${200 + i},0`),
      "Notes!0,0",
    ]);
    const capped = findAll(both, opts("SO-"), 5);
    expect(capped.hits).toHaveLength(5);
    expect(capped.more).toBe(true);
  });
  it("Find Next goes on from the active cell and wraps; Find Previous goes back", () => {
    const hits = [
      { sheetId: "o", sheet: "Orders", row: 3, col: 0, text: "" },
      { sheetId: "o", sheet: "Orders", row: 9, col: 1, text: "" },
      { sheetId: "n", sheet: "Notes", row: 0, col: 0, text: "" },
    ];
    const order = ["o", "n"];
    expect(nextHit(hits, { sheetId: "o", row: 0, col: 0 }, order)).toBe(0);
    expect(nextHit(hits, { sheetId: "o", row: 3, col: 0 }, order)).toBe(1);
    expect(nextHit(hits, { sheetId: "o", row: 9, col: 5 }, order)).toBe(2);
    expect(nextHit(hits, { sheetId: "n", row: 0, col: 0 }, order)).toBe(0); // wraps
    expect(nextHit(hits, { sheetId: "o", row: 9, col: 1 }, order, true)).toBe(0);
    expect(nextHit(hits, { sheetId: "o", row: 0, col: 0 }, order, true)).toBe(2); // wraps
    expect(nextHit([], { sheetId: "o", row: 0, col: 0 }, order)).toBe(-1);
  });
});

describe("what Replace changes", () => {
  const o = (text: string, x: Partial<FindOptions> = {}) => ({ text, ...x });
  it("every match in what was typed, in any case unless asked", () => {
    expect(replaceInput("North-west, West", o("west"), "East")).toEqual({
      next: "North-East, East",
    });
    expect(replaceInput("North-west, West", o("West", { matchCase: true }), "East")).toEqual({
      next: "North-west, East",
    });
  });
  it("the entire cell only, when asked", () => {
    expect(replaceInput("West", o("west", { entireCell: true }), "East")).toEqual({ next: "East" });
    expect(replaceInput("North-West", o("west", { entireCell: true }), "East")).toBeNull();
  });
  it("* replaces the whole text once; $ in the replacement is itself", () => {
    expect(replaceInput("anything", o("*"), "X")).toEqual({ next: "X" });
    expect(replaceInput("banana", o("a*"), "X")).toEqual({ next: "bX" });
    expect(replaceInput("price", o("price"), "$& $1")).toEqual({ next: "$& $1" });
  });
  it("inside a formula; one it would break is left, and said so", () => {
    expect(replaceInput("=SUM(Sheet2!A1:A3)", o("Sheet2"), "Regions")).toEqual({
      next: "=SUM(Regions!A1:A3)",
    });
    expect(replaceInput("=SUM(A1:A3)", o("SUM(", {}), "SUM((")).toEqual({ broken: "=SUM((A1:A3)" });
  });
  it("nothing to replace is null", () => {
    expect(replaceInput("North", o("West"), "East")).toBeNull();
    expect(replaceInput("West", o("West"), "West")).toBeNull();
    expect(replaceInput("West", o(""), "East")).toBeNull();
  });
});

describe("the editor", () => {
  const ed = readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8");
  it("Ctrl+F and Ctrl+H open Find and Replace, not the browser's find", () => {
    expect(ed).toMatch(
      /k === "f" \|\| k === "h"\) \{[\s\S]{0,200}e\.preventDefault\(\);\s*setFindMode\(k === "h" && !wb\.readOnly \? "replace" : "find"\)/,
    );
  });
  it("Find reads what a cell shows, or what was typed", () => {
    const src = ed.slice(ed.indexOf("const findSources = "), ed.indexOf("const replaceAllHits = "));
    expect(src).toMatch(
      /cellView\(engine\.getValue\(t\.id, r, c\), engine\.getInput\(t\.id, r, c\)\)\.text/,
    );
    expect(src).toMatch(/engine\.getInput\(t\.id, r, c\)\?\.i/);
    expect(src).toMatch(/t\.kind === "grid"/);
  });
  it("Replace All is one undoable step, across sheets", () => {
    const src = ed.slice(ed.indexOf("const replaceAllHits = "), ed.indexOf("The Name box's Enter"));
    expect(src).toMatch(
      /wb\.structural\(tabId, \(eng\) => \{\s*for \(const \[id, edits\] of bySheet\) eng\.setInputs\(id, edits\);/,
    );
    expect(src).toMatch(/if \("broken" in r\) \{\s*broken\+\+;\s*continue;/);
  });
});

describe("the panel", () => {
  const panel = readFileSync("src/components/sheets/FindPanel.tsx", "utf8");
  it("opens with the last search, as Excel's does", () => {
    // Seen driving it: closed and opened again, the panel had forgotten.
    expect(panel).toContain("useState(initial.text)");
    expect(panel).toMatch(
      /onRemember\(\{ text, replacement, matchCase, entireCell, lookIn, within \}\)/,
    );
    expect(readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8")).toMatch(
      /initial=\{findMemory\.current\}\s*onRemember=\{rememberFind\}/,
    );
  });
  it("stays inside the grid; a long list scrolls within it", () => {
    // Seen at 715 pixels: Find All's list ran past the grid, over the sheet tabs.
    expect(panel).toMatch(/className="absolute [^"]*max-h-\[calc\(100%-1rem\)\][^"]*flex-col/);
    expect(panel).toMatch(/className="min-h-\[4\.5rem\] flex-1 overflow-auto/);
  });
});
