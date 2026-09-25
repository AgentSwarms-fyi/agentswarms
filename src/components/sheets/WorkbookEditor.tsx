// The workbook editor: toolbar, formula bar, grid, sheet tabs, status bar.
//
// Keyboard and clipboard follow Excel: arrows move (Shift extends, Ctrl
// jumps to the edge of the data), typing replaces, F2 edits, Enter/Tab commit
// and move, Delete clears, Ctrl+Z/Y undo/redo, Ctrl+C/X/V copy/cut/paste
// (formulas shift when pasted inside the workbook; text from Excel or Google
// Sheets pastes as values), Ctrl+D/R fill down/right, Ctrl+B/I/U/5 style,
// Ctrl+K a link, Alt+Enter a line break in the cell, Ctrl+wheel zooms.
// The ribbon formats the selection: fonts, colors, borders, alignment,
// wrapping, merging and number formats; merged cells move and select as
// one, and hidden rows and columns are skipped.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ChevronDown,
  Database,
  ExternalLink,
  Grid3x3,
  Loader2,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmAsk, promptAsk } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { a1, cellKey, colLetters, parseRangeA1, type RangeAddr } from "@/lib/sheets/a1";
import { cellView, editText, impliedFormat } from "@/lib/sheets/cellView";
import type { CellStyle } from "@/lib/sheets/engine";
import { isError, type Scalar } from "@/lib/sheets/formula/values";
import { adjustDecimals } from "@/lib/sheets/format";
import { clampZoom, stepZoom } from "@/lib/sheets/geometry";
import {
  addMerge,
  cellsLostByMerge,
  expandToMerges,
  mergeAt,
  parseMerges,
  removeMerges,
  type MergeMode,
} from "@/lib/sheets/merge";
import {
  bordersFor,
  DEFAULT_SIZE,
  normalizeLink,
  parseInternalLink,
  SIZES,
  type BorderPreset,
  type BorderStyle,
} from "@/lib/sheets/style";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import { shiftFormula } from "@/lib/sheets/formula/shift";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import {
  adjustFormula,
  adjustRuleFormulas,
  describeRange,
  fillEdits,
  moveCells,
  parseTsv,
  toTsv,
  type Axis,
} from "@/lib/sheets/ops";
import {
  sheetsAddTab,
  sheetsDeleteTab,
  sheetsRenameTab,
  sheetsReorderTabs,
} from "@/utils/sheets.functions";
import { selRange, type Selection } from "@/lib/sheets/selection";
import { LinkDialog } from "./LinkDialog";
import { OpenTableDialog } from "./OpenTableDialog";
import { DEFAULT_COL_W, ROW_H, SheetGrid, type Editing, type GridGeometry } from "./SheetGrid";
import { useSheetCharts } from "./useSheetCharts";
import { useSheetRules } from "./useSheetRules";
import { SheetToolbar, ZoomControl, type ClearKind } from "./SheetToolbar";
import { SaveToLakehouseDialog } from "./SaveToLakehouseDialog";
import { TableSheet } from "./TableSheet";
import type { CellEdit, SaveState, TabMeta, useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

const MIN_ROWS = 1000;
const MIN_COLS = 52;
const NEWLINE = String.fromCharCode(10);

type Clip = {
  tabId: string;
  range: RangeAddr;
  inputs: ({ i: string; f?: string; s?: CellStyle; l?: string } | undefined)[][];
  /** What the cells showed when copied, for Paste Values. */
  values: Scalar[][];
  tsv: string;
  cut: boolean;
};

/** A value as typed input that reads back as the same value. */
function literalText(v: Scalar): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v) || v === "") return "";
  // Text that would read as a number, a formula or a boolean stays text.
  return /^[=+\-@]|^(true|false)$/i.test(v) || Number.isFinite(Number(v.replace(/[,$%]/g, "")))
    ? `'${v}`
    : v;
}

/** The zoom each sheet was left at, per workbook, in this browser. */
function readZoom(workbookId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(`sheets.zoom.${workbookId}`);
    const v = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeZoom(workbookId: string, v: Record<string, number>) {
  try {
    localStorage.setItem(`sheets.zoom.${workbookId}`, JSON.stringify(v));
  } catch {
    // Private windows and blocked storage: the zoom just is not remembered.
  }
}

export function WorkbookEditor({
  wb,
  token,
  workbookId,
}: {
  wb: Workbook;
  token: string;
  workbookId: string;
}) {
  const { engine, tabs, activeTabId, rev } = wb;
  const tabId = activeTabId;
  const [selection, setSelection] = useState<Selection>({
    anchor: { row: 0, col: 0 },
    focus: { row: 0, col: 0 },
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [extent, setExtent] = useState({ rows: MIN_ROWS, cols: MIN_COLS });
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    kind: "cell" | "row" | "col";
  } | null>(null);
  const [openTable, setOpenTable] = useState(false);
  const [saveRange, setSaveRange] = useState<RangeAddr | null>(null);
  const editorRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const gridRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLInputElement | null>(null);
  const clip = useRef<Clip | null>(null);

  const addTabFn = useServerFn(sheetsAddTab);
  const renameTabFn = useServerFn(sheetsRenameTab);
  const deleteTabFn = useServerFn(sheetsDeleteTab);
  const reorderFn = useServerFn(sheetsReorderTabs);

  const activeTab = tabs.find((t) => t.id === tabId) ?? null;
  // The live grid, read each render (a copy of every cell per render was the
  // old cost of moving the selection on a large sheet).
  const grid = tabId && engine ? engine.gridOf(tabId) : undefined;
  const colWidths = grid?.colWidths ?? {};
  const merges = useMemo(
    () => parseMerges(grid?.merges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.merges, rev],
  );
  const hiddenRows = useMemo(
    () => new Set([...(grid?.hiddenRows ?? []), ...(grid?.filter?.hidden ?? [])]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.hiddenRows, grid?.filter?.hidden, rev],
  );
  // What the grid draws: rows the filter hides are hidden too.
  const gridView = useMemo(
    () => (grid && grid.filter?.hidden?.length ? { ...grid, hiddenRows: [...hiddenRows] } : grid),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid, hiddenRows, rev],
  );
  const hiddenCols = useMemo(
    () => new Set(grid?.hiddenCols ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.hiddenCols, rev],
  );

  // ── Zoom, per sheet, remembered in this browser ─────────────────────────
  const [zooms, setZooms] = useState<Record<string, number>>(() => readZoom(workbookId));
  const zoom = (tabId && zooms[tabId]) || 100;
  /**
   * Set the zoom, or step it from whatever it is by then: several wheel
   * notches in one frame each take a step (computing each from the value
   * this render saw moved one step for the lot).
   */
  const setZoom = (z: number | ((cur: number) => number)) => {
    if (!tabId) return;
    setZooms((prev) => {
      const cur = prev[tabId] || 100;
      const next = { ...prev, [tabId]: clampZoom(typeof z === "function" ? z(cur) : z) };
      writeZoom(workbookId, next);
      return next;
    });
  };

  // Grow the scrollable area to cover the data, plus room to type.
  useEffect(() => {
    if (!engine || !tabId) return;
    const used = engine.used(tabId);
    setExtent({
      rows: Math.max(MIN_ROWS, used.rows + 200),
      cols: Math.max(MIN_COLS, used.cols + 10),
    });
    setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
    setEditing(null);
  }, [tabId, engine]);

  // A selection never cuts a merged cell in two.
  const range = expandToMerges(selRange(selection), merges);
  // The active cell: the selection's anchor, as in Excel (Shift+click extends
  // the selection but typing still goes where it started).
  const focus = selection.anchor;
  const focusInput = engine && tabId ? engine.getInput(tabId, focus.row, focus.col) : undefined;
  const selectionMerged = merges.some(
    (m) => m.r0 >= range.r0 && m.r1 <= range.r1 && m.c0 >= range.c0 && m.c1 <= range.c1,
  );

  /** The active cell's link, with what to do about it. */
  const linkChip = (geo: GridGeometry) => {
    if (!engine || !tabId) return null;
    // The active cell's link, with what to do about it.
    const url = !editing ? linkUrlAt(focus.row, focus.col) : null;
    if (!url) return null;
    const box = mergeAt(merges, focus.row, focus.col) ?? {
      r0: focus.row,
      c0: focus.col,
      r1: focus.row,
      c1: focus.col,
    };
    return (
      <div
        className="absolute z-30 flex max-w-sm items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
        style={{ left: geo.cols.start(box.c0), top: geo.rows.end(box.r1) + 4 }}
        data-testid="link-chip"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 truncate text-primary underline-offset-2 hover:underline"
          title={`Open ${url}`}
          onClick={() => followLink(focus.row, focus.col)}
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{url}</span>
        </button>
        {engine.getInput(tabId, focus.row, focus.col)?.l && (
          <>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-muted"
              aria-label="Edit link"
              title="Edit link"
              onClick={openLinkDialog}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-muted"
              aria-label="Remove link"
              title="Remove link"
              onClick={() => {
                const cur = engine.getInput(tabId, focus.row, focus.col);
                wb.applyEdits(tabId, [
                  { row: focus.row, col: focus.col, input: cur?.i ?? "", link: null },
                ]);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    );
  };

  // Charts over the sheet's ranges.
  const charts = useSheetCharts({
    wb,
    engine,
    tabId,
    grid,
    range,
    onDone: () => afterDialog(),
  });

  // Conditional formatting, data validation, the filter.
  const rules = useSheetRules({
    wb,
    engine,
    tabId,
    grid,
    rev,
    range,
    focus,
    editing: !!editing,
    // Its menus open dialogs and popovers: the keyboard returns to the grid
    // once they have gone (backToGrid would skip while one is still closing).
    onDone: () => afterDialog(),
  });

  // ── Editing ──────────────────────────────────────────────────────────────

  const startEdit = (text: string, mode: Editing["mode"], source: Editing["source"] = "cell") => {
    setEditing({ row: focus.row, col: focus.col, text, mode, source, caret: text.length });
    setAcIndex(0);
  };

  /**
   * The cell a move of (dr, dc) lands on: out of a merged cell from its far
   * edge, over hidden rows and columns, and into a merged cell at its
   * top-left, as Excel moves.
   */
  const nextCell = useCallback(
    (from: { row: number; col: number }, dr: number, dc: number, extend = false) => {
      const m = mergeAt(merges, from.row, from.col);
      let row = from.row;
      let col = from.col;
      if (m && !extend) {
        if (dr > 0) row = m.r1;
        if (dc > 0) col = m.c1;
        if (dr < 0) row = m.r0;
        if (dc < 0) col = m.c0;
      }
      const step = (v: number, d: number, max: number, hidden: Set<number>) => {
        if (!d) return v;
        let n = Math.max(0, Math.min(max - 1, v + d));
        while (hidden.has(n) && n + Math.sign(d) >= 0 && n + Math.sign(d) < max) n += Math.sign(d);
        return hidden.has(n) ? v : n;
      };
      row = step(row, dr, extent.rows, hiddenRows);
      col = step(col, dc, extent.cols, hiddenCols);
      const into = extend ? undefined : mergeAt(merges, row, col);
      return into ? { row: into.r0, col: into.c0 } : { row, col };
    },
    [extent, merges, hiddenRows, hiddenCols],
  );

  const move = useCallback(
    (dr: number, dc: number, extend = false) => {
      setSelection((s) => {
        // Extending moves the far end; a plain move starts from the active cell.
        const f = nextCell(extend ? s.focus : s.anchor, dr, dc, extend);
        return extend ? { anchor: s.anchor, focus: f } : { anchor: f, focus: f };
      });
    },
    [nextCell],
  );

  // Where a run of Tabs across a row began: Enter then returns to that column
  // on the next row, as Excel does for typing a table row by row.
  const tabRun = useRef<number | null>(null);

  const commit = useCallback(
    (dr: number, dc: number, toCol?: number, checked = false) => {
      if (!editing || !engine || !tabId) return;
      const prev = engine.getInput(tabId, editing.row, editing.col);
      let text = editing.text;
      // Close the parentheses a formula left open, as Excel does.
      if (text.startsWith("=")) {
        const open = (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
        if (open > 0 && open < 20) text += ")".repeat(open);
      }
      if ((prev?.i ?? "") !== text) {
        // A cell's validation: a failing value waits on the alert, which keeps
        // it, returns to the edit, or drops it.
        if (
          !checked &&
          !rules.checkEdit(editing.row, editing.col, text, {
            keep: () => commitRef.current(dr, dc, toCol, true),
            // Once the alert has gone (its focus trap would take the keyboard back).
            retry: () => whenNoDialog(cellEditorFocus),
            cancel: () => {
              setEditing(null);
              whenNoDialog(() => gridRef.current?.focus({ preventScroll: true }));
            },
          })
        )
          return;
        const fmt = prev?.f ? undefined : impliedFormat(text);
        // Text with a line break wraps, as Excel turns Wrap Text on for it.
        const wrap = text.includes(NEWLINE) && !prev?.s?.wrap && !text.startsWith("=");
        wb.applyEdits(tabId, [
          {
            row: editing.row,
            col: editing.col,
            input: text,
            ...(fmt ? { format: fmt } : {}),
            ...(wrap ? { style: { ...(prev?.s ?? {}), wrap: true } } : {}),
          },
        ]);
      }
      setEditing(null);
      const next = nextCell(editing, dr, dc);
      const to = toCol === undefined ? next : { row: next.row, col: toCol };
      setSelection({ anchor: to, focus: to });
      // Now, not on the next frame: the editor is about to unmount, and a key
      // pressed in between would land on the page (Tab walking to the toolbar,
      // the next letters lost) instead of the grid.
      gridRef.current?.focus({ preventScroll: true });
    },
    [editing, engine, tabId, wb, nextCell, rules],
  );
  // The alert finishes an edit after this render's commit is gone.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  /** Run once no dialog is open (a closing one still traps the keyboard). */
  const whenNoDialog = (fn: () => void) => {
    let frames = 0;
    const tick = () => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') && frames++ < 60) {
        requestAnimationFrame(tick);
        return;
      }
      fn();
    };
    requestAnimationFrame(tick);
  };
  /** Back into the edit after a refused value: its editor (cell or bar) takes the keyboard. */
  const cellEditorFocus = () => {
    const el = editorRef.current ?? barRef.current;
    el?.focus();
  };

  /**
   * Give the keyboard back to the grid after a menu or dialog: unless a
   * dialog has just opened (Custom format…, Row height…), which keeps it.
   */
  const backToGrid = () => {
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    gridRef.current?.focus({ preventScroll: true });
  };

  /**
   * After a question (a prompt or a confirmation) closes: the keyboard goes
   * back to the grid once the dialog has gone, unless the person has since
   * put it somewhere else. Without this it fell to the page, because the menu
   * item that asked no longer exists.
   */
  const afterDialog = () => {
    let frames = 0;
    const tick = () => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') && frames++ < 60) {
        requestAnimationFrame(tick);
        return;
      }
      const a = document.activeElement;
      if (!a || a === document.body) gridRef.current?.focus({ preventScroll: true });
    };
    requestAnimationFrame(tick);
  };

  const cancel = () => {
    setEditing(null);
    gridRef.current?.focus({ preventScroll: true });
  };

  // ── Autocomplete for function names ─────────────────────────────────────
  const acPrefix = useMemo(() => {
    if (!editing || !editing.text.startsWith("=")) return null;
    const caret = editing.caret ?? editing.text.length;
    const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(editing.text.slice(0, caret));
    if (!m) return null;
    // Not a cell reference being typed (A1, B12), nor the letters of a
    // reference's second half or a column (A:A, $B, Sheet2!C, [@col]).
    if (/^[A-Za-z]{1,3}\d+$/.test(m[1])) return null;
    if (/[:$!@[]$/.test(editing.text.slice(0, caret - m[1].length))) return null;
    return { word: m[1], at: caret - m[1].length, caret };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.text, editing?.caret]);
  const suggestions = useMemo(() => {
    if (!acPrefix) return [];
    const w = acPrefix.word.toUpperCase();
    return FUNCTION_NAMES.filter((n) => n.startsWith(w) && n !== w).slice(0, 8);
  }, [acPrefix]);

  const acceptSuggestion = (name: string) => {
    if (!editing || !acPrefix) return;
    const text =
      editing.text.slice(0, acPrefix.at) + name + "(" + editing.text.slice(acPrefix.caret);
    setEditing({ ...editing, text, caret: acPrefix.at + name.length + 1, mode: "edit" });
  };

  // The function whose arguments the caret is inside, for the hint line.
  const activeFunction = useMemo(() => {
    if (!editing?.text.startsWith("=")) return null;
    const caret = editing.caret ?? editing.text.length;
    const before = editing.text.slice(0, caret);
    let depth = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === ")") depth++;
      else if (ch === "(") {
        if (depth === 0) {
          const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(before.slice(0, i));
          return m ? m[1].toUpperCase() : null;
        }
        depth--;
      }
    }
    return null;
  }, [editing?.text, editing?.caret]);

  // ── Bulk operations ──────────────────────────────────────────────────────

  const clearSelection = () => {
    if (!engine || !tabId) return;
    const edits: CellEdit[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        if (engine.getInput(tabId, r, c)?.i) edits.push({ row: r, col: c, input: "" });
      }
      if (edits.length > 200_000) break;
    }
    wb.applyEdits(tabId, edits);
  };

  const fill = (source: RangeAddr, target: RangeAddr) => {
    if (!engine || !tabId) return;
    const edits = fillEdits(source, target, (r, c) => engine.getInput(tabId, r, c));
    wb.applyEdits(tabId, edits);
    setSelection({
      anchor: { row: target.r0, col: target.c0 },
      focus: { row: target.r1, col: target.c1 },
      scroll: "anchor",
    });
  };

  // ── Formatting ───────────────────────────────────────────────────────────

  /** Every cell of the selection, capped so a whole-sheet selection stays quick. */
  const eachCell = (fn: (r: number, c: number) => void, bound = range) => {
    if (!engine || !tabId) return;
    const used = engine.used(tabId);
    // A whole column or row formats the cells in use (and a little room),
    // not a million rows.
    const r1 = bound.r1 - bound.r0 > 5000 ? Math.max(bound.r0, used.rows + 100) : bound.r1;
    const c1 = bound.c1 - bound.c0 > 500 ? Math.max(bound.c0, used.cols + 20) : bound.c1;
    for (let r = bound.r0; r <= Math.min(r1, bound.r1); r++)
      for (let c = bound.c0; c <= Math.min(c1, bound.c1); c++) fn(r, c);
  };

  const restyle = (next: (cur: CellStyle, r: number, c: number) => CellStyle | undefined) => {
    if (!engine || !tabId) return;
    const edits: CellEdit[] = [];
    eachCell((r, c) => {
      const cur = engine.getInput(tabId, r, c);
      const s = { ...(next({ ...(cur?.s ?? {}) }, r, c) ?? {}) };
      for (const k of Object.keys(s) as (keyof CellStyle)[]) {
        if (s[k] === undefined || s[k] === false || s[k] === "") delete s[k];
      }
      const had = JSON.stringify(cur?.s ?? {});
      if (had === JSON.stringify(s)) return;
      edits.push({ row: r, col: c, input: cur?.i ?? "", style: Object.keys(s).length ? s : null });
    });
    wb.applyEdits(tabId, edits);
  };

  const style = (patch: Partial<CellStyle>) => restyle((cur) => ({ ...cur, ...patch }));

  // Toggling applies the opposite of the active cell's state to the whole selection.
  const toggle = (k: "b" | "i" | "u" | "st" | "wrap") => style({ [k]: !focusInput?.s?.[k] });

  const growFont = (dir: 1 | -1) => {
    const cur = focusInput?.s?.sz ?? DEFAULT_SIZE;
    const next =
      dir > 0
        ? (SIZES.find((n) => n > cur) ?? Math.min(409, cur + 10))
        : ([...SIZES].reverse().find((n) => n < cur) ?? Math.max(1, cur - 1));
    style({ sz: next === DEFAULT_SIZE ? undefined : next });
  };

  const indent = (dir: 1 | -1) =>
    restyle((cur) => {
      const n = Math.max(0, Math.min(15, (cur.ind ?? 0) + dir));
      return { ...cur, ind: n || undefined, align: n && !cur.align ? "left" : cur.align };
    });

  const borders = (preset: BorderPreset, lineStyle: BorderStyle, color: string) =>
    restyle((cur, r, c) => ({
      ...cur,
      bd: bordersFor(preset, range, r, c, cur.bd, {
        s: lineStyle,
        ...(color !== "#000000" ? { c: color } : {}),
      }),
    }));

  const setFormat = (code: string) => {
    if (!engine || !tabId) return;
    const edits: CellEdit[] = [];
    eachCell((r, c) => {
      const cur = engine.getInput(tabId, r, c);
      edits.push({ row: r, col: c, input: cur?.i ?? "", format: code === "General" ? null : code });
    });
    wb.applyEdits(tabId, edits);
  };

  const decimals = (dir: 1 | -1) => {
    if (!engine || !tabId) return;
    const sample = engine.getValue(tabId, focus.row, focus.col);
    const code = adjustDecimals(focusInput?.f, dir, sample);
    setFormat(code);
  };

  const clear = (kind: ClearKind) => {
    if (!engine || !tabId) return;
    const edits: CellEdit[] = [];
    eachCell((r, c) => {
      const cur = engine.getInput(tabId, r, c);
      if (!cur) return;
      if (kind === "all")
        edits.push({ row: r, col: c, input: "", format: null, style: null, link: null });
      else if (kind === "formats")
        edits.push({ row: r, col: c, input: cur.i, format: null, style: null });
      else if (kind === "contents") {
        if (cur.i) edits.push({ row: r, col: c, input: "" });
      } else if (kind === "links" && cur.l)
        edits.push({ row: r, col: c, input: cur.i, link: null });
    });
    wb.applyEdits(tabId, edits);
    if (kind === "all" || kind === "formats") {
      // Clearing formats also unmerges, as Excel's Clear All does.
      const left = removeMerges(grid?.merges, range);
      if (kind === "all" && left.length !== (grid?.merges?.length ?? 0))
        wb.setGridMeta(tabId, { merges: left });
    }
  };

  const merge = async (mode: MergeMode | "unmerge") => {
    if (!engine || !tabId) return;
    if (mode === "unmerge") {
      wb.setGridMeta(tabId, { merges: removeMerges(grid?.merges, range) });
      return;
    }
    if (range.r0 === range.r1 && range.c0 === range.c1) {
      toast.error("Select two or more cells to merge");
      return;
    }
    if (mode === "across" && range.c0 === range.c1) {
      toast.error("Merge Across joins cells in a row; select more than one column");
      return;
    }
    const cellCount = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (cellCount > 100_000) {
      toast.error("That selection is too large to merge");
      return;
    }
    const lost = cellsLostByMerge(range, mode, (r, c) => !!engine.getInput(tabId, r, c)?.i);
    if (lost.length) {
      const ok = await confirmAsk({
        title: "Merge cells?",
        body:
          mode === "across"
            ? "Merging keeps only the first value in each row and discards the others."
            : "Merging keeps only the upper-left value and discards the others.",
        actionLabel: "Merge",
      });
      afterDialog();
      if (!ok) return;
    }
    const r = range;
    wb.changeGrid(tabId, (g) => {
      const cells = { ...g.cells };
      for (const { row, col } of lost) {
        const cur = cells[cellKey(row, col)];
        if (!cur) continue;
        const next = { ...cur, i: "" };
        delete next.l;
        if (!next.f && !next.s) delete cells[cellKey(row, col)];
        else cells[cellKey(row, col)] = next;
      }
      if (mode === "center") {
        const rows = mode === "center" ? [r.r0] : [];
        for (const row of rows) {
          const key = cellKey(row, r.c0);
          const cur = cells[key] ?? { i: "" };
          cells[key] = { ...cur, s: { ...(cur.s ?? {}), align: "center" } };
        }
      }
      return { ...g, cells, merges: addMerge(g.merges, r, mode) };
    });
    setSelection({ anchor: { row: r.r0, col: r.c0 }, focus: { row: r.r0, col: r.c0 } });
  };

  // ── Format painter ───────────────────────────────────────────────────────
  // Picks up the selection's formats; the next selection made takes them,
  // tiled as Excel tiles a painted pattern.
  const [painter, setPainter] = useState<{
    h: number;
    w: number;
    cells: ({ s?: CellStyle; f?: string } | undefined)[][];
  } | null>(null);
  const startPainter = () => {
    if (!engine || !tabId) return;
    if (painter) return setPainter(null);
    const h = Math.min(range.r1 - range.r0 + 1, 500);
    const w = Math.min(range.c1 - range.c0 + 1, 100);
    const cells = Array.from({ length: h }, (_, dr) =>
      Array.from({ length: w }, (_, dc) => {
        const cur = engine.getInput(tabId, range.r0 + dr, range.c0 + dc);
        return cur ? { s: cur.s, f: cur.f } : undefined;
      }),
    );
    setPainter({ h, w, cells });
  };
  const applyPainter = () => {
    if (!painter || !engine || !tabId) return;
    const edits: CellEdit[] = [];
    eachCell((r, c) => {
      const src = painter.cells[(r - range.r0) % painter.h][(c - range.c0) % painter.w];
      const cur = engine.getInput(tabId, r, c);
      edits.push({
        row: r,
        col: c,
        input: cur?.i ?? "",
        style: src?.s ?? null,
        format: src?.f ?? null,
      });
    });
    wb.applyEdits(tabId, edits);
    setPainter(null);
  };

  // ── Links ────────────────────────────────────────────────────────────────
  const [linkEdit, setLinkEdit] = useState<{ row: number; col: number } | null>(null);
  const openLinkDialog = () => {
    if (editing) commit(0, 0);
    setLinkEdit({ row: focus.row, col: focus.col });
  };
  const linkUrlAt = (row: number, col: number): string | null => {
    if (!engine || !tabId) return null;
    const input = engine.getInput(tabId, row, col);
    if (input?.l) return input.l;
    // =HYPERLINK("https://…", "name"): the address is the first argument.
    const m = /^=\s*HYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i.exec(input?.i ?? "");
    return m ? normalizeLink(m[1].replace(/""/g, '"')) : null;
  };
  const followLink = (row: number, col: number) => {
    const url = linkUrlAt(row, col);
    if (!url) return;
    const internal = parseInternalLink(url);
    if (internal) {
      const target = internal.sheet
        ? tabs.find((t) => t.name.toLowerCase() === internal.sheet!.toLowerCase())
        : activeTab;
      const r = parseRangeA1(internal.ref);
      if (!target || !r)
        return void toast.error(`The link points at ${url}, which is not in this workbook`);
      if (target.id !== tabId) wb.setActiveTabId(target.id);
      // After the sheet switches, select the target.
      requestAnimationFrame(() =>
        setSelection({ anchor: { row: r.r0, col: r.c0 }, focus: { row: r.r1, col: r.c1 } }),
      );
      return;
    }
    const safe = normalizeLink(url);
    if (!safe) return void toast.error("That link is not a web or email address");
    window.open(safe, "_blank", "noopener,noreferrer");
  };

  // ── Hiding, heights and widths ───────────────────────────────────────────
  const hide = (axis: Axis, on: boolean) => {
    if (!tabId) return;
    const lo = axis === "rows" ? range.r0 : range.c0;
    const hi = axis === "rows" ? range.r1 : range.c1;
    const cur = new Set((axis === "rows" ? grid?.hiddenRows : grid?.hiddenCols) ?? []);
    if (on) {
      if (hi - lo + 1 >= (axis === "rows" ? extent.rows : extent.cols)) {
        return void toast.error(
          `A sheet keeps at least one ${axis === "rows" ? "row" : "column"} showing`,
        );
      }
      for (let i = lo; i <= hi; i++) cur.add(i);
    } else for (let i = lo; i <= hi; i++) cur.delete(i);
    const list = [...cur].sort((x, y) => x - y);
    wb.setGridMeta(
      tabId,
      axis === "rows"
        ? { hiddenRows: list.length ? list : undefined }
        : { hiddenCols: list.length ? list : undefined },
    );
    if (on) {
      // The active cell moves off what was just hidden.
      const to = nextCell(
        { row: range.r0, col: range.c0 },
        axis === "rows" ? 1 : 0,
        axis === "cols" ? 1 : 0,
      );
      setSelection({ anchor: to, focus: to });
    }
  };

  const askRowHeight = async () => {
    if (!tabId) return;
    const px = grid?.rowHeights?.[String(range.r0)] ?? ROW_H;
    const v = await promptAsk({
      title: "Row height",
      body: "In points, as Excel measures it (the default is 18). Leave it empty to fit the content.",
      input: { defaultValue: String(Math.round(px * 0.75 * 4) / 4) },
      actionLabel: "Set height",
    });
    afterDialog();
    if (v === null) return;
    const next = { ...(grid?.rowHeights ?? {}) };
    const pt = Number(v);
    if (v.trim() !== "" && (!Number.isFinite(pt) || pt < 0 || pt > 409)) {
      return void toast.error("A row height is between 0 and 409 points");
    }
    for (let r = range.r0; r <= Math.min(range.r1, range.r0 + 100_000); r++) {
      if (v.trim() === "") delete next[String(r)];
      else next[String(r)] = Math.max(12, Math.round((pt * 4) / 3));
    }
    wb.setGridMeta(tabId, { rowHeights: next });
  };

  const askColWidth = async () => {
    if (!tabId) return;
    const px = colWidths[String(range.c0)] ?? DEFAULT_COL_W;
    const v = await promptAsk({
      title: "Column width",
      body: "In characters of the default font, as Excel measures it.",
      input: { defaultValue: String(Math.round(((px - 5) / 7) * 100) / 100), required: true },
      actionLabel: "Set width",
    });
    afterDialog();
    if (v === null) return;
    const ch = Number(v);
    if (!Number.isFinite(ch) || ch < 0 || ch > 255) {
      return void toast.error("A column width is between 0 and 255 characters");
    }
    const next = { ...colWidths };
    for (let c = range.c0; c <= Math.min(range.c1, range.c0 + 16_384); c++) {
      next[String(c)] = Math.max(16, Math.round(ch * 7 + 5));
    }
    wb.setGridMeta(tabId, { colWidths: next });
  };

  const structural = (axis: Axis, at: number, count: number) => {
    if (!engine || !tabId || !activeTab) return;
    const target = activeTab.name;
    wb.structural(tabId, (eng) => {
      for (const s of eng.listSheets()) {
        const g = eng.snapshot(s.id);
        if (!g) continue;
        const shifted = s.id === tabId ? moveCells(g, axis, at, count) : g;
        // Rule formulas (a conditional format's, a validation's) follow as cell formulas do.
        const moved = adjustRuleFormulas(shifted, s.name, target, axis, at, count);
        const cells = { ...moved.cells };
        let changed = s.id === tabId || moved !== shifted;
        for (const [k, cell] of Object.entries(cells)) {
          if (!cell.i.startsWith("=")) continue;
          const next = adjustFormula(cell.i, s.name, target, axis, at, count);
          if (next !== cell.i) {
            cells[k] = { ...cell, i: next };
            changed = true;
          }
        }
        if (changed) eng.replaceGrid(s.id, { ...moved, cells });
      }
    });
  };

  // ── Clipboard ────────────────────────────────────────────────────────────

  const copy = (cut: boolean) => {
    if (!engine || !tabId) return null;
    const rows: string[][] = [];
    const inputs: Clip["inputs"] = [];
    const values: Clip["values"] = [];
    const cellCount = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (cellCount > 500_000) {
      toast.error("That selection is too large to copy (over 500,000 cells).");
      return null;
    }
    for (let r = range.r0; r <= range.r1; r++) {
      const line: string[] = [];
      const ins: Clip["inputs"][number] = [];
      const vals: Scalar[] = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const input = engine.getInput(tabId, r, c);
        const v = engine.getValue(tabId, r, c);
        vals.push(v);
        line.push(cellView(v, input).text);
        ins.push(input ? { i: input.i, f: input.f, s: input.s, l: input.l } : undefined);
      }
      rows.push(line);
      inputs.push(ins);
      values.push(vals);
    }
    const tsv = toTsv(rows);
    clip.current = { tabId, range, inputs, values, tsv, cut };
    return tsv;
  };

  /**
   * Paste: everything (values or formulas, formats, links), or, from a copy
   * made here, only the values (with their number formats) or only the formats.
   */
  const paste = (text: string, mode: "all" | "values" | "formats" = "all") => {
    if (!engine || !tabId) return;
    const at = { row: range.r0, col: range.c0 };
    const internal =
      clip.current && clip.current.tsv.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")
        ? clip.current
        : null;
    const edits: CellEdit[] = [];
    let height = 1;
    let width = 1;
    if (internal) {
      height = internal.inputs.length;
      width = internal.inputs[0]?.length ?? 1;
      internal.inputs.forEach((line, dr) =>
        line.forEach((cell, dc) => {
          const src = { row: internal.range.r0 + dr, col: internal.range.c0 + dc };
          const dst = { row: at.row + dr, col: at.col + dc };
          const input = cell?.i ?? "";
          if (mode === "formats") {
            const cur = engine.getInput(tabId, dst.row, dst.col);
            edits.push({
              ...dst,
              input: cur?.i ?? "",
              format: cell?.f ?? null,
              style: cell?.s ?? null,
            });
            return;
          }
          if (mode === "values") {
            edits.push({
              ...dst,
              input: literalText(internal.values[dr]?.[dc] ?? null),
              format: cell?.f ?? null,
            });
            return;
          }
          edits.push({
            ...dst,
            input: internal.cut
              ? input
              : input.startsWith("=")
                ? shiftFormula(input, dst.row - src.row, dst.col - src.col)
                : input,
            format: cell?.f ?? null,
            // Excel's paste brings the formats and links along with the values.
            style: cell?.s ?? null,
            link: cell?.l ?? null,
          });
        }),
      );
      if (internal.cut && mode === "all") {
        // A cut moves: the source empties once the paste lands (where not overwritten).
        const dests = new Set(edits.map((e) => `${e.row},${e.col}`));
        for (let r = internal.range.r0; r <= internal.range.r1; r++) {
          for (let c = internal.range.c0; c <= internal.range.c1; c++) {
            if (!dests.has(`${r},${c}`) && internal.tabId === tabId)
              edits.push({ row: r, col: c, input: "", format: null, style: null, link: null });
          }
        }
        if (internal.tabId !== tabId) {
          const srcEdits: CellEdit[] = [];
          for (let r = internal.range.r0; r <= internal.range.r1; r++) {
            for (let c = internal.range.c0; c <= internal.range.c1; c++)
              srcEdits.push({ row: r, col: c, input: "", format: null, style: null, link: null });
          }
          wb.applyEdits(internal.tabId, srcEdits);
        }
        clip.current = null;
      }
    } else if (mode === "formats") {
      toast.error("Paste Formatting needs cells copied from this workbook");
      return;
    } else {
      const rows = parseTsv(text);
      height = rows.length;
      width = Math.max(1, ...rows.map((r) => r.length));
      if (rows.length * (rows[0]?.length ?? 0) > 500_000) {
        toast.error("That paste is too large (over 500,000 cells).");
        return;
      }
      rows.forEach((line, dr) =>
        line.forEach((v, dc) => {
          const fmt = impliedFormat(v);
          edits.push({
            row: at.row + dr,
            col: at.col + dc,
            input: v,
            ...(fmt ? { format: fmt } : {}),
          });
        }),
      );
    }
    wb.applyEdits(tabId, edits);
    const last = { row: at.row + height - 1, col: at.col + width - 1 };
    setExtent((x) => ({
      rows: Math.max(x.rows, last.row + 200),
      cols: Math.max(x.cols, last.col + 10),
    }));
    setSelection({ anchor: at, focus: last, scroll: "anchor" });
  };

  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (editing || document.activeElement !== gridRef.current) return;
      const tsv = copy(false);
      if (tsv === null) return;
      e.clipboardData?.setData("text/plain", tsv);
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (editing || document.activeElement !== gridRef.current) return;
      const tsv = copy(true);
      if (tsv === null) return;
      e.clipboardData?.setData("text/plain", tsv);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (editing || document.activeElement !== gridRef.current) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      e.preventDefault();
      paste(text);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────

  /** Ctrl+arrow: to the edge of the current block of data, as Excel jumps. */
  const jump = (dr: number, dc: number, from: { row: number; col: number } = focus) => {
    if (!engine || !tabId) return from;
    const filled = (r: number, c: number) => engine.getValue(tabId, r, c) !== null;
    let r = from.row;
    let c = from.col;
    const inBounds = (rr: number, cc: number) =>
      rr >= 0 && cc >= 0 && rr < extent.rows && cc < extent.cols;
    const startFilled = filled(r, c) && inBounds(r + dr, c + dc) && filled(r + dr, c + dc);
    if (startFilled) {
      while (inBounds(r + dr, c + dc) && filled(r + dr, c + dc)) {
        r += dr;
        c += dc;
      }
    } else {
      r += dr;
      c += dc;
      while (inBounds(r, c) && !filled(r, c)) {
        if (!inBounds(r + dr, c + dc)) break;
        r += dr;
        c += dc;
      }
    }
    return {
      row: Math.max(0, Math.min(extent.rows - 1, r)),
      col: Math.max(0, Math.min(extent.cols - 1, c)),
    };
  };

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (editing) {
      if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setAcIndex(
          (i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length,
        );
        return;
      }
      if (suggestions.length && e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion(suggestions[Math.min(acIndex, suggestions.length - 1)]);
        return;
      }
      if (e.key === "Enter" && e.altKey && editing.source !== "bar") {
        // A line break inside the cell, as Alt+Enter is in Excel.
        e.preventDefault();
        const caret = editing.caret ?? editing.text.length;
        setEditing({
          ...editing,
          text: editing.text.slice(0, caret) + NEWLINE + editing.text.slice(caret),
          caret: caret + 1,
          mode: "edit",
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const back = tabRun.current;
        tabRun.current = null;
        commit(e.shiftKey ? -1 : 1, 0, back ?? undefined);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (tabRun.current === null) tabRun.current = editing.col;
        commit(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (
        editing.mode === "enter" &&
        !editing.text.startsWith("=") &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        e.preventDefault();
        const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[
          e.key
        ]!;
        commit(d[0], d[1]);
      }
      return;
    }
    if (!engine || !tabId) return;
    // Moving any other way ends a run of Tabs (typing does not).
    if (/^(Arrow|Page|Home|End)/.test(e.key)) tabRun.current = null;
    // Alt+Down opens the active cell's list (data validation), as in Excel.
    if (e.key === "ArrowDown" && e.altKey && rules.openList()) {
      e.preventDefault();
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (arrows[e.key]) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      if (mod) {
        const to = jump(dr, dc, e.shiftKey ? selection.focus : selection.anchor);
        setSelection((s) =>
          e.shiftKey ? { anchor: s.anchor, focus: to } : { anchor: to, focus: to },
        );
      } else move(dr, dc, e.shiftKey);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const back = tabRun.current;
      tabRun.current = null;
      if (back !== null) {
        const to = { row: Math.min(extent.rows - 1, focus.row + (e.shiftKey ? -1 : 1)), col: back };
        setSelection({
          anchor: { ...to, row: Math.max(0, to.row) },
          focus: { ...to, row: Math.max(0, to.row) },
        });
      } else move(e.shiftKey ? -1 : 1, 0);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (tabRun.current === null) tabRun.current = focus.col;
      move(0, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      move(e.key === "PageDown" ? 25 : -25, 0, e.shiftKey);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      const to = mod ? { row: 0, col: 0 } : { row: focus.row, col: 0 };
      setSelection((s) =>
        e.shiftKey ? { anchor: s.anchor, focus: to } : { anchor: to, focus: to },
      );
      return;
    }
    if (e.key === "End" && mod) {
      e.preventDefault();
      const u = engine.used(tabId);
      const to = { row: Math.max(0, u.rows - 1), col: Math.max(0, u.cols - 1) };
      setSelection((s) =>
        e.shiftKey ? { anchor: s.anchor, focus: to } : { anchor: to, focus: to },
      );
      return;
    }
    if (e.key === "F2") {
      e.preventDefault();
      startEdit(editText(focusInput), "edit");
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        wb.undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        wb.redo();
      } else if (k === "b" || k === "i" || k === "u") {
        e.preventDefault();
        toggle(k);
      } else if (k === "5") {
        e.preventDefault();
        toggle("st");
      } else if (k === "k") {
        // The grid's Ctrl+K (a link, as in Excel), not the app's search.
        e.preventDefault();
        e.stopPropagation();
        openLinkDialog();
      } else if (k === "a") {
        e.preventDefault();
        // Everything, the active cell where it is and the view unmoved.
        setSelection({
          anchor: { row: 0, col: 0 },
          focus: { row: extent.rows - 1, col: extent.cols - 1 },
          scroll: "none",
        });
      } else if (k === "d" && range.r1 > range.r0) {
        e.preventDefault();
        fill({ ...range, r1: range.r0 }, range);
      } else if (k === "r" && range.c1 > range.c0) {
        e.preventDefault();
        fill({ ...range, c1: range.c0 }, range);
      } else if (k === "s") {
        e.preventDefault();
        void wb.flush();
      } else if (k === "l" && e.shiftKey) {
        e.preventDefault();
        rules.toggleFilter();
      }
      return;
    }
    // Printable character: start typing into the cell, replacing it.
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit(e.key, "enter");
    }
  };

  // ── Status: selection statistics ─────────────────────────────────────────
  const stats = useMemo(() => {
    if (!engine || !tabId) return null;
    const cells = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (cells < 2) return null;
    const used = engine.used(tabId);
    const r1 = Math.min(range.r1, used.rows - 1);
    const c1 = Math.min(range.c1, used.cols - 1);
    let sum = 0;
    let count = 0;
    let nums = 0;
    let min = Infinity;
    let max = -Infinity;
    let visited = 0;
    for (let r = range.r0; r <= r1; r++) {
      for (let c = range.c0; c <= c1; c++) {
        if (++visited > 1_000_000) break;
        const v = engine.getValue(tabId, r, c);
        if (v === null || v === "") continue;
        count++;
        if (typeof v === "number") {
          nums++;
          sum += v;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
    return {
      count,
      nums,
      sum,
      avg: nums ? sum / nums : null,
      min: nums ? min : null,
      max: nums ? max : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tabId, range.r0, range.r1, range.c0, range.c1, rev]);

  /**
   * Save the selection to the lakehouse; a single selected cell means the
   * data around it (the used area of the sheet), as Excel's "current region".
   */
  const openSave = () => {
    if (!engine || !tabId) return;
    if (range.r0 === range.r1 && range.c0 === range.c1) {
      const used = engine.used(tabId);
      if (!used.rows) return void toast.error("This sheet is empty; there is nothing to save");
      setSaveRange({ r0: 0, c0: 0, r1: used.rows - 1, c1: used.cols - 1 });
    } else setSaveRange(range);
  };

  // ── Sheet tabs ───────────────────────────────────────────────────────────

  const addSheet = async () => {
    const names = new Set(tabs.map((t) => t.name.toLowerCase()));
    let n = tabs.length + 1;
    while (names.has(`sheet${n}`)) n++;
    try {
      const r = await addTabFn({
        data: { access_token: token, workbook_id: workbookId, name: `Sheet${n}` },
      });
      if (!r.ok) return toast.error(r.error);
      wb.addTabLocal(r.tab);
    } catch (e) {
      toast.error(`Could not add a sheet: ${(e as Error).message}`);
    }
  };

  const renameSheet = async (t: TabMeta) => {
    const name = await promptAsk({
      title: "Rename sheet",
      body: "Formulas that refer to this sheet follow the new name.",
      input: { defaultValue: t.name, required: true },
      actionLabel: "Rename",
    });
    afterDialog();
    if (name === null || !name.trim() || name.trim() === t.name) return;
    try {
      const r = await renameTabFn({
        data: { access_token: token, tab_id: t.id, name: name.trim() },
      });
      if (!r.ok) return toast.error(r.error);
      wb.renameTabLocal(t.id, t.name, name.trim());
    } catch (e) {
      toast.error(`Could not rename the sheet: ${(e as Error).message}`);
    }
  };

  const deleteSheet = async (t: TabMeta) => {
    if (tabs.length <= 1) return toast.error("A workbook keeps at least one sheet");
    const ok = await confirmAsk({
      title: `Delete "${t.name}"?`,
      body: "Its cells go with it. Formulas elsewhere that refer to it will show #REF!.",
      actionLabel: "Delete sheet",
    });
    afterDialog();
    if (!ok) return;
    try {
      const r = await deleteTabFn({ data: { access_token: token, tab_id: t.id } });
      if (!r.ok) return toast.error(`"${t.name}" was not deleted: ${r.error}`);
      wb.removeTabLocal(t.id);
    } catch (e) {
      toast.error(`"${t.name}" was not deleted: ${(e as Error).message}`);
    }
  };

  const moveSheet = async (t: TabMeta, dir: -1 | 1) => {
    const order = tabs.map((x) => x.id);
    const i = order.indexOf(t.id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    const prev = tabs.map((x) => x.id);
    wb.reorderLocal(order);
    try {
      const r = await reorderFn({ data: { access_token: token, workbook_id: workbookId, order } });
      if (!r.ok) {
        wb.reorderLocal(prev);
        toast.error(r.error);
      }
    } catch (e) {
      wb.reorderLocal(prev);
      toast.error(`Could not reorder the sheets: ${(e as Error).message}`);
    }
  };

  if (!engine || !tabId || !activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
      </div>
    );
  }

  const saving: SaveState | undefined = wb.saveState[tabId];
  const help = activeFunction ? FUNCTION_HELP[activeFunction] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {activeTab.kind === "table" ? (
        <div className="min-h-0 flex-1">
          {wb.tableConfigs[activeTab.id] ? (
            <TableSheet
              key={activeTab.id}
              wb={wb}
              tab={activeTab}
              token={token}
              config={wb.tableConfigs[activeTab.id]}
              pageRows={wb.limits?.pageRows ?? 500}
              status={
                <SaveBadge
                  state={saving}
                  onRetry={() => void wb.saveTab(tabId)}
                  onOverwrite={() => void wb.saveTab(tabId, true)}
                  onReload={async () => {
                    const problem = await wb.reloadTab(tabId);
                    if (problem) toast.error(problem);
                    else toast.success(`Showing the saved "${activeTab.name}"`);
                  }}
                />
              }
            />
          ) : (
            <div className="p-6 text-sm text-destructive">
              This table sheet has no settings; delete it and open the table again.
            </div>
          )}
        </div>
      ) : (
        <>
          <SheetToolbar
            onDone={backToGrid}
            style={focusInput?.s}
            format={focusInput?.f}
            merged={selectionMerged}
            painting={!!painter}
            zoom={zoom}
            gridlines={!grid?.hideGrid}
            extra={{ ...rules.ribbon, insert: charts.ribbon }}
            actions={{
              undo: () => wb.undo(),
              redo: () => wb.redo(),
              style,
              toggle,
              growFont,
              indent,
              borders,
              merge: (m) => void merge(m),
              format: setFormat,
              customFormat: async () => {
                const code = await promptAsk({
                  title: "Custom number format",
                  body: 'An Excel format code, e.g. #,##0.0 or 0.0% or "Q"0 or yyyy-mm, or #,##0;[Red]-#,##0 for red negatives.',
                  input: { defaultValue: focusInput?.f ?? "", required: true },
                  actionLabel: "Apply",
                });
                afterDialog();
                if (code) setFormat(code);
              },
              decimals,
              clear,
              painter: startPainter,
              link: openLinkDialog,
              saveToLakehouse: openSave,
              zoom: setZoom,
              toggleGridlines: () =>
                wb.setGridMeta(tabId, { hideGrid: grid?.hideGrid ? undefined : true }),
            }}
            status={
              <SaveBadge
                state={saving}
                onRetry={() => void wb.saveTab(tabId)}
                onOverwrite={() => void wb.saveTab(tabId, true)}
                onReload={async () => {
                  const problem = await wb.reloadTab(tabId);
                  if (problem) toast.error(problem);
                  else toast.success(`Showing the saved "${activeTab.name}"`);
                }}
              />
            }
          />

          {/* Formula bar */}
          <div className="relative flex items-center gap-2 border-b border-border px-2 py-1">
            <input
              aria-label="Name box"
              className="h-7 w-24 rounded border border-input bg-background px-2 font-mono text-xs"
              value={
                nameBox ??
                (range.r0 === range.r1 && range.c0 === range.c1
                  ? a1(focus.row, focus.col)
                  : describeRange(range))
              }
              onChange={(e) => setNameBox(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setNameBox(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const r = parseRangeA1(nameBox ?? "");
                  if (r) {
                    setSelection({
                      anchor: { row: r.r0, col: r.c0 },
                      focus: { row: r.r1, col: r.c1 },
                    });
                    setExtent((x) => ({
                      rows: Math.max(x.rows, r.r1 + 200),
                      cols: Math.max(x.cols, r.c1 + 10),
                    }));
                    setNameBox(null);
                    gridRef.current?.focus({ preventScroll: true });
                  } else toast.error(`"${nameBox}" is not a cell or range (e.g. B3 or A1:D20)`);
                }
                if (e.key === "Escape") {
                  setNameBox(null);
                  gridRef.current?.focus({ preventScroll: true });
                }
              }}
            />
            <span className="select-none font-serif text-sm italic text-muted-foreground">fx</span>
            <input
              ref={barRef}
              aria-label="Formula bar"
              data-testid="formula-bar"
              className="h-7 flex-1 rounded border border-input bg-background px-2 font-mono text-[13px]"
              value={editing ? editing.text : editText(focusInput)}
              spellCheck={false}
              onFocus={(e) => {
                editorRef.current = e.currentTarget;
                if (!editing) {
                  setEditing({
                    row: focus.row,
                    col: focus.col,
                    text: editText(focusInput),
                    mode: "edit",
                    source: "bar",
                  });
                } else if (editing.source !== "bar") setEditing({ ...editing, source: "bar" });
              }}
              onChange={(e) =>
                setEditing((cur) =>
                  cur
                    ? {
                        ...cur,
                        text: e.target.value,
                        caret: e.target.selectionStart ?? undefined,
                        source: "bar",
                      }
                    : {
                        row: focus.row,
                        col: focus.col,
                        text: e.target.value,
                        mode: "edit",
                        source: "bar",
                      },
                )
              }
              onSelect={(e) => {
                const c = e.currentTarget.selectionStart ?? 0;
                if (editing && editing.source === "bar" && c !== editing.caret) {
                  setEditing({ ...editing, caret: c });
                }
              }}
              onKeyDown={onKey}
            />
            {editing && suggestions.length > 0 && (
              <div
                className="absolute left-36 top-9 z-40 w-80 rounded-md border border-border bg-popover p-1 shadow-md"
                data-testid="formula-suggestions"
              >
                {suggestions.map((n, i) => (
                  <button
                    key={n}
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs",
                      i === acIndex ? "bg-primary/15" : "hover:bg-muted",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptSuggestion(n);
                    }}
                  >
                    <span className="font-mono font-semibold">{n}</span>
                    <span className="truncate text-muted-foreground">
                      {FUNCTION_HELP[n]?.desc ?? ""}
                    </span>
                  </button>
                ))}
                <p className="px-2 pt-1 text-[10px] text-muted-foreground">
                  Tab to insert · ↑↓ to choose
                </p>
              </div>
            )}
            {/* Floats over the grid rather than pushing it down: a bar that
                appeared mid-formula moved every cell under the pointer, and a
                click meant for B2 picked B1. */}
            {help && editing && suggestions.length === 0 && (
              <div
                className="pointer-events-none absolute left-36 top-full z-40 mt-0.5 max-w-xl rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow-md"
                data-testid="function-hint"
              >
                <span className="font-mono text-foreground">{help.sig}</span> — {help.desc}
              </div>
            )}
          </div>

          {/* Grid */}
          <div className="relative min-h-0 flex-1">
            <SheetGrid
              engine={engine}
              tabId={tabId}
              rev={rev}
              rowCount={extent.rows}
              colCount={extent.cols}
              grid={gridView}
              decorate={rules.decorate}
              zoom={zoom / 100}
              selection={selection}
              onSelect={(sel) => {
                tabRun.current = null;
                setSelection(sel);
              }}
              onSelectEnd={() => painter && applyPainter()}
              onZoom={(dir) => setZoom((cur) => stepZoom(cur, dir))}
              onOpenLink={followLink}
              onRowHeight={(r, h) => {
                const next = { ...(grid?.rowHeights ?? {}) };
                if (h === null) delete next[String(r)];
                else next[String(r)] = h;
                wb.setGridMeta(tabId, { rowHeights: next }, { gesture: `row-height:${r}` });
              }}
              renderOverlay={(geo) => (
                <>
                  {rules.overlay(geo)}
                  {charts.overlay(geo)}
                  {linkChip(geo)}
                </>
              )}
              editing={editing}
              onEditChange={setEditing}
              onCommit={commit}
              onKey={onKey}
              onColWidth={(c, w) =>
                wb.setGridMeta(
                  tabId,
                  { colWidths: { ...colWidths, [String(c)]: Math.round(w) } },
                  { gesture: `col-width:${c}` },
                )
              }
              onFill={fill}
              onNearEnd={(axis) =>
                setExtent((x) =>
                  axis === "rows"
                    ? { ...x, rows: Math.min(1_048_576, x.rows + 1000) }
                    : { ...x, cols: Math.min(16_384, x.cols + 26) },
                )
              }
              onContextMenu={(e, kind) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, kind });
              }}
              editorRef={editorRef}
              gridRef={gridRef}
              onType={(text) =>
                // Text that arrives while an edit is starting joins it.
                setEditing((cur) =>
                  cur
                    ? { ...cur, text: cur.text + text, caret: undefined }
                    : {
                        row: focus.row,
                        col: focus.col,
                        text,
                        mode: "enter",
                        source: "cell",
                        caret: text.length,
                      },
                )
              }
            />
            {menu && (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                kind={menu.kind}
                range={range}
                hiddenRowsIn={[...hiddenRows].some((r) => r >= range.r0 && r <= range.r1)}
                hiddenColsIn={[...hiddenCols].some((c) => c >= range.c0 && c <= range.c1)}
                onClose={() => {
                  setMenu(null);
                  // Back to the grid before the action runs (a dialog it opens
                  // takes the keyboard and returns it here): without this the
                  // keyboard fell to the page and Ctrl+Z did nothing (R115).
                  gridRef.current?.focus({ preventScroll: true });
                }}
                actions={{
                  copy: () => {
                    const t = copy(false);
                    if (t !== null)
                      void navigator.clipboard
                        .writeText(t)
                        .catch(() =>
                          toast.error("The browser refused clipboard access; use Ctrl+C."),
                        );
                  },
                  cut: () => {
                    const t = copy(true);
                    if (t !== null)
                      void navigator.clipboard
                        .writeText(t)
                        .catch(() =>
                          toast.error("The browser refused clipboard access; use Ctrl+X."),
                        );
                  },
                  paste: async () => {
                    try {
                      paste(await navigator.clipboard.readText());
                    } catch {
                      toast.error("The browser refused clipboard access; use Ctrl+V.");
                    }
                  },
                  pasteValues: () => {
                    if (!clip.current) return void toast.error("Copy cells in this workbook first");
                    paste(clip.current.tsv, "values");
                  },
                  pasteFormats: () => {
                    if (!clip.current) return void toast.error("Copy cells in this workbook first");
                    paste(clip.current.tsv, "formats");
                  },
                  clear: clearSelection,
                  clearFormats: () => clear("formats"),
                  link: openLinkDialog,
                  insertRowsAbove: () => structural("rows", range.r0, range.r1 - range.r0 + 1),
                  insertRowsBelow: () => structural("rows", range.r1 + 1, range.r1 - range.r0 + 1),
                  deleteRows: () => structural("rows", range.r0, -(range.r1 - range.r0 + 1)),
                  insertColsLeft: () => structural("cols", range.c0, range.c1 - range.c0 + 1),
                  insertColsRight: () => structural("cols", range.c1 + 1, range.c1 - range.c0 + 1),
                  deleteCols: () => structural("cols", range.c0, -(range.c1 - range.c0 + 1)),
                  hideRows: () => hide("rows", true),
                  unhideRows: () => hide("rows", false),
                  hideCols: () => hide("cols", true),
                  unhideCols: () => hide("cols", false),
                  rowHeight: () => void askRowHeight(),
                  colWidth: () => void askColWidth(),
                  saveToLakehouse: () => openSave(),
                }}
              />
            )}
          </div>
        </>
      )}

      {/* Sheet tabs + status */}
      <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-2 py-1 text-xs">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="Add sheet"
              aria-label="Add sheet"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={() => void addSheet()}>
              <Grid3x3 className="mr-2 h-4 w-4" /> Grid sheet
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setOpenTable(true)}>
              <Database className="mr-2 h-4 w-4" /> Table sheet (lakehouse, catalog, import)…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {saveRange && engine && tabId && activeTab && (
          <SaveToLakehouseDialog
            open
            onOpenChange={(o) => !o && setSaveRange(null)}
            token={token}
            workbookId={workbookId}
            takenSheetNames={tabs.map((t) => t.name)}
            source={{
              kind: "grid",
              tabId,
              tabName: activeTab.name,
              range: saveRange,
              get: (r, c) => ({
                v: engine.getValue(tabId, r, c),
                input: engine.getInput(tabId, r, c),
              }),
            }}
            onOpenedTab={(row) => {
              wb.addTabLocal(row);
              toast.success(`Opened ${row.name}`);
            }}
          />
        )}
        {openTable && (
          <OpenTableDialog
            open
            onOpenChange={setOpenTable}
            token={token}
            workbookId={workbookId}
            takenNames={tabs.map((t) => t.name)}
            onOpened={(row) => {
              wb.addTabLocal(row);
              toast.success(`Opened ${row.name}`);
            }}
          />
        )}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Sheets"
        >
          {tabs.map((t) => (
            <SheetTab
              key={t.id}
              tab={t}
              active={t.id === tabId}
              state={wb.saveState[t.id]}
              onSelect={() => {
                if (editing) commit(0, 0);
                wb.setActiveTabId(t.id);
              }}
              onRename={() => void renameSheet(t)}
              onDelete={() => void deleteSheet(t)}
              onMove={(d) => void moveSheet(t, d)}
            />
          ))}
        </div>
        <div
          className="flex shrink-0 items-center gap-3 text-muted-foreground"
          data-testid="selection-stats"
        >
          {stats && (
            <>
              {stats.avg !== null && <span>Average: {fmtStat(stats.avg)}</span>}
              <span>Count: {stats.count.toLocaleString()}</span>
              {stats.nums > 0 && <span>Sum: {fmtStat(stats.sum)}</span>}
            </>
          )}
          {activeTab.kind === "grid" && (
            <ZoomControl zoom={zoom} onZoom={setZoom} onDone={backToGrid} />
          )}
        </div>
      </div>
      {rules.dialogs}
      {charts.dialogs}
      {linkEdit && engine && tabId && (
        <LinkDialog
          open
          onClosed={() => gridRef.current?.focus({ preventScroll: true })}
          onOpenChange={(o) => {
            if (!o) {
              setLinkEdit(null);
              gridRef.current?.focus({ preventScroll: true });
            }
          }}
          initialText={
            cellView(
              engine.getValue(tabId, linkEdit.row, linkEdit.col),
              engine.getInput(tabId, linkEdit.row, linkEdit.col),
            ).text
          }
          initialUrl={engine.getInput(tabId, linkEdit.row, linkEdit.col)?.l ?? ""}
          textLocked={(engine.getInput(tabId, linkEdit.row, linkEdit.col)?.i ?? "").startsWith("=")}
          onApply={(text, url) => {
            const cur = engine.getInput(tabId, linkEdit.row, linkEdit.col);
            const formula = (cur?.i ?? "").startsWith("=");
            wb.applyEdits(tabId, [
              {
                row: linkEdit.row,
                col: linkEdit.col,
                // A formula keeps computing; typed text becomes the link's text.
                input: formula ? cur!.i : text,
                link: url,
              },
            ]);
            setLinkEdit(null);
            gridRef.current?.focus({ preventScroll: true });
          }}
          onRemove={() => {
            const cur = engine.getInput(tabId, linkEdit.row, linkEdit.col);
            wb.applyEdits(tabId, [
              { row: linkEdit.row, col: linkEdit.col, input: cur?.i ?? "", link: null },
            ]);
            setLinkEdit(null);
            gridRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

function fmtStat(n: number): string {
  return Math.abs(n) >= 1e15
    ? n.toExponential(4)
    : n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function SaveBadge({
  state,
  onRetry,
  onOverwrite,
  onReload,
}: {
  state: SaveState | undefined;
  onRetry: () => void;
  onOverwrite: () => void;
  onReload: () => void;
}) {
  if (!state || state.kind === "saved") {
    return <span className="text-muted-foreground">{state ? "All changes saved" : "Saved"}</span>;
  }
  if (state.kind === "pending")
    return <span className="text-muted-foreground">Unsaved changes…</span>;
  if (state.kind === "saving")
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  if (state.kind === "conflict") {
    return (
      <span
        className="flex items-center gap-2 text-amber-600 dark:text-amber-400"
        title={state.message}
      >
        Saved elsewhere since you opened it
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onReload}>
          Reload theirs
        </Button>
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onOverwrite}>
          Keep mine
        </Button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-destructive" title={state.message}>
      Not saved: {state.message.length > 90 ? `${state.message.slice(0, 90)}…` : state.message}
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onRetry}>
        Retry
      </Button>
    </span>
  );
}

function SheetTab({
  tab,
  active,
  state,
  onSelect,
  onRename,
  onDelete,
  onMove,
}: {
  tab: TabMeta;
  active: boolean;
  state: SaveState | undefined;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const unsaved = state && state.kind !== "saved";
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        "group flex shrink-0 items-center gap-1 rounded-t border border-b-0 px-2.5 py-1",
        active
          ? "border-border bg-background font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted",
      )}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "F2") {
          e.preventDefault();
          onRename();
        }
      }}
      onDoubleClick={onRename}
    >
      {tab.kind === "table" && (
        <Database className="h-3 w-3 text-primary" aria-label="Table sheet" />
      )}
      <span>{tab.name}</span>
      {unsaved && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
            aria-label={`Sheet ${tab.name} menu`}
            onClick={(e) => e.stopPropagation()}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        {/* A portal's events still bubble through React to the tab: without
            this, choosing an item also "clicked" the tab and switched to it. */}
        <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMove(-1)}>Move left</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMove(1)}>Move right</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type MenuAction =
  | "copy"
  | "cut"
  | "paste"
  | "pasteValues"
  | "pasteFormats"
  | "clear"
  | "clearFormats"
  | "link"
  | "insertRowsAbove"
  | "insertRowsBelow"
  | "deleteRows"
  | "insertColsLeft"
  | "insertColsRight"
  | "deleteCols"
  | "hideRows"
  | "unhideRows"
  | "hideCols"
  | "unhideCols"
  | "rowHeight"
  | "colWidth"
  | "saveToLakehouse";

function ContextMenu({
  x,
  y,
  kind,
  range,
  hiddenRowsIn,
  hiddenColsIn,
  onClose,
  actions,
}: {
  x: number;
  y: number;
  /** Right-clicked on cells, or on row or column headers. */
  kind: "cell" | "row" | "col";
  range: RangeAddr;
  hiddenRowsIn: boolean;
  hiddenColsIn: boolean;
  onClose: () => void;
  actions: Record<MenuAction, () => void>;
}) {
  const rows = range.r1 - range.r0 + 1;
  const cols = range.c1 - range.c0 + 1;
  const item = (label: string, fn: () => void, danger = false) => (
    <button
      key={label}
      className={cn(
        "block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-muted",
        danger && "text-destructive",
      )}
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
        fn();
      }}
    >
      {label}
    </button>
  );
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // A press anywhere outside closes it, as a menu does.
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", esc);
    window.addEventListener("mousedown", outside);
    return () => {
      window.removeEventListener("keydown", esc);
      window.removeEventListener("mousedown", outside);
    };
  }, [onClose]);
  // Kept on screen: a menu opened near the bottom or right edge opens up or left.
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);
  const sep = (k: string) => <div key={k} className="my-1 h-px bg-border" />;
  const colName = `${colLetters(range.c0)}${cols > 1 ? `:${colLetters(range.c1)}` : ""}`;
  const rowItems = [
    item(`Insert ${rows} row${rows > 1 ? "s" : ""} above`, actions.insertRowsAbove),
    item(`Insert ${rows} row${rows > 1 ? "s" : ""} below`, actions.insertRowsBelow),
    item(`Delete ${rows > 1 ? `${rows} rows` : "row"}`, actions.deleteRows, true),
  ];
  const colItems = [
    item(`Insert ${cols} column${cols > 1 ? "s" : ""} left`, actions.insertColsLeft),
    item(`Insert ${cols} column${cols > 1 ? "s" : ""} right`, actions.insertColsRight),
    item(`Delete ${cols > 1 ? `${cols} columns` : "column"} ${colName}`, actions.deleteCols, true),
  ];
  return (
    <div
      className="fixed z-50 max-h-[80vh] w-60 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
      style={pos}
      role="menu"
      data-testid="grid-context-menu"
      data-kind={kind}
      ref={ref}
    >
      {item("Cut", actions.cut)}
      {item("Copy", actions.copy)}
      {item("Paste", actions.paste)}
      {item("Paste values only", actions.pasteValues)}
      {item("Paste formatting only", actions.pasteFormats)}
      {sep("s1")}
      {kind === "row" && [
        ...rowItems,
        item(`Hide ${rows > 1 ? `${rows} rows` : "row"}`, actions.hideRows),
        ...(hiddenRowsIn ? [item("Unhide rows", actions.unhideRows)] : []),
        item("Row height…", actions.rowHeight),
      ]}
      {kind === "col" && [
        ...colItems,
        item(`Hide ${cols > 1 ? `${cols} columns` : "column"} ${colName}`, actions.hideCols),
        ...(hiddenColsIn ? [item("Unhide columns", actions.unhideCols)] : []),
        item("Column width…", actions.colWidth),
      ]}
      {kind === "cell" && [...rowItems, sep("s2"), ...colItems]}
      {sep("s3")}
      {item("Clear contents", actions.clear)}
      {item("Clear formats", actions.clearFormats)}
      {kind === "cell" && item("Insert link…", actions.link)}
      {sep("s4")}
      {item("Save range to the lakehouse…", actions.saveToLakehouse)}
    </div>
  );
}
