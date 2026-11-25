// Model serving (R538): every model that answers requests, in one place. A
// model's own Automation tab runs its endpoint; this page is where to see all
// of them at once, and which one wants a look.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Rocket } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, TaskBadge } from "@/components/ml/mlUi";
import { fmtInt, relTime } from "@/components/ml/mlFormat";
import { useAuth } from "@/hooks/use-auth";
import { copiesLine, endpointState, sortEndpoints, trafficLine, type Tone } from "@/lib/mlConsole";
import { cn } from "@/lib/utils";
import { mlServingOverview, type MlServingOverview } from "@/utils/mlConsole.functions";

export const Route = createFileRoute("/_authenticated/ml_/serving")({
  component: ServingPage,
  head: () => ({
    meta: [
      { title: "Model serving — AgentSwarms" },
      {
        name: "description",
        content:
          "Every model that answers requests: the version it serves, how traffic splits, and how busy it is.",
      },
    ],
  }),
});

const TONE_STYLE: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/15 text-red-600 dark:text-red-400",
  idle: "bg-muted text-muted-foreground",
};

function ServingPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const load = useServerFn(mlServingOverview);
  const [data, setData] = useState<MlServingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      setData(await load({ data: { access_token: token } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // An endpoint starting or scaling changes on its own.
  useEffect(() => {
    if (!data?.endpoints.some((e) => e.status === "starting" || e.copies.starting > 0)) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [data, reload]);

  const rows = useMemo(() => (data ? sortEndpoints(data.endpoints) : []), [data]);
  const live = rows.filter((e) => e.status !== "stopped");
  const stopped = rows.filter((e) => e.status === "stopped");
  const stats = useMemo(() => {
    const look = live.filter((e) => {
      const t = endpointState(e).tone;
      return t === "bad" || t === "warn";
    }).length;
    return {
      serving: live.filter((e) => e.status === "ready").length,
      copies: live.reduce((n, e) => n + e.copies.ready, 0),
      requests: live.reduce((n, e) => n + e.request_count, 0),
      look,
    };
  }, [live]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Model serving"
        description="Every model that answers requests: the version it serves, how traffic splits between versions, and how busy it is."
        actions={
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {error && !data ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm font-medium">Could not load the endpoints</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !data ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Endpoints serving" value={fmtInt(stats.serving)} />
            <Stat label="Copies running" value={fmtInt(stats.copies)} />
            <Stat label="Requests answered" value={fmtInt(stats.requests)} />
            <Stat
              label="Need a look"
              value={fmtInt(stats.look)}
              accent={stats.look > 0 ? "text-amber-700 dark:text-amber-400" : undefined}
            />
          </div>

          {live.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="Nothing is served yet"
              description="A model answers requests once its production version is deployed: open the model, then Automation → Deploy. Until then it still predicts in batches and through the ML API."
              action={
                <Button asChild variant="outline">
                  <Link to="/ml">Open ML Models</Link>
                </Button>
              }
            />
          ) : (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Model</th>
                      <th className="px-3 py-2.5 font-medium">State</th>
                      <th className="px-3 py-2.5 font-medium">Traffic</th>
                      <th className="px-3 py-2.5 font-medium">Copies</th>
                      <th className="px-3 py-2.5 text-right font-medium">Requests</th>
                      <th className="px-4 py-2.5 text-right font-medium">Last request</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((e) => {
                      const s = endpointState(e);
                      return (
                        // The model's name is the row's one control: a link a
                        // keyboard reaches, not a clickable row around it.
                        <tr
                          key={e.deployment_id}
                          className="border-b last:border-0 hover:bg-muted/40"
                        >
                          <td className="px-4 py-3 align-top">
                            <Link
                              to="/ml/$modelId"
                              params={{ modelId: e.model.id }}
                              search={{ tab: "automation" }}
                              className="font-medium hover:underline"
                            >
                              {e.model.name}
                            </Link>
                            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              <TaskBadge task={e.model.task} />
                              <span>
                                {e.runs_on.kind === "kserve"
                                  ? `KServe · ${e.runs_on.namespace}/${e.runs_on.name}`
                                  : "Sandboxes the app scales"}
                              </span>
                              {e.model.shared ? <span>· shared with you</span> : null}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <Chip
                              label={s.label}
                              style={TONE_STYLE[s.tone]}
                              pulse={e.status === "starting"}
                            />
                            {s.detail ? (
                              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                                {s.detail}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                            {trafficLine(e)}
                          </td>
                          <td className="px-3 py-3 align-top text-xs tabular-nums text-muted-foreground">
                            {copiesLine(e)}
                          </td>
                          <td className="px-3 py-3 text-right align-top tabular-nums">
                            {fmtInt(e.request_count)}
                          </td>
                          <td className="px-4 py-3 text-right align-top text-xs text-muted-foreground">
                            {e.last_used_at ? relTime(e.last_used_at) : "never"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {data.undeployed.length > 0 ? (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-sm font-medium">In production without an endpoint</p>
                <p className="text-xs text-muted-foreground">
                  These answer batch predictions and ML API calls, each starting cold. Deploy one
                  for answers in milliseconds.
                </p>
                <ul className="flex flex-wrap gap-2 pt-1">
                  {data.undeployed.map((m) => (
                    <li key={m.id}>
                      <Link
                        to="/ml/$modelId"
                        params={{ modelId: m.id }}
                        search={{ tab: "automation" }}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                      >
                        {m.name}
                        {m.production_version !== null ? (
                          <span className="text-muted-foreground">v{m.production_version}</span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {stopped.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Stopped:{" "}
              {stopped.map((e, i) => (
                <span key={e.deployment_id}>
                  {i ? ", " : ""}
                  <Link
                    to="/ml/$modelId"
                    params={{ modelId: e.model.id }}
                    search={{ tab: "automation" }}
                    className="hover:underline"
                  >
                    {e.model.name}
                  </Link>
                </span>
              ))}
              .
            </p>
          ) : null}

          <p className={cn("text-xs text-muted-foreground")}>
            {data.serving_backend === "kserve"
              ? "New endpoints run on KServe: the cluster scales each one's pods."
              : "Endpoints run as sandboxes the app starts and scales between each endpoint's minimum and maximum copies."}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", accent)}>
        {value}
      </p>
    </Card>
  );
}
