// Charts on a grid sheet, for the editor: Insert → Chart over the selection
// (or the data around the active cell), the charts drawn over the grid and
// redrawn from the cells on every recalculation, and moving, resizing,
// editing and deleting them, each undoable.

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { parseRangeA1, rangeA1, type RangeAddr } from "@/lib/sheets/a1";
import { cellView } from "@/lib/sheets/cellView";
import { chartData, type ChartDef } from "@/lib/sheets/charts";
import type { GridData, WorkbookEngine } from "@/lib/sheets/engine";
import { currentRegion } from "@/lib/sheets/filter";
import { ChartDialog, type ChartOptions } from "./ChartDialog";
import { ChartFrame } from "./ChartFrame";
import { DEFAULT_COL_W, ROW_H, type GridGeometry } from "./SheetGrid";
import type { useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

const newId = () => Math.random().toString(36).slice(2, 10);

export function useSheetCharts({
  wb,
  engine,
  tabId,
  grid,
  range,
  onDone,
}: {
  wb: Workbook;
  engine: WorkbookEngine | null;
  tabId: string | null;
  grid: GridData | undefined;
  range: RangeAddr;
  onDone: () => void;
}) {
  const [dialog, setDialog] = useState<{ id?: string; initial: ChartOptions } | null>(null);
  const charts = grid?.charts ?? [];

  const value = (r: number, c: number) => (engine && tabId ? engine.getValue(tabId, r, c) : null);
  const display = (r: number, c: number) =>
    engine && tabId
      ? cellView(engine.getValue(tabId, r, c), engine.getInput(tabId, r, c)).text
      : "";

  const setCharts = (next: ChartDef[]) => {
    if (!tabId) return;
    wb.setGridMeta(tabId, { charts: next.length ? next : undefined });
  };

  /** Insert → Chart: the selection, or the block of data around the active cell. */
  const openInsert = () => {
    if (!engine || !tabId) return;
    const single = range.r0 === range.r1 && range.c0 === range.c1;
    const block = single
      ? currentRegion(range.r0, range.c0, (r, c) => engine.getValue(tabId, r, c) !== null)
      : range;
    if (
      block.r0 === block.r1 &&
      block.c0 === block.c1 &&
      engine.getValue(tabId, block.r0, block.c0) === null
    ) {
      toast.error("Select the data to chart first (a header row and the numbers under it).");
      onDone();
      return;
    }
    setDialog({ initial: { type: "column", range: rangeA1(block), legend: "bottom" } });
  };

  const apply = (o: ChartOptions) => {
    if (!dialog || !engine || !tabId) return;
    if (dialog.id) {
      setCharts(charts.map((c) => (c.id === dialog.id ? { ...c, ...o } : c)));
      toast.success("Chart updated");
    } else {
      // Beside the data, as Excel places a new chart.
      const r = parseRangeA1(o.range) ?? range;
      let x = 0;
      for (let c = 0; c <= r.c1; c++) x += grid?.colWidths?.[String(c)] ?? DEFAULT_COL_W;
      let y = 0;
      for (let row = 0; row < r.r0; row++) y += grid?.rowHeights?.[String(row)] ?? ROW_H;
      setCharts([...charts, { id: newId(), ...o, x: x + 24, y, w: 480, h: 300 }]);
      toast.success("Chart inserted");
    }
    setDialog(null);
    onDone();
  };

  const ribbon = (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 gap-1 px-2 text-xs"
      data-testid="tool-chart"
      title="Insert a chart of the selection"
      onMouseDown={(e) => e.preventDefault()}
      onClick={openInsert}
    >
      <BarChart3 className="h-4 w-4" /> Chart
    </Button>
  );

  const overlay = (geo: GridGeometry) =>
    charts.length ? (
      <>
        {charts.map((def) => (
          <ChartFrame
            key={def.id}
            def={def}
            data={chartData(def, value, display)}
            zoom={geo.zoom}
            onChange={(box) =>
              setCharts(charts.map((c) => (c.id === def.id ? { ...c, ...box } : c)))
            }
            onEdit={() => {
              // The options, without the chart's place on the sheet.
              const o: Partial<ChartDef> = { ...def };
              delete o.id;
              delete o.x;
              delete o.y;
              delete o.w;
              delete o.h;
              setDialog({ id: def.id, initial: o as ChartOptions });
            }}
            onDelete={() => {
              setCharts(charts.filter((c) => c.id !== def.id));
              toast.success("Chart deleted (Ctrl+Z brings it back)");
              onDone();
            }}
          />
        ))}
      </>
    ) : null;

  const dialogs = dialog ? (
    <ChartDialog
      initial={dialog.initial}
      editing={!!dialog.id}
      value={value}
      display={display}
      onCancel={() => {
        setDialog(null);
        onDone();
      }}
      onApply={apply}
    />
  ) : null;

  return { ribbon, overlay, dialogs, openInsert };
}
