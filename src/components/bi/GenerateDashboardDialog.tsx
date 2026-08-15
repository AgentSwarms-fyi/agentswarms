// "Generate with AI" — analyze a table, propose visual widgets, let the
// user pick, then build. Two steps:
//   1. Analyze: pick ONE source table (+ optional focus). The analyst reads
//      the column structure and semantics and proposes 8-14 widgets that
//      maximize the variety of chart types the data supports, plus an
//      executive summary.
//   2. Review & generate: the user sees the summary and a checklist of
//      suggested visuals (chart-type icon, title, rationale), selects the
//      ones they want, and generates them through the existing GenBI
//      pipeline. The executive summary is added as a full-width text
//      widget at the top of the dashboard.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  Check,
  FastForward,
  Flower2,
  Gauge,
  Grid3x3,
  Layers,
  LayoutList,
  LineChart,
  Loader2,
  PieChart,
  Radar,
  Rows3,
  ScatterChart,
  ShieldCheck,
  Sparkles,
  Table2,
  Wand2,
  Workflow,
  X as XIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import type { BiDataContext } from "@/components/bi/biDataContext";
import { llmJson, runBiTurn, suggestDashboardWidgets, type WidgetSuggestion } from "@/lib/biAgent";
import { widgetFromBiTurn, widgetFromSemantic, type BiWidget } from "@/lib/biDashboards";
import type { MetricModelOption } from "@/components/bi/biDataContext";
import {
  suggestGovernedWidgets,
  toSemanticQuery,
  type RejectedGovernedWidget,
  type ValidGovernedWidget,
} from "@/lib/biGenerateSemantic";

/** Icon per proposed chart type, so the checklist reads at a glance. */
function ChartTypeIcon({ type }: { type: string }) {
  const cls = "h-3.5 w-3.5 text-primary";
  switch (type) {
    case "kpi":
      return <Gauge className={cls} />;
    case "gauge":
      return <Gauge className={cls} />;
    case "line":
    case "combo":
      return <LineChart className={cls} />;
    case "area":
      return <AreaChart className={cls} />;
    case "hbar":
      return <BarChartHorizontal className={cls} />;
    case "shbar":
      return <Rows3 className={cls} />;
    case "scolumn":
      return <Layers className={cls} />;
    case "barrace":
      return <FastForward className={cls} />;
    case "radar":
      return <Radar className={cls} />;
    case "nightingale":
      return <Flower2 className={cls} />;
    case "sankey":
      return <Workflow className={cls} />;
    case "pie":
    case "treemap":
    case "funnel":
      return <PieChart className={cls} />;
    case "scatter":
    case "boxplot":
      return <ScatterChart className={cls} />;
    case "heatmap":
    case "matrix":
      return <Grid3x3 className={cls} />;
    case "table":
      return <LayoutList className={cls} />;
    default:
      return <BarChart3 className={cls} />;
  }
}

type GenStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "error";
  error?: string;
};

export function GenerateDashboardDialog({
  open,
  onOpenChange,
  ctx,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ctx: BiDataContext;
  /** Finished widgets (≥1) plus the AI's dashboard title. */
  onDone: (widgets: BiWidget[], title: string) => void;
}) {
  const [phase, setPhase] = useState<"configure" | "review">("configure");
  // Which kind of source the dashboard is generated FROM. The choice is made
  // once, here, and decides whether every widget is governed — rather than
  // per widget, which would let an ungoverned chart hide among certified ones.
  const [sourceKind, setSourceKind] = useState<"table" | "semantic">("table");
  const [metricModels, setMetricModels] = useState<MetricModelOption[] | null>(null);
  const [modelName, setModelName] = useState("");
  /** Validated governed widgets, keyed by the id shown in the checklist. */
  const [governed, setGoverned] = useState<Map<string, ValidGovernedWidget>>(new Map());
  const [rejected, setRejected] = useState<RejectedGovernedWidget[]>([]);
  const [table, setTable] = useState("");
  const [focus, setFocus] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [suggestions, setSuggestions] = useState<WidgetSuggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<GenStep[]>([]);

  // Loaded lazily and only when offered: listMetricModels hits the server, and
  // most generates never touch the governed path.
  useEffect(() => {
    if (!open || !ctx.listMetricModels || metricModels !== null) return;
    ctx
      .listMetricModels()
      .then(setMetricModels)
      .catch(() => setMetricModels([]));
  }, [open, ctx, metricModels]);

  const selectedModel = metricModels?.find((m) => m.name === modelName) ?? metricModels?.[0];
  /** The governed source is offered only when the project actually wires it. */
  const canGovern = Boolean(ctx.listMetricModels && ctx.runMetric);

  const selectedTable = ctx.datasets.some((d) => d.name === table)
    ? table
    : (ctx.datasets[0]?.name ?? "");
  const scoped = ctx.datasets.filter((d) => d.name === selectedTable);
  const scopedMetrics =
    scoped.length > 0 ? ctx.metrics.filter((m) => m.table_id === scoped[0].id) : [];

  function reset() {
    setPhase("configure");
    setGoverned(new Map());
    setRejected([]);
    setFocus("");
    setSummary("");
    setSuggestions([]);
    setSelected(new Set());
    setSteps([]);
  }

  /** Plan a dashboard over a governed model: declared vocabulary in, widgets out. */
  async function analyzeGoverned() {
    if (!selectedModel) {
      return toast.error("No semantic models available — publish one in the Semantic Layer first.");
    }
    setAnalyzing(true);
    try {
      const res = await suggestGovernedWidgets({
        model: selectedModel,
        focus: focus.trim() || undefined,
        aiModel: ctx.model ?? undefined,
        llm: llmJson,
      });
      // Both halves are kept. A plan that proposed twelve and validated nine
      // must say which three it dropped and why — see biGenerateSemantic.ts.
      setRejected(res.plan.rejected);
      if (res.plan.widgets.length === 0) {
        throw new Error(
          res.plan.rejected.length > 0
            ? `Every proposed widget was rejected — first reason: ${res.plan.rejected[0].reason}`
            : "The model proposed no widgets — try adding a focus.",
        );
      }
      const map = new Map<string, ValidGovernedWidget>();
      const display: WidgetSuggestion[] = res.plan.widgets.map((w) => {
        const id = crypto.randomUUID();
        map.set(id, w);
        return {
          id,
          title: w.title,
          kind: "chart",
          chartType: w.chartType,
          // Governed widgets are compiled from a SemanticQuery, never from a
          // natural-language question — this field exists only for the raw path.
          question: "",
          rationale:
            w.rationale ||
            `${w.metrics.join(", ")}${w.dimensions.length ? ` by ${w.dimensions.join(", ")}` : ""}`,
        };
      });
      setGoverned(map);
      setTitle(res.title);
      setSummary(res.summary);
      setSuggestions(display);
      setSelected(new Set(display.map((d) => d.id)));
      setPhase("review");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function analyze() {
    if (sourceKind === "semantic") return analyzeGoverned();
    if (scoped.length === 0) {
      return toast.error("No local datasets — upload data on the Data & SQL page first.");
    }
    setAnalyzing(true);
    try {
      const res = await suggestDashboardWidgets({
        datasets: scoped,
        semantics: ctx.semantics,
        metrics: scopedMetrics,
        focus: focus.trim() || undefined,
        model: ctx.model ?? undefined,
      });
      if (res.suggestions.length === 0) {
        throw new Error("The model proposed no widgets — try adding a focus, or another table.");
      }
      setTitle(res.title);
      setSummary(res.summary);
      setSuggestions(res.suggestions);
      setSelected(new Set(res.suggestions.map((s) => s.id)));
      setPhase("review");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    const picks = suggestions.filter((s) => selected.has(s.id));
    if (picks.length === 0) return toast.error("Select at least one widget to generate");
    setGenerating(true);
    let progress: GenStep[] = picks.map((p) => ({ id: p.id, title: p.title, status: "pending" }));
    setSteps(progress);
    try {
      const widgets: BiWidget[] = [];
      for (let i = 0; i < picks.length; i++) {
        progress = progress.map((s, j) => (j === i ? { ...s, status: "running" } : s));
        setSteps(progress);
        let ok = false;
        let reason = "";
        try {
          // Non-data widgets the planner may propose: build them directly.
          if (picks[i].kind === "text" || picks[i].kind === "image") {
            const p = picks[i];
            const widget: BiWidget =
              p.kind === "image"
                ? {
                    id: crypto.randomUUID(),
                    kind: "image",
                    title: p.title || "Image",
                    image: { src: p.imageUrl ?? "", fit: "contain" },
                  }
                : {
                    id: crypto.randomUUID(),
                    kind: "text",
                    title: p.title || "Note",
                    text: p.content ?? "",
                  };
            widgets.push(widget);
            ok = true;
            progress = progress.map((s, j) => (j === i ? { ...s, status: "done" } : s));
            setSteps(progress);
            continue;
          }
          // ── Governed: the compiler writes the SQL, we never do ──
          const gov = governed.get(picks[i].id);
          if (gov && selectedModel && ctx.runMetric) {
            const res = await ctx.runMetric(toSemanticQuery(gov, selectedModel.name));
            if (res.rows.length === 0) {
              reason = "The governed query returned no rows";
            } else {
              const lead = selectedModel.metrics.find((m) => m.name === gov.metrics[0]);
              widgets.push(
                widgetFromSemantic({
                  title: gov.title,
                  model: selectedModel.name,
                  metrics: gov.metrics,
                  dimensions: gov.dimensions,
                  grains: gov.grains,
                  chartType: gov.chartType,
                  columns: res.columns,
                  rows: res.rows,
                  // The compiler's own SQL, kept on the widget so the number
                  // stays inspectable — and so refresh recompiles from the
                  // CURRENT model definition rather than replaying this text.
                  sql: res.sql,
                  format: lead?.format as "number" | "currency" | "percent" | undefined,
                  currency: lead?.currency,
                }),
              );
              ok = true;
            }
            progress = progress.map((st, j) =>
              j === i
                ? { ...st, status: ok ? "done" : "error", error: ok ? undefined : reason }
                : st,
            );
            setSteps(progress);
            continue;
          }

          const turn = await runBiTurn({
            question: picks[i].question,
            datasets: scoped,
            semantics: ctx.semantics,
            metrics: scopedMetrics,
            model: ctx.model ?? undefined,
            preferChart: picks[i].chartType || undefined,
            onUpdate: () => {},
          });
          const widget = widgetFromBiTurn(turn, { kind: "local" });
          ok = Boolean(widget && turn.status === "done" && (turn.result?.row_count ?? 0) > 0);
          if (ok && widget) {
            widget.title = picks[i].title || widget.title;
            widgets.push(widget);
          } else {
            // runBiTurn resolves (never throws) with the reason on the turn.
            reason =
              turn.error ||
              (turn.status !== "done" ? `Failed during ${turn.status}` : "") ||
              ((turn.result?.row_count ?? 0) === 0 ? "The query returned no rows" : "") ||
              "Couldn't build a chart from the result";
          }
        } catch (e) {
          reason = (e as Error).message;
        }
        progress = progress.map((s, j) =>
          j === i ? { ...s, status: ok ? "done" : "error", error: ok ? undefined : reason } : s,
        );
        setSteps(progress);
      }

      const failed = progress.filter((s) => s.status === "error");
      if (widgets.length === 0) {
        // Keep the dialog open so the per-widget reasons stay visible.
        throw new Error(
          failed[0]?.error
            ? `No widgets could be built — ${failed[0].error}`
            : "No selected widget produced a usable result — try different ones.",
        );
      }
      // Executive summary as a full-width text widget at the top.
      const finalWidgets: BiWidget[] = summary.trim()
        ? [
            {
              id: crypto.randomUUID(),
              kind: "text",
              title: "Executive summary",
              text: `## ${title}\n\n${summary.trim()}`,
            },
            ...widgets,
          ]
        : widgets;
      onDone(finalWidgets, title);
      if (failed.length > 0) {
        toast.warning(
          `Added ${widgets.length}. ${failed.length} couldn't be built (${failed
            .map((f) => f.title)
            .join(", ")})${failed[0]?.error ? ` — ${failed[0].error}` : ""}`,
        );
      } else {
        toast.success(`Generated ${widgets.length} widget${widgets.length === 1 ? "" : "s"}`);
      }
      onOpenChange(false);
      reset();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  const busy = analyzing || generating;
  const allSelected = suggestions.length > 0 && selected.size === suggestions.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" /> Generate dashboard with AI
          </DialogTitle>
          <DialogDescription className="text-xs">
            {phase === "configure"
              ? sourceKind === "semantic"
                ? "Pick a governed model — every widget is built from its certified metrics, and the compiler writes the SQL."
                : "Pick a table — the analyst reads its structure and proposes visuals you can choose from."
              : "Review the summary and pick the visuals to build."}
          </DialogDescription>
        </DialogHeader>

        {phase === "configure" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Source
              </Label>
              {/* The governed option appears only when the project wires
                  listMetricModels + runMetric. Offering it otherwise would be a
                  control that silently does nothing. */}
              {canGovern && (
                <div className="mb-2 flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={sourceKind === "table" ? "secondary" : "ghost"}
                    className="h-7 flex-1 gap-1.5 text-[11px]"
                    onClick={() => setSourceKind("table")}
                    disabled={busy}
                  >
                    <Table2 className="h-3 w-3" /> Table
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={sourceKind === "semantic" ? "secondary" : "ghost"}
                    className="h-7 flex-1 gap-1.5 text-[11px]"
                    onClick={() => setSourceKind("semantic")}
                    disabled={busy}
                  >
                    <ShieldCheck className="h-3 w-3" /> Governed metrics
                  </Button>
                </div>
              )}
              {sourceKind === "semantic" ? (
                <>
                  <Select
                    value={selectedModel?.name ?? ""}
                    onValueChange={setModelName}
                    disabled={busy}
                  >
                    <SelectTrigger className="h-9 w-full text-xs">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <SelectValue
                          placeholder={metricModels === null ? "Loading…" : "Pick a model…"}
                        />
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {(metricModels ?? []).map((m) => (
                        <SelectItem key={m.name} value={m.name} className="text-xs">
                          <span>{m.label || m.name}</span>
                          <span className="ml-1.5 text-muted-foreground">
                            · {m.metrics.length} metrics
                          </span>
                          {m.scoped && (
                            <Badge variant="outline" className="ml-1.5 text-[9px]">
                              scoped
                            </Badge>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    Every widget is compiled from this model&apos;s certified metrics — the AI
                    chooses which to show, never how they are calculated.
                  </p>
                  {metricModels?.length === 0 && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400">
                      No semantic models yet — publish one in the Semantic Layer first.
                    </p>
                  )}
                </>
              ) : (
                <Select value={selectedTable} onValueChange={setTable} disabled={busy}>
                  <SelectTrigger className="h-9 w-full text-xs">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Table2 className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
                      <SelectValue placeholder="Pick a table…" />
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {ctx.datasets.map((d) => (
                      <SelectItem key={d.id} value={d.name} className="text-xs">
                        <span className="font-mono">{d.name}</span>
                        <span className="ml-1.5 text-muted-foreground">
                          · {d.row_count.toLocaleString()} rows
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Focus (optional)
              </Label>
              <Textarea
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                rows={2}
                placeholder="Steer the suggestions, e.g. 'revenue and retention by plan'. Leave blank to cover the whole table."
                className="text-xs"
                disabled={busy}
              />
            </div>
            {ctx.onModelChange && (
              <div className="space-y-1">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  AI model
                </Label>
                <BiModelSelect
                  value={ctx.model ?? null}
                  onChange={ctx.onModelChange}
                  className="w-full"
                />
              </div>
            )}
            <Button
              className="w-full gap-1.5"
              onClick={() => void analyze()}
              disabled={busy || (sourceKind === "semantic" && !selectedModel)}
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />{" "}
                  {sourceKind === "semantic" ? "Reading the model…" : "Analyzing table…"}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Analyze & suggest widgets
                </>
              )}
            </Button>
          </div>
        )}

        {phase === "review" && (
          <>
            {rejected.length > 0 && (
              /* Shown, not swallowed. A generate that proposed twelve widgets
                 and built nine is indistinguishable from one that only thought
                 of nine unless the difference is on screen. */
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
                <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  {rejected.length} suggestion{rejected.length === 1 ? "" : "s"} could not be built
                  from this model
                </p>
                <ul className="mt-1 space-y-0.5">
                  {rejected.slice(0, 4).map((r, i) => (
                    <li key={i} className="text-[10px] text-muted-foreground">
                      <span className="font-medium">{r.title}</span> — {r.reason}
                    </li>
                  ))}
                  {rejected.length > 4 && (
                    <li className="text-[10px] text-muted-foreground">
                      …and {rejected.length - 4} more
                    </li>
                  )}
                </ul>
              </div>
            )}
            <div className="max-h-[24vh] shrink-0 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Sparkles className="h-3 w-3 text-primary" /> Executive summary
              </p>
              <p className="text-sm font-semibold">{title}</p>
              {summary && (
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {summary}
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {selected.size} of {suggestions.length} selected
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                disabled={generating}
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(suggestions.map((s) => s.id)))
                }
              >
                {allSelected ? "Clear all" : "Select all"}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="space-y-1.5 pr-1">
                {suggestions.map((s) => {
                  const step = steps.find((st) => st.id === s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                        selected.has(s.id)
                          ? "border-primary/40 bg-primary/5"
                          : "border-border hover:bg-muted/40"
                      }`}
                    >
                      <Checkbox
                        checked={selected.has(s.id)}
                        onCheckedChange={() => toggle(s.id)}
                        disabled={generating}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <ChartTypeIcon type={s.chartType} />
                          <span className="truncate text-xs font-medium">{s.title}</span>
                          {step?.status === "running" && (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                          )}
                          {step?.status === "done" && (
                            <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                          )}
                          {step?.status === "error" && (
                            <XIcon
                              className="h-3 w-3 shrink-0 text-red-500"
                              aria-label={step.error}
                            />
                          )}
                        </div>
                        {step?.status === "error" && step.error ? (
                          <p className="mt-0.5 text-[11px] leading-snug text-red-600 dark:text-red-400">
                            {step.error}
                          </p>
                        ) : (
                          s.rationale && (
                            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                              {s.rationale}
                            </p>
                          )
                        )}
                      </div>
                      <Badge variant="outline" className="shrink-0 text-[9px] font-normal">
                        {s.chartType || "auto"}
                      </Badge>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                className="gap-1.5"
                disabled={generating}
                onClick={() => setPhase("configure")}
              >
                Back
              </Button>
              <Button
                className="flex-1 gap-1.5"
                onClick={() => void generate()}
                disabled={generating || selected.size === 0}
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4" /> Generate {selected.size} widget
                    {selected.size === 1 ? "" : "s"}
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
