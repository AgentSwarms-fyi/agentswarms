// /patterns — Agentic AI Patterns Explorer.
// Read-only ReactFlow visualisations of 7 core agentic patterns + a guided
// tour that walks through how each one actually works, with educational notes
// on the right side that always stay visible.
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  AGENTIC_PATTERNS, ACCENT_CLASSES, getPattern,
} from "@/lib/agenticPatterns";
import { PatternSidebar } from "@/components/patterns/PatternSidebar";
import { PatternCanvas } from "@/components/patterns/PatternCanvas";
import { PatternTourBar } from "@/components/patterns/PatternTourBar";
import { Badge } from "@/components/ui/badge";
import {
  Lightbulb, AlertTriangle, Building2, Workflow, GraduationCap, BookOpen,
  ArrowRight, X, ShieldAlert, ShieldCheck, FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/patterns")({
  component: PatternsPage,
});

function PatternsPage() {
  const [activeId, setActiveId] = useState<string>(AGENTIC_PATTERNS[0].id);
  const [tourActive, setTourActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [notesOpen, setNotesOpen] = useState(true);

  const pattern = useMemo(() => getPattern(activeId) ?? AGENTIC_PATTERNS[0], [activeId]);
  const accent = ACCENT_CLASSES[pattern.accent];

  const handleSelect = (id: string) => {
    setActiveId(id);
    setTourActive(false);
    setStepIndex(0);
  };

  const handleStart = () => {
    setTourActive(true);
    setStepIndex(0);
  };
  const handleEnd = () => {
    setTourActive(false);
    setStepIndex(0);
  };
  const handleNext = () => setStepIndex((i) => Math.min(pattern.tour.length - 1, i + 1));
  const handlePrev = () => setStepIndex((i) => Math.max(0, i - 1));

  const activeStep = tourActive ? pattern.tour[stepIndex] : null;

  const isRAI = pattern.id === "rai-guardrails";

  return (
    <div className="flex h-[calc(100vh-3rem)] w-full overflow-hidden">
      <PatternSidebar activeId={activeId} onSelect={handleSelect} />

      {/* Scenario panel — only for the RAI pattern */}
      {isRAI && <RAIScenarioPanel activeStepIndex={tourActive ? stepIndex : -1} />}

      {/* Canvas + floating tour bar */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Header strip */}
        <div className="border-b border-border bg-card/30 px-5 py-3 flex items-center gap-3">
          <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", accent.bg)}>
            <Workflow className={cn("h-4 w-4", accent.text)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight truncate">{pattern.name}</h1>
              <Badge variant="outline" className={cn("text-[10px]", accent.border, accent.text)}>
                Pattern
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">{pattern.tagline}</p>
          </div>
          {!notesOpen && (
            <button
              type="button"
              onClick={() => setNotesOpen(true)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-[11px] font-medium hover:border-primary/50 hover:text-primary"
              title="Show educational notes"
            >
              <BookOpen className="h-3.5 w-3.5" /> Show notes
            </button>
          )}
        </div>

        {/* Canvas */}
        <div className="flex-1 relative">
          <PatternCanvas
            pattern={pattern}
            activeNodeIds={activeStep?.nodeIds ?? []}
            activeEdgeIds={activeStep?.edgeIds ?? []}
          />
          <PatternTourBar
            pattern={pattern}
            isActive={tourActive}
            stepIndex={stepIndex}
            onStart={handleStart}
            onPrev={handlePrev}
            onNext={handleNext}
            onEnd={handleEnd}
            onJump={setStepIndex}
          />
        </div>
      </div>

      {/* Right educational notes panel */}
      {notesOpen && (
        <NotesPanel pattern={pattern} onHide={() => setNotesOpen(false)} />
      )}
    </div>
  );
}

function NotesPanel({
  pattern, onHide,
}: { pattern: ReturnType<typeof getPattern> & {} | typeof AGENTIC_PATTERNS[number]; onHide: () => void }) {
  const accent = ACCENT_CLASSES[pattern.accent];
  return (
    <aside className="hidden xl:flex w-80 shrink-0 flex-col gap-4 border-l border-border bg-card/40 p-4 overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className={cn(
            "mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            accent.border, accent.text, accent.bg,
          )}>
            <GraduationCap className="h-3 w-3" /> Educational notes
          </div>
          <h3 className="text-sm font-bold tracking-tight">{pattern.name}</h3>
        </div>
        <button
          type="button"
          onClick={onHide}
          className="shrink-0 -mt-1 -mr-1 grid h-7 w-7 place-items-center rounded-md border border-border/50 text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
          title="Hide notes"
          aria-label="Hide notes"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <NoteBlock title="What it is" icon={Workflow} accent={accent}>
        <p>{pattern.summary}</p>
      </NoteBlock>

      <NoteBlock title="Use when" icon={Lightbulb} accent={accent}>
        <BulletList items={pattern.useWhen} />
      </NoteBlock>

      <NoteBlock title="Watch out for" icon={AlertTriangle} accent={accent}>
        <BulletList items={pattern.watchOutFor} />
      </NoteBlock>

      <NoteBlock title="In production" icon={Building2} accent={accent}>
        <BulletList items={pattern.realWorld} />
      </NoteBlock>

      <NoteBlock title="Combines well with" icon={ArrowRight} accent={accent}>
        <div className="flex flex-wrap gap-1.5">
          {pattern.combinesWellWith.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
          ))}
        </div>
      </NoteBlock>

      <div className={cn("mt-2 rounded-lg border p-3 text-[11px] leading-relaxed", accent.border, accent.bg)}>
        <p className={cn("font-semibold mb-1", accent.text)}>Tip</p>
        <p className="text-muted-foreground">
          Click <span className="text-foreground font-medium">Start tour</span> below the canvas to walk through this pattern step-by-step. Each step highlights the active nodes and edges and explains both <em>what</em> is happening and <em>why</em>.
        </p>
      </div>
    </aside>
  );
}

function NoteBlock({
  title, icon: Icon, accent, children,
}: {
  title: string;
  icon: typeof Lightbulb;
  accent: typeof ACCENT_CLASSES[keyof typeof ACCENT_CLASSES];
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-3 text-xs leading-relaxed">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={cn("h-3 w-3", accent.text)} />
        {title}
      </div>
      <div className="text-muted-foreground [&_strong]:text-foreground">{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-1.5">
          <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

// Special left-side scenario panel rendered only for the Responsible AI
// pattern. Shows the input applicant + two output cards (unsafe vs safe)
// so the user can compare what each architecture actually returns.
function RAIScenarioPanel({ activeStepIndex }: { activeStepIndex: number }) {
  // Step 5 (index 4) of the RAI tour highlights the outputs comparison.
  const outputsActive = activeStepIndex === 4;
  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col gap-3 border-r border-border bg-card/40 p-4 overflow-y-auto">
      <div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <FileText className="h-3 w-3" /> Scenario
        </div>
        <h3 className="mt-2 text-sm font-bold tracking-tight">Loan application</h3>
        <p className="text-[11px] text-muted-foreground">
          The same applicant is sent down both paths. Compare what each architecture decides.
        </p>
      </div>

      <div className="rounded-lg border border-border/60 bg-background/60 p-3 text-[11px] leading-relaxed">
        <div className="grid grid-cols-2 gap-y-1.5">
          <span className="text-muted-foreground">Applicant</span>
          <span className="font-semibold text-foreground">Jane Doe</span>
          <span className="text-muted-foreground">Income</span>
          <span className="font-mono text-foreground">$85,000</span>
          <span className="text-muted-foreground">Credit score</span>
          <span className="font-mono text-foreground">720</span>
          <span className="text-muted-foreground">DTI ratio</span>
          <span className="font-mono text-foreground">22%</span>
          <span className="text-muted-foreground">Requested</span>
          <span className="font-mono text-foreground">$25,000</span>
          <span className="text-muted-foreground">ZIP code</span>
          <span className="font-mono text-foreground">90210</span>
        </div>
      </div>

      {/* Unsafe AI output */}
      <div
        className={cn(
          "rounded-lg border-2 p-3 text-[11px] leading-relaxed transition-all",
          "border-rose-400/60 bg-rose-500/5",
          outputsActive && "ring-4 ring-rose-400/40 shadow-lg",
        )}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-rose-300">
          <ShieldAlert className="h-3.5 w-3.5" /> Unsafe AI output
        </div>
        <p className="font-semibold text-rose-200">❌ Rejected</p>
        <p className="mt-1 text-muted-foreground">
          "Applicant profile does not meet our risk criteria for this product."
        </p>
        <p className="mt-2 text-[10px] text-rose-300/80">
          Hidden reason: model correlated ZIP 90210 with a historical risk band and hallucinated a vague justification. Not auditable.
        </p>
      </div>

      {/* Responsible AI output */}
      <div
        className={cn(
          "rounded-lg border-2 p-3 text-[11px] leading-relaxed transition-all",
          "border-emerald-400/60 bg-emerald-500/5",
          outputsActive && "ring-4 ring-emerald-400/40 shadow-lg",
        )}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" /> Responsible AI output
        </div>
        <p className="font-semibold text-emerald-200">✓ Approved at 7.4% APR</p>
        <p className="mt-1 text-muted-foreground">
          "DTI 22% within policy (max 36%); credit 720 above threshold of 680; no derogatory items in last 24 months."
        </p>
        <p className="mt-2 text-[10px] text-emerald-300/80">
          ZIP, name, gender stripped before evaluation. Reason for Decision logged for ECOA / EU AI Act compliance.
        </p>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Run the guided tour below the canvas to see exactly which agent intercepts the data and how the safe path produces an explainable decision.
      </p>
    </aside>
  );
}
