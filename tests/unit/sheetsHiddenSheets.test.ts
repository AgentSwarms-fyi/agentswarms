// Hidden sheets (R160). Excel keeps helper sheets hidden, and some very hidden.
// Before: a hidden sheet came in showing, a very hidden one was left out
// (its formulas said #REF!), a download wrote every sheet showing, and a
// sheet could be neither hidden, unhidden nor duplicated.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkbookEngine } from "@/lib/sheets/engine";
import { shownInstead } from "@/lib/sheets/sheetTabs";
import { readXlsx, writeXlsx, type ImportResult } from "@/lib/sheets/xlsx";
import { gridSchema } from "@/utils/sheets/schemas";

const src = (p: string) => readFileSync(p, "utf8");
let file: ImportResult;

beforeAll(async () => {
  const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-hidden.xlsx"));
  file = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
    maxCells: 1000,
  });
}, 60_000);

const workbookXml = (buf: ArrayBuffer) =>
  strFromU8(unzipSync(new Uint8Array(buf))["xl/workbook.xml"]);

describe("an Excel file's hidden sheets", () => {
  it("come in hidden, the very hidden one too, and the others' formulas read them", () => {
    expect(file.sheets.map((s) => [s.name, s.hidden, !!s.grid.hiddenSheet])).toEqual([
      ["Summary", false, false],
      ["Rates", true, true],
      ["Keys", true, true],
    ]);
    const engine = new WorkbookEngine(
      file.sheets.map((s, i) => ({ id: `s${i}`, name: s.name, grid: s.grid })),
    );
    expect(engine.getValue("s0", 5, 1)).toBeCloseTo(3510); // =SUM of C*Rates!$B$2
    expect(engine.getValue("s0", 6, 1)).toBe("K-2026"); // =Keys!A1
  });
  it("go back out hidden, with Excel opening on a sheet that shows", async () => {
    const e = new WorkbookEngine(
      file.sheets.map((s, i) => ({ id: `s${i}`, name: s.name, grid: s.grid })),
    );
    const buf = await writeXlsx(
      file.sheets.map((s, i) => ({
        kind: "grid" as const,
        name: s.name,
        grid: s.grid,
        value: (r: number, c: number) => e.getValue(`s${i}`, r, c),
      })),
    );
    const xml = workbookXml(buf);
    expect(xml).toMatch(/<sheet [^>]*name="Rates" state="hidden"/);
    expect(xml).toMatch(/<sheet [^>]*name="Keys" state="hidden"/);
    expect(xml).toMatch(/<sheet [^>]*name="Summary" state="visible"/);
    expect(xml).toMatch(/activeTab="0"/);
    const back = await readXlsx(buf, { maxCells: 1000 });
    expect(back.sheets.map((s) => !!s.grid.hiddenSheet)).toEqual([false, true, true]);
  });
  it("a workbook whose sheets are all hidden still opens: the first shows", async () => {
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "A",
        grid: { cells: { "0,0": { i: "1" } }, hiddenSheet: true },
        value: () => 1,
      },
      { kind: "grid", name: "B", grid: { cells: {}, hiddenSheet: true }, value: () => null },
    ]);
    const xml = workbookXml(buf);
    expect(xml).toMatch(/<sheet [^>]*name="A" state="visible"/);
    expect(xml).toMatch(/<sheet [^>]*name="B" state="hidden"/);
  });
  it("with the first sheet hidden, Excel opens on the first one showing", async () => {
    const buf = await writeXlsx([
      { kind: "grid", name: "Lookup", grid: { cells: {}, hiddenSheet: true }, value: () => null },
      { kind: "grid", name: "Report", grid: { cells: {} }, value: () => null },
    ]);
    const xml = workbookXml(buf);
    expect(xml).toMatch(/<sheet [^>]*name="Lookup" state="hidden"/);
    expect(xml).toMatch(/activeTab="1"/);
  });
  it("the saved sheet keeps it", () => {
    expect(gridSchema.safeParse({ cells: {}, hiddenSheet: true }).success).toBe(true);
  });
});

describe("the sheet shown instead of a hidden one", () => {
  const tabs = ["Summary", "Rates", "Keys", "Report"].map((id) => ({ id }));
  const hiding =
    (...ids: string[]) =>
    (t: { id: string }) =>
      ids.includes(t.id);
  it("is the next sheet showing, past other hidden ones", () => {
    expect(shownInstead(tabs, "Rates", hiding("Rates", "Keys"))).toBe("Report");
  });
  it("or, with none after it, the one before", () => {
    expect(shownInstead(tabs, "Report", hiding("Report", "Keys"))).toBe("Rates");
    expect(shownInstead(tabs, "Report", hiding("Report", "Keys", "Rates"))).toBe("Summary");
  });
  it("a file whose first sheet is hidden opens on the first one showing", () => {
    expect(shownInstead(tabs, "Summary", hiding("Summary", "Rates"))).toBe("Keys");
  });
  it("nothing moves when the sheet in view shows, or nothing else does", () => {
    expect(shownInstead(tabs, "Rates", hiding("Keys"))).toBeUndefined();
    expect(shownInstead(tabs, "Rates", () => true)).toBeUndefined();
    expect(shownInstead(tabs, null, () => true)).toBeUndefined();
  });
});

describe("the sheet tabs", () => {
  const ed = src("src/components/sheets/WorkbookEditor.tsx");
  it("show only the sheets not hidden; Hide, Unhide and Duplicate on a tab's menu", () => {
    expect(ed).toMatch(/\{shownTabs\.map\(\(t\) => \(\s*<SheetTab/);
    expect(ed).toMatch(
      /<DropdownMenuItem onSelect=\{thenGrid\(onHide\)\}>Hide<\/DropdownMenuItem>/,
    );
    expect(ed).toMatch(/<DropdownMenuSubTrigger>Unhide<\/DropdownMenuSubTrigger>/);
    expect(ed).toMatch(
      /<DropdownMenuItem onSelect=\{thenGrid\(onDuplicate\)\}>Duplicate<\/DropdownMenuItem>/,
    );
  });
  it("one sheet always shows: hiding or deleting the last one is refused", () => {
    expect(ed).toMatch(
      /if \(shownTabs\.length <= 1\)\s*return void toast\.error\("A workbook keeps at least one sheet showing"\);/,
    );
    expect(ed).toMatch(/if \(!isHiddenTab\(t\) && shownTabs\.length <= 1\)/);
  });
  it("a hidden sheet is never the one in view, however it got hidden; unhiding shows it", () => {
    // Hide from the menu, Ctrl+Z after Unhide, Ctrl+Y after Hide, or a file
    // whose first sheet is hidden: all end on the sheet in view being hidden.
    expect(ed).toMatch(/const moveTo = shownInstead\(tabs, tabId, isHiddenTab\);/);
    expect(ed).toMatch(/if \(moveTo\) setActiveTabId\(moveTo\);/);
    expect(ed).toMatch(
      /wb\.setGridMeta\(t\.id, \{ hiddenSheet: undefined \}\);\s*wb\.setActiveTabId\(t\.id\);/,
    );
  });
  it("after Hide, Unhide or Duplicate the keyboard is on the grid, not on the page", () => {
    // Found while driving it: hiding a sheet took its tab (the menu's way back)
    // away, and Ctrl+Z or the arrows did nothing until the grid was clicked.
    expect(ed).toMatch(/onSelect=\{thenGrid\(onHide\)\}>Hide</);
    expect(ed).toMatch(/onSelect=\{thenGrid\(onDuplicate\)\}>Duplicate</);
    expect(ed).toMatch(/onSelect=\{thenGrid\(\(\) => onUnhide\(h\)\)\}/);
    expect(ed).toMatch(
      /onCloseAutoFocus=\{\(e\) => \{\s*if \(!toGrid\.current\) return;\s*toGrid\.current = false;\s*e\.preventDefault\(\);\s*onDone\?\.\(\);/,
    );
    expect(ed).toMatch(/onDuplicate=\{\(\) => void duplicateSheet\(t\)\}\s*onDone=\{backToGrid\}/);
  });
  it("a copy is a new sheet with the same cells and settings, not hidden, named apart", () => {
    expect(ed).toMatch(/sheets: \[\{ name, grid: \{ \.\.\.snap, hiddenSheet: undefined \} \}\],/);
    expect(ed).toMatch(
      /while \(names\.has\(`\$\{t\.name\} \(\$\{n\}\)`\.toLowerCase\(\)\)\) n\+\+;/,
    );
  });
  it("Find leaves hidden sheets out, and moving a tab passes over them", () => {
    expect(ed).toMatch(/\(t\.id === tabId \|\| !engine\.gridOf\(t\.id\)\?\.hiddenSheet\)/);
    expect(ed).toMatch(
      /while \(j >= 0 && j < order\.length && isHiddenTab\(tabs\[j\]\)\) j \+= dir;/,
    );
  });
});
