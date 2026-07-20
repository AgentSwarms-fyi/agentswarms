// Right-hand builder pane of the BI project editor. Two tabs:
//   Build — pick a source, multi-select tables (JOIN skeletons are seeded
//           with auto-detected join keys), write/run SQL, choose a visual
//           via icon picker, configure fields, add/save the widget.
//   AI    — the GenBI analyst (plan → SQL → execute → chart → narrative);
//           insert any answer as a widget.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AreaChart,
  BarChart2,
  BarChart3,
  BarChart4,
  BarChartHorizontal,
  CandlestickChart,
  Filter,
  Flame,
  Gauge,
  Grid3x3,
  Hash,
  LayoutGrid,
  LineChart,
  Loader2,
  Map as MapIcon,
  MapPin,
  PieChart,
  Play,
  Plus,
  ScatterChart,
  Send,
  Sparkles,
  Table2,
  X,
} from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { BiChatMessage } from "@/components/data-sql/BiChatMessage";
import { BiChartRender, fmtBiNumber } from "@/components/bi/BiChartRender";
import { keyFromSource, sourceFromKey, type BiDataContext } from "@/components/bi/biDataContext";
import { cn } from "@/lib/utils";
import { runBiTurn, type BiTurn, type ChartSpec } from "@/lib/biAgent";
import { snapshotRows, widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";
import type { QueryResult } from "@/lib/sqlEngine";
import { warehouseTablesAsDatasets } from "@/lib/warehouseClient";
import { WAREHOUSE_LABELS } from "@/utils/warehouse/types";

export type BuilderTab = "build" | "ai";

type ChartType = ChartSpec["type"];

const VIZ_TYPES: {
  value: ChartType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "bar", label: "Column", icon: BarChart3 },
  { value: "hbar", label: "Bar", icon: BarChartHorizontal },
  { value: "line", label: "Line", icon: LineChart },
  { value: "area", label: "Area", icon: AreaChart },
  { value: "combo", label: "Combo", icon: BarChart2 },
  { value: "scatter", label: "Scatter", icon: ScatterChart },
  { value: "pie", label: "Pie", icon: PieChart },
  { value: "funnel", label: "Funnel", icon: Filter },
  { value: "treemap", label: "Treemap", icon: LayoutGrid },
  { value: "heatmap", label: "Heatmap", icon: Flame },
  { value: "boxplot", label: "Box plot", icon: CandlestickChart },
  { value: "waterfall", label: "Waterfall", icon: BarChart4 },
  { value: "kpi", label: "KPI", icon: Hash },
  { value: "gauge", label: "Gauge", icon: Gauge },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
  { value: "map", label: "Map", icon: MapIcon },
  { value: "bubblemap", label: "Bubbles", icon: MapPin },
  { value: "table", label: "Table", icon: Table2 },
];

type SourceTable = { name: string; cols: string[] };

function detectJoinKey(a: string[], b: string[]): string | null {
  const setB = new Set(b.map((c) => c.toLowerCase()));
  const common = a.filter((c) => setB.has(c.toLowerCase()));
  return (
    common.find((c) => /_id$/i.test(c)) ?? common.find((c) => /^id$/i.test(c)) ?? common[0] ?? null
  );
}

function seedSql(tables: SourceTable[]): string {
  if (tables.length === 0) return "";
  if (tables.length === 1) return `SELECT *\nFROM ${tables[0].name}\nLIMIT 50`;
  const [first, ...rest] = tables;
  const lines = ["SELECT *", `FROM ${first.name}`];
  for (const t of rest) {
    const key = detectJoinKey(first.cols, t.cols);
    lines.push(
      key
        ? `JOIN ${t.name} ON ${first.name}.${key} = ${t.name}.${key}`
        : `JOIN ${t.name} ON ${first.name}.<join_key> = ${t.name}.<join_key>`,
    );
  }
  lines.push("LIMIT 50");
  return lines.join("\n");
}

export function BiBuilderPane({
  ctx,
  tab,
  onTabChange,
  initial,
  onSubmit,
  onInsertAi,
  onClose,
}: {
  ctx: BiDataContext;
  tab: BuilderTab;
  onTabChange: (t: BuilderTab) => void;
  /** Present when editing an existing chart widget (Build tab). */
  initial: BiWidget | null;
  onSubmit: (widget: BiWidget) => void;
  onInsertAi: (widget: BiWidget) => void;
  onClose: () => void;
}) {
  // Shared source across both tabs.
  const [sourceKey, setSourceKey] = useState("local");

  // ── Build tab state ─────────────────────────────────────────────────
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  const lastSeeded = useRef("");
  const [title, setTitle] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [nameField, setNameField] = useState("");
  const [valueField, setValueField] = useState("");
  const [kpiLabel, setKpiLabel] = useState("");
  const [lineField, setLineField] = useState("");
  const [sizeField, setSizeField] = useState("");
  const [rowField, setRowField] = useState("");
  const [colField, setColField] = useState("");
  const [locationField, setLocationField] = useState("");
  const [targetField, setTargetField] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // ── AI tab state ────────────────────────────────────────────────────
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<BiTurn[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [insertedIdx, setInsertedIdx] = useState<Set<number>>(new Set());
  const turnsScrollRef = useRef<HTMLDivElement>(null);

  // Prefill / reset the Build form when the edited widget changes.
  useEffect(() => {
    if (initial) {
      const key = keyFromSource(initial.source);
      setSourceKey(key);
      if (key !== "local") ctx.ensureSchema(key);
      setSql(initial.sql ?? "");
      setTitle(initial.title);
      const c = initial.chart ?? { type: "table" as const };
      setChartType(c.type);
      setXField("xField" in c ? c.xField : "");
      setYField(c.type === "combo" ? c.barField : "yField" in c ? c.yField : "");
      setNameField("nameField" in c ? c.nameField : "");
      setValueField("valueField" in c ? c.valueField : "");
      setKpiLabel("label" in c ? (c.label ?? "") : "");
      setLineField(c.type === "combo" ? c.lineField : "");
      setSizeField(c.type === "scatter" ? (c.sizeField ?? "") : "");
      setRowField(c.type === "matrix" ? c.rowField : "");
      setColField(c.type === "matrix" ? c.colField : "");
      setLocationField("locationField" in c ? c.locationField : "");
      setTargetField("targetField" in c ? (c.targetField ?? "") : "");
      setMaxInput(c.type === "gauge" && c.max !== undefined ? String(c.max) : "");
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
      onTabChange("build");
    } else {
      setSql("");
      lastSeeded.current = "";
      setTitle("");
      setChartType("bar");
      setXField("");
      setYField("");
      setNameField("");
      setValueField("");
      setKpiLabel("");
      setLineField("");
      setSizeField("");
      setRowField("");
      setColField("");
      setLocationField("");
      setTargetField("");
      setMaxInput("");
      setPreview(null);
    }
    setSelectedTables([]);
    setRunError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => {
    turnsScrollRef.current?.scrollTo({
      top: turnsScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  const sourceTables: SourceTable[] = useMemo(() => {
    if (sourceKey === "local") {
      return ctx.datasets.map((d) => ({ name: d.name, cols: d.columns.map((c) => c.name) }));
    }
    const t = ctx.whTables[sourceKey];
    if (!t || t === "loading" || t === "error") return [];
    return t.map((x) => ({
      name: `${x.schema}.${x.name}`,
      cols: x.columns.map((c) => c.name),
    }));
  }, [sourceKey, ctx.datasets, ctx.whTables]);

  const schemaLoading =
    sourceKey !== "local" &&
    (ctx.whTables[sourceKey] === "loading" || ctx.whTables[sourceKey] === undefined);

  function changeSource(v: string) {
    setSourceKey(v);
    setSelectedTables([]);
    setPreview(null);
    if (sql === lastSeeded.current) {
      setSql("");
      lastSeeded.current = "";
    }
    if (v !== "local") ctx.ensureSchema(v);
  }

  function toggleTable(name: string) {
    const next = selectedTables.includes(name)
      ? selectedTables.filter((t) => t !== name)
      : [...selectedTables, name];
    setSelectedTables(next);
    // Only auto-write the query while the user hasn't typed their own SQL.
    if (!sql.trim() || sql === lastSeeded.current) {
      const seeded = seedSql(
        next
          .map((n) => sourceTables.find((t) => t.name === n))
          .filter((t): t is SourceTable => Boolean(t)),
      );
      setSql(seeded);
      lastSeeded.current = seeded;
    }
  }

  async function runPreview() {
    if (!sql.trim()) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await ctx.runSql(sourceFromKey(sourceKey, ctx.warehouses), sql.trim());
      setPreview(res);
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
      const numericCols = res.columns.filter((c) => typeof res.rows[0]?.[c] === "number");
      const stringCols = res.columns.filter((c) => typeof res.rows[0]?.[c] === "string");
      if (!lineField || !res.columns.includes(lineField)) {
        setLineField(numericCols.find((c) => c !== firstNumber) ?? firstNumber);
      }
      if (!locationField || !res.columns.includes(locationField)) setLocationField(firstString);
      if (!rowField || !res.columns.includes(rowField)) setRowField(firstString);
      if (!colField || !res.columns.includes(colField)) {
        setColField(stringCols.find((c) => c !== firstString) ?? firstString);
      }
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
        return valueField
          ? {
              type: "kpi",
              valueField,
              label: kpiLabel || undefined,
              targetField: targetField || undefined,
            }
          : null;
      case "gauge": {
        const max = maxInput.trim() ? Number(maxInput) : undefined;
        return valueField
          ? {
              type: "gauge",
              valueField,
              label: kpiLabel || undefined,
              targetField: targetField || undefined,
              max: max !== undefined && Number.isFinite(max) ? max : undefined,
            }
          : null;
      }
      case "pie":
      case "funnel":
      case "treemap":
        return nameField && valueField ? { type: chartType, nameField, valueField } : null;
      case "combo":
        return xField && yField && lineField
          ? { type: "combo", xField, barField: yField, lineField }
          : null;
      case "scatter":
        return xField && yField
          ? { type: "scatter", xField, yField, sizeField: sizeField || undefined }
          : null;
      case "heatmap":
        return xField && yField && valueField
          ? { type: "heatmap", xField, yField, valueField }
          : null;
      case "matrix":
        return rowField && colField && valueField
          ? { type: "matrix", rowField, colField, valueField }
          : null;
      case "map":
      case "bubblemap":
        return locationField && valueField ? { type: chartType, locationField, valueField } : null;
      default:
        return xField && yField ? { type: chartType, xField, yField } : null;
    }
  }, [
    chartType,
    xField,
    yField,
    nameField,
    valueField,
    kpiLabel,
    lineField,
    sizeField,
    rowField,
    colField,
    locationField,
    targetField,
    maxInput,
  ]);

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
    toast.success(initial ? "Widget updated" : "Widget added to the dashboard");
  }

  // ── AI analyst ──────────────────────────────────────────────────────
  const activeWarehouse =
    sourceKey !== "local" ? (ctx.warehouses.find((w) => w.id === sourceKey) ?? null) : null;

  const aiDatasets = useMemo(() => {
    if (!activeWarehouse) return ctx.datasets;
    const tables = ctx.whTables[activeWarehouse.id];
    if (!tables || tables === "loading" || tables === "error") return [];
    return warehouseTablesAsDatasets(activeWarehouse.id, tables, ctx.userId);
  }, [activeWarehouse, ctx.datasets, ctx.whTables, ctx.userId]);

  async function sendQuestion() {
    const q = question.trim();
    if (!q || aiBusy) return;
    if (aiDatasets.length === 0) {
      toast.error(
        activeWarehouse
          ? "The warehouse schema hasn't loaded yet."
          : "No local datasets — upload data on the Data & SQL page first.",
      );
      return;
    }
    setQuestion("");
    setAiBusy(true);
    setTurns((prev) => [...prev, { question: q, status: "planning" }]);
    try {
      await runBiTurn({
        question: q,
        datasets: aiDatasets,
        semantics: activeWarehouse ? new Map() : ctx.semantics,
        metrics: activeWarehouse ? [] : ctx.metrics,
        execute: activeWarehouse
          ? (generated) => ctx.runSql(sourceFromKey(activeWarehouse.id, ctx.warehouses), generated)
          : undefined,
        dialect: activeWarehouse ? WAREHOUSE_LABELS[activeWarehouse.provider] : undefined,
        onUpdate: (turn) => {
          setTurns((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = turn;
            return copy;
          });
        },
      });
    } finally {
      setAiBusy(false);
    }
  }

  function insertTurn(turn: BiTurn, idx: number) {
    const widget = widgetFromBiTurn(turn, sourceFromKey(sourceKey, ctx.warehouses));
    if (!widget) return toast.error("This answer has no result to insert");
    onInsertAi(widget);
    setInsertedIdx((prev) => new Set(prev).add(idx));
    toast.success("Widget inserted into the dashboard");
  }

  const fieldSelect = (label: string, value: string, setter: (v: string) => void) => (
    <div className="space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
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

  const optionalFieldSelect = (label: string, value: string, setter: (v: string) => void) => (
    <div className="space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Select value={value || "__none__"} onValueChange={(v) => setter(v === "__none__" ? "" : v)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__" className="text-xs">
            None
          </SelectItem>
          {(preview?.columns ?? []).map((c) => (
            <SelectItem key={c} value={c} className="text-xs">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const sourceSelect = (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Data source
      </Label>
      <Select value={sourceKey} onValueChange={changeSource}>
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
  );

  return (
    <div className="flex w-[420px] shrink-0 flex-col border-l border-border bg-background">
      {/* Header + tab switch */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-1 rounded-md bg-muted p-0.5">
          <button
            type="button"
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs font-medium transition",
              tab === "build"
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onTabChange("build")}
          >
            Build a chart
          </button>
          <button
            type="button"
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs font-medium transition",
              tab === "ai"
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onTabChange("ai")}
          >
            <Sparkles className="h-3 w-3 text-primary" /> AI analyst
          </button>
        </div>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {tab === "build" ? (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {initial && (
              <Badge variant="secondary" className="text-[10px]">
                Editing “{initial.title}”
              </Badge>
            )}
            {sourceSelect}

            {/* Tables — above the SQL, multi-select for joins */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Tables — select one or more to join
                </Label>
                {schemaLoading && (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> loading…
                  </span>
                )}
              </div>
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1.5">
                {sourceTables.length === 0 && !schemaLoading && (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground">
                    No tables available for this source.
                  </p>
                )}
                {sourceTables.map((t) => {
                  const checked = selectedTables.includes(t.name);
                  return (
                    <div key={t.name} className="rounded px-1 py-0.5 hover:bg-muted/60">
                      <Label className="flex cursor-pointer items-center gap-2 py-0.5 font-mono text-[11px] font-normal">
                        <Checkbox checked={checked} onCheckedChange={() => toggleTable(t.name)} />
                        <span className="truncate">{t.name}</span>
                        {ctx.preparedTables?.has(t.name) && (
                          <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                            prep
                          </Badge>
                        )}
                      </Label>
                      {checked && (
                        <p
                          className="ml-6 truncate text-[9px] text-muted-foreground"
                          title={t.cols.join(", ")}
                        >
                          {t.cols.slice(0, 8).join(" · ")}
                          {t.cols.length > 8 ? ` · +${t.cols.length - 8} more` : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {selectedTables.length > 1 && (
                <p className="text-[10px] text-muted-foreground">
                  A JOIN skeleton was written below — adjust the join keys if needed.
                </p>
              )}
            </div>

            {/* SQL */}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                SQL (SELECT only)
              </Label>
              <Textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                rows={5}
                className="font-mono text-xs"
                placeholder="Select tables above, or write your own query"
              />
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
                  Run
                </Button>
                {preview && (
                  <span className="text-[10px] text-muted-foreground">
                    {preview.row_count} rows · {preview.columns.length} cols
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
                {/* Visualization — icon picker */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Visualisation
                  </Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {VIZ_TYPES.map((v) => (
                      <button
                        key={v.value}
                        type="button"
                        title={v.label}
                        onClick={() => setChartType(v.value)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[10px] font-medium transition",
                          chartType === v.value
                            ? "border-primary bg-primary/10 text-primary shadow-sm"
                            : "border-border/60 text-muted-foreground hover:border-primary/40 hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        <v.icon className="h-5 w-5" />
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {(chartType === "bar" ||
                    chartType === "hbar" ||
                    chartType === "line" ||
                    chartType === "area") && (
                    <>
                      {fieldSelect(chartType === "hbar" ? "Category" : "X axis", xField, setXField)}
                      {fieldSelect("Value (numeric)", yField, setYField)}
                    </>
                  )}
                  {chartType === "waterfall" && (
                    <>
                      {fieldSelect("Stage / step", xField, setXField)}
                      {fieldSelect("Change (+/- numeric)", yField, setYField)}
                    </>
                  )}
                  {chartType === "boxplot" && (
                    <>
                      {fieldSelect("Category", xField, setXField)}
                      {fieldSelect("Value (numeric)", yField, setYField)}
                    </>
                  )}
                  {(chartType === "pie" || chartType === "funnel" || chartType === "treemap") && (
                    <>
                      {fieldSelect(
                        chartType === "funnel" ? "Stage" : "Category",
                        nameField,
                        setNameField,
                      )}
                      {fieldSelect("Value (numeric)", valueField, setValueField)}
                    </>
                  )}
                  {chartType === "combo" && (
                    <>
                      {fieldSelect("X axis", xField, setXField)}
                      {fieldSelect("Bars (numeric)", yField, setYField)}
                      {fieldSelect("Line (numeric)", lineField, setLineField)}
                    </>
                  )}
                  {chartType === "scatter" && (
                    <>
                      {fieldSelect("X (numeric)", xField, setXField)}
                      {fieldSelect("Y (numeric)", yField, setYField)}
                      {optionalFieldSelect("Bubble size", sizeField, setSizeField)}
                    </>
                  )}
                  {chartType === "heatmap" && (
                    <>
                      {fieldSelect("Columns (X)", xField, setXField)}
                      {fieldSelect("Rows (Y)", yField, setYField)}
                      {fieldSelect("Value (numeric)", valueField, setValueField)}
                    </>
                  )}
                  {chartType === "matrix" && (
                    <>
                      {fieldSelect("Rows", rowField, setRowField)}
                      {fieldSelect("Columns", colField, setColField)}
                      {fieldSelect("Value (numeric)", valueField, setValueField)}
                    </>
                  )}
                  {(chartType === "map" || chartType === "bubblemap") && (
                    <>
                      {fieldSelect("Location (country)", locationField, setLocationField)}
                      {fieldSelect("Value (numeric)", valueField, setValueField)}
                    </>
                  )}
                  {(chartType === "kpi" || chartType === "gauge") && (
                    <>
                      {fieldSelect("Value column", valueField, setValueField)}
                      {optionalFieldSelect("Target column", targetField, setTargetField)}
                      {chartType === "gauge" && (
                        <div className="space-y-1">
                          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Max (optional)
                          </Label>
                          <Input
                            value={maxInput}
                            onChange={(e) => setMaxInput(e.target.value)}
                            className="h-8 text-xs"
                            placeholder="auto"
                            inputMode="decimal"
                          />
                        </div>
                      )}
                      <div className="space-y-1">
                        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Label
                        </Label>
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
                {(chartType === "map" || chartType === "bubblemap") && (
                  <p className="text-[10px] text-muted-foreground">
                    Locations are matched to countries by name or common shorthand (USA, UK…).
                    Unmatched rows are counted on the map.
                  </p>
                )}

                {/* Preview */}
                <div className="rounded-lg border border-border/60 bg-card p-2">
                  {chartSpec && chartSpec.type !== "table" ? (
                    <BiChartRender chart={chartSpec} rows={preview.rows} />
                  ) : (
                    <div className="max-h-48 overflow-auto rounded border border-border/50">
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
          </div>
          <div className="border-t border-border p-3">
            <Button className="w-full gap-1.5" onClick={submit} disabled={!canSubmit}>
              <Plus className="h-4 w-4" />
              {initial ? "Save widget" : "Add to dashboard"}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 p-3 pb-2">
            {sourceSelect}
            {schemaLoading && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> loading schema…
              </span>
            )}
          </div>
          <div
            ref={turnsScrollRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-border/50 bg-muted/20 p-3"
          >
            {turns.length === 0 && (
              <p className="py-10 text-center text-xs text-muted-foreground">
                Ask a business question — the analyst writes and runs the SQL, picks a chart, and
                explains the result. Insert any answer as a widget.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className="space-y-1.5">
                <BiChatMessage turn={t} />
                {t.status === "done" && t.result && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      variant={insertedIdx.has(i) ? "secondary" : "default"}
                      onClick={() => insertTurn(t, i)}
                    >
                      <Plus className="h-3 w-3" />
                      {insertedIdx.has(i) ? "Insert again" : "Insert into dashboard"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-1.5 border-t border-border p-3">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendQuestion();
                }
              }}
              placeholder="Ask a business question…"
              className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-xs focus:border-primary focus:outline-none"
              disabled={aiBusy}
            />
            <Button
              size="icon"
              className="h-9 w-9"
              onClick={() => void sendQuestion()}
              disabled={aiBusy || !question.trim() || schemaLoading}
            >
              {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
