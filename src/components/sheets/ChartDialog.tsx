// Insert → Chart (and a chart's Edit): the type, drawn from the chosen range
// as a live preview, and the options Excel's chart elements offer (title,
// series by rows or columns, stacking, legend, data labels, axis titles).

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseRangeA1 } from "@/lib/sheets/a1";
import { CHART_TYPES, chartData, type ChartDef, type ChartType } from "@/lib/sheets/charts";
import type { Scalar } from "@/lib/sheets/formula/values";
import { cn } from "@/lib/utils";
import { SheetChart } from "./SheetChart";

const select = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

export type ChartOptions = Omit<ChartDef, "id" | "x" | "y" | "w" | "h">;

export function ChartDialog({
  initial,
  editing,
  value,
  display,
  onCancel,
  onApply,
}: {
  initial: ChartOptions;
  /** Editing an existing chart (the button says Save) rather than inserting one. */
  editing?: boolean;
  value: (row: number, col: number) => Scalar;
  display: (row: number, col: number) => string;
  onCancel: () => void;
  onApply: (o: ChartOptions) => void;
}) {
  const [o, setO] = useState<ChartOptions>(initial);
  const [rangeText, setRangeText] = useState(initial.range);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<ChartOptions>) => setO((cur) => ({ ...cur, ...patch }));
  const validRange = parseRangeA1(rangeText.trim().toUpperCase().replace(/\$/g, ""));
  const live = validRange ? { ...o, range: rangeText.trim().toUpperCase().replace(/\$/g, "") } : o;
  const data = useMemo(
    () => chartData(live, value, display),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.range, live.type, live.seriesIn],
  );
  const stackable =
    o.type === "column" || o.type === "bar" || o.type === "area" || o.type === "line";
  const axes = o.type !== "pie" && o.type !== "doughnut" && o.type !== "radar";

  const apply = () => {
    if (!validRange) return setProblem(`"${rangeText}" is not a range such as A1:D13`);
    if (data.problem) return setProblem(data.problem);
    onApply({ ...o, range: live.range, title: o.title?.trim() || undefined });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-3xl" data-testid="chart-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit chart" : "Insert chart"}</DialogTitle>
          <DialogDescription>
            A chart of cells on this sheet. It redraws as they change.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Chart type">
              {CHART_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  role="radio"
                  aria-checked={o.type === t.type}
                  title={t.hint}
                  data-testid={`chart-type-${t.type}`}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left text-xs",
                    o.type === t.type
                      ? "border-primary bg-primary/10 font-medium"
                      : "border-border hover:bg-muted",
                  )}
                  onClick={() => set({ type: t.type as ChartType })}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div
              className="h-64 rounded-md border border-border bg-background"
              data-testid="chart-preview"
            >
              <SheetChart def={{ ...live, id: "preview", x: 0, y: 0, w: 0, h: 0 }} data={data} />
            </div>
          </div>
          <form
            className="space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="chart-range">Data range</Label>
              <Input
                id="chart-range"
                className="h-8 font-mono text-xs"
                value={rangeText}
                onChange={(e) => {
                  setRangeText(e.target.value);
                  setProblem(null);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chart-title">Title</Label>
              <Input
                id="chart-title"
                className="h-8"
                value={o.title ?? ""}
                onChange={(e) => set({ title: e.target.value })}
                placeholder="Revenue by region"
              />
            </div>
            {o.type !== "scatter" && (
              <div className="space-y-1">
                <Label htmlFor="chart-series">Series</Label>
                <select
                  id="chart-series"
                  className={select}
                  value={o.seriesIn ?? "auto"}
                  onChange={(e) => set({ seriesIn: e.target.value as ChartOptions["seriesIn"] })}
                >
                  <option value="auto">As Excel reads the range</option>
                  <option value="cols">In columns</option>
                  <option value="rows">In rows</option>
                </select>
              </div>
            )}
            {stackable && (
              <div className="space-y-1">
                <Label htmlFor="chart-stack">Stacking</Label>
                <select
                  id="chart-stack"
                  className={select}
                  value={o.stacked ?? "none"}
                  onChange={(e) => set({ stacked: e.target.value as ChartOptions["stacked"] })}
                >
                  <option value="none">Side by side</option>
                  <option value="normal">Stacked</option>
                  <option value="percent">100% stacked</option>
                </select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="chart-legend">Legend</Label>
              <select
                id="chart-legend"
                className={select}
                value={o.legend ?? "bottom"}
                onChange={(e) => set({ legend: e.target.value as ChartOptions["legend"] })}
              >
                <option value="bottom">Bottom</option>
                <option value="top">Top</option>
                <option value="right">Right</option>
                <option value="none">None</option>
              </select>
            </div>
            {axes && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="chart-x">Horizontal axis title</Label>
                  <Input
                    id="chart-x"
                    className="h-8"
                    value={o.xTitle ?? ""}
                    onChange={(e) => set({ xTitle: e.target.value || undefined })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="chart-y">Vertical axis title</Label>
                  <Input
                    id="chart-y"
                    className="h-8"
                    value={o.yTitle ?? ""}
                    onChange={(e) => set({ yTitle: e.target.value || undefined })}
                  />
                </div>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!o.labels}
                onChange={(e) => set({ labels: e.target.checked || undefined })}
              />
              Data labels
            </label>
            {(o.type === "line" || o.type === "area" || o.type === "combo") && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!o.smooth}
                  onChange={(e) => set({ smooth: e.target.checked || undefined })}
                />
                Smooth lines
              </label>
            )}
            {problem && <p className="text-sm text-destructive">{problem}</p>}
            <DialogFooter className="pt-2">
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" data-testid="chart-apply">
                {editing ? "Save" : "Insert"}
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
