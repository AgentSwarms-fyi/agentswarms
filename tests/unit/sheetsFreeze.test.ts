// R151. Freeze Panes. An Excel file's frozen rows and columns came in and
// went out again in the file (freeze_panes B2 read back by openpyxl), but the
// grid never drew them: a long sheet's header row and first column scrolled
// away, and View had no Freeze to put them back. While proving it, charts
// were seen drawn over the column headers when scrolled under them.
// Here: the grid drawn to HTML with frozen panes (each cell once, in the
// pane that holds it), the stacking order, the freeze line moving with
// inserted and deleted rows, and the menu's limits.
import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SheetGrid, type GridGeometry } from "@/components/sheets/SheetGrid";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import {
  freezePatch,
  MAX_FROZEN_COLS,
  MAX_FROZEN_ROWS,
  moveCells,
  shiftFrozen,
} from "@/lib/sheets/ops";

const noop = () => {};

function html(frozen: Partial<GridData>, overlays: string[] = []): string {
  const cells: GridData["cells"] = {};
  for (let r = 0; r < 30; r++) for (let c = 0; c < 6; c++) cells[`${r},${c}`] = { i: `${r}.${c}` };
  const engine = new WorkbookEngine([
    { id: "s", name: "S", kind: "grid", grid: { cells, ...frozen } },
  ]);
  return renderToStaticMarkup(
    createElement(SheetGrid, {
      engine,
      tabId: "s",
      rev: 0,
      rowCount: 60,
      colCount: 12,
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
      renderOverlay: (geo: GridGeometry) => {
        overlays.push(`${geo.pane}:${geo.has?.(0, 0)}`);
        return null;
      },
    }),
  );
}

/** The markup of the element with this test id (up to its sibling panes). */
const section = (h: string, id: string) => {
  const i = h.indexOf(`data-testid="${id}"`);
  return i < 0 ? "" : h.slice(i);
};
const count = (h: string, needle: string) => h.split(needle).length - 1;

describe("the grid draws frozen panes", () => {
  it("nothing frozen: no panes, every cell in the body once", () => {
    const h = html({});
    expect(h).not.toContain('data-testid="frozen-rows"');
    expect(h).not.toContain("data-frozen=");
    expect(count(h, 'data-cell="A1"')).toBe(1);
  });

  it("the top row and first column: each cell drawn once, in the pane that holds it", () => {
    const overlays: string[] = [];
    const h = html({ frozenRows: 1, frozenCols: 1 }, overlays);
    expect(h).toContain('data-frozen="1,1"');
    for (const cell of ["A1", "B1", "A5", "B5", "F20"])
      expect(count(h, `data-cell="${cell}"`)).toBe(1);
    const corner = section(h, "frozen-corner");
    const rowsPane = section(h, "frozen-rows");
    const colsPane = section(h, "frozen-cols");
    // A1 is the corner's; B1 the frozen row's; A5 the frozen column's; B5 the body's.
    expect(corner).toContain('data-cell="A1"');
    expect(rowsPane.slice(0, rowsPane.indexOf('data-testid="frozen-corner"'))).toContain(
      'data-cell="B1"',
    );
    expect(colsPane.slice(0, colsPane.indexOf('data-testid="frozen-rows"'))).toContain(
      'data-cell="A5"',
    );
    expect(h.slice(0, h.indexOf('data-testid="frozen-cols"'))).toContain('data-cell="B5"');
    // The corner sticks both ways by itself. Nested in the rows pane (whose
    // overflow is hidden) it stuck to that box and slid away: seen in the UI.
    expect(h).toMatch(
      /z-\[37\]"[^>]*><div[^>]*style="top:26px;left:52px;width:104px;height:24px"[^>]*data-testid="frozen-corner"/,
    );
    // Each pane draws its own overlays, told which cells are its own.
    expect(overlays.sort()).toEqual(["body:false", "cols:false", "corner:true", "rows:false"]);
  });

  it("the frozen rows' and columns' headers stay put with them", () => {
    const h = html({ frozenRows: 2, frozenCols: 1 });
    // Sticky bands first in each header track: rows 1–2's numbers (48 px under
    // the 26 px column header), then column A's letter; the scrolling ones follow.
    const rowBand = h.indexOf('class="sticky z-[1] bg-muted" style="top:26px;height:48px"');
    const colBand = h.indexOf(
      'class="sticky z-[1] bg-muted" style="left:52px;width:104px;height:26px"',
    );
    expect(rowBand).toBeGreaterThan(-1);
    expect(colBand).toBeGreaterThan(-1);
    const at = (s: string) => h.indexOf(s);
    expect(rowBand).toBeLessThan(at('data-row="1"'));
    expect(at('data-row="1"')).toBeLessThan(at('data-row="2"'));
    expect(at('data-row="2"')).toBeLessThan(at('data-row="3"'));
    expect(colBand).toBeLessThan(at('data-col="A"'));
    expect(at('data-col="A"')).toBeLessThan(at('data-col="B"'));
    expect(count(h, 'data-row="1"')).toBe(1);
    expect(count(h, 'data-col="A"')).toBe(1);
  });

  it("stacks body, then frozen panes, then headers; charts go under the headers", () => {
    const h = html({ frozenRows: 1 });
    expect(h).toMatch(/data-testid="sheet-grid"[^>]*class="[^"]*\bisolate\b/);
    const z = (cls: string) => Number(/z-\[(\d+)\]/.exec(cls)?.[1]);
    const cornerHeader = /class="sticky left-0 top-0 (z-\[\d+\])/.exec(h)![1];
    const colHeaders = /class="sticky top-0 (z-\[\d+\]) bg-muted"/.exec(h)![1];
    const rowHeaders = /class="sticky left-0 (z-\[\d+\]) bg-muted"/.exec(h)![1];
    const rowsPane =
      /class="pointer-events-none absolute left-0 top-0 (z-\[\d+\])"[^>]*>\s*<div[^>]*data-testid="frozen-rows"/.exec(
        h,
      )![1];
    // Charts are z-20 in the body (ChartFrame); the panes must cover them,
    // and the headers everything.
    expect(readFileSync("src/components/sheets/ChartFrame.tsx", "utf8")).toContain(
      '"group absolute z-20 ',
    );
    expect(z(rowsPane)).toBeGreaterThan(30);
    expect(z(rowHeaders)).toBeGreaterThan(z(rowsPane));
    expect(z(colHeaders)).toBeGreaterThan(z(rowHeaders));
    expect(z(cornerHeader)).toBeGreaterThan(z(colHeaders));
  });
});

describe("the grid's geometry with frozen panes", () => {
  const src = readFileSync("src/components/sheets/SheetGrid.tsx", "utf8");
  it("a click in a frozen pane is not moved by the scroll", () => {
    expect(src).toMatch(/const x = sx < frozenW \? sx : sx \+ el\.scrollLeft;/);
    expect(src).toMatch(/const y = sy < frozenH \? sy : sy \+ el\.scrollTop;/);
  });
  it("a cell scrolled into view clears the frozen panes; a frozen one needs no scroll", () => {
    expect(src).toMatch(
      /if \(target\.row >= fr\) \{\s*if \(top < el\.scrollTop \+ frozenH\) el\.scrollTop = top - frozenH;/,
    );
    expect(src).toMatch(
      /if \(target\.col >= fc\) \{\s*if \(left < el\.scrollLeft \+ frozenW\) el\.scrollLeft = left - frozenW;/,
    );
  });
  it("overlays draw only in the pane that holds their cell", () => {
    const rules = readFileSync("src/components/sheets/useSheetRules.tsx", "utf8");
    expect(rules).toMatch(
      /const here = \(r: number, c: number\) => geo\.has\?\.\(r, c\) \?\? true;/,
    );
    expect(rules).toMatch(/if \(!w \|\| !here\(r0, c\)\) continue;/);
    expect(rules).toMatch(/activeRule && dvEnv && tabId && here\(focus\.row, focus\.col\)/);
    expect(readFileSync("src/components/sheets/useSheetCharts.tsx", "utf8")).toMatch(
      /charts\.length && \(geo\.pane \?\? "body"\) === "body"/,
    );
    expect(readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8")).toMatch(
      /if \(!url \|\| \(geo\.has && !geo\.has\(focus\.row, focus\.col\)\)\) return null;/,
    );
  });
});

describe("the freeze line", () => {
  it("moves down past rows inserted above it, and shrinks with frozen rows deleted", () => {
    expect(shiftFrozen(2, 0, 3, MAX_FROZEN_ROWS)).toBe(5);
    expect(shiftFrozen(2, 1, 1, MAX_FROZEN_ROWS)).toBe(3);
    expect(shiftFrozen(2, 2, 5, MAX_FROZEN_ROWS)).toBe(2); // below the line
    expect(shiftFrozen(3, 1, -1, MAX_FROZEN_ROWS)).toBe(2);
    expect(shiftFrozen(3, 1, -10, MAX_FROZEN_ROWS)).toBe(1);
    expect(shiftFrozen(1, 0, -1, MAX_FROZEN_ROWS)).toBeUndefined();
    expect(shiftFrozen(99, 0, 5, MAX_FROZEN_ROWS)).toBe(100); // what a save keeps
    expect(shiftFrozen(undefined, 0, 1, MAX_FROZEN_ROWS)).toBeUndefined();
  });
  it("inserting and deleting rows and columns carries it", () => {
    const g: GridData = { cells: {}, frozenRows: 1, frozenCols: 2 };
    expect(moveCells(g, "rows", 0, 2).frozenRows).toBe(3);
    expect(moveCells(g, "rows", 0, 2).frozenCols).toBe(2);
    expect(moveCells(g, "cols", 1, 1).frozenCols).toBe(3);
    expect(moveCells(g, "cols", 0, -2).frozenCols).toBeUndefined();
    expect(moveCells(g, "rows", 5, 1).frozenRows).toBe(1);
  });
  it("Freeze Panes keeps what a save allows, and says when it could not", () => {
    expect(freezePatch(1, 0)).toEqual({
      patch: { frozenRows: 1, frozenCols: undefined },
      clamped: false,
    });
    expect(freezePatch(0, 0).patch).toEqual({ frozenRows: undefined, frozenCols: undefined });
    expect(freezePatch(250, 80)).toEqual({
      patch: { frozenRows: MAX_FROZEN_ROWS, frozenCols: MAX_FROZEN_COLS },
      clamped: true,
    });
    // The save's own limits.
    const schema = readFileSync("src/utils/sheets/schemas.ts", "utf8");
    expect(schema).toContain(`frozenRows: z.number().int().min(0).max(${MAX_FROZEN_ROWS})`);
    expect(schema).toContain(`frozenCols: z.number().int().min(0).max(${MAX_FROZEN_COLS})`);
  });
  it("View → Freeze sets it as an undoable sheet setting", () => {
    const ed = readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8");
    expect(ed).toMatch(
      /const \{ patch, clamped \} = freezePatch\(rows, cols\);\s*wb\.setGridMeta\(tabId, patch\);/,
    );
    expect(ed).toMatch(/view: \(\s*<FreezeMenu/);
  });
});
