// A chart floating over the grid, as in Excel: drag it by its frame to move
// it, drag the corner to resize it; Edit and Delete sit on its frame, and
// Delete (the key) removes it while it has the keyboard.

import { useEffect, useRef, useState } from "react";
import { GripHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ChartData, ChartDef } from "@/lib/sheets/charts";
import { cn } from "@/lib/utils";
import { SheetChart } from "./SheetChart";

const MIN_W = 200;
const MIN_H = 140;

export function ChartFrame({
  def,
  data,
  zoom,
  onChange,
  onEdit,
  onDelete,
}: {
  def: ChartDef;
  data: ChartData;
  zoom: number;
  /** A move or resize, in 100%-zoom pixels, when the drag ends. */
  onChange: (box: Pick<ChartDef, "x" | "y" | "w" | "h">) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [drag, setDrag] = useState<Pick<ChartDef, "x" | "y" | "w" | "h"> | null>(null);
  const start = useRef<{
    px: number;
    py: number;
    box: Pick<ChartDef, "x" | "y" | "w" | "h">;
  } | null>(null);
  const box = drag ?? { x: def.x, y: def.y, w: def.w, h: def.h };

  // A drag follows the pointer anywhere on the page, and ends where it is let go.
  const [mode, setMode] = useState<"move" | "resize" | null>(null);
  useEffect(() => {
    if (!mode) return;
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = (e.clientX - s.px) / zoom;
      const dy = (e.clientY - s.py) / zoom;
      setDrag(
        mode === "move"
          ? {
              ...s.box,
              x: Math.max(0, Math.round(s.box.x + dx)),
              y: Math.max(0, Math.round(s.box.y + dy)),
            }
          : {
              ...s.box,
              w: Math.max(MIN_W, Math.round(s.box.w + dx)),
              h: Math.max(MIN_H, Math.round(s.box.h + dy)),
            },
      );
    };
    const up = () => {
      setMode(null);
      setDrag((d) => {
        if (d && (d.x !== def.x || d.y !== def.y || d.w !== def.w || d.h !== def.h)) onChange(d);
        return null;
      });
      start.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [mode, zoom, def.x, def.y, def.w, def.h, onChange]);

  const begin = (m: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    start.current = {
      px: e.clientX,
      py: e.clientY,
      box: { x: def.x, y: def.y, w: def.w, h: def.h },
    };
    setMode(m);
  };

  return (
    <div
      role="figure"
      aria-label={def.title ? `Chart: ${def.title}` : `${def.type} chart of ${def.range}`}
      tabIndex={0}
      data-testid="sheet-chart"
      data-chart-id={def.id}
      className={cn(
        "group absolute z-20 flex flex-col overflow-hidden rounded-md border border-border bg-background shadow-md outline-none focus-visible:ring-2 focus-visible:ring-primary",
        mode && "ring-2 ring-primary",
      )}
      style={{ left: box.x * zoom, top: box.y * zoom, width: box.w * zoom, height: box.h * zoom }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDelete();
        } else if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      <div
        className="flex h-6 shrink-0 cursor-move items-center gap-1 border-b border-transparent px-1 text-muted-foreground opacity-0 transition-opacity group-hover:border-border group-hover:opacity-100 group-focus-within:opacity-100"
        onPointerDown={begin("move")}
        title="Drag to move"
        data-testid="chart-move"
      >
        <GripHorizontal className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate text-[11px]">{def.range}</span>
        <button
          type="button"
          className="rounded p-0.5 hover:bg-muted hover:text-foreground"
          aria-label="Edit chart"
          title="Edit chart"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onEdit}
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 hover:bg-muted hover:text-destructive"
          aria-label="Delete chart"
          title="Delete chart"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <SheetChart def={def} data={data} />
      </div>
      <div
        className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize opacity-0 group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(135deg, transparent 50%, var(--muted-foreground) 50%, var(--muted-foreground) 60%, transparent 60%, transparent 75%, var(--muted-foreground) 75%)",
        }}
        onPointerDown={begin("resize")}
        aria-hidden
        data-testid="chart-resize"
      />
    </div>
  );
}
