// Floating, collapsible guided-tour panel for swarm templates.
// Shows step-by-step explanations of each node, lets the user click a step
// to highlight that node on the canvas. Per-step real-world references and
// a top banner of case studies tie each pattern to production deployments.
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, GraduationCap, X, ExternalLink, Building2 } from "lucide-react";
import type { SwarmTourStep, SwarmCaseStudy } from "@/lib/swarmTemplates";

type Props = {
  steps: SwarmTourStep[];
  templateTitle: string;
  caseStudies?: SwarmCaseStudy[];
  onFocusNode: (nodeId: string) => void;
  onClose: () => void;
  /** When the swarm is executing, the node currently running (or waiting on approval). */
  activeNodeIds?: Set<string>;
  /** True while a run is in progress — drives "follow the run" auto-advance. */
  isRunning?: boolean;
};

export function SwarmTour({
  steps,
  templateTitle,
  caseStudies,
  onFocusNode,
  onClose,
  activeNodeIds,
  isRunning,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [idx, setIdx] = useState(0);
  const [showCases, setShowCases] = useState(false);

  // During parallel execution, cycle through all active nodes every 2 seconds
  // so the user sees each agent's tour step in turn.
  const cycleRef = useRef(0);

  useEffect(() => {
    if (!activeNodeIds || activeNodeIds.size === 0) return;

    // Collect all tour step indices that match active nodes, in order
    const matchingIndices: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (activeNodeIds.has(steps[i].nodeId)) matchingIndices.push(i);
    }
    if (matchingIndices.length === 0) return;

    // Single active node — jump to it immediately (no cycling needed)
    if (matchingIndices.length === 1) {
      const target = matchingIndices[0];
      if (target >= idx || !isRunning) {
        setIdx(target);
        setCollapsed(false);
      }
      return;
    }

    // Multiple active nodes — start cycling
    // Show the first one immediately
    cycleRef.current = 0;
    setIdx(matchingIndices[0]);
    setCollapsed(false);

    const timer = setInterval(() => {
      cycleRef.current = (cycleRef.current + 1) % matchingIndices.length;
      setIdx(matchingIndices[cycleRef.current]);
    }, 2000);

    return () => clearInterval(timer);
  }, [activeNodeIds, steps]);

  // Auto-highlight the current step's node whenever the step changes or
  // the tour is expanded — removes the need for a manual highlight button.
  useEffect(() => {
    if (collapsed) return;
    const step = steps[idx];
    if (step) onFocusNode(step.nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, collapsed]);

  if (steps.length === 0) return null;
  const step = steps[idx];

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-card/95 backdrop-blur px-4 py-2 text-xs font-medium shadow-xl hover:border-primary/70 transition-colors"
      >
        <GraduationCap className="h-3.5 w-3.5 text-primary" />
        Resume guided tour ({idx + 1}/{steps.length})
      </button>
    );
  }

  return (
    <Card className="absolute bottom-4 right-4 z-20 w-[420px] max-w-[calc(100%-2rem)] border-primary/40 bg-card/95 backdrop-blur shadow-2xl max-h-[70vh] overflow-y-auto">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 sticky top-0 bg-card/95 backdrop-blur z-10">
        <div className="flex items-center gap-2 min-w-0">
          <GraduationCap className="h-4 w-4 text-primary shrink-0" />
          <p className="text-xs font-semibold truncate">Guided tour · {templateTitle}</p>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {idx + 1} / {steps.length}
          </Badge>
          {isRunning && (
            <Badge className="text-[10px] shrink-0 bg-amber-500/20 text-amber-600 border-amber-500/40 gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              {activeNodeIds && activeNodeIds.size > 1 ? `${activeNodeIds.size} parallel` : "Live"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {caseStudies && caseStudies.length > 0 && (
            <Button
              variant={showCases ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[10px] gap-1"
              onClick={() => setShowCases((s) => !s)}
              title="Real-world case studies"
            >
              <Building2 className="h-3 w-3" />
              {caseStudies.length} case {caseStudies.length === 1 ? "study" : "studies"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setCollapsed(true)}
            title="Minimize"
          >
            <ChevronLeft className="h-3.5 w-3.5 rotate-90" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title="Close tour"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showCases && caseStudies && caseStudies.length > 0 && (
        <div className="border-b border-border bg-primary/5 px-4 py-3 space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-primary font-bold flex items-center gap-1">
            <Building2 className="h-3 w-3" /> How real organizations use this pattern
          </p>
          {caseStudies.map((cs, i) => (
            <div key={i} className="space-y-1 border-l-2 border-primary/40 pl-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">{cs.org}</p>
                <a
                  href={cs.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  Source <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              <p className="text-[11px] leading-relaxed text-foreground/85">{cs.headline}</p>
              {cs.quote && (
                <p className="text-[11px] italic text-muted-foreground border-l-2 border-muted-foreground/30 pl-2">
                  "{cs.quote}"
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">— {cs.source}</p>
            </div>
          ))}
        </div>
      )}

      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold">{step.title}</h4>
        </div>

        <div className="space-y-2 text-xs leading-relaxed">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-primary font-bold mb-0.5">
              What it does
            </p>
            <p className="text-foreground/90">{step.what}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-primary font-bold mb-0.5">
              Why it's here
            </p>
            <p className="text-muted-foreground">{step.why}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-primary font-bold mb-0.5">
              Watch for
            </p>
            <p className="text-muted-foreground">{step.watchFor}</p>
          </div>
          {step.realWorldRef && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-2 mt-2">
              <p className="text-[10px] uppercase tracking-wider text-primary font-bold mb-1 flex items-center gap-1">
                <Building2 className="h-3 w-3" /> In production at {step.realWorldRef.org}
              </p>
              <p className="text-[11px] text-foreground/85 leading-relaxed mb-1">
                {step.realWorldRef.label}
              </p>
              <a
                href={step.realWorldRef.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
              >
                Read the source <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={idx === 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
          </Button>
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === idx
                    ? "w-6 bg-primary"
                    : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60"
                }`}
                aria-label={`Go to step ${i + 1}`}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={idx === steps.length - 1}
            onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))}
          >
            Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
