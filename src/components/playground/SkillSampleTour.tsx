// Lightweight guided-tour overlay for Skill-sample agents.
//
// Activated whenever the loaded agent has tools.skillTourId matching one of
// the SAMPLE_AGENTS_WITH_SKILLS entries. Sits at the right edge of the
// Playground, dismissible per-agent (sessionStorage).
//
// Distinct from TemplateTour (which is for /templates-provisioned agents).
// Same visual language so the two never appear at once.

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GraduationCap, Sparkles, X, BookOpen, ArrowRight } from "lucide-react";
import { getSampleAgentByTourId } from "@/lib/sampleAgentsWithSkills";

type Props = {
  agentId: string | null;
  skillTourId: string | null | undefined;
  onUseSuggestedPrompt: (prompt: string) => void;
};

export function SkillSampleTour({ agentId, skillTourId, onUseSuggestedPrompt }: Props) {
  const sample = getSampleAgentByTourId(skillTourId);
  const dismissKey = agentId ? `skill-sample-tour-dismissed:${agentId}` : null;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!dismissKey) return;
    try {
      setDismissed(sessionStorage.getItem(dismissKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);

  if (!sample || !agentId || dismissed) return null;

  function dismiss() {
    if (dismissKey) {
      try {
        sessionStorage.setItem(dismissKey, "1");
      } catch {
        /* ignore */
      }
    }
    setDismissed(true);
  }

  return (
    <div className="pointer-events-none absolute right-0 top-0 hidden h-full w-[340px] xl:block">
      <Card className="pointer-events-auto m-3 max-h-[calc(100%-1.5rem)] overflow-hidden border-primary/30 bg-background/95 shadow-xl backdrop-blur">
        <div className="flex items-start justify-between gap-2 border-b border-border/60 p-3">
          <div className="flex items-start gap-2">
            <div className="rounded-md bg-primary/15 p-1.5 text-primary">
              <GraduationCap className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Skill Library tour
              </div>
              <div className="text-sm font-semibold leading-tight">{sample.tour.headline}</div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={dismiss}
            aria-label="Dismiss tour"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <ScrollArea className="max-h-[calc(100vh-12rem)]">
          <div className="space-y-3 p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">{sample.tour.subhead}</p>

            <div className="rounded-md border border-border/60 bg-muted/30 p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <BookOpen className="h-3 w-3" />
                Skills attached
              </div>
              <div className="flex flex-wrap gap-1">
                {sample.skillIds.map((id) => (
                  <Badge key={id} variant="secondary" className="text-[10px] font-mono">
                    {id.replace(/^sample:/, "")}
                  </Badge>
                ))}
              </div>
            </div>

            <ol className="space-y-2.5">
              {sample.tour.steps.map((step, i) => (
                <li
                  key={step.id}
                  className="rounded-md border border-border/60 bg-background/60 p-2.5"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                      {i + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold">{step.title}</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {step.body}
                      </p>
                      {step.suggestedPrompt && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2 h-7 w-full justify-start gap-1.5 text-[11px]"
                          onClick={() => onUseSuggestedPrompt(step.suggestedPrompt!)}
                        >
                          <Sparkles className="h-3 w-3" />
                          Use suggested prompt
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            <Link
              to="/skills"
              className="flex items-center gap-1.5 text-[11px] text-primary hover:underline"
            >
              Browse all skills
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
}
