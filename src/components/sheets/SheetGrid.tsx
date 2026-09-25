// The grid: a virtualized cell surface with Excel's keyboard and mouse habits.
//
// Only the visible rows and columns are in the DOM, so a sheet can be tens of
// thousands of rows tall without the page noticing. Headers stay pinned with
// CSS sticky tracks around the body. While a formula is being typed, clicking
// (or dragging across) cells inserts their reference at the caret, as Excel's
// point mode does; otherwise a click selects.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { a1, cellKey, colLetters, normRange, rangeA1, type RangeAddr } from "@/lib/sheets/a1";
import { cellView, editText } from "@/lib/sheets/cellView";
import type { WorkbookEngine } from "@/lib/sheets/engine";
import { acceptsReference, selRange, type Selection } from "@/lib/sheets/selection";
import { cn } from "@/lib/utils";

export const ROW_H = 24;
export const HEADER_H = 26;
export const HEADER_W = 52;
export const DEFAULT_COL_W = 104;
/** Rough width of a character of cell text, for overflow and autofit. */
const TEXT_PX = 7.2;

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

type Props = {
  engine: WorkbookEngine;
  tabId: string;
  rev: number;
  rowCount: number;
  colCount: number;
  colWidths: Record<string, number>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  editing: Editing | null;
  onEditChange: (e: Editing | null) => void;
  /** Commit the edit, then move by (dr, dc). */
  onCommit: (dr: number, dc: number) => void;
  onKey: (e: React.KeyboardEvent) => void;
  onColWidth: (col: number, width: number) => void;
  onFill: (source: RangeAddr, target: RangeAddr) => void;
  onNearEnd: (axis: "rows" | "cols") => void;
  onContextMenu?: (e: React.MouseEvent, row: number, col: number) => void;
  /** The other place a formula can be typed (the formula bar), when it has focus. */
  editorRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** The element that holds the keyboard while no cell is being edited. */
  gridRef: React.MutableRefObject<HTMLElement | null>;
  /** Text arrived without a keydown (IME composition, dictation, insertText): start typing it. */
  onType: (text: string) => void;
};

export function SheetGrid(props: Props) {
  const {
    engine,
    tabId,
    rev,
    rowCount,
    colCount,
    colWidths,
    selection,
    onSelect,
    editing,
    onEditChange,
    onCommit,
    onKey,
    onColWidth,
    onFill,
    onNearEnd,
    editorRef,
    gridRef,
    onType,
  } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cellEditorRef = useRef<HTMLInputElement | null>(null);
  const width = useCallback((c: number) => colWidths[String(c)] ?? DEFAULT_COL_W, [colWidths]);

  const rowV = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: width,
    overscan: 4,
  });
  // Column widths changed: the virtualizer must re-measure.
  useEffect(() => {
    colV.measure();
  }, [colWidths, colV]);

  // Column offsets for positioning the selection box over any columns.
  const offsets = useMemo(() => {
    const out = new Array<number>(colCount + 1);
    out[0] = 0;
    for (let c = 0; c < colCount; c++) out[c + 1] = out[c] + width(c);
    return out;
  }, [colCount, width]);
  const totalW = offsets[colCount];
  const totalH = rowCount * ROW_H;

  // ── Scrolling into view ─────────────────────────────────────────────────
  // The moving end, as a keyboard extension goes; the active cell after a
  // paste or fill; nothing for a whole row, column or sheet.
  const active = selection.anchor;
  const target = selection.scroll === "anchor" ? selection.anchor : selection.focus;
  const noScroll = selection.scroll === "none";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || noScroll) return;
    const top = target.row * ROW_H;
    const left = offsets[target.col] ?? 0;
    const w = width(target.col);
    const viewW = el.clientWidth - HEADER_W;
    const viewH = el.clientHeight - HEADER_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + viewH) el.scrollTop = top + ROW_H - viewH;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (left + w > el.scrollLeft + viewW) el.scrollLeft = left + w - viewW;
  }, [target.row, target.col, noScroll, offsets, width]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight > totalH - ROW_H * 20) onNearEnd("rows");
    if (el.scrollLeft + el.clientWidth > totalW - DEFAULT_COL_W * 3) onNearEnd("cols");
  };

  // ── Mouse: select, drag-select, point mode, fill ─────────────────────────
  const drag = useRef<
    | { kind: "select" }
    | { kind: "point"; start: { row: number; col: number }; at: number; len: number }
    | { kind: "fill"; source: RangeAddr }
    | null
  >(null);
  const [fillPreview, setFillPreview] = useState<RangeAddr | null>(null);

  const cellAt = (clientX: number, clientY: number): { row: number; col: number } | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - HEADER_W + el.scrollLeft;
    const y = clientY - rect.top - HEADER_H + el.scrollTop;
    if (x < 0 || y < 0) return null;
    const row = Math.min(rowCount - 1, Math.floor(y / ROW_H));
    let lo = 0;
    let hi = colCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return { row, col: lo };
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
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit) return;
    // Point mode: a formula being typed takes the clicked cell as a reference.
    if (editing) {
      const caret = editing.caret ?? editing.text.length;
      if (
        acceptsReference(editing.text, caret) &&
        !(hit.row === editing.row && hit.col === editing.col)
      ) {
        e.preventDefault();
        const ref = a1(hit.row, hit.col);
        const ins = insertReference(ref);
        if (ins) drag.current = { kind: "point", start: hit, at: ins.at, len: ins.len };
        return;
      }
      onCommit(0, 0);
    }
    e.preventDefault();
    gridRef.current?.focus({ preventScroll: true });
    if (e.shiftKey) onSelect({ anchor: selection.anchor, focus: hit });
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
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  // ── Column resize ────────────────────────────────────────────────────────
  const startResize = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(col);
    const move = (ev: MouseEvent) =>
      onColWidth(col, Math.max(24, Math.min(1200, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const autoFit = (col: number) => {
    // Widest shown text in the first rows of data, measured roughly.
    const used = engine.used(tabId);
    let max = colLetters(col).length * 8;
    for (let r = 0; r < Math.min(used.rows, 2000); r++) {
      const v = cellView(engine.getValue(tabId, r, col), engine.getInput(tabId, r, col));
      max = Math.max(max, v.text.length * TEXT_PX);
    }
    onColWidth(col, Math.max(40, Math.min(600, Math.ceil(max + 16))));
  };

  // ── Rendering ────────────────────────────────────────────────────────────
  const range = selRange(selection);
  const vRows = rowV.getVirtualItems();
  const vCols = colV.getVirtualItems();
  void rev; // values are read from the engine each render; rev forces the render

  const boxStyle = (r: RangeAddr) => ({
    left: offsets[r.c0],
    top: r.r0 * ROW_H,
    width: offsets[r.c1 + 1] - offsets[r.c0],
    height: (r.r1 - r.r0 + 1) * ROW_H,
  });

  // Cells. Left-aligned text wider than its cell runs on over the empty
  // cells to its right (Excel does the same); those draw above the grid lines.
  const cellNodes: React.ReactNode[] = [];
  const overflowNodes: React.ReactNode[] = [];
  for (const vr of vRows) {
    for (const vc of vCols) {
      const r = vr.index;
      const c = vc.index;
      const input = engine.getInput(tabId, r, c);
      const value = engine.getValue(tabId, r, c);
      if (value === null && !input?.s) continue;
      const view = cellView(
        value,
        input,
        value !== null && typeof value === "object"
          ? engine.getErrorDetail(tabId, r, c)
          : undefined,
      );
      const st = input?.s;
      let w = vc.size;
      if (view.kind === "text" && view.align === "left" && !st?.bg) {
        const need = view.text.length * TEXT_PX + 12;
        for (let k = c + 1; w < need && k < colCount && k < c + 40; k++) {
          if (engine.getValue(tabId, r, k) !== null || engine.getInput(tabId, r, k)?.s?.bg) break;
          w += width(k);
        }
      }
      const node = (
        <div
          key={`${vr.key}:${vc.key}`}
          role="gridcell"
          data-cell={a1(r, c)}
          title={view.title}
          className={cn(
            "absolute overflow-hidden whitespace-pre px-1.5 leading-[23px]",
            view.kind === "error" && "text-destructive",
            w > vc.size && "bg-background",
            st?.b && "font-semibold",
            st?.i && "italic",
            st?.u && "underline",
          )}
          style={{
            left: vc.start,
            top: vr.start + (w > vc.size ? 0.5 : 0),
            width: w - (w > vc.size ? 1 : 0),
            height: vr.size - (w > vc.size ? 1.5 : 0),
            textAlign: view.align,
            color: st?.color,
            background: st?.bg,
          }}
        >
          {view.text}
        </div>
      );
      (w > vc.size ? overflowNodes : cellNodes).push(node);
    }
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

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      role="grid"
      aria-label="Sheet grid"
      aria-rowcount={rowCount}
      aria-colcount={colCount}
      data-testid="sheet-grid"
      className="relative h-full w-full select-none overflow-auto bg-background text-[13px] outline-none"
      onKeyDown={onKey}
      onScroll={onScroll}
    >
      <div
        style={{
          display: "grid",
          // As wide as its columns, not as the viewport: a sticky header can
          // only travel inside its container, and a viewport-wide container
          // let the row numbers scroll away past the first screen of columns.
          width: HEADER_W + totalW,
          gridTemplateColumns: `${HEADER_W}px ${totalW}px`,
          gridTemplateRows: `${HEADER_H}px ${totalH}px`,
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
        <div className="sticky top-0 z-20 bg-muted" style={{ height: HEADER_H }}>
          {vCols.map((vc) => {
            const selected = vc.index >= range.c0 && vc.index <= range.c1;
            return (
              <div
                key={vc.key}
                className={cn(
                  "absolute top-0 flex h-full items-center justify-center border-b border-r border-border text-xs text-muted-foreground",
                  selected && "bg-primary/15 font-semibold text-foreground",
                )}
                style={{ left: vc.start, width: vc.size }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  gridRef.current?.focus({ preventScroll: true });
                  const anchorCol = e.shiftKey ? selection.anchor.col : vc.index;
                  // The active cell is the column's top, as Excel's; no scroll.
                  onSelect({
                    anchor: { row: 0, col: anchorCol },
                    focus: { row: rowCount - 1, col: vc.index },
                    scroll: "none",
                  });
                }}
                role="columnheader"
              >
                {colLetters(vc.index)}
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                  onMouseDown={(e) => startResize(e, vc.index)}
                  onDoubleClick={() => autoFit(vc.index)}
                  title="Drag to resize; double-click to fit"
                />
              </div>
            );
          })}
        </div>
        {/* Row headers */}
        <div className="sticky left-0 z-10 bg-muted" style={{ width: HEADER_W }}>
          {vRows.map((vr) => {
            const selected = vr.index >= range.r0 && vr.index <= range.r1;
            return (
              <div
                key={vr.key}
                className={cn(
                  "absolute left-0 flex w-full items-center justify-center border-b border-r border-border text-xs text-muted-foreground",
                  selected && "bg-primary/15 font-semibold text-foreground",
                )}
                style={{ top: vr.start, height: vr.size }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  gridRef.current?.focus({ preventScroll: true });
                  const anchorRow = e.shiftKey ? selection.anchor.row : vr.index;
                  // The active cell is the row's first; the view stays (scrolling
                  // to the selection's far end would jump to the last column).
                  onSelect({
                    anchor: { row: anchorRow, col: 0 },
                    focus: { row: vr.index, col: colCount - 1 },
                    scroll: "none",
                  });
                }}
                role="rowheader"
              >
                {vr.index + 1}
              </div>
            );
          })}
        </div>
        {/* Cells */}
        <div
          className="relative"
          onMouseDown={onMouseDown}
          onDoubleClick={(e) => {
            const hit = cellAt(e.clientX, e.clientY);
            if (!hit) return;
            const text = editText(engine.getInput(tabId, hit.row, hit.col));
            onEditChange({ row: hit.row, col: hit.col, text, mode: "edit", caret: text.length });
          }}
          onContextMenu={(e) => {
            const hit = cellAt(e.clientX, e.clientY);
            if (hit && props.onContextMenu) {
              if (
                !(
                  hit.row >= range.r0 &&
                  hit.row <= range.r1 &&
                  hit.col >= range.c0 &&
                  hit.col <= range.c1
                )
              ) {
                onSelect({ anchor: hit, focus: hit });
              }
              props.onContextMenu(e, hit.row, hit.col);
            }
          }}
        >
          {cellNodes}
          {/* Grid lines, drawn once as a background instead of per cell */}
          <GridLines vRows={vRows} vCols={vCols} />
          {/* Text that runs on into empty cells covers their grid lines, as in Excel */}
          {overflowNodes}
          {/* Selection */}
          <div
            className="pointer-events-none absolute border-2 border-primary bg-primary/5"
            style={boxStyle(range)}
            data-testid="selection-box"
          />
          {/* Active cell */}
          <div
            className="pointer-events-none absolute border-2 border-primary"
            style={boxStyle({ r0: active.row, c0: active.col, r1: active.row, c1: active.col })}
          />
          {/* Fill handle */}
          {!editing && (
            <div
              className="absolute z-10 h-2 w-2 cursor-crosshair border border-background bg-primary"
              style={{
                left: offsets[range.c1 + 1] - 4,
                top: (range.r1 + 1) * ROW_H - 4,
              }}
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
              style={boxStyle(fillPreview)}
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
              left: offsets[active.col] ?? 0,
              top: active.row * ROW_H,
              width: 1,
              height: ROW_H,
            }}
            tabIndex={0}
            spellCheck={false}
            autoComplete="off"
            onInput={(e) => {
              const el = e.currentTarget;
              if ((e.nativeEvent as InputEvent).isComposing) return;
              const text = el.value;
              el.value = "";
              if (text) onType(text);
            }}
            onCompositionEnd={(e) => {
              const el = e.currentTarget;
              const text = e.data || el.value;
              el.value = "";
              if (text) onType(text);
            }}
          />
          {/* In-cell editor */}
          {editing && (
            <input
              ref={(el) => {
                cellEditorRef.current = el;
                if (el && editing.source !== "bar") editorRef.current = el;
              }}
              aria-label={`Editing ${a1(editing.row, editing.col)}`}
              data-testid="cell-editor"
              className="absolute z-20 border-2 border-primary bg-background px-1.5 text-[13px] outline-none"
              style={{
                left: offsets[editing.col],
                top: editing.row * ROW_H,
                minWidth: width(editing.col),
                width: Math.max(width(editing.col), editing.text.length * 7.5 + 20),
                height: ROW_H,
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

function GridLines({
  vRows,
  vCols,
}: {
  vRows: { start: number; size: number; index: number }[];
  vCols: { start: number; size: number; index: number }[];
}) {
  if (!vRows.length || !vCols.length) return null;
  const top = vRows[0].start;
  const bottom = vRows[vRows.length - 1].start + vRows[vRows.length - 1].size;
  const left = vCols[0].start;
  const right = vCols[vCols.length - 1].start + vCols[vCols.length - 1].size;
  return (
    <svg
      className="pointer-events-none absolute"
      style={{ left, top, width: right - left, height: bottom - top }}
      aria-hidden
    >
      {vRows.map((vr) => (
        <line
          key={`r${vr.index}`}
          x1={0}
          x2={right - left}
          y1={vr.start + vr.size - top - 0.5}
          y2={vr.start + vr.size - top - 0.5}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}
      {vCols.map((vc) => (
        <line
          key={`c${vc.index}`}
          y1={0}
          y2={bottom - top}
          x1={vc.start + vc.size - left - 0.5}
          x2={vc.start + vc.size - left - 0.5}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}
