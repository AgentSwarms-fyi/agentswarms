// Floating bottom control bar for the guided tour.
// Two states:
//   - idle:    "Start guided tour" CTA + brief description
//   - running: step counter, prev/next/end controls, current step explanation
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  ChevronLeft,
  ChevronRight,
  X,
  GraduationCap,
  Building2,
  Sparkles,
} from "lucide-react";
import { ACCENT_CLASSES, type AgenticPattern } from "@/lib/agenticPatterns";
import { cn } from "@/lib/utils";

type Props = {
  pattern: AgenticPattern;
  isActive: boolean;
  stepIndex: number;
  onStart: () => void;
  onPrev: () => void;
  onNext: () => void;
  onEnd: () => void;
  onJump: (i: number) => void;
};

export function PatternTourBar({
  pattern,
  isActive,
  stepIndex,
  onStart,
  onPrev,
  onNext,
  onEnd,
  onJump,
}: Props) {
  const c = ACCENT_CLASSES[pattern.accent];
  const total = pattern.tour.length;

  if (!isActive) {
    return (
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(640px,calc(100%-2rem))]">
        <div
          className={cn(
            "rounded-xl border-2 bg-card/95 backdrop-blur shadow-2xl px-4 py-3 flex items-center gap-3",
            c.border,
          )}
        >
          <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", c.bg)}>
            <GraduationCap className={cn("h-4 w-4", c.text)} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">Take the guided tour</p>
            <p className="text-[10px] text-muted-foreground line-clamp-1">
              {total} steps walking through how{" "}
              <span className="text-foreground">{pattern.name}</span> actually works.
            </p>
          </div>
          <Button size="sm" onClick={onStart} className="shrink-0 h-8">
            <Play className="h-3.5 w-3.5 mr-1.5" /> Start tour
          </Button>
        </div>
      </div>
    );
  }

  const step = pattern.tour[stepIndex];

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(720px,calc(100%-2rem))]">
      <div className={cn("rounded-xl border-2 bg-card/95 backdrop-blur shadow-2xl", c.border)}>
        {/* Header row */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className={cn("h-3.5 w-3.5 shrink-0", c.text)} />
            <span className="text-xs font-semibold truncate">{step.title}</span>
            <Badge variant="outline" className="text-[10px] shrink-0">
              {stepIndex + 1} / {total}
            </Badge>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onEnd} title="End tour">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2 text-xs leading-relaxed max-h-[40vh] overflow-y-auto">
          <div>
            <p className={cn("text-[10px] uppercase tracking-wider font-bold mb-0.5", c.text)}>
              What's happening
            </p>
            <p className="text-foreground/90">{step.what}</p>
          </div>
          <div>
            <p className={cn("text-[10px] uppercase tracking-wider font-bold mb-0.5", c.text)}>
              Why it matters
            </p>
            <p className="text-muted-foreground">{step.why}</p>
          </div>
          {step.realWorld && (
            <div className={cn("rounded-md border p-2 mt-1", c.border, c.bg)}>
              <p
                className={cn(
                  "text-[10px] uppercase tracking-wider font-bold mb-1 flex items-center gap-1",
                  c.text,
                )}
              >
                <Building2 className="h-3 w-3" /> In production
              </p>
              <p className="text-[11px] text-foreground/85">{step.realWorld}</p>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={stepIndex === 0}
            onClick={onPrev}
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
          </Button>
          <div className="flex gap-1">
            {pattern.tour.map((_, i) => (
              <button
                key={i}
                onClick={() => onJump(i)}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === stepIndex
                    ? cn("w-6", c.bg.replace("/10", ""))
                    : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60",
                )}
                style={i === stepIndex ? { backgroundColor: c.stroke } : undefined}
                aria-label={`Go to step ${i + 1}`}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={stepIndex === total - 1}
            onClick={onNext}
          >
            Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
