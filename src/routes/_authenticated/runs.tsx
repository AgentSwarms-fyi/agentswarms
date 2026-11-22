// Runs: everything that ran for you, in one list.
//
// Pipelines, workflows, swarms, scheduled emails, model training and batch
// predictions, notebooks, SQL models, data monitors, evaluations, and the
// scheduled refreshes that keep only their latest result. Each kind had its
// own page and its own words for "it worked"; here they share one list, one
// set of words, and one question: what needs a look.
import { createFileRoute, Link } from "@tanstack/react-router";
import { MessageSquareText, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { RunFixDialog } from "@/components/runs/RunFixDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRunDuration } from "@/lib/swarmRunStatus";
import { askAssistant } from "@/lib/assistantThread";
import {
  askAboutFailure,
  dayLabel,
  filterRuns,
  IN_FLIGHT,
  NEEDS_A_LOOK,
  RUN_KINDS,
  RUN_STATUS_LABEL,
  runCounts,
  runKindLabel,
  TRIGGER_LABEL,
  type RunKind,
  type RunRow,
  type RunStatus,
} from "@/lib/runs";
import { cn } from "@/lib/utils";
import { runsListFn } from "@/utils/runs.functions";

export const Route = createFileRoute("/_authenticated/runs")({
  component: RunsPage,
  head: () => ({ meta: [{ title: "Runs — AgentSwarms" }] }),
});

const WINDOWS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const DOT: Record<RunStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-primary",
  waiting: "bg-amber-500",
  succeeded: "bg-emerald-500",
  partial: "bg-amber-500",
  alert: "bg-amber-500",
  skipped: "bg-muted-foreground/40",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/40",
};

type Show = "all" | "needs_a_look" | "in_flight";

function RunsPage() {
  const [days, setDays] = useState(14);
  const [show, setShow] = useState<Show>("all");
  const [kinds, setKinds] = useState<Set<RunKind>>(new Set());
  const [data, setData] = useState<{
    runs: RunRow[];
    unread: RunKind[];
    capped: RunKind[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await runsListFn({ data: { days } });
      setData({ runs: r.runs, unread: r.unread, capped: r.capped });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Runs could not be read");
    } finally {
      setBusy(false);
    }
  }, [days]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  // While something is still running, look again every half minute; once
  // everything has finished, the list holds still.
  const anyInFlight = !!data?.runs.some((r) => IN_FLIGHT.has(r.status));
  useEffect(() => {
    if (!anyInFlight) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [anyInFlight, load]);

  const counts = useMemo(() => runCounts(data?.runs ?? []), [data]);
  const shown = useMemo(() => filterRuns(data?.runs ?? [], { kinds, show }), [data, kinds, show]);
  const byDay = useMemo(() => {
    const out: Array<{ day: string; runs: RunRow[] }> = [];
    for (const r of shown) {
      const day = dayLabel(r.startedAt);
      if (out.at(-1)?.day !== day) out.push({ day, runs: [] });
      out.at(-1)!.runs.push(r);
    }
    return out;
  }, [shown]);

  const toggleKind = (k: RunKind) =>
    setKinds((was) => {
      const next = new Set(was);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const windowLabel = WINDOWS.find((w) => w.days === days)?.label ?? `${days} days`;

  return (
    <div className="mx-auto min-w-0 max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Runs"
        description="Everything that ran for you: pipelines, workflows, swarms, scheduled emails, models, notebooks, SQL models, monitors and evaluations."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Which runs" className="flex rounded-lg border p-0.5">
          {(
            [
              ["all", `All ${counts.total}`],
              ["needs_a_look", `Needs a look ${counts.needsALook}`],
              ["in_flight", `Not finished ${counts.inFlight}`],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={show === v}
              onClick={() => setShow(v)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                show === v
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          In the last
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border bg-background px-2 py-1 text-xs text-foreground"
          >
            {WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {counts.byKind.size > 1 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Kinds of run">
          {RUN_KINDS.filter((k) => counts.byKind.has(k.id)).map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kinds.has(k.id)}
              onClick={() => toggleKind(k.id)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition-colors",
                kinds.has(k.id)
                  ? "border-foreground/30 bg-muted text-foreground"
                  : "text-muted-foreground hover:border-foreground/20 hover:text-foreground",
              )}
            >
              {k.label} {counts.byKind.get(k.id)}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <p className="text-sm text-muted-foreground">Runs could not be read: {error}</p>
      ) : !data ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          {data.runs.length === 0
            ? `Nothing ran in the last ${windowLabel}.`
            : show === "needs_a_look"
              ? `Nothing needs a look in the last ${windowLabel}.`
              : show === "in_flight"
                ? "Everything has finished."
                : "No runs of these kinds."}
        </p>
      ) : (
        <div className="space-y-5">
          {byDay.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">{g.day}</h2>
              <ul className="divide-y rounded-lg border bg-card">
                {g.runs.map((r) => (
                  <RunItem key={`${r.kind}:${r.id}`} run={r} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {data && (data.unread.length > 0 || data.capped.length > 0) && (
        <p className="text-xs text-muted-foreground">
          {data.unread.length > 0 &&
            `Not read just now: ${data.unread.map((k) => runKindLabel(k).toLowerCase()).join(", ")}. `}
          {data.capped.length > 0 &&
            `Only the newest 100 are listed for: ${data.capped.map((k) => runKindLabel(k).toLowerCase()).join(", ")}.`}
        </p>
      )}
    </div>
  );
}

function RunItem({ run: r }: { run: RunRow }) {
  const [fixing, setFixing] = useState(false);
  const time = new Date(r.startedAt);
  const facts = [
    RUN_STATUS_LABEL[r.status],
    r.trigger && TRIGGER_LABEL[r.trigger],
    Number.isNaN(time.getTime())
      ? null
      : time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    r.durationMs !== null && !IN_FLIGHT.has(r.status) ? formatRunDuration(r.durationMs) : null,
    r.costUsd !== null && r.costUsd > 0 ? `$${r.costUsd.toFixed(r.costUsd < 0.01 ? 4 : 2)}` : null,
  ].filter(Boolean);
  const name = r.link ? (
    <Link
      to={r.link.to as never}
      search={(r.link.search ?? {}) as never}
      className="truncate font-medium hover:underline"
    >
      {r.name}
    </Link>
  ) : (
    <span className="truncate font-medium">{r.name}</span>
  );
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[r.status])} aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-baseline gap-2 text-sm">
          {name}
          <span className="shrink-0 text-xs text-muted-foreground">{runKindLabel(r.kind)}</span>
        </div>
        <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
        {r.error && <p className="line-clamp-2 text-xs leading-5 text-foreground/80">{r.error}</p>}
        {r.latestOnly && (
          <p className="text-[11px] text-muted-foreground">Only its latest run is kept.</p>
        )}
      </div>
      {NEEDS_A_LOOK.has(r.status) && (
        <div className="flex shrink-0 flex-col items-end gap-0.5 sm:flex-row sm:items-center">
          {r.fixTarget && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => setFixing(true)}
            >
              <Wrench className="h-3.5 w-3.5" /> Suggest a fix
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={() => askAssistant(askAboutFailure(r))}
          >
            <MessageSquareText className="h-3.5 w-3.5" /> Ask about this
          </Button>
        </div>
      )}
      {r.fixTarget && (
        <RunFixDialog
          open={fixing}
          onOpenChange={setFixing}
          target={r.fixTarget}
          name={r.name}
          onAskAssistant={() => askAssistant(askAboutFailure(r))}
        />
      )}
    </li>
  );
}
