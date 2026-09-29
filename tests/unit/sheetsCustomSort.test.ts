// Data → Sort… (R156), Excel's Custom Sort: several levels, each A to Z or
// Z to A. Before, Sort A to Z sorted by the active column only, so a list
// could not be ordered by city and then by name. And found while proving
// it: every sort moved rows under a merged cell and left the merge where it
// was, joining two other records' cells; a sort now refuses merged cells.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRangeA1 } from "@/lib/sheets/a1";
import { cellView } from "@/lib/sheets/cellView";
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
const src = (p: string) => readFileSync(p, "utf8");

function sorted(keys: { col: number; desc: boolean }[], header = true) {
  const engine = new WorkbookEngine([{ id: "s", name: "Contacts", grid: structuredClone(grid) }]);
  const edits: RowEdit[] = sortEdits(
    LIST,
    keys,
    {
      value: (r, c) => engine.getValue("s", r, c),
      input: (r, c) => engine.getInput("s", r, c),
    },
    header,
  );
  engine.setInputs(
    "s",
    edits.map((e) => ({
      row: e.row,
      col: e.col,
      input: e.input,
      format: e.format,
      style: e.style,
      link: e.link,
      note: e.note,
    })),
  );
  const text = (r: number, c: number) =>
    cellView(engine.getValue("s", r, c), engine.getInput("s", r, c)).text;
  return { engine, text };
}

describe("sorting by several columns", () => {
  it("city A to Z, then name Z to A: ties in the first are ordered by the second", () => {
    const { text } = sorted([
      { col: 2, desc: false },
      { col: 0, desc: true },
    ]);
    expect([1, 2, 3, 4, 5, 6, 7].map((r) => `${text(r, 2)}/${text(r, 0)}`)).toEqual([
      "Braga/Dev Iyer",
      "Braga/Dev Iyer",
      "Faro/Cleo Park",
      "Lisbon/Asha Rao",
      "Lisbon/Asha Rao",
      "Porto/Ben Ode",
      "Porto/Ben Ode",
    ]);
  });
  it("the second level decides between rows the first leaves tied", () => {
    // Signed up A to Z: 8 Mar holds two Asha rows and two Dev rows; Name Z to A puts Dev first.
    const { text } = sorted([
      { col: 3, desc: false },
      { col: 0, desc: true },
    ]);
    expect([1, 2, 3, 4, 5, 6, 7].map((r) => text(r, 0))).toEqual([
      "Dev Iyer",
      "Dev Iyer",
      "Asha Rao",
      "Asha Rao",
      "Ben Ode",
      "Ben Ode",
      "Cleo Park",
    ]);
  });
  it("Z to A on the first level", () => {
    const { text } = sorted([{ col: 2, desc: true }]);
    expect([1, 2, 3, 4, 5, 6, 7].map((r) => text(r, 2))).toEqual([
      "Porto",
      "Porto",
      "Lisbon",
      "Lisbon",
      "Faro",
      "Braga",
      "Braga",
    ]);
  });
  it("rows tie on every level keep their order (a stable sort)", () => {
    const { text } = sorted([{ col: 0, desc: false }]);
    // The two Asha rows: lower case first, as they stood.
    expect([text(1, 1), text(2, 1)]).toEqual(["asha@example.com", "ASHA@EXAMPLE.COM"]);
  });
  it("formulas and notes go with their rows; the header stays", () => {
    const { engine, text } = sorted([
      { col: 2, desc: false },
      { col: 0, desc: true },
    ]);
    expect(text(0, 0)).toBe("Name");
    // Cleo (Faro), from row 5 to row 4: her =LEN(B5) is now =LEN(B4), her note with her.
    expect(engine.getInput("s", 3, 4)?.i).toBe("=LEN(B4)");
    expect(engine.getInput("s", 3, 2)?.n).toMatch(/Moved from Lisbon in April\./);
  });
});

describe("Data → Sort… and merged cells", () => {
  const rules = src("src/components/sheets/useSheetRules.tsx");
  const dlg = src("src/components/sheets/SortDialog.tsx");
  it("the Data tab has Sort…, over the filter's range or the data around the cell", () => {
    expect(rules).toMatch(
      /tool\("Sort…", <ArrowUpDown className="h-4 w-4" \/>, openSort, "tool-sort-custom"\)/,
    );
    expect(rules).toMatch(/const block = inFilter \? filterRange! : dataBlock\(\);/);
    expect(rules).toMatch(/header: inFilter \|\| looksLikeHeader\(block\),/);
  });
  it("every sort refuses a range with merged cells, and says so", () => {
    expect(rules).toMatch(
      /const sortByKeys = [\s\S]{0,160}if \(!engine \|\| !tabId\) return false;\s*if \(mergedIn\(block\)\) return false;/,
    );
    expect(rules).toMatch(/Unmerge them to sort it\./);
    expect(rules).toMatch(/if \(mergedIn\(block\)\) return;\s*setSorting\(/);
    // Sort A to Z says it sorted only when it did; the filter's arrows likewise.
    expect(rules).toMatch(
      /if \(!sortBlock\(block, focus\.col, desc, looksLikeHeader\(block\)\)\) return;/,
    );
    expect(rules).toMatch(
      /if \(sortBlock\(filterRange, filterRange\.c0 \+ offset, desc, true\)\) refilter\(\);/,
    );
  });
  it("sorts by every level the dialog holds, and re-filters a filter's range", () => {
    expect(rules).toMatch(
      /const keys = levels\.map\(\(l\) => \(\{ col: s\.block\.c0 \+ l\.offset, desc: l\.desc \}\)\);/,
    );
    expect(rules).toMatch(/if \(s\.filtered\) refilter\(\);/);
  });
  it("the dialog: a column once, a new level on a column not used yet, headers guessed", () => {
    expect(dlg).toMatch(/disabled=\{Boolean\(repeated\)\}/);
    expect(dlg).toMatch(
      /const unused = columns\.findIndex\(\(_, i\) => !levels\.some\(\(l\) => l\.offset === i\)\);/,
    );
    expect(dlg).toMatch(/useState\(guessHeader\)/);
    expect(dlg).toMatch(/\[\{ offset: first, desc: false \}\]/);
  });
});
