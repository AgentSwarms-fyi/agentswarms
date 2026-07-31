// Guided tour overlay for template-provisioned agents.
//
// Activated whenever the loaded agent has `tools.templateId` matching one of
// the REAL_TEMPLATES. Provides:
//   - A persistent right-side lesson panel with checkpoints that auto-tick
//     as the user progresses through the demo.
//   - A floating coach mark on the input box for the very first step.
//   - A "Use suggested prompt" button so users can fire the canonical demo
//     in one click.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2,
  Circle,
  GraduationCap,
  Sparkles,
  X,
  ArrowRight,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { getRealTemplate, type RealTemplate, type TemplateLessonStep } from "@/lib/realTemplates";

export type TourSignals = {
  agentId: string | null;
  // Number of user messages sent in the active conversation.
  userMessageCount: number;
  // Number of assistant messages successfully streamed.
  assistantMessageCount: number;
  // Whether the most recent assistant message contains citations.
  lastAssistantHasCitations: boolean;
  // True if there is at least one pending approval for this agent right now.
  hasPendingApproval: boolean;
  // True if at least one approval for this agent has been decided
  // (approved/rejected) since the tour started.
  hasDecidedApproval: boolean;
};

type TourProps = {
  templateId: string | null | undefined;
  signals: TourSignals;
  onUseSuggestedPrompt: (prompt: string) => void;
};

// Decide which step ids should be considered complete given the signals.
function computeCompletedSteps(
  template: RealTemplate,
  signals: TourSignals,
): Set<TemplateLessonStep["id"]> {
  const done = new Set<TemplateLessonStep["id"]>();
  if (signals.userMessageCount > 0) done.add("send_first_message");
  if (signals.assistantMessageCount > 0) done.add("model_replies");

  if (template.guardrails.enforceCitations) {
    if (signals.lastAssistantHasCitations) done.add("citations_appear");
  } else {
    // For non-RAG templates, treat the citations step as informational and
    // mark it done as soon as a reply has streamed.
    if (signals.assistantMessageCount > 0) done.add("citations_appear");
  }

  if (template.approvalSeed) {
    if (signals.hasPendingApproval || signals.hasDecidedApproval) {
      done.add("approval_shown");
    }
    if (signals.hasDecidedApproval) done.add("approval_decided");
  } else {
    // Templates without an approval seed: ticking these is informational.
    if (signals.assistantMessageCount > 1) done.add("approval_shown");
    if (signals.assistantMessageCount > 2) done.add("approval_decided");
  }

  return done;
}

export function TemplateTour({ templateId, signals, onUseSuggestedPrompt }: TourProps) {
  const template = templateId ? getRealTemplate(templateId) : undefined;

  // Persist dismissal per-agent so it doesn't keep popping back up.
  const dismissKey = signals.agentId ? `template-tour-dismissed:${signals.agentId}` : null;
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    if (!dismissKey) return;
    try {
      setDismissed(sessionStorage.getItem(dismissKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);

  const completed = useMemo(
    () =>
      template ? computeCompletedSteps(template, signals) : new Set<TemplateLessonStep["id"]>(),
    [template, signals],
  );

  // Index of the next-incomplete step (the "current" step the user should act on).
  const currentIdx = useMemo(() => {
    if (!template) return -1;
    const idx = template.lesson.findIndex((s) => !completed.has(s.id));
    return idx === -1 ? template.lesson.length - 1 : idx;
  }, [template, completed]);

  // Auto-scroll the current step into view whenever it advances.
  const stepRefs = useRef<Array<HTMLLIElement | null>>([]);
  useEffect(() => {
    if (currentIdx < 0) return;
    const el = stepRefs.current[currentIdx];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentIdx]);

  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const copyPrompt = async (prompt: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedIdx(idx);
      toast.success("Prompt copied");
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      toast.error("Couldn't copy — try selecting the text instead");
    }
  };

  if (!template || dismissed) return null;

  const totalSteps = template.lesson.length;
  const completedCount = template.lesson.filter((s) => completed.has(s.id)).length;
  const progressPct = totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 0;
  const allDone = completedCount === totalSteps;

  const dismiss = () => {
    setDismissed(true);
    if (dismissKey) {
      try {
        sessionStorage.setItem(dismissKey, "1");
      } catch {
        /* ignore */
      }
    }
  };

  // Fallback prompt for when the current step has none — use the template's first canonical prompt.
  const fallbackFirstPrompt = template.suggestedPrompts[0] || "";

  return (
    <Card className="absolute right-4 top-4 z-30 w-[340px] max-h-[calc(100%-2rem)] flex flex-col border-primary/30 bg-card/95 backdrop-blur shadow-xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 h-7 w-7 shrink-0 rounded-lg bg-primary/15 flex items-center justify-center">
            <GraduationCap className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-semibold truncate">Guided tour</p>
              <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4">
                DEMO
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground truncate">{template.title}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={dismiss}
          title="Dismiss tour"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Progress */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            {allDone
              ? "Tour complete 🎉"
              : `Step ${Math.min(completedCount + 1, totalSteps)} of ${totalSteps}`}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">{progressPct}%</span>
        </div>
        <Progress value={progressPct} className="h-1.5" />
      </div>

      {/* Steps list */}
      <ScrollArea className="flex-1 px-3 pb-2">
        <ol className="space-y-2 py-2">
          {template.lesson.map((step, idx) => {
            const isDone = completed.has(step.id);
            const isCurrent = idx === currentIdx && !isDone;
            const prompt = step.suggestedPrompt;
            const isCopied = copiedIdx === idx;
            return (
              <li
                key={step.id}
                ref={(el) => {
                  stepRefs.current[idx] = el;
                }}
                className={cn(
                  "rounded-lg border p-2.5 transition-colors",
                  isDone
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : isCurrent
                      ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border bg-background/40 opacity-70",
                )}
              >
                <div className="flex items-start gap-2">
                  {isDone ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  ) : (
                    <Circle
                      className={cn(
                        "h-4 w-4 mt-0.5 shrink-0",
                        isCurrent ? "text-primary" : "text-muted-foreground/50",
                      )}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-xs font-medium leading-snug",
                        isDone || isCurrent ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {idx + 1}. {step.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                      {step.description}
                    </p>

                    {/* Per-step prompt chip */}
                    {prompt && (
                      <div
                        className={cn(
                          "mt-2 rounded-md border p-2 transition-colors",
                          isCurrent
                            ? "border-primary/40 bg-background"
                            : isDone
                              ? "border-emerald-500/20 bg-background/50 opacity-80"
                              : "border-border bg-background/30 opacity-80",
                        )}
                      >
                        {step.promptHint && (
                          <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                            {step.promptHint}
                          </p>
                        )}
                        <p className="text-[11px] text-foreground/85 leading-snug italic line-clamp-3 mb-1.5 whitespace-pre-line">
                          {prompt}
                        </p>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant={isCurrent ? "default" : "outline"}
                            className="h-6 px-2 text-[10px] gap-1 flex-1"
                            onClick={() => onUseSuggestedPrompt(prompt)}
                            title="Insert this prompt into the chat input"
                          >
                            <Sparkles className="h-2.5 w-2.5" /> Try this prompt
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => copyPrompt(prompt, idx)}
                            title="Copy prompt"
                          >
                            {isCopied ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    {step.learnMoreRoute && step.learnMoreLabel && (
                      <Link
                        to={step.learnMoreRoute}
                        className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1.5 font-medium"
                      >
                        {step.learnMoreLabel} <ArrowRight className="h-2.5 w-2.5" />
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </ScrollArea>

      {/* Fallback footer — only when the current step has no inline prompt and no message sent yet */}
      {signals.userMessageCount === 0 &&
        currentIdx >= 0 &&
        !template.lesson[currentIdx]?.suggestedPrompt &&
        fallbackFirstPrompt && (
          <div className="border-t border-border p-3 bg-muted/30">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
              Suggested first prompt
            </p>
            <p className="text-[11px] text-muted-foreground leading-snug line-clamp-3 mb-2 italic">
              "{fallbackFirstPrompt}"
            </p>
            <Button
              size="sm"
              className="w-full h-7 text-xs gap-1"
              onClick={() => onUseSuggestedPrompt(fallbackFirstPrompt)}
            >
              <Sparkles className="h-3 w-3" /> Try this prompt
            </Button>
          </div>
        )}

      {allDone && (
        <div className="border-t border-border p-3 bg-emerald-500/5">
          <p className="text-[11px] text-foreground/80 leading-snug">
            🎉 You've completed the guided tour. Edit the agent, swap the model, or replace the
            knowledge base to make it yours.
          </p>
          <div className="flex gap-2 mt-2">
            <Button asChild variant="outline" size="sm" className="flex-1 h-7 text-xs">
              <Link to="/agents">Edit agent</Link>
            </Button>
            <Button size="sm" className="flex-1 h-7 text-xs" onClick={dismiss}>
              Close tour
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
