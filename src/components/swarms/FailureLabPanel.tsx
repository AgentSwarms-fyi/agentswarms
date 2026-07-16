// Failure-Mode Lab panel — shown on the swarm canvas when a lab is loaded
// (via /swarms?lab=<id>). Presents the symptom + task, progressive hints, the
// post-run assertion checklist, and — once solved (or revealed) — the
// diagnosis answer key. Purely presentational; the parent (swarms.tsx) owns
// the run, computes the LabEvaluation, and persists progress.

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FlaskConical,
  Lightbulb,
  CheckCircle2,
  XCircle,
  Eye,
  ChevronDown,
  ChevronUp,
  X,
  PartyPopper,
} from "lucide-react";
import type { FailureLab } from "@/lib/failureLabs";
import type { LabEvaluation } from "@/lib/failureLabCheck";

type Props = {
  lab: FailureLab;
  result: LabEvaluation | null; // null until the first run completes
  isRunning: boolean;
  hasRun: boolean;
  onClose: () => void;
  // Reported up so the parent can persist hints_used / revealed on solve.
  onHintsUsedChange?: (n: number) => void;
  onRevealed?: () => void;
};

const DIFFICULTY_STYLE: Record<FailureLab["difficulty"], string> = {
  intro: "border-emerald-500/40 text-emerald-500",
  intermediate: "border-amber-500/40 text-amber-500",
  advanced: "border-red-500/40 text-red-500",
};

export function FailureLabPanel({
  lab,
  result,
  isRunning,
  hasRun,
  onClose,
  onHintsUsedChange,
  onRevealed,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [hintsShown, setHintsShown] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const solved = !!result?.passed;
  const showAnswer = solved || revealed;

  // Reset transient state when switching to a different lab.
  useEffect(() => {
    setHintsShown(0);
    setRevealed(false);
    setCollapsed(false);
  }, [lab.id]);

  useEffect(() => {
    onHintsUsedChange?.(hintsShown);
  }, [hintsShown, onHintsUsedChange]);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="absolute bottom-4 left-4 z-20 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-card/95 px-4 py-2 text-xs font-medium shadow-xl backdrop-blur transition-colors hover:border-primary/70"
      >
        <FlaskConical className="h-3.5 w-3.5 text-primary" />
        {solved ? "Lab solved ✓" : "Resume failure lab"}
      </button>
    );
  }

  return (
    <Card className="absolute bottom-4 left-4 z-20 max-h-[72vh] w-[420px] max-w-[calc(100%-2rem)] overflow-y-auto border-primary/40 bg-card/95 shadow-2xl backdrop-blur">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-card/95 px-4 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-primary" />
          <p className="truncate text-xs font-semibold">Failure Lab</p>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {lab.category}
          </Badge>
          <Badge
            variant="outline"
            className={`shrink-0 text-[10px] ${DIFFICULTY_STYLE[lab.difficulty]}`}
          >
            {lab.difficulty}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:text-primary"
            title="Collapse"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:text-destructive"
            title="Exit lab"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4 text-sm">
        {/* Title + symptom */}
        <div>
          <h3 className="text-sm font-semibold">{lab.title}</h3>
          <div className="mt-1.5 rounded-md border border-red-500/30 bg-red-500/5 p-2.5 text-[12px] leading-relaxed text-foreground/90">
            <span className="font-medium text-red-400">Symptom: </span>
            {lab.symptom}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{lab.brief}</p>
        </div>

        {/* Solved banner */}
        {solved && (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
            <PartyPopper className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <div>
              <p className="text-xs font-semibold text-emerald-400">Solved! All checks pass.</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Read the diagnosis below to lock in the lesson.
              </p>
            </div>
          </div>
        )}

        {/* Assertion checklist (after a run) */}
        {result && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Checks ({result.results.filter((r) => r.passed).length}/{result.results.length})
            </p>
            <div className="space-y-1.5">
              {result.results.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px] leading-snug">
                  {r.passed ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  )}
                  <span className={r.passed ? "text-muted-foreground" : "text-foreground/90"}>
                    {r.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!hasRun && (
          <p className="rounded-md border border-border/60 bg-background/40 p-2 text-[11px] text-muted-foreground">
            Run the swarm to see what's wrong, then edit the nodes/edges and re-run. The checks
            above turn green when your fix is correct.
          </p>
        )}

        {/* Progressive hints */}
        {!showAnswer && (
          <div>
            <div className="space-y-1.5">
              {lab.hints.slice(0, hintsShown).map((h, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-snug text-foreground/90"
                >
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>{h}</span>
                </div>
              ))}
            </div>
            {hintsShown < lab.hints.length && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 w-full text-[11px]"
                onClick={() => setHintsShown((n) => n + 1)}
              >
                <Lightbulb className="mr-1.5 h-3 w-3" />
                {hintsShown === 0
                  ? "Show a hint"
                  : `Show next hint (${hintsShown}/${lab.hints.length})`}
              </Button>
            )}
          </div>
        )}

        {/* Diagnosis (revealed on solve or via escape hatch) */}
        {showAnswer ? (
          <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              Diagnosis
            </p>
            <p className="text-[12px] leading-relaxed text-foreground/90">{lab.diagnosis}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              The fix
            </p>
            <p className="text-[12px] leading-relaxed text-foreground/90">{lab.fixSummary}</p>
          </div>
        ) : (
          hintsShown >= lab.hints.length && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-[11px] text-muted-foreground"
              onClick={() => {
                setRevealed(true);
                onRevealed?.();
              }}
            >
              <Eye className="mr-1.5 h-3 w-3" />
              Reveal the answer
            </Button>
          )
        )}

        {isRunning && (
          <p className="flex items-center gap-1.5 text-[11px] text-amber-400">
            <ChevronUp className="h-3 w-3 animate-pulse" /> Running — checks update when it
            finishes.
          </p>
        )}
      </div>
    </Card>
  );
}
