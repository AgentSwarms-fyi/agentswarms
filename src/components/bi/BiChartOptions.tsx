// The three option editors that sit below the field pickers in the chart
// builder: drill hierarchy, time intelligence, and the reference line.
//
// Grouped in one file because each is small and they are the same kind of
// thing — extra options for a subset of chart types. Which chart types each
// applies to stays in BiBuilderPane, so that file still reads as a list of
// what appears when; these render unconditionally once shown.
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChartType } from "@/components/bi/BiVizPicker";

/** Category drill-down levels, top to detail. */
export function BiDrillHierarchy({
  drillList,
  setDrillList,
  columns,
}: {
  drillList: string[];
  setDrillList: (v: string[]) => void;
  columns: string[];
}) {
  return (
    <div className="col-span-2 space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Drill hierarchy (top → detail)
      </Label>
      <div className="flex flex-wrap items-center gap-1">
        {drillList.map((f, i) => (
          <Badge key={f} variant="secondary" className="gap-1 px-1.5 text-[10px]">
            {i + 1}. {f}
            <button type="button" onClick={() => setDrillList(drillList.filter((x) => x !== f))}>
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
        <Select
          key={drillList.length}
          onValueChange={(v) => !drillList.includes(v) && setDrillList([...drillList, v])}
        >
          <SelectTrigger className="h-7 w-28 text-[10px]">
            <SelectValue placeholder="+ add level" />
          </SelectTrigger>
          <SelectContent>
            {columns
              .filter((c) => !drillList.includes(c))
              .map((c) => (
                <SelectItem key={c} value={c} className="text-xs">
                  {c}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-[9px] text-muted-foreground">
        Two or more levels enable click-to-drill (the query must include every level's column).
      </p>
    </div>
  );
}

/** Date grain, comparison, running total, trend and forecast (line/area). */
export function BiTimeSeriesOptions({
  chartType,
  seriesField,
  grainSel,
  setGrainSel,
  compareSel,
  setCompareSel,
  runningB,
  setRunningB,
  trendB,
  setTrendB,
  forecastN,
  setForecastN,
}: {
  chartType: ChartType;
  /** When set, the single-series calculations are hidden rather than disabled. */
  seriesField: string;
  grainSel: string;
  setGrainSel: (v: string) => void;
  compareSel: string;
  setCompareSel: (v: string) => void;
  runningB: boolean;
  setRunningB: (v: boolean) => void;
  trendB: boolean;
  setTrendB: (v: boolean) => void;
  forecastN: string;
  setForecastN: (v: string) => void;
}) {
  return (
    <>
      <>
        <div className="space-y-1">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Date grain
          </Label>
          <Select value={grainSel} onValueChange={setGrainSel}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["auto", "day", "week", "month", "quarter", "year"].map((g) => (
                <SelectItem key={g} value={g} className="text-xs">
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Running total, comparison, trend and forecast are
        single-series calculations — hidden while a series
        split is active so we never offer a toggle that the
        renderer can't apply. Date grain works either way. */}
        {seriesField ? (
          <p className="col-span-2 text-[10px] text-muted-foreground">
            Running total, compare, trend and forecast apply to single-series charts. Clear “Split
            by series” to use them.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Compare
              </Label>
              <Select value={compareSel} onValueChange={setCompareSel}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">
                    None
                  </SelectItem>
                  <SelectItem value="prior_period" className="text-xs">
                    Prior period
                  </SelectItem>
                  <SelectItem value="prior_year" className="text-xs">
                    Prior year
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-4">
              <Label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal">
                <Checkbox checked={runningB} onCheckedChange={(v) => setRunningB(Boolean(v))} />
                Running total
              </Label>
              {chartType === "line" && (
                <Label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal">
                  <Checkbox checked={trendB} onCheckedChange={(v) => setTrendB(Boolean(v))} />
                  Trend line
                </Label>
              )}
              {chartType === "line" && (
                <span className="flex items-center gap-1.5 text-xs">
                  Forecast
                  <Input
                    value={forecastN}
                    onChange={(e) => setForecastN(e.target.value)}
                    className="h-7 w-14 text-xs"
                    placeholder="0"
                    inputMode="numeric"
                  />
                  periods
                </span>
              )}
            </div>
          </>
        )}
      </>
    </>
  );
}

/** Horizontal reference line: none, series average, or a target value. */
export function BiRefLineOptions({
  refMode,
  setRefMode,
  refValue,
  setRefValue,
  refLabel,
  setRefLabel,
}: {
  refMode: string;
  setRefMode: (v: string) => void;
  refValue: string;
  setRefValue: (v: string) => void;
  refLabel: string;
  setRefLabel: (v: string) => void;
}) {
  return (
    <>
      <>
        <div className="space-y-1">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Reference line
          </Label>
          <Select value={refMode} onValueChange={setRefMode}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" className="text-xs">
                None
              </SelectItem>
              <SelectItem value="avg" className="text-xs">
                Average
              </SelectItem>
              <SelectItem value="value" className="text-xs">
                Target value
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {refMode === "value" && (
          <div className="space-y-1">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Target
            </Label>
            <Input
              value={refValue}
              onChange={(e) => setRefValue(e.target.value)}
              className="h-8 text-xs"
              inputMode="decimal"
              placeholder="e.g. 10000"
            />
          </div>
        )}
        {refMode !== "none" && (
          <div className="space-y-1">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Line label
            </Label>
            <Input
              value={refLabel}
              onChange={(e) => setRefLabel(e.target.value)}
              className="h-8 text-xs"
              placeholder="target"
            />
          </div>
        )}
      </>
    </>
  );
}
