// "Recent runs" tab for the /swarms page.
//
// Merges live runs from the in-browser run manager (which keeps executing
// across navigation) with the durable swarm_runs history in the DB. Running
// or paused ("waiting") runs can be cancelled from here — directly if this tab
// owns the run, or via a DB flag the owning tab's cancel-watch picks up. A run
// parked on the server at an approval ("suspended") is ended by deciding the
// approval, so its row opens the approvals inbox instead (R108).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  RefreshCw,
  History,
  Play,
  Square,
  BarChart3,
  Hourglass,
  CheckCircle2,
  XCircle,
  Ban,
} from "lucide-react";
import { toast } from "sonner";
import {
  subscribe as subscribeRuns,
  getSnapshot as getRunsSnapshot,
  cancelRun as cancelManagedRun,
  cancelByDbRunId,
  type ManagedRunView,
} from "@/lib/swarmRunManager";
import {
  formatRunDuration,
  parkedApproval,
  parkedRunView,
  runStatusView,
  showsDuration,
  type RunStatusView,
  type RunTone,
} from "@/lib/swarmRunStatus";
import { openApprovalsInbox } from "@/lib/approvalsInbox";

type DbRun = {
  id: string;
  swarm_id: string | null;
  swarm_name: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  step_count: number;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  cancel_requested: boolean;
};

type RunItem = {
  key: string;
  dbRunId: string | null;
  localRunId: string | null; // set when this tab owns the live run
  swarmId: string | null;
  swarmName: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  steps: number;
  costUsd: number;
  live: boolean;
};

function useManagedRuns(): ManagedRunView[] {
  return useSyncExternalStore(subscribeRuns, getRunsSnapshot, getRunsSnapshot);
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function duration(startedAt: number, finishedAt: number | null): string {
  return formatRunDuration((finishedAt ?? Date.now()) - startedAt);
}

const TONE: Record<RunTone, { cls: string; Icon: typeof Play }> = {
  active: { cls: "bg-amber-500/10 text-amber-400 border-amber-500/30", Icon: Loader2 },
  waiting: { cls: "bg-amber-500/10 text-amber-300 border-amber-500/30", Icon: Hourglass },
  success: {
    cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    Icon: CheckCircle2,
  },
  error: { cls: "bg-destructive/10 text-destructive border-destructive/30", Icon: XCircle },
  muted: { cls: "bg-muted text-muted-foreground border-border", Icon: Ban },
};

function StatusBadge({ view, spinning }: { view: RunStatusView; spinning: boolean }) {
  const { cls, Icon } = TONE[view.tone];
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] ${cls}`}>
      <Icon className={`h-3 w-3 ${spinning ? "animate-spin" : ""}`} />
      {view.label}
    </Badge>
  );
}

/** The approval requests of the parked runs on screen, by run id. */
type ParkedRequests = { byRun: Map<string, string[]>; failed: boolean };

export function RecentRunsPanel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const liveRuns = useManagedRuns();
  const [dbRuns, setDbRuns] = useState<DbRun[]>([]);
  const [requests, setRequests] = useState<ParkedRequests>({ byRun: new Map(), failed: false });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("swarm_runs")
      .select(
        "id, swarm_id, swarm_name, status, started_at, finished_at, step_count, total_cost_usd, total_tokens_in, total_tokens_out, cancel_requested",
      )
      .order("started_at", { ascending: false })
      .limit(50);
    const rows = (data ?? []) as DbRun[];
    // A parked run is only waiting for someone if its request is still
    // pending; the request says so, the run row cannot (R108).
    const parked = rows.filter((r) => r.status === "suspended").map((r) => r.id);
    const next: ParkedRequests = { byRun: new Map(), failed: false };
    if (parked.length) {
      const { data: asks, error } = await supabase
        .from("approvals")
        .select("swarm_run_id, status")
        .in("swarm_run_id", parked);
      if (error) next.failed = true;
      for (const a of asks ?? []) {
        if (!a.swarm_run_id) continue;
        next.byRun.set(a.swarm_run_id, [...(next.byRun.get(a.swarm_run_id) ?? []), a.status]);
      }
    }
    setDbRuns(rows);
    setRequests(next);
    setLoading(false);
  }, [user]);

  const viewOf = (item: RunItem): RunStatusView =>
    item.status === "suspended" && item.dbRunId
      ? parkedRunView(parkedApproval(requests.byRun.get(item.dbRunId), requests.failed))
      : runStatusView(item.status);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while any run is active (or briefly after) so the list stays fresh
  // without realtime. Live in-memory runs already update instantly.
  const hasActive =
    liveRuns.some((r) => runStatusView(r.status).live) ||
    dbRuns.some((r) => runStatusView(r.status).live);
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const items = useMemo<RunItem[]>(() => {
    const map = new Map<string, RunItem>();
    for (const r of dbRuns) {
      map.set(r.id, {
        key: r.id,
        dbRunId: r.id,
        localRunId: null,
        swarmId: r.swarm_id,
        swarmName: r.swarm_name || "Untitled swarm",
        status: r.cancel_requested && runStatusView(r.status).live ? "cancelled" : r.status,
        startedAt: new Date(r.started_at).getTime(),
        finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
        steps: r.step_count,
        costUsd: Number(r.total_cost_usd ?? 0),
        live: false,
      });
    }
    for (const run of liveRuns) {
      const key = run.dbRunId ?? run.runId;
      const prev = map.get(key);
      map.set(key, {
        key,
        dbRunId: run.dbRunId,
        localRunId: run.runId,
        swarmId: run.swarmId,
        swarmName: run.swarmName || prev?.swarmName || "Untitled swarm",
        // The live view is authoritative for a run this tab owns.
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        steps: Object.values(run.nodeStatus).filter((s) => s === "done").length || prev?.steps || 0,
        costUsd: run.costUsd || prev?.costUsd || 0,
        live: true,
      });
    }
    return Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
  }, [dbRuns, liveRuns]);

  const cancel = async (item: RunItem) => {
    if (item.localRunId && item.live) {
      cancelManagedRun(item.localRunId);
    } else if (item.dbRunId) {
      await cancelByDbRunId(item.dbRunId);
    }
    toast.info("Cancelling run…");
    // Reflect immediately, then reconcile with the DB.
    setDbRuns((prev) =>
      prev.map((r) => (r.id === item.dbRunId ? { ...r, status: "cancelled" } : r)),
    );
    setTimeout(() => void load(), 1200);
  };

  const activeCount = items.filter((i) => runStatusView(i.status).live).length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <History className="h-5 w-5 text-primary" /> Recent runs
            {activeCount > 0 && (
              <Badge
                variant="outline"
                className="ml-1 text-[10px] border-amber-500/40 text-amber-400"
              >
                {activeCount} active
              </Badge>
            )}
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Runs keep executing even if you leave the canvas. Cancel a running run here; a run
            waiting for an approval goes on or stops when the approval is decided.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} className="h-8">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
        </div>
      ) : items.length === 0 ? (
        <Card className="border-dashed border-2 border-border/50">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <History className="h-12 w-12 text-muted-foreground mb-3" />
            <p className="text-muted-foreground text-center max-w-sm">
              No runs yet. Open a swarm, enter an input and hit <strong>Run</strong> — it'll show up
              here and keep going even if you navigate away.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const view = viewOf(item);
            return (
              <Card key={item.key} className="border-border/60">
                <CardContent className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold truncate">{item.swarmName}</p>
                      <StatusBadge view={view} spinning={item.status === "running"} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>started {relTime(item.startedAt)}</span>
                      {showsDuration(view, item.finishedAt) && (
                        <>
                          <span>·</span>
                          <span>{duration(item.startedAt, item.finishedAt)}</span>
                        </>
                      )}
                      {item.steps > 0 && (
                        <>
                          <span>·</span>
                          <span>{item.steps} steps</span>
                        </>
                      )}
                      {item.costUsd > 0 && (
                        <>
                          <span>·</span>
                          <span>${item.costUsd.toFixed(4)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {item.swarmId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() =>
                          navigate({
                            to: "/swarms",
                            search: {
                              swarm: item.swarmId!,
                              view: "canvas",
                              template: undefined,
                            },
                          })
                        }
                      >
                        <Play className="h-3.5 w-3.5 mr-1.5" /> Open
                      </Button>
                    )}
                    {item.dbRunId && (
                      <Button variant="ghost" size="sm" className="h-8" asChild>
                        <Link to="/analytics/observability/$runId" params={{ runId: item.dbRunId }}>
                          <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Trace
                        </Link>
                      </Button>
                    )}
                    {view.awaitingDecision && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => openApprovalsInbox()}
                      >
                        <Hourglass className="h-3.5 w-3.5 mr-1.5" /> Review approval
                      </Button>
                    )}
                    {view.cancellable && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-destructive hover:text-destructive"
                        onClick={() => void cancel(item)}
                      >
                        <Square className="h-3.5 w-3.5 mr-1.5" /> Cancel
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
