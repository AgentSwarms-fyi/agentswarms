// A file's text stays text (R164). Before: the import kept text as text
// only when it was made of digits and $.,%()- alone, so £1,234.50, €99,
// ¥500 and codes like 1e5 came in as numbers (COUNT and SUM took them), and
// a text starting with an apostrophe lost it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkbookEngine } from "@/lib/sheets/engine";
import { readXlsx, writeXlsx, type ImportResult } from "@/lib/sheets/xlsx";

let file: ImportResult;
let e: WorkbookEngine;
beforeAll(async () => {
  const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-text.xlsx"));
  file = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
    maxCells: 1000,
  });
  e = new WorkbookEngine([{ id: "s", name: "Texts", grid: file.sheets[0].grid }]);
  e.recalcAll();
}, 60_000);

const TEXTS = ["£1,234.50", "€99", "¥500", "1e5", "2E3", "'quoted", "$1,200", "007", "=1+1"];

describe("a file's text cells (openpyxl-text.xlsx)", () => {
  it("come in as the text they are", () => {
    expect(TEXTS.map((_, r) => e.getValue("s", r, 0))).toEqual(TEXTS);
  });
  it("so ISTEXT says so, and COUNT and SUM leave them out, as in Excel", () => {
    expect(TEXTS.map((_, r) => e.getValue("s", r, 1))).toEqual(TEXTS.map(() => true));
    expect(e.getValue("s", 0, 2)).toBe(0); // COUNT
    expect(e.getValue("s", 1, 2)).toBe(9); // COUNTA
    expect(e.getValue("s", 0, 3)).toBe(0); // SUM
  });
  it("a number in the file is still a number", () => {
    expect(e.getValue("s", 0, 4)).toBe(1234.5);
    expect(e.getValue("s", 1, 4)).toBe(true);
  });
  it("are kept as typed text, so editing them keeps them text", () => {
    expect(file.sheets[0].grid.cells["0,0"].i).toBe("'£1,234.50");
    expect(file.sheets[0].grid.cells["5,0"].i).toBe("''quoted");
    // A plain word needs no mark, and has none.
    expect(file.sheets[0].grid.cells["0,5"].i).toBe("Hello");
  });
  it("go back out as text, and come in again the same", async () => {
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "Texts",
        grid: e.snapshot("s")!,
        value: (r, c) => e.getValue("s", r, c),
      },
    ]);
    const back = await readXlsx(buf, { maxCells: 1000 });
    const again = new WorkbookEngine([{ id: "s", name: "Texts", grid: back.sheets[0].grid }]);
    again.recalcAll();
    expect(TEXTS.map((_, r) => again.getValue("s", r, 0))).toEqual(TEXTS);
    expect(again.getValue("s", 0, 2)).toBe(0);
  });
});
