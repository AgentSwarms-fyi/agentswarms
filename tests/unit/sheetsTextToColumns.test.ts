// Data → Text to columns (R157), as Excel's: a column of "Lisbon, PT, 2026"
// or "Asha Rao" split into the cells to its right. Before, the Data tab had
// no way to do it; a formula per piece (TEXTBEFORE, TEXTAFTER) was the only
// route, and it left the text where it was.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorkbookEngine } from "@/lib/sheets/engine";
import { splitColumn, splitEdits, splitText, type SplitOptions } from "@/lib/sheets/textToColumns";

const comma: SplitOptions = { delimiters: [","], consecutive: false, qualifier: '"' };
const space: SplitOptions = { delimiters: [" "], consecutive: true, qualifier: null };
const src = (p: string) => readFileSync(p, "utf8");

describe("splitting a cell's text", () => {
  it("at each delimiter, keeping empty pieces between two in a row", () => {
    expect(splitText("Lisbon,PT,2026", comma)).toEqual(["Lisbon", "PT", "2026"]);
    expect(splitText("a,,b,", comma)).toEqual(["a", "", "b", ""]);
  });
  it("several in a row as one, when asked", () => {
    expect(splitText("Asha   Rao ", space)).toEqual(["Asha", "Rao"]);
    expect(splitText("Asha   Rao", { ...space, consecutive: false })).toEqual([
      "Asha",
      "",
      "",
      "Rao",
    ]);
  });
  it("any of several delimiters", () => {
    expect(splitText("a;b,c", { ...comma, delimiters: [",", ";"] })).toEqual(["a", "b", "c"]);
  });
  it("quotes keep a piece whole, and a doubled quote is a quote", () => {
    expect(splitText('"Lisbon, PT",2026', comma)).toEqual(["Lisbon, PT", "2026"]);
    expect(splitText('"say ""hi""",x', comma)).toEqual(['say "hi"', "x"]);
    expect(splitText('"Lisbon, PT",2026', { ...comma, qualifier: null })).toEqual([
      '"Lisbon',
      ' PT"',
      "2026",
    ]);
  });
  it("with nothing to split at, the text stays whole", () => {
    expect(splitText("a,b", { ...comma, delimiters: [] })).toEqual(["a,b"]);
  });
});

describe("the pieces as cells", () => {
  it("numbers and dates become them; formula-looking text stays text; short rows are filled", () => {
    const { rows, width } = splitColumn(
      ["Lisbon,1200,2026-03-08", "=HYPERLINK(1),-5", "only"],
      comma,
    );
    expect(width).toBe(3);
    const edits = splitEdits(rows, width, { row: 1, col: 0 });
    const engine = new WorkbookEngine([{ id: "s", name: "S", grid: { cells: {} } }]);
    engine.setInputs("s", edits);
    expect(engine.getValue("s", 1, 0)).toBe("Lisbon");
    expect(engine.getValue("s", 1, 1)).toBe(1200);
    expect(typeof engine.getValue("s", 1, 2)).toBe("number"); // a date is a serial
    expect(engine.getInput("s", 1, 2)?.f).toMatch(/y/);
    // Not run: kept as the text it was.
    expect(engine.getValue("s", 2, 0)).toBe("=HYPERLINK(1)");
    expect(engine.getValue("s", 2, 1)).toBe(-5);
    expect(engine.getValue("s", 2, 2)).toBe(null);
    expect(engine.getValue("s", 3, 0)).toBe("only");
    expect(edits.filter((e) => e.row === 3).map((e) => e.input)).toEqual(["only", "", ""]);
  });
  it("the pieces start at the destination", () => {
    const edits = splitEdits([["a", "b"]], 2, { row: 4, col: 6 });
    expect(edits.map((e) => [e.row, e.col, e.input])).toEqual([
      [4, 6, "a"],
      [4, 7, "b"],
    ]);
  });
});

describe("Data → Text to columns…", () => {
  const rules = src("src/components/sheets/useSheetRules.tsx");
  const dlg = src("src/components/sheets/TextToColumnsDialog.tsx");
  it("is on the Data tab, for one column's cells, down to the last cell in use", () => {
    expect(rules).toMatch(
      /tool\("Text to columns…", <Columns3 className="h-4 w-4" \/>, openSplit, "tool-split"\)/,
    );
    expect(rules).toMatch(
      /if \(range\.c0 !== range\.c1\) \{\s*toast\.error\("Select cells in one column to split them\."\);/,
    );
    expect(rules).toMatch(
      /const r1 = Math\.min\(range\.r1, Math\.max\(engine\.used\(tabId\)\.rows - 1, range\.r0\)\);/,
    );
  });
  it("asks before writing over data, refuses merged cells, and is one step to undo", () => {
    expect(rules).toMatch(
      /const isSource = c === s\.range\.c0 && r >= s\.range\.r0 && r <= s\.range\.r1;/,
    );
    expect(rules).toMatch(/taken &&\s*!\(await confirmAsk\(/);
    expect(rules).toMatch(/if \(mergedIn\(target, "split text into it"\)\) return;/);
    expect(rules).toMatch(/wb\.applyEdits\(tabId, splitEdits\(rows, width, dest\)\);/);
  });
  it("the dialog previews the split and needs a character to split at", () => {
    expect(dlg).toMatch(/splitColumn\(texts\.slice\(0, PREVIEW_ROWS\), opts\)/);
    expect(dlg).toMatch(/disabled=\{none \|\| !dest\.trim\(\)\}/);
  });
});
