// ML pipelines (R540): a model's work, automated end to end, where people
// look for it. A pipeline here is a workflow that trains, scores or runs a
// Kubeflow pipeline, so it has the workflow's schedule, retries, approvals
// and run history; this page is the view of them from the model side, and
// each opens in the workflow editor.
//
// R541: a pipeline can be kept as a file in the team's GitHub or GitLab
// repository — saved, updated and imported from there, and deployed by CI.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, GitMerge, Loader2, Play, Plus, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { JobStatusChip } from "@/components/ml/mlUi";
import { PipelineRepoMenu, RepoBar, RepoLine } from "@/components/ml/PipelineRepo";
import { fmtInt, relTime } from "@/components/ml/mlFormat";
import { useAuth } from "@/hooks/use-auth";
import { duration, nextRunLine } from "@/lib/mlConsole";
import { triggerLine } from "@/lib/mlPipelines";
import { reportFailure } from "@/lib/silentFailureNet";
import { cn } from "@/lib/utils";
import {
  mlPipelineCreate,
  mlPipelinesOverview,
  type MlPipelinesOverview,
} from "@/utils/mlConsole.functions";
import { workflowRunNow } from "@/utils/workflows.functions";
import { mlRepoOverview, type RepoLinkView, type RepoSummary } from "@/utils/mlRepo.functions";

export const Route = createFileRoute("/_authenticated/ml_/pipelines")({
  component: PipelinesPage,
  head: () => ({
    meta: [
      { title: "ML pipelines — AgentSwarms" },
      {
        name: "description",
        content:
          "Automate a model's work end to end: retrain, check, promote, score, or run a pipeline on your Kubeflow.",
      },
    ],
  }),
});

function PipelinesPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const navigate = useNavigate();
  const load = useServerFn(mlPipelinesOverview);
  const create = useServerFn(mlPipelineCreate);
  const runNow = useServerFn(workflowRunNow);
  const loadRepo = useServerFn(mlRepoOverview);
  const [data, setData] = useState<MlPipelinesOverview | null>(null);
  const [repo, setRepo] = useState<{ repo: RepoSummary | null; links: RepoLinkView[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const linkOf = useMemo(() => new Map((repo?.links ?? []).map((l) => [l.workflowId, l])), [repo]);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      const [overview, inRepo] = await Promise.all([
        load({ data: { access_token: token } }),
        // The repository is extra: a page that cannot read it still lists
        // the pipelines, and says why under the list.
        loadRepo({ data: { accessToken: token } }).catch((e: Error) => ({
          ok: false as const,
          error: e.message,
        })),
      ]);
      setData(overview);
      setRepo(inRepo.ok ? { repo: inRepo.repo, links: inRepo.links } : null);
      setRepoError(inRepo.ok ? (inRepo.linksError ?? null) : inRepo.error);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, load, loadRepo]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // A run in progress changes on its own.
  useEffect(() => {
    if (!data?.pipelines.some((p) => p.last?.state === "running")) return;
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [data, reload]);

  const stats = useMemo(() => {
    if (!data) return null;
    const week = Date.now() - 7 * 86_400_000;
    return {
      pipelines: data.pipelines.length,
      scheduled: data.pipelines.filter((p) => p.is_active && p.schedule !== "manual").length,
      running: data.pipelines.filter((p) => p.last?.state === "running").length,
      failed: data.recent.filter(
        (r) =>
          r.state === "failed" && new Date(r.finished_at ?? r.started_at ?? 0).getTime() >= week,
      ).length,
    };
  }, [data]);

  async function newPipeline() {
    if (!token) return;
    setBusy("new");
    try {
      const r = await create({ data: { access_token: token } });
      if (!r.ok) {
        toast.error(`Could not create it: ${r.error}`);
        return;
      }
      toast.success("ML pipeline created: pick what each step runs, then save");
      void navigate({ to: "/workflows", search: { open: r.id } });
    } catch (e) {
      reportFailure("create the ML pipeline", e);
    } finally {
      setBusy(null);
    }
  }

  async function run(id: string, name: string) {
    if (!token) return;
    setBusy(id);
    try {
      const r = await runNow({ data: { accessToken: token, id } });
      if (!r.ok) {
        toast.error(`${name} did not start: ${r.error}`);
        return;
      }
      toast.success(`${name} started`);
      await reload();
    } catch (e) {
      reportFailure(`start ${name}`, e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="ML pipelines"
        description="Automate a model's work end to end: retrain it, check it, promote it, score new rows, or run a pipeline on your Kubeflow, on a schedule or when you start it."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" disabled={busy === "new"} onClick={() => void newPipeline()}>
              {busy === "new" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-3.5 w-3.5" />
              )}
              New ML pipeline
            </Button>
          </>
        }
      />

      {error && !data ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm font-medium">Could not load ML pipelines</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !data || !stats ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : data.pipelines.length === 0 ? (
        <>
          {repo ? <RepoBar repo={repo.repo} token={token} onChanged={() => void reload()} /> : null}
          <EmptyState
            icon={GitMerge}
            title="No ML pipelines yet"
            description="An ML pipeline retrains a model, checks it, scores new rows with it, or runs a pipeline on your Kubeflow, one step after another, on a schedule or when you start it. A new one starts as retrain, then score; add approvals, notifications and Kubeflow steps in the editor."
            action={
              <Button disabled={busy === "new"} onClick={() => void newPipeline()}>
                <Plus className="mr-1.5 h-4 w-4" /> New ML pipeline
              </Button>
            }
          />
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="ML pipelines" value={fmtInt(stats.pipelines)} />
            <Stat label="On a schedule" value={fmtInt(stats.scheduled)} />
            <Stat label="Running now" value={fmtInt(stats.running)} />
            <Stat
              label="Failed this week"
              value={fmtInt(stats.failed)}
              accent={stats.failed ? "text-red-600 dark:text-red-400" : undefined}
            />
          </div>

          {repo ? <RepoBar repo={repo.repo} token={token} onChanged={() => void reload()} /> : null}

          <div className="space-y-3">
            {data.pipelines.map((p) => (
              <Card key={p.id}>
                <CardContent className="flex flex-wrap items-start gap-4 p-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to="/workflows"
                        search={{ open: p.id }}
                        className="font-medium hover:underline"
                      >
                        {p.name}
                      </Link>
                      {p.last ? <JobStatusChip status={p.last.state} /> : null}
                    </div>
                    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {p.steps.map((step, i) => (
                        <span key={`${step}-${i}`} className="inline-flex items-center gap-1">
                          {i > 0 ? <ArrowRight className="h-3 w-3 opacity-60" /> : null}
                          <span className="rounded border px-1.5 py-0.5">{step}</span>
                        </span>
                      ))}
                    </p>
                    {p.models.length || p.kubeflow.length ? (
                      <p className="text-xs text-muted-foreground">
                        {p.models.length ? `Models: ${p.models.join(", ")}` : ""}
                        {p.models.length && p.kubeflow.length ? " · " : ""}
                        {p.kubeflow.length ? `On Kubeflow: ${p.kubeflow.join(", ")}` : ""}
                      </p>
                    ) : null}
                    {p.last?.state === "failed" && p.last.error ? (
                      <p className="break-words text-xs text-destructive">{p.last.error}</p>
                    ) : null}
                    <RepoLine link={linkOf.get(p.id)} />
                  </div>
                  <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Runs</span>
                    <span>{triggerLine(p)}</span>
                    {p.is_active && p.schedule !== "manual" ? (
                      <>
                        <span className="text-muted-foreground">Next</span>
                        <span>{nextRunLine(p.next_run_at)}</span>
                      </>
                    ) : null}
                    <span className="text-muted-foreground">Last</span>
                    <span>
                      {p.last ? relTime(p.last.finished_at ?? p.last.started_at) : "never run"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === p.id || p.last?.state === "running"}
                      onClick={() => void run(p.id, p.name)}
                    >
                      {busy === p.id ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Run now
                    </Button>
                    <PipelineRepoMenu
                      pipeline={p}
                      repo={repo?.repo ?? null}
                      link={linkOf.get(p.id)}
                      token={token}
                      onChanged={() => void reload()}
                    />
                    <Button size="sm" variant="ghost" asChild>
                      <Link to="/workflows" search={{ open: p.id }}>
                        Open
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {data.recent.length ? (
            <section className="space-y-2">
              <div>
                <h2 className="text-sm font-medium">Recent runs</h2>
                <p className="text-xs text-muted-foreground">
                  Each run&apos;s steps, logs and the jobs it started are in the workflow editor.
                </p>
              </div>
              <Card>
                <CardContent className="overflow-x-auto p-0">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Pipeline</th>
                        <th className="px-3 py-2 font-medium">Outcome</th>
                        <th className="px-3 py-2 font-medium">Started by</th>
                        <th className="px-3 py-2 text-right font-medium">Took</th>
                        <th className="px-4 py-2 text-right font-medium">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((r) => (
                        <tr key={r.id} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            <Link
                              to="/workflows"
                              search={{ open: r.workflow_id }}
                              className="hover:underline"
                            >
                              {r.name}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5">
                            <JobStatusChip status={r.state} />
                          </td>
                          <td className="px-3 py-2.5 text-xs text-muted-foreground">
                            {r.trigger === "schedule"
                              ? "the schedule"
                              : r.trigger === "manual"
                                ? "a person"
                                : r.trigger === "api"
                                  ? "an API call or CI"
                                  : (r.trigger ?? "—")}
                          </td>
                          <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                            {duration(r.started_at, r.finished_at) ?? "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                            {r.started_at ? relTime(r.started_at) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </section>
          ) : null}
        </>
      )}

      {repoError ? (
        <p className="text-xs text-muted-foreground" role="status">
          {repoError}
        </p>
      ) : null}

      {data && data.kubeflowConnections === 0 ? (
        <p className="text-xs text-muted-foreground">
          Pipelines your team keeps on Kubeflow can run as steps too: connect the server under{" "}
          <Link
            to="/integrations"
            search={{ tab: "kubeflow" }}
            className="text-primary hover:underline"
          >
            Integrations → Kubeflow
          </Link>
          , then add a Kubeflow pipeline step.
        </p>
      ) : null}
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
