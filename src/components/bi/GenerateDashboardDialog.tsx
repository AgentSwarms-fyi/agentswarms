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
import { useState } from "react";
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
import { runBiTurn, suggestDashboardWidgets, type WidgetSuggestion } from "@/lib/biAgent";
import { widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";

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
  const [table, setTable] = useState("");
  const [focus, setFocus] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [suggestions, setSuggestions] = useState<WidgetSuggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<GenStep[]>([]);

  const selectedTable = ctx.datasets.some((d) => d.name === table)
    ? table
    : (ctx.datasets[0]?.name ?? "");
  const scoped = ctx.datasets.filter((d) => d.name === selectedTable);
  const scopedMetrics =
    scoped.length > 0 ? ctx.metrics.filter((m) => m.table_id === scoped[0].id) : [];

  function reset() {
    setPhase("configure");
    setFocus("");
    setSummary("");
    setSuggestions([]);
    setSelected(new Set());
    setSteps([]);
  }

  async function analyze() {
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
              ? "Pick a table — the analyst reads its structure and proposes visuals you can choose from."
              : "Review the summary and pick the visuals to build."}
          </DialogDescription>
        </DialogHeader>

        {phase === "configure" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Source table
              </Label>
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
            <Button className="w-full gap-1.5" onClick={() => void analyze()} disabled={busy}>
              {analyzing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Analyzing table…
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
