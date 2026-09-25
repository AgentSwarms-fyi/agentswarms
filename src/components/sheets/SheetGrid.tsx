// The grid: a windowed cell surface with Excel's keyboard and mouse habits.
//
// Only the cells in view are in the DOM, so a sheet can be tens of thousands
// of rows tall without the page noticing. Rows and columns have their own
// sizes (set by hand, grown for wrapped text, hidden) and everything scales
// with the zoom; positions come from prefix sums, so a pixel maps to a cell
// in O(log n). Headers stay pinned with CSS sticky tracks around the body.
// While a formula is being typed, clicking (or dragging across) cells
// inserts their reference at the caret, as Excel's point mode does;
// otherwise a click selects.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { a1, colLetters, normRange, rangeA1, type RangeAddr } from "@/lib/sheets/a1";
import { cellView, editText } from "@/lib/sheets/cellView";
import { inkOn } from "@/lib/sheets/ink";
import type { CellInput, GridData, WorkbookEngine } from "@/lib/sheets/engine";
import { AxisGeometry } from "@/lib/sheets/geometry";
import { autoRowHeights, CELL_PAD_X } from "@/lib/sheets/layout";
import { expandToMerges, mergeAt, parseMerges, intersects } from "@/lib/sheets/merge";
import { acceptsReference, selRange, startsEdit, type Selection } from "@/lib/sheets/selection";
import { cssBorder, fontPx, fontStack, INDENT_PX, type Borders } from "@/lib/sheets/style";
import { cn } from "@/lib/utils";
import { measureText } from "./measure";

export const ROW_H = 24;
export const HEADER_H = 26;
export const HEADER_W = 52;
export const DEFAULT_COL_W = 104;
const LINK_COLOR = "#0563C1";

export type Editing = {
  row: number;
  col: number;
  text: string;
  /** "enter": typing replaced the cell, arrows commit; "edit": F2/double-click, arrows move the caret. */
  mode: "enter" | "edit";
  /** Where the caret goes after a click-inserted reference. */
  caret?: number;
  /** Which editor holds the keyboard: the cell itself, or the formula bar. */
  source?: "cell" | "bar";
};

/** What a rule (conditional formatting) adds to a cell's own look. */
export type CellDecoration = {
  color?: string;
  bg?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  st?: boolean;
  /** A data bar: the filled share of the cell (0–1), from `start` (0–1) for negatives. */
  bar?: { start: number; end: number; color: string };
  /** An icon drawn before the value. */
  icon?: string;
};

export type GridGeometry = {
  rows: AxisGeometry;
  cols: AxisGeometry;
  zoom: number;
};

type Props = {
  engine: WorkbookEngine;
  tabId: string;
  rev: number;
  rowCount: number;
  colCount: number;
  /** The sheet's live grid (sizes, merges, hidden rows and columns). */
  grid: GridData | undefined;
  /** 1 is 100%. */
  zoom: number;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** A mouse selection ended (the format painter applies here). */
  onSelectEnd?: () => void;
  editing: Editing | null;
  onEditChange: (e: Editing | null) => void;
  /** Commit the edit, then move by (dr, dc). */
  onCommit: (dr: number, dc: number) => void;
  onKey: (e: React.KeyboardEvent) => void;
  onColWidth: (col: number, width: number) => void;
  /** A row's height set by hand; null returns it to fitting its content. */
  onRowHeight: (row: number, height: number | null) => void;
  onFill: (source: RangeAddr, target: RangeAddr) => void;
  onNearEnd: (axis: "rows" | "cols") => void;
  onContextMenu?: (e: React.MouseEvent, kind: "cell" | "row" | "col") => void;
  /** Ctrl+wheel over the grid. */
  onZoom?: (dir: 1 | -1) => void;
  /** Ctrl+click on a cell that holds a link. */
  onOpenLink?: (row: number, col: number) => void;
  /** Conditional formatting and the like, per cell. */
  decorate?: (row: number, col: number) => CellDecoration | undefined;
  /** Things drawn over the cells (charts, filter buttons), placed with the geometry. */
  renderOverlay?: (geo: GridGeometry) => React.ReactNode;
  /** The other place a formula can be typed (the formula bar), when it has focus. */
  editorRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** The element that holds the keyboard while no cell is being edited. */
  gridRef: React.MutableRefObject<HTMLElement | null>;
  /** Text arrived without a keydown (IME composition, dictation, insertText): start typing it. */
  onType: (text: string) => void;
};

function cellFont(s: CellInput["s"], z: number, base: string, extra?: CellDecoration): string {
  const italic = (extra?.i ?? s?.i) ? "italic " : "";
  const weight = (extra?.b ?? s?.b) ? "600 " : "";
  return `${italic}${weight}${fontPx(s?.sz, z)}px ${fontStack(s?.font) ?? base}`;
}

export function SheetGrid(props: Props) {
  const {
    engine,
    tabId,
    rev,
    rowCount,
    colCount,
    grid,
    zoom: z,
    selection,
    onSelect,
    editing,
    onEditChange,
    onCommit,
    onKey,
    onColWidth,
    onRowHeight,
    onFill,
    onNearEnd,
    editorRef,
    gridRef,
    onType,
    decorate,
  } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cellEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const [baseFont, setBaseFont] = useState("sans-serif");
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) setBaseFont(getComputedStyle(el).fontFamily || "sans-serif");
  }, []);

  const headerH = Math.round(HEADER_H * Math.max(0.6, z));
  const headerW = Math.round(HEADER_W * Math.max(0.6, z));

  // ── Geometry ─────────────────────────────────────────────────────────────
  const merges = useMemo(
    () => parseMerges(grid?.merges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.merges, rev],
  );
  const hiddenRows = useMemo(
    () => new Set(grid?.hiddenRows ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.hiddenRows, rev],
  );
  const hiddenCols = useMemo(
    () => new Set(grid?.hiddenCols ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.hiddenCols, rev],
  );
  const baseColW = useCallback(
    (c: number) => (hiddenCols.has(c) ? 0 : (grid?.colWidths?.[String(c)] ?? DEFAULT_COL_W)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid, hiddenCols, rev],
  );
  // Rows grown for wrapped text or a larger font, unless a height was set.
  const autoHeights = useMemo(
    () =>
      grid
        ? autoRowHeights({
            cells: grid.cells,
            manual: grid.rowHeights,
            base: ROW_H,
            colWidth: baseColW,
            text: (r, c) =>
              cellView(engine.getValue(tabId, r, c), engine.getInput(tabId, r, c)).text,
            measure: (t, font) => measureText(t, font.replace("sans-serif", baseFont)),
            merged: (r, c) => !!mergeAt(merges, r, c),
          })
        : new Map<number, number>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid, rev, baseColW, merges, baseFont, engine, tabId],
  );
  const rows = useMemo(
    () =>
      new AxisGeometry(rowCount, (r) =>
        hiddenRows.has(r)
          ? 0
          : Math.round((grid?.rowHeights?.[String(r)] ?? autoHeights.get(r) ?? ROW_H) * z),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowCount, hiddenRows, autoHeights, grid, z, rev],
  );
  const cols = useMemo(
    () => new AxisGeometry(colCount, (c) => Math.round(baseColW(c) * z)),
    [colCount, baseColW, z],
  );
  const totalW = cols.total;
  const totalH = rows.total;

  // ── The window in view ───────────────────────────────────────────────────
  const [view, setView] = useState({ top: 0, left: 0, w: 1200, h: 800 });
  const readView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setView((v) => {
      const next = {
        top: el.scrollTop,
        left: el.scrollLeft,
        w: el.clientWidth - headerW,
        h: el.clientHeight - headerH,
      };
      return v.top === next.top && v.left === next.left && v.w === next.w && v.h === next.h
        ? v
        : next;
    });
  }, [headerW, headerH]);
  useLayoutEffect(() => {
    readView();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(readView);
    ro.observe(el);
    return () => ro.disconnect();
  }, [readView]);

  const firstRow = Math.max(0, rows.indexAt(view.top) - 4);
  const lastRow = Math.min(rowCount - 1, rows.indexAt(view.top + view.h) + 4);
  const firstCol = Math.max(0, cols.indexAt(view.left) - 2);
  const lastCol = Math.min(colCount - 1, cols.indexAt(view.left + view.w) + 2);
  const visRows: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) if (rows.size(r) > 0) visRows.push(r);
  const visCols: number[] = [];
  for (let c = firstCol; c <= lastCol; c++) if (cols.size(c) > 0) visCols.push(c);

  // ── Selection, merged-aware ──────────────────────────────────────────────
  const range = expandToMerges(selRange(selection), merges);
  const active = selection.anchor;
  const activeBox = mergeAt(merges, active.row, active.col) ?? {
    r0: active.row,
    c0: active.col,
    r1: active.row,
    c1: active.col,
  };
  const rect = (r: RangeAddr) => ({
    left: cols.start(r.c0),
    top: rows.start(r.r0),
    width: cols.end(r.c1) - cols.start(r.c0),
    height: rows.end(r.r1) - rows.start(r.r0),
  });

  // ── Scrolling into view ─────────────────────────────────────────────────
  // The moving end, as a keyboard extension goes; the active cell after a
  // paste or fill; nothing for a whole row, column or sheet.
  const target = selection.scroll === "anchor" ? selection.anchor : selection.focus;
  const noScroll = selection.scroll === "none";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || noScroll) return;
    const top = rows.start(target.row);
    const h = Math.max(1, rows.size(target.row));
    const left = cols.start(target.col);
    const w = cols.size(target.col);
    const viewW = el.clientWidth - headerW;
    const viewH = el.clientHeight - headerH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + h > el.scrollTop + viewH) el.scrollTop = top + h - viewH;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (left + w > el.scrollLeft + viewW) el.scrollLeft = left + w - viewW;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.row, target.col, noScroll, rows, cols]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    readView();
    if (el.scrollTop + el.clientHeight > totalH - ROW_H * z * 20) onNearEnd("rows");
    if (el.scrollLeft + el.clientWidth > totalW - DEFAULT_COL_W * z * 3) onNearEnd("cols");
  };

  // Ctrl+wheel zooms (a passive React listener cannot stop the page zooming).
  const onZoomRef = useRef(props.onZoom);
  onZoomRef.current = props.onZoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !onZoomRef.current) return;
      e.preventDefault();
      onZoomRef.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // ── Mouse: select, drag-select, point mode, fill ─────────────────────────
  const drag = useRef<
    | { kind: "select" }
    | { kind: "rows"; from: number }
    | { kind: "cols"; from: number }
    | { kind: "point"; start: { row: number; col: number }; at: number; len: number }
    | { kind: "fill"; source: RangeAddr }
    | null
  >(null);
  const [fillPreview, setFillPreview] = useState<RangeAddr | null>(null);

  const cellAt = (clientX: number, clientY: number): { row: number; col: number } | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const x = clientX - box.left - headerW + el.scrollLeft;
    const y = clientY - box.top - headerH + el.scrollTop;
    return {
      row: Math.max(0, Math.min(rowCount - 1, rows.indexAt(Math.max(0, y)))),
      col: Math.max(0, Math.min(colCount - 1, cols.indexAt(Math.max(0, x)))),
    };
  };

  /** A click inside a merge means its top-left cell. */
  const topLeft = (hit: { row: number; col: number }) => {
    const m = mergeAt(merges, hit.row, hit.col);
    return m ? { row: m.r0, col: m.c0 } : hit;
  };

  const insertReference = (ref: string, replace?: { at: number; len: number }) => {
    if (!editing) return null;
    const caret = replace ? replace.at : (editing.caret ?? editing.text.length);
    const before = editing.text.slice(0, caret);
    const after = editing.text.slice(replace ? replace.at + replace.len : caret);
    const text = before + ref + after;
    onEditChange({ ...editing, text, caret: caret + ref.length, mode: "edit" });
    return { at: caret, len: ref.length };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const raw = cellAt(e.clientX, e.clientY);
    if (!raw) return;
    const hit = topLeft(raw);
    // Point mode: a formula being typed takes the clicked cell as a reference.
    if (editing) {
      const caret = editing.caret ?? editing.text.length;
      if (
        acceptsReference(editing.text, caret) &&
        !(hit.row === editing.row && hit.col === editing.col)
      ) {
        e.preventDefault();
        const ins = insertReference(a1(hit.row, hit.col));
        if (ins) drag.current = { kind: "point", start: hit, at: ins.at, len: ins.len };
        return;
      }
      onCommit(0, 0);
    }
    if ((e.ctrlKey || e.metaKey) && props.onOpenLink) {
      const input = engine.getInput(tabId, hit.row, hit.col);
      if (input?.l || /^=\s*HYPERLINK\s*\(/i.test(input?.i ?? "")) {
        e.preventDefault();
        props.onOpenLink(hit.row, hit.col);
        return;
      }
    }
    e.preventDefault();
    gridRef.current?.focus({ preventScroll: true });
    if (e.shiftKey) onSelect({ anchor: selection.anchor, focus: raw });
    else onSelect({ anchor: hit, focus: hit });
    drag.current = { kind: "select" };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const hit = cellAt(e.clientX, e.clientY);
      if (!hit) return;
      if (d.kind === "select") {
        onSelect({ anchor: selection.anchor, focus: hit });
      } else if (d.kind === "cols") {
        onSelect({
          anchor: { row: 0, col: d.from },
          focus: { row: rowCount - 1, col: hit.col },
          scroll: "none",
        });
      } else if (d.kind === "rows") {
        onSelect({
          anchor: { row: d.from, col: 0 },
          focus: { row: hit.row, col: colCount - 1 },
          scroll: "none",
        });
      } else if (d.kind === "point") {
        const ref =
          hit.row === d.start.row && hit.col === d.start.col
            ? a1(hit.row, hit.col)
            : rangeA1(normRange(d.start, hit));
        const ins = insertReference(ref, { at: d.at, len: d.len });
        if (ins) drag.current = { ...d, len: ins.len };
      } else if (d.kind === "fill") {
        const s = d.source;
        // Fill extends along the axis the pointer moved further on.
        const down = hit.row > s.r1 ? hit.row - s.r1 : 0;
        const right = hit.col > s.c1 ? hit.col - s.c1 : 0;
        if (down === 0 && right === 0) setFillPreview(null);
        else if (down >= right) setFillPreview({ r0: s.r0, c0: s.c0, r1: hit.row, c1: s.c1 });
        else setFillPreview({ r0: s.r0, c0: s.c0, r1: s.r1, c1: hit.col });
      }
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.kind === "fill") {
        setFillPreview((p) => {
          if (p) onFill(d.source, p);
          return null;
        });
      }
      if (d?.kind === "point") {
        // Keep typing in the editor that holds the formula.
        requestAnimationFrame(() => editorRef.current?.focus());
      }
      if (d?.kind === "select" || d?.kind === "rows" || d?.kind === "cols") props.onSelectEnd?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  // ── Resizing rows and columns ────────────────────────────────────────────
  const startColResize = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = baseColW(col);
    const move = (ev: MouseEvent) =>
      onColWidth(col, Math.max(16, Math.min(1200, startW + (ev.clientX - startX) / z)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startRowResize = (e: React.MouseEvent, row: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = rows.size(row) / z;
    const move = (ev: MouseEvent) =>
      onRowHeight(row, Math.max(12, Math.min(800, Math.round(startH + (ev.clientY - startY) / z))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const autoFit = (col: number) => {
    // Widest shown text in the first rows of data.
    const used = engine.used(tabId);
    let max = colLetters(col).length * 8;
    for (let r = 0; r < Math.min(used.rows, 2000); r++) {
      const input = engine.getInput(tabId, r, col);
      const v = cellView(engine.getValue(tabId, r, col), input);
      if (!v.text || mergeAt(merges, r, col)) continue;
      max = Math.max(max, measureText(v.text, cellFont(input?.s, 1, baseFont)));
    }
    onColWidth(col, Math.max(24, Math.min(800, Math.ceil(max + CELL_PAD_X * 2 + 4))));
  };

  // ── Cells ────────────────────────────────────────────────────────────────
  void rev; // values are read from the engine each render; rev forces the render
  const pad = CELL_PAD_X * z;
  const isEmpty = (r: number, c: number) =>
    engine.getValue(tabId, r, c) === null && !engine.getInput(tabId, r, c)?.s?.bg;

  const cellNodes: React.ReactNode[] = [];
  const overlayNodes: React.ReactNode[] = [];

  const drawCell = (r: number, c: number, box: RangeAddr, merged: boolean) => {
    const input = engine.getInput(tabId, r, c);
    const value = engine.getValue(tabId, r, c);
    const deco = decorate?.(r, c);
    const st = input?.s;
    if (value === null && !st && !input?.l && !deco && !merged) return;
    const view = cellView(
      value,
      input,
      value !== null && typeof value === "object" ? engine.getErrorDetail(tabId, r, c) : undefined,
    );
    const pos = rect(box);
    const font = cellFont(st, z, baseFont, deco);
    const indent = (st?.ind ?? 0) * INDENT_PX * z;
    const inner = pos.width - pad * 2 - indent;
    let text = view.text;
    // A number that does not fit shows ####, as in Excel (text runs on instead).
    if (view.kind === "number" && !st?.wrap && measureText(text, font) > inner) {
      text = "#".repeat(Math.max(1, Math.floor(inner / Math.max(1, measureText("#", font)))));
    }
    const isLink = !!input?.l || /^=\s*HYPERLINK\s*\(/i.test(input?.i ?? "");
    // A formula from an Excel file that this engine cannot compute shows the
    // value Excel saved; a corner mark and the tooltip say so.
    const cached = engine.isCached(tabId, r, c);
    const cachedNote = cached
      ? (() => {
          const fns = engine.unknownFunctions(tabId, r, c);
          return fns.length
            ? `The value Excel last saved. ${fns.join(", ")} ${fns.length > 1 ? "are" : "is"} not computed in Sheets yet, so this cell does not recalculate.`
            : "The value Excel last saved. This formula refers to something outside this workbook, so it does not recalculate.";
        })()
      : undefined;
    const bg = deco?.bg ?? st?.bg;
    const color =
      deco?.color ?? view.color ?? st?.color ?? (isLink ? LINK_COLOR : undefined) ?? inkOn(bg);
    const underline = (deco?.u ?? st?.u) || (isLink && !st?.color);
    const strike = deco?.st ?? st?.st;

    // Text wider than its cell runs on over empty neighbours (left-aligned to
    // the right, right-aligned to the left), covering their grid lines.
    let left = pos.left;
    let width = pos.width;
    let spill = false;
    if (!merged && !st?.wrap && view.kind === "text" && text) {
      const need = measureText(text, font) + pad * 2 + indent;
      if (need > width) {
        if (view.align === "left") {
          for (let k = c + 1; width < need && k < colCount && k < c + 60; k++) {
            if (!isEmpty(r, k) || mergeAt(merges, r, k)) break;
            width += cols.size(k);
          }
        } else if (view.align === "right") {
          for (let k = c - 1; width < need && k >= 0 && k > c - 60; k--) {
            if (!isEmpty(r, k) || mergeAt(merges, r, k)) break;
            width += cols.size(k);
            left -= cols.size(k);
          }
        }
        spill = width > pos.width;
      }
    }
    const va = st?.va ?? "bottom";
    const node = (
      <div
        key={`${r}:${c}`}
        role="gridcell"
        data-cell={a1(r, c)}
        title={
          cachedNote ?? view.title ?? (input?.l ? `${input.l} (Ctrl+click to open)` : undefined)
        }
        data-cached={cached || undefined}
        className={cn(
          "absolute flex overflow-hidden",
          view.kind === "error" && !color && "text-destructive",
          (spill || merged) && !bg && "bg-background",
        )}
        style={{
          left,
          top: pos.top + (spill || merged ? 0.5 : 0),
          width: width - (spill || merged ? 1 : 0),
          height: pos.height - (spill || merged ? 1.5 : 0),
          padding: `0 ${pad}px`,
          paddingLeft: pad + (view.align === "left" ? indent : 0),
          paddingRight: pad + (view.align === "right" ? indent : 0),
          alignItems: va === "top" ? "flex-start" : va === "middle" ? "center" : "flex-end",
          justifyContent:
            view.align === "center" ? "center" : view.align === "right" ? "flex-end" : "flex-start",
          font,
          color,
          background:
            spill && bg
              ? `linear-gradient(to right, ${bg} 0 ${pos.width}px, var(--background) ${pos.width}px)`
              : bg,
          textDecoration:
            [underline && "underline", strike && "line-through"].filter(Boolean).join(" ") ||
            undefined,
          lineHeight: 1.25,
        }}
      >
        {cached && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 h-0 w-0 border-r-[6px] border-t-[6px] border-r-transparent border-t-amber-500"
          />
        )}
        {deco?.bar && (
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-[3px] top-[3px] opacity-60"
            style={{
              left: `${deco.bar.start * 100}%`,
              width: `${Math.max(0, deco.bar.end - deco.bar.start) * 100}%`,
              background: `linear-gradient(to right, ${deco.bar.color}, ${deco.bar.color}33)`,
            }}
          />
        )}
        <span
          className={cn(
            "relative max-w-full",
            st?.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
          style={{
            textAlign: view.align,
            width: st?.wrap ? "100%" : undefined,
            paddingBottom: va === "bottom" ? 2 * z : undefined,
            paddingTop: va === "top" ? 2 * z : undefined,
          }}
        >
          {deco?.icon && <span className="mr-1">{deco.icon}</span>}
          {text}
        </span>
      </div>
    );
    (spill || merged ? overlayNodes : cellNodes).push(node);
    const bd = st?.bd;
    if (bd) overlayNodes.push(borderNode(`b${r}:${c}`, pos, bd));
  };

  for (const r of visRows) {
    for (const c of visCols) {
      if (mergeAt(merges, r, c)) continue;
      drawCell(r, c, { r0: r, c0: c, r1: r, c1: c }, false);
    }
  }
  // Merged cells, drawn whole even when their top-left is scrolled away.
  const viewBox = { r0: firstRow, c0: firstCol, r1: lastRow, c1: lastCol };
  for (const m of merges) {
    if (!intersects(m, viewBox)) continue;
    drawCell(m.r0, m.c0, m, true);
  }

  // Keep the in-cell editor focused (unless the formula bar holds the edit)
  // and its caret where a click-inserted reference left it.
  useEffect(() => {
    const el = cellEditorRef.current;
    if (!el || !editing || editing.source === "bar") return;
    if (document.activeElement !== el) el.focus();
    if (editing.caret !== undefined && el.selectionStart !== editing.caret) {
      el.setSelectionRange(editing.caret, editing.caret);
    }
  }, [editing]);

  const editBox = editing
    ? (mergeAt(merges, editing.row, editing.col) ?? {
        r0: editing.row,
        c0: editing.col,
        r1: editing.row,
        c1: editing.col,
      })
    : null;
  const editInput = editing ? engine.getInput(tabId, editing.row, editing.col) : undefined;

  const headerFont = Math.max(9, Math.round(12 * Math.min(1.4, z)));

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      role="grid"
      aria-label="Sheet grid"
      aria-rowcount={rowCount}
      aria-colcount={colCount}
      data-testid="sheet-grid"
      data-zoom={Math.round(z * 100)}
      className="relative h-full w-full select-none overflow-auto bg-background text-[13px] outline-none"
      // Only keys pressed in the grid itself. A popover drawn over the grid
      // (a filter's search box, a list of choices, a link's buttons) lives in
      // a portal elsewhere in the page, but React still bubbles its keys up
      // here: typing in it started a cell edit and swallowed Enter (R121).
      onKeyDown={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        onKey(e);
      }}
      onScroll={onScroll}
    >
      <div
        style={{
          display: "grid",
          // As wide as its columns, not as the viewport: a sticky header can
          // only travel inside its container, and a viewport-wide container
          // let the row numbers scroll away past the first screen of columns.
          width: headerW + totalW,
          gridTemplateColumns: `${headerW}px ${totalW}px`,
          gridTemplateRows: `${headerH}px ${totalH}px`,
        }}
      >
        {/* Corner: selects the whole sheet */}
        <div
          className="sticky left-0 top-0 z-30 border-b border-r border-border bg-muted"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect({
              // A1 stays the active cell and the view does not jump to the
              // last row and column.
              anchor: { row: 0, col: 0 },
              focus: { row: rowCount - 1, col: colCount - 1 },
              scroll: "none",
            });
            gridRef.current?.focus({ preventScroll: true });
          }}
          title="Select all"
        />
        {/* Column headers */}
        <div className="sticky top-0 z-20 bg-muted" style={{ height: headerH }}>
          {visCols.map((c) => {
            const selected = c >= range.c0 && c <= range.c1;
            const hiddenBefore = c > 0 && cols.size(c - 1) === 0;
            return (
              <div
                key={c}
                className={cn(
                  "absolute top-0 flex h-full items-center justify-center border-b border-r border-border text-muted-foreground",
                  selected && "bg-primary/15 font-semibold text-foreground",
                  hiddenBefore && "border-l-2 border-l-primary/60",
                )}
                style={{ left: cols.start(c), width: cols.size(c), fontSize: headerFont }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  gridRef.current?.focus({ preventScroll: true });
                  const from = e.shiftKey ? selection.anchor.col : c;
                  // The active cell is the column's top, as Excel's; no scroll.
                  onSelect({
                    anchor: { row: 0, col: from },
                    focus: { row: rowCount - 1, col: c },
                    scroll: "none",
                  });
                  drag.current = { kind: "cols", from };
                }}
                onContextMenu={(e) => {
                  if (
                    !(c >= range.c0 && c <= range.c1 && range.r0 === 0 && range.r1 >= rowCount - 1)
                  ) {
                    onSelect({
                      anchor: { row: 0, col: c },
                      focus: { row: rowCount - 1, col: c },
                      scroll: "none",
                    });
                  }
                  props.onContextMenu?.(e, "col");
                }}
                role="columnheader"
                data-col={colLetters(c)}
              >
                {colLetters(c)}
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                  onMouseDown={(e) => startColResize(e, c)}
                  onDoubleClick={() => autoFit(c)}
                  title="Drag to resize; double-click to fit"
                  data-testid={`col-resize-${colLetters(c)}`}
                />
              </div>
            );
          })}
        </div>
        {/* Row headers */}
        <div className="sticky left-0 z-10 bg-muted" style={{ width: headerW }}>
          {visRows.map((r) => {
            const selected = r >= range.r0 && r <= range.r1;
            const hiddenBefore = r > 0 && rows.size(r - 1) === 0;
            return (
              <div
                key={r}
                className={cn(
                  "absolute left-0 flex w-full items-center justify-center border-b border-r border-border text-muted-foreground",
                  selected && "bg-primary/15 font-semibold text-foreground",
                  hiddenBefore && "border-t-2 border-t-primary/60",
                )}
                style={{ top: rows.start(r), height: rows.size(r), fontSize: headerFont }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  gridRef.current?.focus({ preventScroll: true });
                  const from = e.shiftKey ? selection.anchor.row : r;
                  // The active cell is the row's first; the view stays (scrolling
                  // to the selection's far end would jump to the last column).
                  onSelect({
                    anchor: { row: from, col: 0 },
                    focus: { row: r, col: colCount - 1 },
                    scroll: "none",
                  });
                  drag.current = { kind: "rows", from };
                }}
                onContextMenu={(e) => {
                  if (
                    !(r >= range.r0 && r <= range.r1 && range.c0 === 0 && range.c1 >= colCount - 1)
                  ) {
                    onSelect({
                      anchor: { row: r, col: 0 },
                      focus: { row: r, col: colCount - 1 },
                      scroll: "none",
                    });
                  }
                  props.onContextMenu?.(e, "row");
                }}
                role="rowheader"
                data-row={r + 1}
              >
                {r + 1}
                <div
                  className="absolute bottom-0 left-0 h-1.5 w-full cursor-row-resize hover:bg-primary/40"
                  onMouseDown={(e) => startRowResize(e, r)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onRowHeight(r, null);
                  }}
                  title="Drag to resize; double-click to fit"
                  data-testid={`row-resize-${r + 1}`}
                />
              </div>
            );
          })}
        </div>
        {/* Cells */}
        <div
          className="relative"
          onMouseDown={onMouseDown}
          onDoubleClick={(e) => {
            const raw = cellAt(e.clientX, e.clientY);
            if (!raw) return;
            const hit = topLeft(raw);
            const text = editText(engine.getInput(tabId, hit.row, hit.col));
            onEditChange({ row: hit.row, col: hit.col, text, mode: "edit", caret: text.length });
          }}
          onContextMenu={(e) => {
            const raw = cellAt(e.clientX, e.clientY);
            if (raw && props.onContextMenu) {
              if (
                !(
                  raw.row >= range.r0 &&
                  raw.row <= range.r1 &&
                  raw.col >= range.c0 &&
                  raw.col <= range.c1
                )
              ) {
                const hit = topLeft(raw);
                onSelect({ anchor: hit, focus: hit });
              }
              props.onContextMenu(e, "cell");
            }
          }}
        >
          {cellNodes}
          {/* Grid lines, drawn once as a background instead of per cell */}
          {!grid?.hideGrid && <GridLines rows={visRows} cols={visCols} geo={{ rows, cols }} />}
          {/* Text that runs on, merged cells and borders cover the grid lines, as in Excel */}
          {overlayNodes}
          {props.renderOverlay?.({ rows, cols, zoom: z })}
          {/* Selection */}
          <div
            className="pointer-events-none absolute border-2 border-primary bg-primary/5"
            style={rect(range)}
            data-testid="selection-box"
          />
          {/* Active cell */}
          <div
            className="pointer-events-none absolute border-2 border-primary"
            style={rect(activeBox)}
          />
          {/* Fill handle */}
          {!editing && (
            <div
              className="absolute z-10 h-2 w-2 cursor-crosshair border border-background bg-primary"
              style={{ left: cols.end(range.c1) - 4, top: rows.end(range.r1) - 4 }}
              title="Drag to fill"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                drag.current = { kind: "fill", source: range };
              }}
              data-testid="fill-handle"
            />
          )}
          {fillPreview && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-primary/70"
              style={rect(fillPreview)}
            />
          )}
          {/* The keyboard's home while nothing is being edited. A focused div only
              sees keydown, and text that arrives without one (an IME composing
              Japanese, dictation, a virtual keyboard) would be lost; a textarea
              receives it as input, which starts the edit as a keypress would.
              It sits on the active cell so an IME's candidate window does too. */}
          <textarea
            ref={(el) => {
              gridRef.current = el;
            }}
            aria-label={`Cell ${a1(active.row, active.col)}`}
            data-testid="grid-keyboard"
            className="pointer-events-none absolute z-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
            style={{
              left: cols.start(active.col),
              top: rows.start(active.row),
              width: 1,
              height: Math.max(1, rows.size(active.row)),
            }}
            tabIndex={0}
            spellCheck={false}
            autoComplete="off"
            onInput={(e) => {
              const el = e.currentTarget;
              if ((e.nativeEvent as InputEvent).isComposing) return;
              const text = el.value;
              el.value = "";
              if (startsEdit(text)) onType(text);
            }}
            onCompositionEnd={(e) => {
              const el = e.currentTarget;
              const text = e.data || el.value;
              el.value = "";
              if (startsEdit(text)) onType(text);
            }}
          />
          {/* In-cell editor: a textarea, so Alt+Enter can break a line as in Excel */}
          {editing && editBox && (
            <textarea
              ref={(el) => {
                cellEditorRef.current = el;
                if (el && editing.source !== "bar") editorRef.current = el;
              }}
              aria-label={`Editing ${a1(editing.row, editing.col)}`}
              data-testid="cell-editor"
              className="absolute z-20 resize-none overflow-hidden border-2 border-primary bg-background outline-none"
              style={{
                left: cols.start(editBox.c0),
                top: rows.start(editBox.r0),
                minWidth: rect(editBox).width,
                width: Math.max(
                  rect(editBox).width,
                  Math.min(
                    900,
                    Math.max(
                      ...editing.text
                        .split("\n")
                        .map((l) => measureText(l, cellFont(editInput?.s, z, baseFont))),
                    ) +
                      pad * 2 +
                      12,
                  ),
                ),
                height: Math.max(
                  rect(editBox).height,
                  editing.text.split("\n").length * fontPx(editInput?.s?.sz, z) * 1.3 + 6,
                ),
                padding: `${2 * z}px ${pad - 2}px`,
                font: cellFont(editInput?.s, z, baseFont),
                lineHeight: 1.25,
                whiteSpace: "pre",
              }}
              value={editing.text}
              spellCheck={false}
              autoFocus={editing.source !== "bar"}
              onFocus={(e) => {
                editorRef.current = e.currentTarget;
                if (editing.source === "bar") onEditChange({ ...editing, source: "cell" });
              }}
              onChange={(e) =>
                onEditChange({
                  ...editing,
                  text: e.target.value,
                  caret: e.target.selectionStart ?? e.target.value.length,
                  source: "cell",
                })
              }
              // The caret lives in the edit's state, not read back from some
              // input later: autocomplete and point mode insert at it.
              onSelect={(e) => {
                const c = e.currentTarget.selectionStart ?? editing.text.length;
                if (c !== editing.caret) onEditChange({ ...editing, caret: c });
              }}
              onKeyDown={(e) => {
                onKey(e);
                // Handled here; the grid around must not handle it a second time.
                e.stopPropagation();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function borderNode(
  key: string,
  pos: { left: number; top: number; width: number; height: number },
  bd: Borders,
): React.ReactNode {
  // One pixel up and left, so a border sits on the grid line it replaces and
  // the right border of B2 and the left border of C2 draw the same line.
  return (
    <div
      key={key}
      aria-hidden
      className="pointer-events-none absolute box-border"
      style={{
        left: pos.left - 1,
        top: pos.top - 1,
        width: pos.width + 1,
        height: pos.height + 1,
        borderTop: cssBorder(bd.t),
        borderRight: cssBorder(bd.r),
        borderBottom: cssBorder(bd.b),
        borderLeft: cssBorder(bd.l),
      }}
    />
  );
}

function GridLines({
  rows,
  cols,
  geo,
}: {
  rows: number[];
  cols: number[];
  geo: { rows: AxisGeometry; cols: AxisGeometry };
}) {
  if (!rows.length || !cols.length) return null;
  const top = geo.rows.start(rows[0]);
  const bottom = geo.rows.end(rows[rows.length - 1]);
  const left = geo.cols.start(cols[0]);
  const right = geo.cols.end(cols[cols.length - 1]);
  return (
    <svg
      className="pointer-events-none absolute"
      style={{ left, top, width: right - left, height: bottom - top }}
      aria-hidden
    >
      {rows.map((r) => (
        <line
          key={`r${r}`}
          x1={0}
          x2={right - left}
          y1={geo.rows.end(r) - top - 0.5}
          y2={geo.rows.end(r) - top - 0.5}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}
      {cols.map((c) => (
        <line
          key={`c${c}`}
          y1={0}
          y2={bottom - top}
          x1={geo.cols.end(c) - left - 0.5}
          x2={geo.cols.end(c) - left - 0.5}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}
