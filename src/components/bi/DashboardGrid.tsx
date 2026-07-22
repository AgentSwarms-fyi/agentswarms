// 12-column dashboard grid with pointer-based drag-to-move and
// drag-to-resize. Purpose-built (no grid-layout dependency — the usual
// react-grid-layout stack relies on findDOMNode, removed in React 19).
// Live push-down while dragging, top-gravity compaction on release.
// Below STACK_BREAKPOINT the grid stacks into a single reading column
// (ordered top-left → bottom-right) so dashboards work on phones.
import { useEffect, useRef, useState } from "react";
import { GRID_COLS, compactLayout, pushDown, type BiLayoutItem } from "@/lib/biDashboards";

const ROW_H = 56;
const GAP = 12;
const STACK_BREAKPOINT = 560;

type DragState = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  orig: BiLayoutItem;
};

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function DashboardGrid({
  layout,
  editable,
  onLayoutChange,
  renderItem,
  emptyState,
}: {
  layout: BiLayoutItem[];
  editable: boolean;
  onLayoutChange?: (next: BiLayoutItem[]) => void;
  renderItem: (id: string) => React.ReactNode;
  emptyState?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [working, setWorking] = useState<BiLayoutItem[] | null>(null);
  const workingRef = useRef<BiLayoutItem[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const colW = width > 0 ? (width - GAP * (GRID_COLS - 1)) / GRID_COLS : 0;
  const items = working ?? layout;
  const totalRows = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);

  function toPx(it: BiLayoutItem) {
    return {
      left: it.x * (colW + GAP),
      top: it.y * (ROW_H + GAP),
      width: it.w * colW + (it.w - 1) * GAP,
      height: it.h * ROW_H + (it.h - 1) * GAP,
    };
  }

  function startDrag(e: React.PointerEvent, id: string, mode: "move" | "resize") {
    if (!editable || colW === 0) return;
    const orig = layout.find((l) => l.i === id);
    if (!orig) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, mode, startX: e.clientX, startY: e.clientY, orig: { ...orig } };
    setDraggingId(id);
  }

  function moveDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || colW === 0) return;
    const dx = Math.round((e.clientX - d.startX) / (colW + GAP));
    const dy = Math.round((e.clientY - d.startY) / (ROW_H + GAP));
    let next: BiLayoutItem;
    if (d.mode === "move") {
      next = {
        ...d.orig,
        x: clamp(d.orig.x + dx, 0, GRID_COLS - d.orig.w),
        y: Math.max(0, d.orig.y + dy),
      };
    } else {
      next = {
        ...d.orig,
        w: clamp(d.orig.w + dx, 2, GRID_COLS - d.orig.x),
        h: Math.max(2, d.orig.h + dy),
      };
    }
    const updated = pushDown(layout, next);
    workingRef.current = updated;
    setWorking(updated);
  }

  function endDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const finalLayout = workingRef.current;
    workingRef.current = null;
    setWorking(null);
    if (finalLayout && onLayoutChange) onLayoutChange(compactLayout(finalLayout));
  }

  if (layout.length === 0) {
    return <div ref={containerRef}>{emptyState ?? null}</div>;
  }

  // Mobile: one full-width column in reading order; drag/resize disabled
  // (layout edits need the 12-column canvas). Same container node keeps the
  // ResizeObserver alive across mode switches.
  if (width > 0 && width < STACK_BREAKPOINT) {
    const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
    return (
      <div ref={containerRef} className="flex w-full flex-col" style={{ gap: GAP }}>
        {ordered.map((it) => (
          <div
            key={it.i}
            data-widget-id={it.i}
            className="w-full"
            style={{ height: Math.max(it.h, 3) * ROW_H }}
          >
            {renderItem(it.i)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={{ height: totalRows * (ROW_H + GAP) - GAP }}
    >
      {/* Mount widgets only once the real width is measured: recharts'
          ResponsiveContainer gets stuck if it first observes a 0-width
          parent, leaving a tiny chart with a dead hover/tooltip area. */}
      {width > 0 &&
        items.map((it) => {
          const pos = toPx(it);
          const isDragging = draggingId === it.i;
          return (
            <div
              key={it.i}
              data-widget-id={it.i}
              className={`absolute ${
                isDragging ? "z-30 opacity-90 shadow-xl" : "z-0"
              } ${draggingId && !isDragging ? "transition-all duration-150" : ""}`}
              style={pos}
            >
              {editable && (
                <div
                  className="absolute inset-x-0 top-0 z-20 h-9 cursor-grab active:cursor-grabbing"
                  style={{ right: 72 }}
                  title="Drag to move"
                  onPointerDown={(e) => startDrag(e, it.i, "move")}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              )}
              <div className="h-full w-full">{renderItem(it.i)}</div>
              {editable && (
                <div
                  className="absolute bottom-0.5 right-0.5 z-20 h-4 w-4 cursor-nwse-resize rounded-sm border-b-2 border-r-2 border-muted-foreground/50 hover:border-primary"
                  title="Drag to resize"
                  onPointerDown={(e) => startDrag(e, it.i, "resize")}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              )}
            </div>
          );
        })}
    </div>
  );
}
