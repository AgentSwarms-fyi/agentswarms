// ML operations (R538): across every model a person can see, what needs a
// look, what is running, what is due, and what just finished. Each row opens
// the model page on the tab that holds the detail.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, JobStatusChip } from "@/components/ml/mlUi";
import { fmtInt, relTime } from "@/components/ml/mlFormat";
import { useAuth } from "@/hooks/use-auth";
import {
  duration,
  lastRunOutcome,
  nextRunLine,
  scheduleKind,
  type ModelTab,
} from "@/lib/mlConsole";
import { cn } from "@/lib/utils";
import { mlOperationsOverview, type MlOperationsOverview } from "@/utils/mlConsole.functions";

export const Route = createFileRoute("/_authenticated/ml_/operations")({
  component: OperationsPage,
  head: () => ({
    meta: [
      { title: "ML operations — AgentSwarms" },
      {
        name: "description",
        content:
          "What needs a look, what is running, what is due and what just finished, across every model you can see.",
      },
    ],
  }),
});

const SEVERITY_STYLE = {
  bad: "bg-red-500/15 text-red-600 dark:text-red-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
} as const;

/** An ML pipeline opens in the workflow editor, where it is run and changed (R540). */
function PipelineLink({ id, name }: { id: string; name: string }) {
  return (
    <Link to="/workflows" search={{ open: id }} className="font-medium hover:underline">
      {name}
    </Link>
  );
}

function ModelLink({ id, name, tab }: { id: string; name: string; tab: ModelTab }) {
  return (
    <Link
      to="/ml/$modelId"
      params={{ modelId: id }}
      search={{ tab }}
      className="font-medium hover:underline"
    >
      {name}
    </Link>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function OperationsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const load = useServerFn(mlOperationsOverview);
  const [data, setData] = useState<MlOperationsOverview | null>(null);
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
  // Something running changes on its own; nothing running, nothing to poll.
  useEffect(() => {
    if (
      !data ||
      (data.running.length === 0 &&
        data.predicting.length === 0 &&
        data.pipelineRunning.length === 0)
    )
      return;
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [data, reload]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="ML operations"
        description="What needs a look, what is running, what is due and what just finished, across every model you can see."
        actions={
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {error && !data ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm font-medium">Could not load ML operations</p>
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
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : data.models === 0 && data.pipelines === 0 ? (
        <EmptyState
          icon={Activity}
          title="No models yet"
          description="Training, predictions, schedules and endpoints show up here once you have a model."
          action={
            <Button asChild>
              <Link to="/ml/new">Train a model</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat
              label="Needs a look"
              value={fmtInt(data.attention.length)}
              accent={data.attention.length ? "text-amber-700 dark:text-amber-400" : undefined}
            />
            <Stat
              label="Running now"
              value={fmtInt(data.running.length + data.pipelineRunning.length)}
            />
            <Stat label="Predicting now" value={fmtInt(data.predicting.length)} />
            <Stat label="Scheduled" value={fmtInt(data.upcoming.length)} />
          </div>

          <Section
            title="Needs a look"
            hint="Failures in the last seven days, endpoints that are failing, behind production or rolled back, and production versions whose data drifted or whose accuracy fell."
          >
            {data.attention.length === 0 ? (
              <Card>
                <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Nothing needs a look.
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="divide-y p-0">
                  {data.attention.map((a, i) => (
                    <div key={`${a.model_id}-${i}`} className="flex items-start gap-3 px-4 py-3">
                      <Chip
                        label={a.severity === "bad" ? "failed" : "check"}
                        style={SEVERITY_STYLE[a.severity]}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {a.pipeline_id ? (
                            <PipelineLink id={a.pipeline_id} name={a.model_name} />
                          ) : (
                            <ModelLink id={a.model_id} name={a.model_name} tab={a.tab} />
                          )}
                          <span className="text-muted-foreground"> · {a.what}</span>
                        </p>
                        {a.detail ? (
                          <p className="mt-0.5 break-words text-xs text-muted-foreground">
                            {a.detail}
                          </p>
                        ) : null}
                      </div>
                      {a.at ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {relTime(a.at)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </Section>

          {data.running.length + data.predicting.length + data.pipelineRunning.length > 0 ? (
            <Section
              title="Running now"
              hint="ML pipelines, training, imports and batch predictions in progress. A job waiting for room, such as a node with a free GPU, says so."
            >
              <Card>
                <CardContent className="divide-y p-0">
                  {data.pipelineRunning.map((r) => (
                    <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                      <JobStatusChip status="running" />
                      <p className="min-w-0 flex-1 text-sm">
                        <PipelineLink id={r.workflow_id} name={r.name} />
                        <span className="text-muted-foreground"> · pipeline run</span>
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        started {relTime(r.started_at)}
                      </span>
                    </div>
                  ))}
                  {data.running.map((j) => (
                    <div key={j.id} className="flex items-start gap-3 px-4 py-3">
                      <JobStatusChip status={j.status} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <ModelLink id={j.model_id} name={j.model_name} tab="jobs" />
                          <span className="text-muted-foreground">
                            {" "}
                            · {j.import ? "Importing" : "Training"}
                            {j.version !== null ? ` v${j.version}` : ""}
                            {j.shards && j.shards > 1 ? ` on ${j.shards} workers` : ""}
                            {j.trigger && j.trigger !== "manual" ? ` (${j.trigger})` : ""}
                          </span>
                        </p>
                        {j.waiting ? (
                          <p className="mt-0.5 break-words text-xs text-amber-700 dark:text-amber-400">
                            {j.waiting}
                          </p>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        started {relTime(j.started_at ?? j.created_at)}
                      </span>
                    </div>
                  ))}
                  {data.predicting.map((p) => (
                    <div key={p.id} className="flex items-start gap-3 px-4 py-3">
                      <JobStatusChip status={p.status} />
                      <p className="min-w-0 flex-1 text-sm">
                        <ModelLink id={p.model_id} name={p.model_name} tab="predictions" />
                        <span className="text-muted-foreground">
                          {" "}
                          · Batch prediction{p.version !== null ? ` with v${p.version}` : ""}
                        </span>
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        started {relTime(p.created_at)}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </Section>
          ) : null}

          <Section
            title="Coming up"
            hint="Scheduled retraining and batch predictions, soonest first."
          >
            {data.upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing is scheduled. A model&apos;s Automation tab retrains or predicts on a
                schedule.
              </p>
            ) : (
              <Card>
                <CardContent className="overflow-x-auto p-0">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Model</th>
                        <th className="px-3 py-2 font-medium">Schedule</th>
                        <th className="px-3 py-2 font-medium">Next run</th>
                        <th className="px-4 py-2 font-medium">Last run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.upcoming.map((s) => (
                        <tr key={s.id} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            <ModelLink id={s.model_id} name={s.model_name} tab="automation" />
                          </td>
                          <td className="px-3 py-2.5 text-xs text-muted-foreground">
                            {scheduleKind(s.kind)} · {s.name}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-muted-foreground">
                            {nextRunLine(s.next_run_at)}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">
                            {s.last_run_at
                              ? `${lastRunOutcome(s.last_status)} ${relTime(s.last_run_at)}`
                              : "not yet"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </Section>

          <Section
            title="Recently finished"
            hint="The last fifteen ML pipeline runs, jobs and batch predictions."
          >
            {data.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has run yet.</p>
            ) : (
              <Card>
                <CardContent className="overflow-x-auto p-0">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Model or pipeline</th>
                        <th className="px-3 py-2 font-medium">What</th>
                        <th className="px-3 py-2 font-medium">Outcome</th>
                        <th className="px-3 py-2 text-right font-medium">Took</th>
                        <th className="px-4 py-2 text-right font-medium">Finished</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((r) => (
                        <tr key={`${r.type}-${r.id}`} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            {r.type === "pipeline" ? (
                              <PipelineLink id={r.workflow_id} name={r.name} />
                            ) : (
                              <ModelLink
                                id={r.model_id}
                                name={r.model_name}
                                tab={r.type === "job" ? "jobs" : "predictions"}
                              />
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-muted-foreground">
                            {r.type === "pipeline"
                              ? "ML pipeline run"
                              : r.type === "job"
                                ? `${r.import ? "Import" : "Training"}${r.version !== null ? ` v${r.version}` : ""}`
                                : `Batch prediction${r.version !== null ? ` with v${r.version}` : ""}${
                                    r.row_count ? ` · ${fmtInt(r.row_count)} rows` : ""
                                  }`}
                          </td>
                          <td className="px-3 py-2.5">
                            <JobStatusChip status={r.type === "pipeline" ? r.state : r.status} />
                          </td>
                          <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                            {duration(
                              r.type === "prediction"
                                ? r.created_at
                                : (r.started_at ?? r.created_at),
                              r.finished_at,
                            ) ?? "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                            {r.finished_at ? relTime(r.finished_at) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </Section>

          <p className={cn("text-xs text-muted-foreground")}>
            Training runs in{" "}
            {data.compute.backend === "k8s"
              ? "Kubernetes Jobs"
              : data.compute.backend === "ecs"
                ? "Fargate tasks"
                : "sandboxes"}
            , up to {fmtInt(data.compute.trainings_per_person)} at a time per person, each for up to{" "}
            {fmtInt(data.compute.time_budget_minutes)} minutes
            {data.compute.search_workers > 1
              ? `, its search spread over up to ${fmtInt(data.compute.search_workers)} workers`
              : ""}
            .{" "}
            {data.compute.training_gpus > 0
              ? `A classification or regression search asks for ${data.compute.training_gpus} GPU${data.compute.training_gpus === 1 ? "" : "s"} for XGBoost.`
              : "No GPUs: every candidate trains on CPUs."}
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
