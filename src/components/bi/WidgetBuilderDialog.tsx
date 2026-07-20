// Manual chart-widget builder: pick a data source, write SQL, preview the
// result, configure the chart, add to the dashboard. Also used to edit an
// existing chart widget.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, Table2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BiChartRender, fmtBiNumber } from "@/components/bi/BiChartRender";
import { sourceFromKey, keyFromSource, type BiDataContext } from "@/components/bi/biDataContext";
import type { ChartSpec } from "@/lib/biAgent";
import { snapshotRows, type BiWidget } from "@/lib/biDashboards";
import type { QueryResult } from "@/lib/sqlEngine";
import { WAREHOUSE_LABELS } from "@/utils/warehouse/types";

type ChartType = ChartSpec["type"];

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "bar", label: "Bar chart" },
  { value: "line", label: "Line chart" },
  { value: "area", label: "Area chart" },
  { value: "pie", label: "Pie chart" },
  { value: "kpi", label: "KPI (single value)" },
  { value: "table", label: "Table" },
];

export function WidgetBuilderDialog({
  open,
  onOpenChange,
  ctx,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ctx: BiDataContext;
  /** Present when editing an existing chart widget. */
  initial?: BiWidget | null;
  onSubmit: (widget: BiWidget) => void;
}) {
  const [sourceKey, setSourceKey] = useState("local");
  const [sql, setSql] = useState("");
  const [title, setTitle] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [nameField, setNameField] = useState("");
  const [valueField, setValueField] = useState("");
  const [kpiLabel, setKpiLabel] = useState("");
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Reset / prefill whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      const key = keyFromSource(initial.source);
      setSourceKey(key);
      if (key !== "local") ctx.ensureSchema(key);
      setSql(initial.sql ?? "");
      setTitle(initial.title);
      const c = initial.chart ?? { type: "table" as const };
      setChartType(c.type);
      setXField("xField" in c ? c.xField : "");
      setYField("yField" in c ? c.yField : "");
      setNameField("nameField" in c ? c.nameField : "");
      setValueField("valueField" in c ? c.valueField : "");
      setKpiLabel(c.type === "kpi" ? (c.label ?? "") : "");
      setPreview(
        initial.rows && initial.columns
          ? {
              columns: initial.columns,
              rows: initial.rows,
              row_count: initial.rows.length,
              total_matched: initial.rows.length,
              capped: false,
              duration_ms: 0,
            }
          : null,
      );
    } else {
      setSourceKey("local");
      setSql("");
      setTitle("");
      setChartType("bar");
      setXField("");
      setYField("");
      setNameField("");
      setValueField("");
      setKpiLabel("");
      setPreview(null);
    }
    setRunError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tableNames = useMemo(() => {
    if (sourceKey === "local") return ctx.datasets.map((d) => d.name);
    const t = ctx.whTables[sourceKey];
    if (!t || t === "loading" || t === "error") return [];
    return t.map((x) => `${x.schema}.${x.name}`);
  }, [sourceKey, ctx.datasets, ctx.whTables]);

  const schemaLoading = sourceKey !== "local" && ctx.whTables[sourceKey] === "loading";

  async function runPreview() {
    if (!sql.trim()) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await ctx.runSql(sourceFromKey(sourceKey, ctx.warehouses), sql.trim());
      setPreview(res);
      // Sensible defaults for the chart config from the result shape.
      const firstString =
        res.columns.find((c) => typeof res.rows[0]?.[c] === "string") ?? res.columns[0] ?? "";
      const firstNumber =
        res.columns.find((c) => typeof res.rows[0]?.[c] === "number") ??
        res.columns[1] ??
        res.columns[0] ??
        "";
      if (!xField || !res.columns.includes(xField)) setXField(firstString);
      if (!yField || !res.columns.includes(yField)) setYField(firstNumber);
      if (!nameField || !res.columns.includes(nameField)) setNameField(firstString);
      if (!valueField || !res.columns.includes(valueField)) setValueField(firstNumber);
      if (res.row_count === 1 && res.columns.length === 1 && !initial) setChartType("kpi");
    } catch (e) {
      setPreview(null);
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const chartSpec: ChartSpec | null = useMemo(() => {
    switch (chartType) {
      case "table":
        return { type: "table" };
      case "kpi":
        return valueField ? { type: "kpi", valueField, label: kpiLabel || undefined } : null;
      case "pie":
        return nameField && valueField ? { type: "pie", nameField, valueField } : null;
      default:
        return xField && yField ? { type: chartType, xField, yField } : null;
    }
  }, [chartType, xField, yField, nameField, valueField, kpiLabel]);

  const canSubmit = Boolean(title.trim() && sql.trim() && preview && chartSpec);

  function submit() {
    if (!canSubmit || !preview || !chartSpec) return;
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      kind: "chart",
      title: title.trim(),
      source: sourceFromKey(sourceKey, ctx.warehouses),
      sql: sql.trim(),
      chart: chartSpec,
      columns: preview.columns,
      rows: snapshotRows(preview.rows),
      narrative: initial?.narrative,
      refreshed_at: new Date().toISOString(),
    });
    onOpenChange(false);
    toast.success(initial ? "Widget updated" : "Widget added to the dashboard");
  }

  const fieldSelect = (label: string, value: string, setter: (v: string) => void) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value || undefined} onValueChange={setter}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Pick a column" />
        </SelectTrigger>
        <SelectContent>
          {(preview?.columns ?? []).map((c) => (
            <SelectItem key={c} value={c} className="text-xs">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit chart widget" : "Add chart from your data"}</DialogTitle>
          <DialogDescription>
            Write a read-only SQL query against a connected source, preview it, then choose how to
            visualise it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Data source</Label>
            <Select
              value={sourceKey}
              onValueChange={(v) => {
                setSourceKey(v);
                setPreview(null);
                if (v !== "local") ctx.ensureSchema(v);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local" className="text-xs">
                  Local datasets (Data &amp; SQL)
                </SelectItem>
                {ctx.warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id} className="text-xs">
                    {w.name} — {WAREHOUSE_LABELS[w.provider]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Widget title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Revenue by month"
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">SQL (SELECT only)</Label>
            {schemaLoading && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> loading tables…
              </span>
            )}
          </div>
          <Textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={4}
            className="font-mono text-xs"
            placeholder="SELECT category, SUM(amount) AS total FROM my_table GROUP BY category"
          />
          {tableNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">Tables:</span>
              {tableNames.slice(0, 12).map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className="cursor-pointer font-mono text-[9px] hover:border-primary/60"
                  title="Click to use in the query"
                  onClick={() =>
                    setSql((s) => (s.trim() ? `${s} ${t}` : `SELECT * FROM ${t} LIMIT 50`))
                  }
                >
                  {t}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void runPreview()}
              disabled={running || !sql.trim()}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              Run preview
            </Button>
            {preview && (
              <span className="text-[10px] text-muted-foreground">
                {preview.row_count} rows · {preview.columns.length} columns
                {preview.capped ? " (truncated)" : ""}
              </span>
            )}
          </div>
          {runError && (
            <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {runError}
            </p>
          )}
        </div>

        {preview && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">Visualisation</Label>
                <Select value={chartType} onValueChange={(v) => setChartType(v as ChartType)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHART_TYPES.map((c) => (
                      <SelectItem key={c.value} value={c.value} className="text-xs">
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(chartType === "bar" || chartType === "line" || chartType === "area") && (
                <>
                  {fieldSelect("X axis", xField, setXField)}
                  {fieldSelect("Y axis (numeric)", yField, setYField)}
                </>
              )}
              {chartType === "pie" && (
                <>
                  {fieldSelect("Category", nameField, setNameField)}
                  {fieldSelect("Value (numeric)", valueField, setValueField)}
                </>
              )}
              {chartType === "kpi" && (
                <>
                  {fieldSelect("Value column", valueField, setValueField)}
                  <div className="space-y-1">
                    <Label className="text-xs">KPI label (optional)</Label>
                    <Input
                      value={kpiLabel}
                      onChange={(e) => setKpiLabel(e.target.value)}
                      className="h-8 text-xs"
                      placeholder="Total revenue"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="rounded-lg border border-border/60 bg-card p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Table2 className="h-3 w-3" /> Preview
              </p>
              {chartSpec && chartSpec.type !== "table" ? (
                <BiChartRender chart={chartSpec} rows={preview.rows} />
              ) : (
                <div className="max-h-56 overflow-auto rounded border border-border/50">
                  <table className="w-full text-left">
                    <thead>
                      <tr>
                        {preview.columns.map((c) => (
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
                      {preview.rows.slice(0, 20).map((row, i) => (
                        <tr key={i} className="border-t border-border/40">
                          {preview.columns.map((c) => (
                            <td key={c} className="px-2 py-1 font-mono text-[10px]">
                              {row[c] === null || row[c] === undefined
                                ? "null"
                                : typeof row[c] === "number"
                                  ? fmtBiNumber(row[c])
                                  : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {initial ? "Save widget" : "Add to dashboard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
