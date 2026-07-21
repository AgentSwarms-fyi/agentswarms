// "Generate with AI" — one goal in, a whole dashboard out. Plans 5-8
// analyst questions from the goal + schema, runs each through the existing
// GenBI pipeline (plan → SQL → execute → chart → narrative) and hands the
// finished widgets back to the editor for auto-layout.
import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Wand2, X as XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import type { BiDataContext } from "@/components/bi/biDataContext";
import { planDashboard, runBiTurn } from "@/lib/biAgent";
import { widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";

type Step = { question: string; status: "pending" | "running" | "done" | "error" };

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
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [phase, setPhase] = useState("");

  async function run() {
    const g = goal.trim();
    if (!g || busy) return;
    if (ctx.datasets.length === 0) {
      return toast.error("No local datasets — upload data on the Data & SQL page first.");
    }
    setBusy(true);
    setSteps([]);
    setPhase("Planning the dashboard…");
    try {
      const plan = await planDashboard({
        goal: g,
        datasets: ctx.datasets,
        semantics: ctx.semantics,
        metrics: ctx.metrics,
        model: ctx.model ?? undefined,
      });
      if (plan.questions.length === 0) throw new Error("The model returned no questions");
      let progress: Step[] = plan.questions.map((q) => ({ question: q, status: "pending" }));
      setSteps(progress);
      setPhase("");

      const widgets: BiWidget[] = [];
      for (let i = 0; i < plan.questions.length; i++) {
        progress = progress.map((s, j) => (j === i ? { ...s, status: "running" } : s));
        setSteps(progress);
        const turn = await runBiTurn({
          question: plan.questions[i],
          datasets: ctx.datasets,
          semantics: ctx.semantics,
          metrics: ctx.metrics,
          model: ctx.model ?? undefined,
          onUpdate: () => {},
        });
        const widget = widgetFromBiTurn(turn, { kind: "local" });
        const ok = Boolean(widget && turn.status === "done" && (turn.result?.row_count ?? 0) > 0);
        if (ok && widget) widgets.push(widget);
        progress = progress.map((s, j) => (j === i ? { ...s, status: ok ? "done" : "error" } : s));
        setSteps(progress);
      }
      if (widgets.length === 0) {
        throw new Error("No question produced a usable result — try rephrasing the goal.");
      }
      onDone(widgets, plan.title);
      toast.success(`Generated ${widgets.length} widgets`);
      onOpenChange(false);
      setGoal("");
      setSteps([]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" /> Generate dashboard with AI
          </DialogTitle>
          <DialogDescription className="text-xs">
            Describe the goal — the analyst plans the questions, writes and runs the SQL, picks the
            charts and lays everything out. Uses your local &amp; prepared datasets.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder='e.g. "Monthly revenue review by plan and region"'
            className="text-xs"
            disabled={busy}
          />
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
          {phase && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {phase}
            </p>
          )}
          {steps.length > 0 && (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  {s.status === "running" ? (
                    <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" />
                  ) : s.status === "done" ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                  ) : s.status === "error" ? (
                    <XIcon className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                  ) : (
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  )}
                  <span
                    className={
                      s.status === "error" ? "text-muted-foreground line-through" : undefined
                    }
                  >
                    {s.question}
                  </span>
                </div>
              ))}
            </div>
          )}
          <Button
            className="w-full gap-1.5"
            onClick={() => void run()}
            disabled={busy || !goal.trim()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {busy ? "Generating…" : "Generate dashboard"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
