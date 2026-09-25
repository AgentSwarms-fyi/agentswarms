// The workbook editor: toolbar, formula bar, grid, sheet tabs, status bar.
//
// Keyboard and clipboard follow Excel: arrows move (Shift extends, Ctrl
// jumps to the edge of the data), typing replaces, F2 edits, Enter/Tab commit
// and move, Delete clears, Ctrl+Z/Y undo/redo, Ctrl+C/X/V copy/cut/paste
// (formulas shift when pasted inside the workbook; text from Excel or Google
// Sheets pastes as values), Ctrl+D/R fill down/right, Ctrl+B/I/U style.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Database,
  Grid3x3,
  Italic,
  Loader2,
  Plus,
  Redo2,
  Underline,
  Undo2,
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
import { a1, colLetters, parseRangeA1, type RangeAddr } from "@/lib/sheets/a1";
import { cellView, editText, impliedFormat } from "@/lib/sheets/cellView";
import type { CellStyle } from "@/lib/sheets/engine";
import { PRESET_FORMATS } from "@/lib/sheets/format";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import { shiftFormula } from "@/lib/sheets/formula/shift";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import {
  adjustFormula,
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
import { OpenTableDialog } from "./OpenTableDialog";
import { SheetGrid, type Editing } from "./SheetGrid";
import { SaveToLakehouseDialog } from "./SaveToLakehouseDialog";
import { TableSheet } from "./TableSheet";
import type { CellEdit, SaveState, TabMeta, useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

const MIN_ROWS = 1000;
const MIN_COLS = 52;

type Clip = {
  tabId: string;
  range: RangeAddr;
  inputs: ({ i: string; f?: string } | undefined)[][];
  tsv: string;
  cut: boolean;
};

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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
  const grid = tabId && engine ? engine.snapshot(tabId) : undefined;
  const colWidths = grid?.colWidths ?? {};

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

  const range = selRange(selection);
  // The active cell: the selection's anchor, as in Excel (Shift+click extends
  // the selection but typing still goes where it started).
  const focus = selection.anchor;
  const focusInput = engine && tabId ? engine.getInput(tabId, focus.row, focus.col) : undefined;

  // ── Editing ──────────────────────────────────────────────────────────────

  const startEdit = (text: string, mode: Editing["mode"], source: Editing["source"] = "cell") => {
    setEditing({ row: focus.row, col: focus.col, text, mode, source, caret: text.length });
    setAcIndex(0);
  };

  const move = useCallback(
    (dr: number, dc: number, extend = false) => {
      setSelection((s) => {
        // Extending moves the far end; a plain move starts from the active cell.
        const from = extend ? s.focus : s.anchor;
        const f = {
          row: Math.max(0, Math.min(extent.rows - 1, from.row + dr)),
          col: Math.max(0, Math.min(extent.cols - 1, from.col + dc)),
        };
        return extend ? { anchor: s.anchor, focus: f } : { anchor: f, focus: f };
      });
    },
    [extent],
  );

  // Where a run of Tabs across a row began: Enter then returns to that column
  // on the next row, as Excel does for typing a table row by row.
  const tabRun = useRef<number | null>(null);

  const commit = useCallback(
    (dr: number, dc: number, toCol?: number) => {
      if (!editing || !engine || !tabId) return;
      const prev = engine.getInput(tabId, editing.row, editing.col);
      let text = editing.text;
      // Close the parentheses a formula left open, as Excel does.
      if (text.startsWith("=")) {
        const open = (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
        if (open > 0 && open < 20) text += ")".repeat(open);
      }
      if ((prev?.i ?? "") !== text) {
        const fmt = prev?.f ? undefined : impliedFormat(text);
        wb.applyEdits(tabId, [
          { row: editing.row, col: editing.col, input: text, ...(fmt ? { format: fmt } : {}) },
        ]);
      }
      setEditing(null);
      const to = {
        row: Math.max(0, Math.min(extent.rows - 1, editing.row + dr)),
        col: Math.max(0, Math.min(extent.cols - 1, toCol ?? editing.col + dc)),
      };
      setSelection({ anchor: to, focus: to });
      // Now, not on the next frame: the editor is about to unmount, and a key
      // pressed in between would land on the page (Tab walking to the toolbar,
      // the next letters lost) instead of the grid.
      gridRef.current?.focus({ preventScroll: true });
    },
    [editing, engine, tabId, wb, extent],
  );

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

  const style = (patch: Partial<CellStyle>) => {
    if (!engine || !tabId) return;
    // Toggling applies the opposite of the active cell's state to the whole selection.
    const edits: CellEdit[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const cur = engine.getInput(tabId, r, c);
        const s = { ...(cur?.s ?? {}), ...patch };
        for (const k of Object.keys(s) as (keyof CellStyle)[]) if (!s[k]) delete s[k];
        edits.push({
          row: r,
          col: c,
          input: cur?.i ?? "",
          style: Object.keys(s).length ? s : null,
        });
      }
    }
    wb.applyEdits(tabId, edits);
  };

  const toggle = (k: "b" | "i" | "u") => style({ [k]: !focusInput?.s?.[k] });

  const setFormat = (code: string) => {
    if (!engine || !tabId) return;
    const edits: CellEdit[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const cur = engine.getInput(tabId, r, c);
        edits.push({
          row: r,
          col: c,
          input: cur?.i ?? "",
          format: code === "General" ? null : code,
        });
      }
    }
    wb.applyEdits(tabId, edits);
  };

  const structural = (axis: Axis, at: number, count: number) => {
    if (!engine || !tabId || !activeTab) return;
    const target = activeTab.name;
    wb.structural(tabId, (eng) => {
      for (const s of eng.listSheets()) {
        const g = eng.snapshot(s.id);
        if (!g) continue;
        const moved = s.id === tabId ? moveCells(g, axis, at, count) : g;
        const cells = { ...moved.cells };
        let changed = s.id === tabId;
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
    const cellCount = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (cellCount > 500_000) {
      toast.error("That selection is too large to copy (over 500,000 cells).");
      return null;
    }
    for (let r = range.r0; r <= range.r1; r++) {
      const line: string[] = [];
      const ins: Clip["inputs"][number] = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const input = engine.getInput(tabId, r, c);
        line.push(cellView(engine.getValue(tabId, r, c), input).text);
        ins.push(input ? { i: input.i, f: input.f } : undefined);
      }
      rows.push(line);
      inputs.push(ins);
    }
    const tsv = toTsv(rows);
    clip.current = { tabId, range, inputs, tsv, cut };
    return tsv;
  };

  const paste = (text: string) => {
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
          edits.push({
            ...dst,
            input: internal.cut
              ? input
              : input.startsWith("=")
                ? shiftFormula(input, dst.row - src.row, dst.col - src.col)
                : input,
            format: cell?.f ?? null,
          });
        }),
      );
      if (internal.cut) {
        // A cut moves: the source empties once the paste lands (where not overwritten).
        const dests = new Set(edits.map((e) => `${e.row},${e.col}`));
        for (let r = internal.range.r0; r <= internal.range.r1; r++) {
          for (let c = internal.range.c0; c <= internal.range.c1; c++) {
            if (!dests.has(`${r},${c}`) && internal.tabId === tabId)
              edits.push({ row: r, col: c, input: "", format: null });
          }
        }
        if (internal.tabId !== tabId) {
          const srcEdits: CellEdit[] = [];
          for (let r = internal.range.r0; r <= internal.range.r1; r++) {
            for (let c = internal.range.c0; c <= internal.range.c1; c++)
              srcEdits.push({ row: r, col: c, input: "", format: null });
          }
          wb.applyEdits(internal.tabId, srcEdits);
        }
        clip.current = null;
      }
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
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Undo (Ctrl+Z)"
              onClick={() => wb.undo()}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Redo (Ctrl+Y)"
              onClick={() => wb.redo()}
            >
              <Redo2 className="h-4 w-4" />
            </Button>
            <div className="mx-1 h-5 w-px bg-border" />
            <Button
              size="icon"
              variant={focusInput?.s?.b ? "secondary" : "ghost"}
              className="h-7 w-7"
              title="Bold (Ctrl+B)"
              onClick={() => toggle("b")}
            >
              <Bold className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant={focusInput?.s?.i ? "secondary" : "ghost"}
              className="h-7 w-7"
              title="Italic (Ctrl+I)"
              onClick={() => toggle("i")}
            >
              <Italic className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant={focusInput?.s?.u ? "secondary" : "ghost"}
              className="h-7 w-7"
              title="Underline (Ctrl+U)"
              onClick={() => toggle("u")}
            >
              <Underline className="h-4 w-4" />
            </Button>
            <div className="mx-1 h-5 w-px bg-border" />
            {(["left", "center", "right"] as const).map((al) => {
              const Icon = al === "left" ? AlignLeft : al === "center" ? AlignCenter : AlignRight;
              return (
                <Button
                  key={al}
                  size="icon"
                  variant={focusInput?.s?.align === al ? "secondary" : "ghost"}
                  className="h-7 w-7"
                  title={`Align ${al}`}
                  onClick={() => style({ align: focusInput?.s?.align === al ? undefined : al })}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              );
            })}
            <div className="mx-1 h-5 w-px bg-border" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  title="Number format"
                >
                  {PRESET_FORMATS.find((p) => p.code === focusInput?.f)?.label ??
                    (focusInput?.f ? "Custom" : "General")}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {PRESET_FORMATS.map((p) => (
                  <DropdownMenuItem key={p.code} onSelect={() => setFormat(p.code)}>
                    <span className="w-28">{p.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{p.code}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={async () => {
                    const code = await promptAsk({
                      title: "Custom number format",
                      body: 'An Excel format code, e.g. #,##0.0 or 0.0% or "Q"0 or yyyy-mm.',
                      input: { defaultValue: focusInput?.f ?? "", required: true },
                      actionLabel: "Apply",
                    });
                    if (code) setFormat(code);
                  }}
                >
                  Custom…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              title="Save the selection (or the whole sheet) as a lakehouse table"
              onClick={openSave}
            >
              <Database className="h-3.5 w-3.5" /> Save to lakehouse
            </Button>
            <div className="ml-auto flex items-center gap-2 pr-1 text-xs" data-testid="save-state">
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
            </div>
          </div>

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
              colWidths={colWidths}
              selection={selection}
              onSelect={(sel) => {
                tabRun.current = null;
                setSelection(sel);
              }}
              editing={editing}
              onEditChange={setEditing}
              onCommit={commit}
              onKey={onKey}
              onColWidth={(c, w) =>
                wb.setGridMeta(tabId, { colWidths: { ...colWidths, [String(c)]: Math.round(w) } })
              }
              onFill={fill}
              onNearEnd={(axis) =>
                setExtent((x) =>
                  axis === "rows"
                    ? { ...x, rows: Math.min(1_048_576, x.rows + 1000) }
                    : { ...x, cols: Math.min(16_384, x.cols + 26) },
                )
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY });
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
                range={range}
                onClose={() => setMenu(null)}
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
                  clear: clearSelection,
                  insertRowsAbove: () => structural("rows", range.r0, range.r1 - range.r0 + 1),
                  insertRowsBelow: () => structural("rows", range.r1 + 1, range.r1 - range.r0 + 1),
                  deleteRows: () => structural("rows", range.r0, -(range.r1 - range.r0 + 1)),
                  insertColsLeft: () => structural("cols", range.c0, range.c1 - range.c0 + 1),
                  insertColsRight: () => structural("cols", range.c1 + 1, range.c1 - range.c0 + 1),
                  deleteCols: () => structural("cols", range.c0, -(range.c1 - range.c0 + 1)),
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
        </div>
      </div>
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

function ContextMenu({
  x,
  y,
  range,
  onClose,
  actions,
}: {
  x: number;
  y: number;
  range: RangeAddr;
  onClose: () => void;
  actions: Record<
    | "copy"
    | "cut"
    | "paste"
    | "clear"
    | "insertRowsAbove"
    | "insertRowsBelow"
    | "deleteRows"
    | "insertColsLeft"
    | "insertColsRight"
    | "deleteCols"
    | "saveToLakehouse",
    () => void
  >;
}) {
  const rows = range.r1 - range.r0 + 1;
  const cols = range.c1 - range.c0 + 1;
  const item = (label: string, fn: () => void, danger = false) => (
    <button
      className={cn(
        "block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-muted",
        danger && "text-destructive",
      )}
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
  return (
    <div
      className="fixed z-50 w-56 rounded-md border border-border bg-popover p-1 shadow-lg"
      style={{ left: x, top: y }}
      role="menu"
      data-testid="grid-context-menu"
      ref={ref}
    >
      {item("Cut", actions.cut)}
      {item("Copy", actions.copy)}
      {item("Paste", actions.paste)}
      {item("Clear contents", actions.clear)}
      <div className="my-1 h-px bg-border" />
      {item(`Insert ${rows} row${rows > 1 ? "s" : ""} above`, actions.insertRowsAbove)}
      {item(`Insert ${rows} row${rows > 1 ? "s" : ""} below`, actions.insertRowsBelow)}
      {item(`Delete ${rows > 1 ? `${rows} rows` : "row"}`, actions.deleteRows, true)}
      <div className="my-1 h-px bg-border" />
      {item(`Insert ${cols} column${cols > 1 ? "s" : ""} left`, actions.insertColsLeft)}
      {item(`Insert ${cols} column${cols > 1 ? "s" : ""} right`, actions.insertColsRight)}
      {item(
        `Delete ${cols > 1 ? `${cols} columns` : "column"} ${colLetters(range.c0)}${cols > 1 ? `:${colLetters(range.c1)}` : ""}`,
        actions.deleteCols,
        true,
      )}
      <div className="my-1 h-px bg-border" />
      {item("Save range to the lakehouse…", actions.saveToLakehouse)}
    </div>
  );
}
