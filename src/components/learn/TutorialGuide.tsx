// The tutorial being followed, beside whatever page the person is on (R529).
//
// It says the one step to do next, in the page's own words, with a link to
// where it is done, and ticks it a moment after the thing exists. It folds to
// a small pill; closing it puts the tutorial away until it is resumed on Learn.
//
// The document scrolls, not the page area, so the guide is fixed to the
// window, at the left edge of the page area as measured: never over the menu,
// whether the menu is open, folded to icons or hidden on a phone.
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTutorialGuide } from "@/hooks/use-tutorial-guide";
import { announceTutorialChange, linkIsHere, nextStepIndex, tutorialById } from "@/lib/tutorials";
import { reportFailure } from "@/lib/silentFailureNet";
import { cn } from "@/lib/utils";
import { hideTutorial } from "@/utils/tutorials.functions";

/** Folded or open, per browser: a convenience, so it is fine to lose. */
const FOLDED_KEY = "agentswarms:tutorial-guide-folded.v1";

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFolded(v: boolean) {
  try {
    window.localStorage.setItem(FOLDED_KEY, v ? "1" : "0");
  } catch {
    /* private window: it stays as it is for this page only */
  }
}

export function TutorialGuide() {
  const { pathname, search } = useLocation();
  const { active, checking, refresh, setActive } = useTutorialGuide();
  const hide = useServerFn(hideTutorial);
  const [folded, setFolded] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);
  const lastDone = useRef<{ id: string; count: number } | null>(null);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => setFolded(readFolded()), []);

  // The page area's left edge, followed as the menu opens and folds.
  useEffect(() => {
    const area = anchor?.parentElement;
    if (!area) return;
    const measure = () => setLeft(Math.max(0, Math.round(area.getBoundingClientRect().left)));
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(area);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);

  const tutorial = active ? tutorialById(active.id) : undefined;
  const done = active?.progress?.done ?? [];
  const doneCount = done.filter(Boolean).length;

  // A step that ticked since the last look is named for a few seconds, so the
  // tick is noticed without a toast.
  useEffect(() => {
    if (!active || !tutorial) {
      lastDone.current = null;
      return;
    }
    const prev = lastDone.current;
    lastDone.current = { id: active.id, count: doneCount };
    if (!prev || prev.id !== active.id || doneCount <= prev.count) return;
    const newest = [...done.keys()].reverse().find((i) => done[i]);
    if (newest === undefined) return;
    setJustDone(tutorial.steps[newest].title);
    const t = window.setTimeout(() => setJustDone(null), 5000);
    return () => window.clearTimeout(t);
    // done is derived from active; doneCount is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, doneCount, tutorial]);

  const marker = <span ref={setAnchor} hidden />;
  const place = { left: left + 16 };

  // Learn shows every tutorial in full; the guide would only repeat it there.
  if (!active || !tutorial || pathname === "/learn") return marker;

  const next = nextStepIndex(done);
  const finished = active.progress !== null && next === -1;
  const step = next >= 0 ? tutorial.steps[next] : null;
  const target = (next >= 0 && active.progress?.links[next]) || step?.link;
  const link = target && !linkIsHere(target, pathname, search) ? target : null;
  const note = next >= 0 ? active.progress?.notes[next] : null;

  const toggleFold = () => {
    const v = !folded;
    setFolded(v);
    writeFolded(v);
  };

  const close = async () => {
    setActive(null);
    try {
      await hide({ data: { id: active.id } });
    } catch (e) {
      // Not put away on the server: it would come back on the next look.
      reportFailure("put the tutorial away", e);
    } finally {
      announceTutorialChange();
    }
  };

  if (folded) {
    return (
      <>
        {marker}
        <button
          type="button"
          onClick={toggleFold}
          style={place}
          className="pointer-events-auto fixed bottom-4 z-30 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs shadow-md transition hover:border-primary/40"
          aria-label={`Show the tutorial guide: ${tutorial.title}`}
          title="Show the tutorial guide"
        >
          <GraduationCap className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[14rem] truncate font-medium">{tutorial.title}</span>
          <span className="tabular-nums text-muted-foreground">
            {doneCount}/{tutorial.steps.length}
          </span>
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </>
    );
  }

  return (
    <>
      {marker}
      <aside
        aria-label="Tutorial guide"
        style={place}
        className="pointer-events-auto fixed bottom-4 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-card shadow-lg"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <GraduationCap className="h-4 w-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {tutorial.title}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={toggleFold}
            aria-label="Fold the tutorial guide"
            title="Fold"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void close()}
            aria-label="Close the tutorial guide"
            title="Close. Resume it on Learn."
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="space-y-2.5 px-3 py-3">
          <ol
            className="flex gap-1"
            aria-label={`${doneCount} of ${tutorial.steps.length} steps done`}
          >
            {tutorial.steps.map((s, i) => (
              <li
                key={s.id}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  done[i] ? "bg-emerald-500/70" : i === next ? "bg-primary/60" : "bg-muted",
                )}
              />
            ))}
          </ol>

          {justDone && (
            <p
              className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"
              role="status"
            >
              <Check className="h-3.5 w-3.5" /> Done: {justDone}
            </p>
          )}

          {active.error ? (
            <p className="text-xs text-muted-foreground">
              The steps could not be checked just now: {active.error}
            </p>
          ) : finished ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Every step is done.</p>
              {active.progress && active.progress.made.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {active.progress.made.slice(0, 4).map((m) => (
                    <li key={`${m.label}:${m.name}`} className="truncate">
                      <span className="text-muted-foreground">{m.label}: </span>
                      <Link
                        to={m.link.to as never}
                        search={(m.link.search ?? {}) as never}
                        className="font-medium text-primary hover:underline"
                      >
                        {m.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2 pt-1">
                <Button asChild size="sm" variant="outline">
                  <Link to="/learn">More tutorials</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void close()}>
                  Close
                </Button>
              </div>
            </div>
          ) : step ? (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground tabular-nums">
                Step {next + 1} of {tutorial.steps.length}
              </p>
              <p className="text-sm font-medium leading-5">{step.title}</p>
              <p className="text-xs leading-5 text-muted-foreground">{step.how}</p>
              {note && (
                <p
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs leading-5",
                    note.tone === "problem"
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-foreground/80",
                  )}
                >
                  {note.text}
                </p>
              )}
              <div className="flex items-center gap-2 pt-1">
                {link && (
                  <Button asChild size="sm">
                    <Link to={link.to as never} search={(link.search ?? {}) as never}>
                      {active.progress?.links[next] ? "Go to it" : step.cta}
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void refresh()}
                  disabled={checking}
                  title="Look again now. It also looks by itself every half minute."
                >
                  {checking ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Check
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
