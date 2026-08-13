// The builder's "Governed metrics (Semantic Layer)" source: pick a model,
// tick metrics and group-bys, preview through the governed compiler. No SQL
// is written or shown — the semantic layer writes it under the caller's own
// grants, which is the point.
//
// Extracted from BiBuilderPane the same way as its siblings: this component
// owns NO state (no hooks) — it receives the parent's values and setters, so
// hook order and effect timing in the pane are untouched.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { fmtBiValue } from "@/components/bi/BiChartRender";
import { coerceSemanticChart } from "@/lib/biDashboards";
import type { MetricModelOption } from "@/components/bi/biDataContext";
import type { TimeGrain } from "@/lib/semanticLayer";
import type { Dispatch, SetStateAction } from "react";

/** Time rollups offered per checked time dimension. */
const MM_GRAINS: readonly TimeGrain[] = ["day", "week", "month", "quarter", "year"];

export type MetricPreview = {
  columns: string[];
  rows: Record<string, unknown>[];
  sql: string;
  rollup?: string;
  /** Present when a share policy scoped the rows (see runMetric). */
  access_note?: string;
};

export function BiMetricSource({
  metricModels,
  reload,
  mmName,
  setMmName,
  mmMetrics,
  setMmMetrics,
  mmDims,
  setMmDims,
  mmGrains,
  setMmGrains,
  setMmPreview,
  chartType,
  mmRunning,
  runPreview,
  mmPreview,
  title,
  setTitle,
}: {
  metricModels: MetricModelOption[] | "loading" | "error" | null;
  /** Re-fetch the model list after a load error. */
  reload: () => void;
  mmName: string;
  setMmName: Dispatch<SetStateAction<string>>;
  mmMetrics: string[];
  setMmMetrics: Dispatch<SetStateAction<string[]>>;
  mmDims: string[];
  setMmDims: Dispatch<SetStateAction<string[]>>;
  mmGrains: Record<string, TimeGrain>;
  setMmGrains: Dispatch<SetStateAction<Record<string, TimeGrain>>>;
  /** Any pick change invalidates the previewed result. */
  setMmPreview: Dispatch<SetStateAction<MetricPreview | null>>;
  /** The visual picker's current chart type — for the coercion notice. */
  chartType: string;
  mmRunning: boolean;
  runPreview: () => void;
  mmPreview: MetricPreview | null;
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
}) {
  const mmModel = Array.isArray(metricModels)
    ? metricModels.find((m) => m.name === mmName)
    : undefined;

  function pickModel(name: string) {
    setMmName(name);
    setMmMetrics([]);
    setMmDims([]);
    setMmGrains({});
    setMmPreview(null);
  }

  function toggleMetric(name: string) {
    setMmMetrics((cur) => (cur.includes(name) ? cur.filter((m) => m !== name) : [...cur, name]));
    setMmPreview(null);
  }

  function toggleDim(name: string) {
    setMmDims((cur) => (cur.includes(name) ? cur.filter((d) => d !== name) : [...cur, name]));
    setMmGrains((cur) => {
      if (!(name in cur)) return cur;
      const next = { ...cur };
      delete next[name];
      return next;
    });
    setMmPreview(null);
  }

  if (metricModels === "loading") {
    return <p className="text-xs text-muted-foreground">Loading semantic models…</p>;
  }
  if (metricModels === "error") {
    return (
      <p className="text-xs text-destructive">
        Could not load semantic models.{" "}
        <button type="button" className="underline underline-offset-2" onClick={reload}>
          Retry
        </button>
      </p>
    );
  }
  if (!Array.isArray(metricModels) || metricModels.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No semantic models available yet. Define one under Semantic Layer, then pick its metrics
        here.
      </p>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Semantic model
        </Label>
        <Select value={mmName || undefined} onValueChange={pickModel}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Pick a model" />
          </SelectTrigger>
          <SelectContent>
            {metricModels.map((m) => (
              <SelectItem key={m.name} value={m.name} className="text-xs">
                {m.label ? `${m.label} (${m.name})` : m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mmModel && (
        <>
          {/* Same disclosure the runner shows: a grantee looking at scoped
              numbers should never have to guess that they are scoped. */}
          {mmModel.scoped && (
            <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-[10px] leading-relaxed">
              Shared with you under a <strong>restricted policy</strong> — every preview and
              inserted widget is your scoped view, not the global total.
            </p>
          )}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Metrics
            </Label>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {mmModel.metrics.map((m) => (
                <Label
                  key={m.name}
                  className="flex cursor-pointer items-center gap-2 text-xs font-normal normal-case tracking-normal text-foreground"
                >
                  <Checkbox
                    checked={mmMetrics.includes(m.name)}
                    onCheckedChange={() => toggleMetric(m.name)}
                  />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] uppercase text-muted-foreground">
                    {m.agg}
                  </span>
                </Label>
              ))}
              {mmModel.metrics.length === 0 && (
                <p className="text-[10px] text-muted-foreground">This model declares no metrics.</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Group by
            </Label>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {mmModel.dimensions.map((d) => (
                <div key={d.name} className="flex items-center gap-2">
                  <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-xs font-normal normal-case tracking-normal text-foreground">
                    <Checkbox
                      checked={mmDims.includes(d.name)}
                      onCheckedChange={() => toggleDim(d.name)}
                    />
                    <span className="truncate">{d.name}</span>
                  </Label>
                  {d.type === "time" && mmDims.includes(d.name) && (
                    <Select
                      value={mmGrains[d.name] ?? "raw"}
                      onValueChange={(v) => {
                        setMmGrains((cur) => {
                          const next = { ...cur };
                          if (v === "raw") delete next[d.name];
                          else next[d.name] = v as TimeGrain;
                          return next;
                        });
                        setMmPreview(null);
                      }}
                    >
                      <SelectTrigger className="h-6 w-24 shrink-0 text-[10px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="raw" className="text-xs">
                          raw
                        </SelectItem>
                        {MM_GRAINS.map((g) => (
                          <SelectItem key={g} value={g} className="text-xs">
                            by {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              ))}
              {mmModel.dimensions.length === 0 && (
                <p className="text-[10px] text-muted-foreground">
                  This model declares no dimensions.
                </p>
              )}
            </div>
          </div>

          {coerceSemanticChart(chartType) !== chartType && (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              The selected chart type is not available for governed metrics — this widget will
              insert as a table. Governed widgets support table, bar, line, area, KPI and pie.
            </p>
          )}

          <Button
            size="sm"
            variant="secondary"
            className="h-8 w-full gap-1.5 text-xs"
            onClick={runPreview}
            disabled={mmRunning || mmMetrics.length === 0}
          >
            {mmRunning ? "Running…" : "Preview"}
          </Button>

          {mmPreview && (
            <>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>
                  {mmPreview.rows.length} row{mmPreview.rows.length === 1 ? "" : "s"}
                </span>
                {mmPreview.rollup && (
                  <Badge variant="secondary" className="text-[10px]">
                    rollup: {mmPreview.rollup}
                  </Badge>
                )}
              </div>
              {mmPreview.access_note && (
                <p className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] leading-relaxed">
                  Restricted share — {mmPreview.access_note}. These numbers are your scoped view,
                  not the global total.
                </p>
              )}
              <div className="max-h-48 overflow-auto rounded border border-border/50">
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      {mmPreview.columns.map((c) => (
                        <th
                          key={c}
                          className="sticky top-0 bg-muted px-2 py-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mmPreview.rows.slice(0, 20).map((row, i) => (
                      <tr key={i} className="border-t border-border/40">
                        {mmPreview.columns.map((c) => (
                          <td key={c} className="px-2 py-1 font-mono text-[10px]">
                            {row[c] === null || row[c] === undefined
                              ? "null"
                              : typeof row[c] === "number"
                                ? fmtBiValue(row[c])
                                : String(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Widget title
                </Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Revenue by month"
                  className="h-8 text-xs"
                />
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
