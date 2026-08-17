import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { listClaim, UNKNOWN_COUNT } from "@/lib/listClaim";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import { QualityTrends } from "@/components/observability/QualityTrends";

export const Route = createFileRoute("/_authenticated/analytics_/observability")({
  component: ObservabilityList,
});

type Run = {
  id: string;
  swarm_name: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  total_latency_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  step_count: number;
  error_count: number;
};

function ObservabilityList() {
  const { user, loading: authLoading } = useAuth();
  const [runs, setRuns] = useState<Run[] | null>(null);
  // Why the run list could not be read, or null. Without it a 403 left `runs`
  // at [] and the page said "0 swarm runs" and "No swarm runs yet. Execute a
  // swarm from the Swarms canvas" — to an account holding 26.
  const [loadError, setLoadError] = useState<string | null>(null);
  const location = useLocation();
  const isDetailRoute = location.pathname.startsWith("/analytics/observability/");

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("swarm_runs")
        .select(
          "id, swarm_name, status, started_at, finished_at, total_latency_ms, total_tokens_in, total_tokens_out, total_cost_usd, step_count, error_count",
        )
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) {
        setLoadError(error.message);
        setRuns([]);
        return;
      }
      setLoadError(null);
      setRuns((data ?? []) as Run[]);
    })();
  }, [user]);

  if (isDetailRoute) return <Outlet />;

  // A count and an empty state are claims only a completed read may make.
  const claim = listClaim({
    loaded: runs !== null,
    error: loadError,
    count: runs?.length ?? 0,
  });

  if (authLoading || !runs) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Observability
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Swarm Observability</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {claim.message === "error" ? UNKNOWN_COUNT : runs.length} swarm run
          {claim.message !== "error" && runs.length === 1 ? "" : "s"} · click a row to inspect
          agent-level traces · auto-deleted after 30 days
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          Looking for single-agent or playground traces? See{" "}
          <Link to="/traces" className="underline">
            Traces &amp; Logs
          </Link>
          . User activity lives in the{" "}
          <Link to="/audit" className="underline">
            Audit Log
          </Link>
          .
        </p>
      </div>

      <QualityTrends />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Swarm</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-right">Steps</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claim.message === "error" && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm" role="alert">
                  <span className="text-warning">
                    Your swarm runs could not be loaded — {loadError}.
                  </span>
                  <span className="block text-muted-foreground">
                    Any runs you have are still recorded; this page just cannot list them right now.
                  </span>
                </TableCell>
              </TableRow>
            )}
            {claim.message === "empty" && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">
                  No swarm runs yet. Execute a swarm from the Swarms canvas to see traces here.
                </TableCell>
              </TableRow>
            )}
            {runs.map((r) => (
              <TableRow key={r.id} className="hover:bg-muted/40">
                <TableCell className="text-xs font-mono text-muted-foreground p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    {format(new Date(r.started_at), "MMM dd HH:mm:ss")}
                  </Link>
                </TableCell>
                <TableCell className="text-sm p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    {r.swarm_name ?? "Untitled swarm"}
                  </Link>
                </TableCell>
                <TableCell className="text-center p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    <Badge
                      variant="outline"
                      className={
                        r.status === "success"
                          ? "border-emerald-500/40 text-emerald-500"
                          : r.status === "error"
                            ? "border-red-500/40 text-red-500"
                            : r.status === "running"
                              ? "border-amber-500/40 text-amber-500"
                              : "border-border text-muted-foreground"
                      }
                    >
                      {r.status}
                    </Badge>
                  </Link>
                </TableCell>
                <TableCell className="text-right text-xs font-mono p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    {r.step_count}
                  </Link>
                </TableCell>
                <TableCell className="text-right text-xs font-mono p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    {r.error_count}
                  </Link>
                </TableCell>
                <TableCell className="text-right text-xs font-mono p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    {r.total_latency_ms}ms
                  </Link>
                </TableCell>
                <TableCell className="text-right text-xs font-mono p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    {r.total_tokens_in}/{r.total_tokens_out}
                  </Link>
                </TableCell>
                <TableCell className="text-right text-xs font-mono p-0">
                  <Link
                    to="/analytics/observability/$runId"
                    params={{ runId: r.id }}
                    className="block p-2"
                  >
                    ${Number(r.total_cost_usd ?? 0).toFixed(4)}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
