// R152. Cell notes (Excel's comments). An .xlsx from openpyxl, which much
// Python-made reporting uses, with a note in it could not be imported at all:
// "Could not read …: Cannot read properties of undefined (reading
// 'comments')". ExcelJS expects Excel's own layout (xl/commentsN.xml) and
// threw on openpyxl's (xl/comments/commentN.xml, an absolute target). Notes
// in Excel's own layout came in and were dropped without a word, and a sheet
// had no notes to add. Here: the package read for notes whatever wrote it,
// the round trip, the engine keeping a note-only cell, a sort carrying notes
// (and Excel's saved values), Find's Look in Notes, the grid's red corner,
// and the editor's Shift+F2 and cell menu.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import { SheetGrid } from "@/components/sheets/SheetGrid";
import { cellView } from "@/lib/sheets/cellView";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { sortEdits } from "@/lib/sheets/filter";
import { findAll } from "@/lib/sheets/find";
import { readXlsx, writeXlsx } from "@/lib/sheets/xlsx";
import { sheetNotes, withoutCommentRels } from "@/lib/sheets/xlsxNotes";
import { gridSchema } from "@/utils/sheets/schemas";

const fixture = () => {
  const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-notes.xlsx"));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const toBuf = (u: Uint8Array) =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe("an .xlsx's notes", () => {
  // The file libraries load once per worker, slowly under a full run.
  beforeAll(async () => {
    await readXlsx(await writeXlsx([]), { maxCells: 10 });
  }, 120_000);

  it("openpyxl's layout stopped the file library; without the comment links it loads", async () => {
    await expect(new ExcelJS.Workbook().xlsx.load(fixture())).rejects.toThrow(/comments/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(withoutCommentRels(fixture()));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Budget", "Notes 2"]);
  });

  it("come in with the file: each on its cell, the author first, one on an empty cell kept", async () => {
    const r = await readXlsx(fixture(), { maxCells: 1000 });
    const budget = r.sheets.find((s) => s.name === "Budget")!.grid.cells;
    expect(budget["2,1"]).toMatchObject({
      i: "450",
      n: "Asha:\nTwo trips to the Lisbon office.\nReceipts in the shared drive.",
    });
    expect(budget["3,0"].n).toBe("Ben:\nAnnual licences, paid in March.");
    expect(budget["4,1"]).toMatchObject({
      i: "=SUM(B2:B4)",
      n: "Asha:\nChecked against the ledger on 30 Sep.",
    });
    expect(budget["1,3"]).toEqual({ i: "", n: "Ben:\nAsk finance about Q4." });
    expect(r.sheets[1].grid.cells["0,0"].n).toBe("Asha:\nOn the second sheet.");
  });

  it("go out as Excel's own notes, and come back the same", async () => {
    const r = await readXlsx(fixture(), { maxCells: 1000 });
    const e = new WorkbookEngine(
      r.sheets.map((s, i) => ({ id: `s${i}`, name: s.name, kind: "grid" as const, grid: s.grid })),
    );
    const buf = await writeXlsx(
      r.sheets.map((s, i) => ({
        kind: "grid" as const,
        name: s.name,
        grid: e.snapshot(`s${i}`)!,
        value: (row: number, col: number) => e.getValue(`s${i}`, row, col),
      })),
    );
    const parts = unzipSync(new Uint8Array(buf));
    const comments = Object.keys(parts).filter((n) => /^xl\/comments\d+\.xml$/.test(n));
    expect(comments.length).toBe(2);
    expect(strFromU8(parts[comments[0]])).toContain("Two trips to the Lisbon office.");
    const back = await readXlsx(buf, { maxCells: 1000 });
    const notes = (g: GridData) =>
      Object.fromEntries(Object.entries(g.cells).flatMap(([k, c]) => (c.n ? [[k, c.n]] : [])));
    expect(notes(back.sheets[0].grid)).toEqual(notes(r.sheets[0].grid));
    expect(notes(back.sheets[1].grid)).toEqual(notes(r.sheets[1].grid));
  });

  it("Excel's own layout, which came in and was dropped, now comes in", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = "x";
    ws.getCell("A1").note = "Kept note";
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const r = await readXlsx(buf, { maxCells: 10 });
    expect(r.sheets[0].grid.cells["0,0"]).toMatchObject({ i: "x", n: "Kept note" });
  });

  it("a threaded comment (Excel 365) is read from its own part, with its replies", async () => {
    const files = unzipSync(new Uint8Array(fixture()));
    const rels = "xl/worksheets/_rels/sheet2.xml.rels";
    files[rels] = strToU8(
      strFromU8(files[rels]).replace(
        "</Relationships>",
        '<Relationship Id="t1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>',
      ),
    );
    files["xl/threadedComments/threadedComment1.xml"] = strToU8(
      '<ThreadedComments><threadedComment ref="A1" personId="{P1}" id="{C1}"><text>Is this final?</text></threadedComment>' +
        '<threadedComment ref="A1" personId="{P2}" id="{C2}" parentId="{C1}"><text>Yes &amp; signed off.</text></threadedComment></ThreadedComments>',
    );
    files["xl/persons/person.xml"] = strToU8(
      '<personList><person displayName="Dara Kim" id="{P1}"/><person displayName="Chen Wei" id="{P2}"/></personList>',
    );
    expect(sheetNotes(files, "xl/worksheets/sheet2.xml").get("A1")).toBe(
      "Dara Kim:\nIs this final?\n\nChen Wei:\nYes & signed off.",
    );
    const r = await readXlsx(toBuf(zipSync(files)), { maxCells: 1000 });
    expect(r.sheets[1].grid.cells["0,0"].n).toBe(
      "Dara Kim:\nIs this final?\n\nChen Wei:\nYes & signed off.",
    );
  });
});

describe("a note in the workbook", () => {
  const engine = () =>
    new WorkbookEngine([
      { id: "s", name: "S", kind: "grid", grid: { cells: { "0,0": { i: "x", n: "hello" } } } },
    ]);

  it("is kept by an edit that does not mention it, and removed by one that does", () => {
    const e = engine();
    e.setInputs("s", [{ row: 0, col: 0, input: "y" }]);
    expect(e.getInput("s", 0, 0)).toEqual({ i: "y", n: "hello" });
    e.setInputs("s", [{ row: 0, col: 0, input: "y", note: null }]);
    expect(e.getInput("s", 0, 0)).toEqual({ i: "y" });
  });
  it("keeps a cell that holds nothing else, as Excel does", () => {
    const e = engine();
    e.setInputs("s", [{ row: 0, col: 0, input: "" }]);
    expect(e.getInput("s", 0, 0)).toEqual({ i: "", n: "hello" });
    e.setInputs("s", [{ row: 0, col: 0, input: "", note: null }]);
    expect(e.getInput("s", 0, 0)).toBeUndefined();
  });
  it("is saved: the server's schema takes it, up to Excel's limit", () => {
    expect(gridSchema.safeParse({ cells: { "0,0": { i: "", n: "Note" } } }).success).toBe(true);
    expect(
      gridSchema.safeParse({ cells: { "0,0": { i: "", n: "x".repeat(32768) } } }).success,
    ).toBe(false);
  });
  it("goes with its row in a sort, and so does Excel's saved value", () => {
    const cells: Record<string, { i: string; n?: string; c?: number }> = {
      "0,0": { i: "Name" },
      "1,0": { i: "b", n: "second" },
      "2,0": { i: "a", n: "first" },
      "1,1": { i: "=CUBEVALUE(1)", c: 20 },
      "2,1": { i: "=CUBEVALUE(2)", c: 10 },
    };
    const edits = sortEdits(
      { r0: 0, c0: 0, r1: 2, c1: 1 },
      [{ col: 0, desc: false }],
      {
        value: (r, c) => (cells[`${r},${c}`]?.i ?? null) as string | null,
        input: (r, c) => cells[`${r},${c}`],
      },
      true,
    );
    const at = (r: number, c: number) => edits.find((x) => x.row === r && x.col === c)!;
    expect(at(1, 0)).toMatchObject({ input: "a", note: "first" });
    expect(at(2, 0)).toMatchObject({ input: "b", note: "second" });
    expect(at(1, 1).cached).toBe(10);
    expect(readFileSync("src/components/sheets/useSheetRules.tsx", "utf8")).toMatch(
      /\.\.\.\(e\.note \? \{ n: e\.note \} : \{\}\),\s*\.\.\.\(e\.cached !== null && e\.input\.startsWith\("="\) \? \{ c: e\.cached \} : \{\}\),/,
    );
  });
  it("Find looks in notes, as Excel's Look in: Notes", () => {
    const e = engine();
    const hits = findAll(
      [
        {
          sheetId: "s",
          sheet: "S",
          rows: 1,
          cols: 1,
          text: (r, c) => e.getInput("s", r, c)?.n || undefined,
        },
      ],
      { text: "hell", lookIn: "notes" },
    );
    expect(hits.hits).toEqual([{ sheetId: "s", sheet: "S", row: 0, col: 0, text: "hello" }]);
    expect(readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8")).toMatch(
      /lookIn === "notes"\s*\? \(r: number, c: number\) => engine\.getInput\(t\.id, r, c\)\?\.n/,
    );
  });
});

describe("the grid and the editor", () => {
  it("a cell with a note shows Excel's red corner and the note on hover, even when empty", () => {
    const engine = new WorkbookEngine([
      {
        id: "s",
        name: "S",
        kind: "grid",
        grid: {
          cells: { "0,0": { i: "x", n: "Asha:\nCheck this" }, "1,1": { i: "", n: "Empty" } },
        },
      },
    ]);
    const noop = () => {};
    const h = renderToStaticMarkup(
      createElement(SheetGrid, {
        engine,
        tabId: "s",
        rev: 0,
        rowCount: 20,
        colCount: 6,
        grid: engine.gridOf("s"),
        zoom: 1,
        selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
        onSelect: noop,
        editing: null,
        onEditChange: noop,
        onCommit: noop,
        onKey: noop,
        onColWidth: noop,
        onRowHeight: noop,
        onFill: noop,
        onNearEnd: noop,
        editorRef: { current: null },
        gridRef: { current: null },
        onType: noop,
      }),
    );
    expect(h).toMatch(
      /title="Asha:\nCheck this" data-note="true"[^>]*data-cell="A1"|data-cell="A1"[^>]*title="Asha:\nCheck this"/,
    );
    expect(h).toMatch(/data-cell="B2"[^>]*data-note="true"|data-note="true"[^>]*data-cell="B2"/);
    expect(h.match(/border-t-red-600/g)?.length).toBe(2);
    expect(cellView(engine.getValue("s", 1, 1), engine.getInput("s", 1, 1)).text).toBe("");
  });
  it("Shift+F2 and the cell's menu open the note; paste brings it; the active cell shows it", () => {
    const ed = readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8");
    expect(ed).toMatch(/if \(e\.key === "F2" && e\.shiftKey\) \{[\s\S]{0,120}openNoteDialog\(\);/);
    expect(ed).toMatch(/item\(hasNote \? "Edit note…" : "New note…", actions\.note\)/);
    expect(ed).toMatch(/hasNote && item\("Delete note", actions\.deleteNote, true\)/);
    expect(ed).toMatch(/link: cell\?\.l \?\? null,\s*note: cell\?\.n \?\? null,/);
    expect(ed).toMatch(/l: input\.l, n: input\.n \}/);
    expect(ed).toMatch(
      /if \(!note \|\| \(geo\.has && !geo\.has\(focus\.row, focus\.col\)\)\) return null;/,
    );
  });
  it("Clear all takes a cell's note, as Excel's; Clear notes takes only the note", () => {
    const ed = readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8");
    const clear = ed.slice(ed.indexOf("const clear = (kind: ClearKind)"));
    expect(clear).toMatch(
      /if \(kind === "all"\)\s*edits\.push\(\{[^}]*link: null,\s*note: null,\s*\}\);/,
    );
    expect(clear).toMatch(
      /kind === "notes" && cur\.n\) edits\.push\(\{ row: r, col: c, input: cur\.i, note: null \}\)/,
    );
    // Clear contents keeps the note: the edit does not mention it.
    expect(clear).toMatch(/if \(cur\.i\) edits\.push\(\{ row: r, col: c, input: "" \}\);/);
    expect(readFileSync("src/components/sheets/SheetToolbar.tsx", "utf8")).toMatch(
      /onSelect=\{\(\) => a\.clear\("notes"\)\}>Clear notes</,
    );
    // The engine: an edit with note null removes it, and the emptied cell goes.
    const engine = new WorkbookEngine([{ id: "s", name: "S", grid: { cells: {} } }]);
    engine.setInputs("s", [{ row: 0, col: 0, input: "x", note: "n" }]);
    engine.setInputs("s", [
      { row: 0, col: 0, input: "", format: null, style: null, link: null, note: null },
    ]);
    expect(engine.getInput("s", 0, 0)).toBeUndefined();
  });
  it("the import dialog counts each sheet's notes before it comes in", () => {
    const dlg = readFileSync("src/components/sheets/ImportFileDialog.tsx", "utf8");
    expect(dlg).toMatch(/Object\.values\(grid\.cells\)\.filter\(\(c\) => c\.n\)\.length/);
    expect(dlg).toMatch(/noteCount\(s\.grid\) > 0 &&/);
    expect(dlg).toMatch(/links, notes,/);
  });
});
