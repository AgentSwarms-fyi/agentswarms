// Generate a whole paginated report with AI.
//
// The machinery is the dashboard generator's, deliberately: the same table
// context, the same `runBiTurn` per section, the same `widgetFromBiTurn` to
// turn an answer into a widget. Only two things differ, and both are the
// report's shape rather than its data — the planner is asked for an ordered
// narrative of SECTIONS instead of a set of tiles, and each section says
// whether its answer belongs in a chart or in a table somebody will read a
// row of.
import { useState } from "react";
import { toast } from "sonner";
import { FileText, Loader2, Sparkles, Table2 } from "lucide-react";

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
import { runBiTurn } from "@/lib/biAgent";
import { widgetFromBiTurn } from "@/lib/biDashboards";
import { suggestReportOutline, type ReportSection } from "@/lib/biReportAgent";
import { newBlockId, type ReportBlock } from "@/lib/biReports";

type Step = {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
  reason?: string;
};

export function GenerateReportDialog({
  open,
  onOpenChange,
  ctx,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ctx: BiDataContext;
  /** The finished blocks (≥1) and the title the planner chose. */
  onDone: (blocks: ReportBlock[], title: string) => void;
}) {
  const [phase, setPhase] = useState<"configure" | "review">("configure");
  const [table, setTable] = useState("");
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [sections, setSections] = useState<ReportSection[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [steps, setSteps] = useState<Step[]>([]);

  const selectedTable = ctx.datasets.some((d) => d.name === table)
    ? table
    : (ctx.datasets[0]?.name ?? "");
  const scoped = ctx.datasets.filter((d) => d.name === selectedTable);
  const scopedMetrics =
    scoped.length > 0 ? ctx.metrics.filter((m) => m.table_id === scoped[0].id) : [];

  function reset() {
    setPhase("configure");
    setSections([]);
    setPicked(new Set());
    setSteps([]);
    setTitle("");
    setSummary("");
  }

  async function plan() {
    if (!scoped.length) return toast.error("Pick a table first");
    setPlanning(true);
    try {
      const out = await suggestReportOutline({
        datasets: scoped,
        semantics: ctx.semantics,
        metrics: scopedMetrics,
        goal: goal.trim() || undefined,
        model: ctx.model ?? undefined,
      });
      if (!out.sections.length) {
        return toast.error(
          "The planner returned no usable sections — try naming what the report is for",
        );
      }
      setTitle(out.title);
      setSummary(out.summary);
      setSections(out.sections);
      setPicked(new Set(out.sections.map((_, i) => i)));
      setPhase("review");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function build() {
    const chosen = sections.map((s, i) => ({ s, i })).filter(({ i }) => picked.has(i));
    if (!chosen.length) return toast.error("Pick at least one section");
    setBuilding(true);
    const progress: Step[] = chosen.map(({ s, i }) => ({
      key: String(i),
      label: s.heading,
      status: "pending",
    }));
    setSteps(progress);

    const blocks: ReportBlock[] = [];
    // The summary opens the report, as the thing a reader meets first.
    if (summary.trim()) {
      blocks.push({ id: newBlockId(), kind: "heading", text: title || "Report", level: 1 });
      blocks.push({ id: newBlockId(), kind: "text", text: summary.trim() });
    }

    const failures: string[] = [];
    for (let n = 0; n < chosen.length; n++) {
      const { s } = chosen[n];
      progress[n] = { ...progress[n], status: "running" };
      setSteps([...progress]);
      let reason = "";
      try {
        const turn = await runBiTurn({
          question: s.question,
          datasets: scoped,
          semantics: ctx.semantics,
          metrics: scopedMetrics,
          model: ctx.model ?? undefined,
          // A table section still needs a chart spec built (the widget carries
          // one either way); asking for "table" keeps the answer row-shaped.
          preferChart: s.present === "table" ? "table" : s.chartType || undefined,
          onUpdate: () => {},
        });
        const widget = widgetFromBiTurn(turn, { kind: "local" });
        if (widget && turn.status === "done" && (turn.result?.row_count ?? 0) > 0) {
          widget.title = "";
          if (s.pageBreakBefore && blocks.length) {
            blocks.push({ id: newBlockId(), kind: "pagebreak" });
          }
          blocks.push({ id: newBlockId(), kind: "heading", text: s.heading, level: 2 });
          blocks.push(
            s.present === "table"
              ? { id: newBlockId(), kind: "table", widget, zebra: true }
              : { id: newBlockId(), kind: "chart", widget, height: 200 },
          );
          progress[n] = { ...progress[n], status: "done" };
        } else {
          reason =
            turn.error ||
            (turn.status !== "done" ? `Failed during ${turn.status}` : "") ||
            ((turn.result?.row_count ?? 0) === 0 ? "The query returned no rows" : "") ||
            "Could not build this section";
        }
      } catch (e) {
        reason = (e as Error).message;
      }
      if (reason) {
        progress[n] = { ...progress[n], status: "error", reason };
        failures.push(`${chosen[n].s.heading}: ${reason}`);
      }
      setSteps([...progress]);
    }
    setBuilding(false);

    // A block or two is still a report; nothing at all is not, and the
    // per-section reasons are the useful thing then, so the dialog stays open.
    const built = blocks.filter((b) => b.kind === "chart" || b.kind === "table").length;
    if (built === 0) {
      toast.error("No section could be built — see the reasons below");
      return;
    }
    if (failures.length) {
      toast.warning(`${built} section(s) built`, {
        description: failures.slice(0, 3).join(" · "),
        duration: 10000,
      });
    }
    onDone(blocks, title || "Report");
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Generate a report
          </DialogTitle>
          <DialogDescription>
            A report is read in order, so the planner returns sections rather than tiles — and says
            which of them belong in a table somebody will check a row of.
          </DialogDescription>
        </DialogHeader>

        {phase === "configure" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Table</Label>
              <Select value={selectedTable} onValueChange={setTable}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Pick a table…" />
                </SelectTrigger>
                <SelectContent>
                  {ctx.datasets.map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">What is the report for? (optional)</Label>
              <Textarea
                rows={3}
                placeholder="The monthly pack the finance team reviews — headline revenue, the split by region, and the line-level detail behind it."
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>
            {/* Only when the project can remember the choice; a picker whose
                selection goes nowhere is worse than the server default. */}
            {ctx.onModelChange ? (
              <div className="space-y-1.5">
                <Label className="text-xs">AI model</Label>
                <BiModelSelect
                  value={ctx.model ?? null}
                  onChange={ctx.onModelChange}
                  className="w-full"
                />
              </div>
            ) : null}
            <Button onClick={() => void plan()} disabled={planning || !ctx.datasets.length}>
              {planning ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Plan the report
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">{title}</p>
              {summary ? <p className="text-xs text-muted-foreground">{summary}</p> : null}
            </div>
            <div className="space-y-1.5">
              {sections.map((s, i) => {
                const step = steps.find((x) => x.key === String(i));
                return (
                  <div key={i} className="flex items-start gap-2 rounded-md border p-2">
                    <Checkbox
                      checked={picked.has(i)}
                      disabled={building}
                      onCheckedChange={(v) => {
                        const next = new Set(picked);
                        if (v) next.add(i);
                        else next.delete(i);
                        setPicked(next);
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium">{s.heading}</span>
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          {s.present === "table" ? (
                            <Table2 className="h-3 w-3" />
                          ) : (
                            <FileText className="h-3 w-3" />
                          )}
                          {s.present === "table" ? "table" : s.chartType}
                        </Badge>
                        {s.pageBreakBefore ? (
                          <Badge variant="secondary" className="text-[10px]">
                            new page
                          </Badge>
                        ) : null}
                        {step?.status === "running" ? (
                          <Loader2 className="h-3 w-3 animate-spin text-primary" />
                        ) : null}
                        {step?.status === "done" ? (
                          <Badge className="text-[10px]">built</Badge>
                        ) : null}
                      </div>
                      <p className="text-[11px] text-muted-foreground">{s.question}</p>
                      {s.rationale ? (
                        <p className="text-[11px] text-muted-foreground/80">{s.rationale}</p>
                      ) : null}
                      {step?.status === "error" ? (
                        <p className="text-[11px] text-destructive">{step.reason}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void build()} disabled={building}>
                {building ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                Build {picked.size} section{picked.size === 1 ? "" : "s"}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={building}>
                Back
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
