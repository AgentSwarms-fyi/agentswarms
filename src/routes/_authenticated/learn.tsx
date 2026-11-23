// Learn: tutorials done in the app itself, and what is new (R529).
//
// A tutorial is started here and followed on the pages it names, with the
// guide in the corner. Its steps tick from what the person really made since
// starting it (src/lib/tutorialChecks.ts), so this page and the guide show the
// same thing and neither can be ahead of the person.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, Check, Clock, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/hooks/use-auth";
import { markWhatsNewSeen } from "@/hooks/use-whats-new";
import type { ObjectLink } from "@/lib/objectKinds";
import {
  announceTutorialChange,
  nextStepIndex,
  TUTORIALS,
  type Tutorial,
  type TutorialId,
} from "@/lib/tutorials";
import { reportFailure } from "@/lib/silentFailureNet";
import { cn } from "@/lib/utils";
import { WHATS_NEW, type WhatsNewEntry } from "@/lib/whatsNew";
import {
  learnState,
  resumeTutorial,
  startTutorial,
  type LearnState,
  type TutorialState,
} from "@/utils/tutorials.functions";

export const Route = createFileRoute("/_authenticated/learn")({
  component: LearnPage,
  head: () => ({ meta: [{ title: "Learn — AgentSwarms" }] }),
});

type Ready = Extract<LearnState, { ready: true }>;

function day(date: string, withYear = false): string {
  // A date-only string read as local midnight, so it is the same day everywhere.
  return new Date(`${date.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function ObjectLinkTo({
  link,
  className,
  children,
}: {
  link: ObjectLink;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={link.to as never} search={(link.search ?? {}) as never} className={className}>
      {children}
    </Link>
  );
}

function LearnPage() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const read = useServerFn(learnState);
  const start = useServerFn(startTutorial);
  const resume = useServerFn(resumeTutorial);
  const [state, setState] = useState<LearnState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<TutorialId | null>(null);
  // How many entries were new when the page opened: still labelled on this
  // visit, though opening the page marks them seen.
  const [newOnOpen, setNewOnOpen] = useState(0);
  // Marked once per visit: an effect run twice (as development runs them)
  // would otherwise find nothing new the second time and drop the labels.
  const seenOnOpen = useRef<number | null>(null);

  useEffect(() => {
    if (seenOnOpen.current === null) seenOnOpen.current = markWhatsNewSeen();
    setNewOnOpen(seenOnOpen.current);
  }, []);

  const load = useCallback(async () => {
    try {
      setState(await read({ data: {} }));
      setFailed(null);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "The tutorials could not be read.");
    }
  }, [read]);

  useEffect(() => {
    if (!userId) return;
    void load();
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [userId, load]);

  const go = (link: ObjectLink) =>
    void navigate({ to: link.to as never, search: (link.search ?? {}) as never });

  const begin = async (t: Tutorial, again: boolean) => {
    if (
      again &&
      !(await confirmAsk({
        title: `Start “${t.title}” again?`,
        body: "Its steps tick again only for what you make from now. What you made before is kept.",
        actionLabel: "Start again",
      }))
    ) {
      return;
    }
    setBusy(t.id);
    try {
      const res = await start({ data: { id: t.id } });
      if (!res.ok) {
        toast.error("The tutorial did not start", { description: res.error });
        return;
      }
      announceTutorialChange();
      go(t.steps[0].link);
    } catch (e) {
      reportFailure("start the tutorial", e);
    } finally {
      setBusy(null);
    }
  };

  const carryOn = async (t: Tutorial, s: TutorialState) => {
    setBusy(t.id);
    try {
      if (s.run.hidden) {
        const res = await resume({ data: { id: t.id } });
        if (!res.ok) {
          toast.error("The guide did not come back", { description: res.error });
          return;
        }
        announceTutorialChange();
      }
      const next = nextStepIndex(s.progress?.done ?? []);
      const i = next < 0 ? 0 : next;
      go(s.progress?.links[i] ?? t.steps[i].link);
    } catch (e) {
      reportFailure("bring the tutorial back", e);
    } finally {
      setBusy(null);
    }
  };

  const ready = state?.ready ? state : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 p-6">
      <PageHeader
        title="Learn"
        description="Short tutorials done in the app itself, on the sample data every workspace has. A step ticks when what it asks for exists, and what you make is yours to keep."
      />

      {failed && <p className="text-sm text-destructive">{failed}</p>}
      {state && !state.ready && (
        <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {state.message}
        </p>
      )}

      <section aria-labelledby="tutorials-heading" className="space-y-4">
        <h2 id="tutorials-heading" className="text-sm font-semibold text-foreground">
          Tutorials
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {TUTORIALS.map((t) => (
            <TutorialCard
              key={t.id}
              tutorial={t}
              ready={ready}
              loading={!state && !failed}
              busy={busy === t.id}
              onStart={(again) => void begin(t, again)}
              onCarryOn={(s) => void carryOn(t, s)}
            />
          ))}
        </div>
      </section>

      <WhatsNew newCount={newOnOpen} />
    </div>
  );
}

function Needs({ tutorial, ready }: { tutorial: Tutorial; ready: Ready | null }) {
  if (!tutorial.needs.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
      {tutorial.needs.map((n) => {
        const ok = ready ? ready.needs[n] : null;
        if (n === "model") {
          return (
            <li key={n} className="flex items-center gap-1.5">
              {ok ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <span className="h-3.5 w-3.5" />
              )}
              {ok === false ? (
                <span>
                  Uses a model, and no key was found for you.{" "}
                  <Link to="/integrations" className="text-primary hover:underline">
                    Connect one
                  </Link>{" "}
                  first, or ask whoever shares one.
                </span>
              ) : (
                <span>Uses a model</span>
              )}
            </li>
          );
        }
        return (
          <li key={n} className="flex items-center gap-1.5">
            {ok ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <span className="h-3.5 w-3.5" />
            )}
            {ok === false ? (
              <span>Needs the lakehouse, which is not switched on for this server.</span>
            ) : (
              <span>Uses the lakehouse</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TutorialCard({
  tutorial: t,
  ready,
  loading,
  busy,
  onStart,
  onCarryOn,
}: {
  tutorial: Tutorial;
  ready: Ready | null;
  loading: boolean;
  busy: boolean;
  onStart: (again: boolean) => void;
  onCarryOn: (s: TutorialState) => void;
}) {
  const s = ready?.started[t.id];
  const done = s?.progress?.done ?? [];
  const doneCount = done.filter(Boolean).length;
  const next = s?.progress ? nextStepIndex(done) : -1;
  const finished = Boolean(s?.run.finished_at) && next === -1;
  const blocked = t.needs.includes("lakehouse") && ready?.needs.lakehouse === false;

  return (
    <article
      id={`tutorial-${t.id}`}
      className="flex scroll-mt-6 flex-col rounded-xl border bg-card p-5"
    >
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t.area}
        <span aria-hidden>·</span>
        <Clock className="h-3 w-3" />
        <span className="tabular-nums normal-case tracking-normal">{t.minutes} min</span>
      </p>
      <h3 className="mt-1.5 text-base font-semibold leading-6 text-balance">{t.title}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t.outcome}</p>
      <Needs tutorial={t} ready={ready} />

      <ol className="mt-4 space-y-2">
        {t.steps.map((step, i) => {
          const isDone = Boolean(done[i]);
          const isNext = s && !finished && i === next;
          const note = s?.progress?.notes[i];
          return (
            <li key={step.id} className="flex gap-2.5">
              <span
                className={cn(
                  "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold tabular-nums",
                  isDone
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : isNext
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                )}
              >
                {isDone ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className={cn("text-sm leading-5", isDone && "text-muted-foreground")}>
                  {step.title}
                </p>
                {note && (
                  <p
                    className={cn(
                      "mt-0.5 text-xs leading-5",
                      note.tone === "problem"
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-muted-foreground",
                    )}
                  >
                    {note.text}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {s?.error && (
        <p className="mt-3 text-xs text-muted-foreground">
          The steps could not be checked just now: {s.error}
        </p>
      )}

      {finished && s?.progress && s.progress.made.length > 0 && (
        <div className="mt-4 rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            Done {s.run.finished_at ? day(s.run.finished_at) : ""}. It made:
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {s.progress.made.slice(0, 6).map((m) => (
              <li key={`${m.label}:${m.name}`} className="truncate">
                <span className="text-muted-foreground">{m.label}: </span>
                <ObjectLinkTo link={m.link} className="text-primary hover:underline">
                  {m.name}
                </ObjectLinkTo>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
        {loading ? (
          <Loader2
            className="h-4 w-4 animate-spin text-muted-foreground"
            aria-label="Reading your tutorials"
          />
        ) : !ready ? null : !s ? (
          <Button size="sm" disabled={busy || blocked} onClick={() => onStart(false)}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Start
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        ) : finished ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || blocked}
            onClick={() => onStart(true)}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Do it again
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => onCarryOn(s)}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {s.run.hidden ? "Resume" : `Go to step ${next + 1}`}
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || blocked}
              onClick={() => onStart(true)}
            >
              Start again
            </Button>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {doneCount} of {t.steps.length} done
            </span>
          </>
        )}
      </div>
    </article>
  );
}

function WhatsNew({ newCount }: { newCount: number }) {
  return (
    <section aria-labelledby="whats-new-heading" className="max-w-3xl space-y-4">
      <div>
        <h2 id="whats-new-heading" className="text-sm font-semibold text-foreground">
          What&apos;s new
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What changed in the app, newest first, with where to find it.
        </p>
      </div>
      <ol className="divide-y rounded-xl border bg-card">
        {WHATS_NEW.map((e, i) => (
          <WhatsNewRow
            key={e.id}
            entry={e}
            isNew={i < newCount}
            showDate={i === 0 || WHATS_NEW[i - 1].date !== e.date}
          />
        ))}
      </ol>
    </section>
  );
}

function WhatsNewRow({
  entry: e,
  isNew,
  showDate,
}: {
  entry: WhatsNewEntry;
  isNew: boolean;
  showDate: boolean;
}) {
  const tutorial = e.tutorial ? TUTORIALS.find((t) => t.id === e.tutorial) : undefined;
  return (
    <li className="grid gap-x-5 gap-y-1 px-4 py-3.5 sm:grid-cols-[5.5rem_1fr]">
      <p className="text-xs tabular-nums text-muted-foreground sm:pt-0.5">
        {showDate ? day(e.date) : <span className="sr-only">{day(e.date)}</span>}
      </p>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {e.title}
          {isNew && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              New
            </span>
          )}
        </p>
        <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{e.body}</p>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <ObjectLinkTo
            link={e.link}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            {e.cta}
            <ArrowRight className="h-3.5 w-3.5" />
          </ObjectLinkTo>
          {tutorial && (
            <a
              href={`#tutorial-${tutorial.id}`}
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              Tutorial: {tutorial.title}
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
