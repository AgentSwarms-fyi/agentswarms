// One model: what it predicts, how well, from what, and every version and
// job it has had. Polls while a job is live so training is watched, not
// waited for.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import * as Recharts from "recharts";
import {
  ArrowLeft,
  Copy,
  FileClock,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Share2,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { confirmAsk, promptAsk } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  mlCancelJob,
  mlDeleteModel,
  mlGetModel,
  mlPromoteVersion,
  mlTrainVersion,
  mlUpdateModel,
  type MlModelDetail,
} from "@/utils/ml.functions";
import type { MlJobRow, MlVersionRow } from "@/utils/ml/access.server";
import {
  ML_JOB_LIVE,
  ML_PRIMARY_METRIC,
  type MlFeatureImportance,
  type MlFeatureSchemaEntry,
  type MlForecastPoint,
  type MlHistoryPoint,
  type MlLeaderboardRow,
  type MlSource,
  type MlTask,
} from "@/utils/ml/types";
import {
  JobStatusChip,
  MetricTile,
  StageChip,
  TaskBadge,
  fmtDuration,
  fmtInt,
  fmtMetric,
  metricDirection,
  metricLabel,
  metricTone,
  relTime,
} from "@/components/ml/mlUi";

// React 19's stricter JSX typing rejects recharts' class components — cast via any.
/* eslint-disable @typescript-eslint/no-explicit-any */
const ResponsiveContainer = Recharts.ResponsiveContainer as any;
const BarChart = Recharts.BarChart as any;
const Bar = Recharts.Bar as any;
const XAxis = Recharts.XAxis as any;
const YAxis = Recharts.YAxis as any;
const Tooltip = Recharts.Tooltip as any;
const ComposedChart = Recharts.ComposedChart as any;
const Line = Recharts.Line as any;
const CartesianGrid = Recharts.CartesianGrid as any;
const Legend = Recharts.Legend as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const Route = createFileRoute("/_authenticated/ml_/$modelId")({
  component: ModelPage,
  head: () => ({ meta: [{ title: "Model — AgentSwarms" }] }),
});

const LIVE = new Set<string>(ML_JOB_LIVE);

function ModelPage() {
  const { modelId } = Route.useParams();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const navigate = useNavigate();
  const getFn = useServerFn(mlGetModel);
  const trainFn = useServerFn(mlTrainVersion);
  const cancelFn = useServerFn(mlCancelJob);
  const promoteFn = useServerFn(mlPromoteVersion);
  const updateFn = useServerFn(mlUpdateModel);
  const deleteFn = useServerFn(mlDeleteModel);

  const [detail, setDetail] = useState<MlModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const [trainOpen, setTrainOpen] = useState(false);
  const [budget, setBudget] = useState<number | "">("");
  const [maxRows, setMaxRows] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [logsFor, setLogsFor] = useState<MlJobRow | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      setDetail(await getFn({ data: { access_token: token, model_id: modelId } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, getFn, modelId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const liveJob = detail?.jobs.find((j) => LIVE.has(j.status)) ?? null;
  useEffect(() => {
    if (!liveJob) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [liveJob, reload]);

  const focus = useMemo(() => {
    if (!detail) return null;
    const prod = detail.versions.find((v) => v.id === detail.model.production_version_id);
    return prod ?? detail.versions.find((v) => v.status === "ready") ?? detail.versions[0] ?? null;
  }, [detail]);

  const startTraining = async () => {
    setBusy(true);
    try {
      const r = await trainFn({
        data: {
          access_token: token,
          model_id: modelId,
          time_budget_minutes: budget === "" ? undefined : Number(budget),
          max_rows: maxRows === "" ? undefined : Number(maxRows),
        },
      });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Training started");
        setTrainOpen(false);
        setTab("overview");
      }
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const promote = async (
    v: MlVersionRow,
    stage: "production" | "staging" | "archived" | "candidate",
  ) => {
    const label =
      stage === "production"
        ? `Promote v${v.version} to production? Agents and dashboards using this model switch to it immediately.`
        : stage === "archived"
          ? `Archive v${v.version}? It stays in the registry with its metrics and passport but is no longer offered.`
          : null;
    if (
      label &&
      !(await confirmAsk({
        title: label,
        actionLabel: stage === "production" ? "Promote" : "Archive",
      }))
    )
      return;
    const r = await promoteFn({ data: { access_token: token, version_id: v.id, stage } });
    if (!r.ok) toast.error(r.error);
    else
      toast.success(
        stage === "production" ? `v${v.version} is now in production` : `v${v.version} → ${stage}`,
      );
    await reload();
  };

  const rename = async () => {
    if (!detail) return;
    const name = await promptAsk({
      title: "Rename model",
      input: { defaultValue: detail.model.name, required: true },
      actionLabel: "Rename",
    });
    if (!name || name === detail.model.name) return;
    const r = await updateFn({ data: { access_token: token, model_id: modelId, name } });
    if (!r.ok) toast.error(r.error);
    await reload();
  };

  const remove = async () => {
    if (!detail) return;
    if (
      !(await confirmAsk({
        title: `Delete "${detail.model.name}"?`,
        body: "Every version, its metrics and its training jobs are removed, and anything predicting with this model stops. This cannot be undone.",
        actionLabel: "Delete model",
      }))
    )
      return;
    await deleteFn({ data: { access_token: token, model_id: modelId } });
    toast.success("Model deleted");
    void navigate({ to: "/ml" });
  };

  const cancel = async (job: MlJobRow) => {
    if (!(await confirmAsk({ title: `Cancel this training job? The version stays as cancelled.` })))
      return;
    await cancelFn({ data: { access_token: token, job_id: job.id } });
    await reload();
  };

  if (detail === null && error !== null) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm font-medium">Could not load this model</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                Try again
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to="/ml">All models</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const { model, shared, versions, jobs, limits } = detail;
  const src = model.source as MlSource;
  const task = model.task as MlTask;
  const primary = ML_PRIMARY_METRIC[task];

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/ml"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> ML Models
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="font-display text-3xl font-semibold tracking-tight">{model.name}</h1>
            <TaskBadge task={model.task} />
            {focus ? <StageChip stage={focus.stage} status={focus.status} /> : null}
            {shared ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Share2 className="h-3 w-3" /> shared with you
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Predicts <span className="font-medium text-foreground">{model.target_column}</span> from{" "}
            <span className="font-medium text-foreground">
              {src.schema}.{src.table}
            </span>
            {model.description ? ` — ${model.description}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          {!shared ? (
            <>
              <Button variant="outline" size="sm" onClick={() => void rename()}>
                Rename
              </Button>
              <Button size="sm" disabled={Boolean(liveJob)} onClick={() => setTrainOpen(true)}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Train new version
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-600"
                onClick={() => void remove()}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {liveJob ? (
        <LiveJobBanner job={liveJob} onCancel={shared ? undefined : () => void cancel(liveJob)} />
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>
          <TabsTrigger value="jobs">Jobs ({jobs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          {!focus || focus.status !== "ready" ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                {liveJob
                  ? "The first version is training. Metrics appear here the moment it finishes."
                  : focus?.status === "failed"
                    ? "The last training run failed — see the Jobs tab for the error, then train a new version."
                    : "No trained version yet."}
              </CardContent>
            </Card>
          ) : (
            <VersionOverview version={focus} task={task} primary={primary} model={model} />
          )}
        </TabsContent>

        <TabsContent value="versions" className="mt-4">
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Algorithm</th>
                  <th className="px-3 py-2 text-right font-medium">{metricLabel(primary)}</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 font-medium">Trained</th>
                  <th className="px-3 py-2 font-medium">Snapshot</th>
                  {!shared ? <th className="px-3 py-2 text-right font-medium">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  const value = (v.metrics as Record<string, number | null>)?.[primary] ?? null;
                  return (
                    <tr key={v.id} className={cn("border-t", v.id === focus?.id && "bg-primary/5")}>
                      <td className="px-3 py-2 font-medium">v{v.version}</td>
                      <td className="px-3 py-2">
                        <StageChip stage={v.stage} status={v.status} />
                      </td>
                      <td className="px-3 py-2">{v.algorithm ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMetric(primary, value)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtInt(v.training_rows)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {v.trained_at ? relTime(v.trained_at) : "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {v.training_snapshot_id ?? "—"}
                      </td>
                      {!shared ? (
                        <td className="px-3 py-2 text-right">
                          {v.status === "ready" && v.stage !== "production" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void promote(v, "production")}
                            >
                              Promote
                            </Button>
                          ) : null}
                          {v.status === "ready" &&
                          v.stage !== "archived" &&
                          v.stage !== "production" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-1"
                              onClick={() => void promote(v, "archived")}
                            >
                              Archive
                            </Button>
                          ) : null}
                          {v.status === "ready" && v.stage === "archived" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void promote(v, "candidate")}
                            >
                              Restore
                            </Button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="jobs" className="mt-4">
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-3 py-2 text-right font-medium">Logs</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-muted-foreground" colSpan={5}>
                      No jobs yet.
                    </td>
                  </tr>
                ) : (
                  jobs.map((j) => {
                    const r = j.result as {
                      algorithm?: string;
                      primary_metric?: string;
                      metrics?: Record<string, number | null>;
                    } | null;
                    return (
                      <tr key={j.id} className="border-t">
                        <td className="px-3 py-2 text-muted-foreground">{relTime(j.created_at)}</td>
                        <td className="px-3 py-2">
                          <JobStatusChip status={j.status} />
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {fmtDuration(j.started_at, j.finished_at)}
                        </td>
                        <td className="max-w-md px-3 py-2">
                          {j.error ? (
                            <span className="text-red-600 dark:text-red-400">
                              {j.error.slice(0, 200)}
                            </span>
                          ) : r?.algorithm ? (
                            <span>
                              {r.algorithm} · {metricLabel(r.primary_metric ?? "")}{" "}
                              {fmtMetric(
                                r.primary_metric ?? "",
                                r.metrics?.[r.primary_metric ?? ""],
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="ghost" onClick={() => setLogsFor(j)}>
                            <ScrollText className="mr-1 h-3.5 w-3.5" /> View
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={trainOpen} onOpenChange={setTrainOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Train a new version</DialogTitle>
            <DialogDescription>
              Reads {src.schema}.{src.table} as of the current snapshot and trains v
              {(versions[0]?.version ?? 0) + 1}. The version you promote stays in production until
              you switch.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Time budget (minutes)</Label>
              <Input
                type="number"
                min={1}
                placeholder={String(limits.train_time_budget_minutes)}
                value={budget}
                onChange={(e) => setBudget(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max training rows</Label>
              <Input
                type="number"
                min={100}
                placeholder={String(limits.train_max_rows)}
                value={maxRows}
                onChange={(e) => setMaxRows(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTrainOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void startTraining()}>
              {busy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Train
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={logsFor !== null} onOpenChange={(o) => !o && setLogsFor(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Training logs</DialogTitle>
            <DialogDescription>
              {logsFor
                ? `${logsFor.status} · started ${relTime(logsFor.started_at ?? logsFor.created_at)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">
            {[
              logsFor?.logs,
              logsFor?.error && !logsFor.logs?.includes(logsFor.error)
                ? `\n===== error =====\n${logsFor.error}`
                : "",
            ]
              .filter(Boolean)
              .join("\n") || "No output was captured."}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LiveJobBanner({ job, onCancel }: { job: MlJobRow; onCancel?: () => void }) {
  const tail = (job.logs ?? "").split("\n").filter(Boolean).slice(-6);
  return (
    <Card className="border-blue-500/30 bg-blue-500/5">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            <span className="font-medium">Training in progress</span>
            <JobStatusChip status={job.status} />
            <span className="text-muted-foreground">
              {fmtDuration(job.started_at ?? job.created_at)}
            </span>
          </div>
          {onCancel ? (
            <Button size="sm" variant="outline" onClick={onCancel}>
              <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
            </Button>
          ) : null}
        </div>
        {tail.length ? (
          <pre className="max-h-32 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {tail.join("\n")}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">Starting the sandbox…</p>
        )}
      </CardContent>
    </Card>
  );
}

function VersionOverview({
  version,
  task,
  primary,
  model,
}: {
  version: MlVersionRow;
  task: MlTask;
  primary: string;
  model: MlModelDetail["model"];
}) {
  const metrics = (version.metrics ?? {}) as Record<
    string,
    number | null | { labels: string[]; matrix: number[][] }
  >;
  const scalar = Object.entries(metrics).filter(([, v]) => typeof v === "number" || v === null) as [
    string,
    number | null,
  ][];
  const ordered = [
    ...scalar.filter(([k]) => k === primary),
    ...scalar.filter(([k]) => k !== primary && k !== "holdout_periods"),
  ].slice(0, 6);
  const cm = metrics.confusion_matrix as { labels: string[]; matrix: number[][] } | undefined;
  const importance = (version.feature_importance ?? []) as MlFeatureImportance[];
  const schema = (version.feature_schema ?? []) as MlFeatureSchemaEntry[];
  const leaderboard = (version.leaderboard ?? []) as MlLeaderboardRow[];
  const warnings = (version.warnings ?? []) as string[];
  const forecast = version.forecast as {
    points: MlForecastPoint[];
    history: MlHistoryPoint[];
  } | null;
  const usedFeatures = schema.filter((e) => e.role === "feature");

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {ordered.map(([k, v]) => (
          <MetricTile
            key={k}
            label={metricLabel(k)}
            value={fmtMetric(k, v)}
            hint={k === primary ? `primary · ${metricDirection(k)} is better` : undefined}
            tone={k === primary ? metricTone(k, v) : undefined}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {task === "forecast" && forecast ? (
          <Card className="lg:col-span-2">
            <CardContent className="p-4">
              <p className="text-sm font-medium">Forecast</p>
              <p className="mb-3 text-xs text-muted-foreground">
                History, the projected periods and a residual-based band that widens with distance.
              </p>
              <ForecastChart history={forecast.history} points={forecast.points} />
            </CardContent>
          </Card>
        ) : null}

        {importance.length ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm font-medium">What the model relies on</p>
              <p className="mb-3 text-xs text-muted-foreground">
                Permutation importance on the holdout set: how much the score drops when a column is
                shuffled.
              </p>
              <ImportanceChart rows={importance.slice(0, 15)} />
            </CardContent>
          </Card>
        ) : null}

        {cm ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm font-medium">Confusion matrix</p>
              <p className="mb-3 text-xs text-muted-foreground">
                Rows are the truth, columns the prediction.
              </p>
              <ConfusionMatrix labels={cm.labels} matrix={cm.matrix} />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium">Leaderboard</p>
            <p className="mb-3 text-xs text-muted-foreground">
              Every candidate tried, scored on the same holdout.
            </p>
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Algorithm</th>
                  <th className="py-1 text-right font-medium">
                    {leaderboard[0] ? metricLabel(leaderboard[0].metric) : "Score"}
                  </th>
                  <th className="py-1 text-right font-medium">Fit</th>
                  <th className="py-1 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((r) => (
                  <tr
                    key={r.algorithm}
                    className={cn("border-t", r.algorithm === version.algorithm && "font-medium")}
                  >
                    <td className="py-1">
                      {r.algorithm}
                      {r.algorithm === version.algorithm ? " ★" : ""}
                    </td>
                    <td className="py-1 text-right tabular-nums">{fmtMetric(r.metric, r.value)}</td>
                    <td className="py-1 text-right tabular-nums">
                      {r.fit_seconds ? `${r.fit_seconds}s` : "—"}
                    </td>
                    <td className="py-1 text-right text-muted-foreground">
                      {r.status}
                      {r.note ? ` · ${r.note}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <p className="font-medium">Lineage</p>
            <Detail k="Algorithm" v={version.algorithm ?? "—"} />
            <Detail
              k="Trained on"
              v={`${fmtInt(version.training_rows)} rows${version.training_sampled ? ` (sampled from ${fmtInt(version.training_total_rows)})` : ""}`}
            />
            <Detail
              k="Features"
              v={
                task === "forecast"
                  ? `${model.time_column} → ${model.target_column}`
                  : `${usedFeatures.length} columns`
              }
            />
            <Detail
              k="Lakehouse snapshot"
              v={
                version.training_snapshot_id ? String(version.training_snapshot_id) : "not recorded"
              }
            />
            <Detail
              k="Decision id"
              v={
                version.decision_id ? (
                  <span className="inline-flex items-center gap-1 font-mono text-xs">
                    {version.decision_id.slice(0, 8)}…
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        void navigator.clipboard?.writeText(version.decision_id ?? "");
                        toast.success("Decision id copied");
                      }}
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                    <Link
                      to="/traces"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <FileClock className="h-3 w-3" /> audit
                    </Link>
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <Detail
              k="Artifact"
              v={
                version.artifact_sha256
                  ? `sha256 ${version.artifact_sha256.slice(0, 12)}… · ${fmtInt(version.artifact_bytes)} bytes`
                  : "—"
              }
            />
            <Detail
              k="Trained"
              v={version.trained_at ? new Date(version.trained_at).toLocaleString() : "—"}
            />
            {warnings.length ? (
              <ul className="mt-2 space-y-1 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Detail({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

function ImportanceChart({ rows }: { rows: MlFeatureImportance[] }) {
  const data = rows.map((r) => ({ feature: r.feature, importance: Math.max(0, r.importance) }));
  return (
    <div style={{ height: Math.max(160, data.length * 24) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="feature" width={140} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v: number) => v.toFixed(4)} />
          <Bar dataKey="importance" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ForecastChart({
  history,
  points,
}: {
  history: MlHistoryPoint[];
  points: MlForecastPoint[];
}) {
  const data = [
    ...history.map((h) => ({ period: h.period, actual: h.y })),
    ...points.map((p) => ({ period: p.period, forecast: p.yhat, lo: p.lo, hi: p.hi })),
  ];
  return (
    <div style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="period" tick={{ fontSize: 10 }} minTickGap={24} />
          <YAxis tick={{ fontSize: 10 }} width={56} />
          <Tooltip />
          <Legend />
          <Line
            type="monotone"
            dataKey="actual"
            stroke="var(--chart-1)"
            dot={false}
            strokeWidth={2}
            name="actual"
          />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke="var(--chart-2)"
            dot={false}
            strokeWidth={2}
            strokeDasharray="6 3"
            name="forecast"
          />
          <Line
            type="monotone"
            dataKey="hi"
            stroke="var(--chart-2)"
            dot={false}
            strokeWidth={1}
            strokeDasharray="2 3"
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="lo"
            stroke="var(--chart-2)"
            dot={false}
            strokeWidth={1}
            strokeDasharray="2 3"
            legendType="none"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ConfusionMatrix({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  return (
    <div className="overflow-auto">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="p-1" />
            {labels.map((l) => (
              <th
                key={l}
                className="max-w-[6rem] truncate p-1 text-center font-medium text-muted-foreground"
              >
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => {
            const total = row.reduce((a, b) => a + b, 0) || 1;
            return (
              <tr key={labels[i]}>
                <th className="max-w-[6rem] truncate p-1 text-right font-medium text-muted-foreground">
                  {labels[i]}
                </th>
                {row.map((n, j) => {
                  const share = n / total;
                  return (
                    <td
                      key={j}
                      className={cn(
                        "h-8 w-12 text-center tabular-nums",
                        i === j ? "font-semibold" : "",
                      )}
                      style={{
                        background: `color-mix(in oklch, var(--chart-1) ${Math.round(share * 70)}%, transparent)`,
                      }}
                    >
                      {n}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
