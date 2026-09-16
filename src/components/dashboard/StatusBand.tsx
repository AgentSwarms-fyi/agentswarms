// The one line the dashboard exists to say: is anything broken right now?
//
// Every status in here was already recorded — by the SaaS sync, the warehouse
// connection test, the swarm scheduler, the pipeline run, the data monitor.
// None of it was ever aggregated, so a source that stopped syncing three weeks
// ago looked exactly like one that synced this morning from anywhere except
// its own settings page. This is the aggregation, and it is the first thing on
// the page rather than a pill inside a hero, because "is my platform healthy"
// is the question somebody opens a dashboard to ask.
//
// It says "everything is running" out loud when nothing is wrong. A band that
// renders only on failure teaches nobody it exists, and its absence then reads
// as "not loaded yet" rather than "nothing to report".

import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Attention = {
  /** What is wrong, in the words the owner would use. */
  label: string;
  count: number;
  to: string;
};

export function StatusBand({
  items,
  loading,
  checkedAt,
}: {
  items: Attention[];
  loading: boolean;
  checkedAt: Date | null;
}) {
  const live = items.filter((i) => i.count > 0);
  const total = live.reduce((n, i) => n + i.count, 0);
  const ok = !loading && live.length === 0;

  return (
    <section
      aria-label="Platform status"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border px-4 py-3",
        ok && "border-emerald-500/30 bg-emerald-500/5",
        !ok && live.length > 0 && "border-amber-500/40 bg-amber-500/10",
        loading && "border-border bg-card",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {ok ? (
          <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-emerald-500" />
        ) : live.length > 0 ? (
          <AlertTriangle className="h-4.5 w-4.5 shrink-0 text-amber-500" />
        ) : (
          <span className="h-4.5 w-4.5 shrink-0 animate-pulse rounded-full bg-muted" />
        )}
        <p className="text-sm font-medium">
          {loading
            ? "Checking the platform…"
            : ok
              ? "Everything is running"
              : `${total} thing${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`}
        </p>
      </div>

      {live.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {live.map((i) => (
            <Link key={i.to + i.label} to={i.to}>
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-background/60 font-normal hover:bg-background"
              >
                <span className="mr-1.5 font-semibold tabular-nums">{i.count}</span>
                {i.label}
              </Badge>
            </Link>
          ))}
        </div>
      )}

      {checkedAt && (
        // Freshness, stated rather than assumed. A dashboard with no timestamp
        // is one you cannot tell apart from a stale tab left open overnight.
        <p className="ml-auto text-xs text-muted-foreground tabular-nums">
          checked {checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
    </section>
  );
}
