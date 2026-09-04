// ML Models — the registry. Every model the user owns or was granted, with
// its production version's headline metric, what it predicts from, and
// whether something is training right now.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, Plus, RefreshCw, Search, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { mlListModels, type MlModelSummary } from "@/utils/ml.functions";
import {
  ML_PRIMARY_METRIC,
  ML_TASK_LABEL,
  ML_TASKS,
  type MlSource,
  type MlTask,
} from "@/utils/ml/types";
import {
  Chip,
  JOB_STATUS_STYLE,
  StageChip,
  TaskBadge,
  fmtInt,
  fmtMetric,
  metricLabel,
  metricTone,
  relTime,
} from "@/components/ml/mlUi";

export const Route = createFileRoute("/_authenticated/ml")({
  component: MlPage,
  head: () => ({
    meta: [
      { title: "ML Models — AgentSwarms" },
      {
        name: "description",
        content:
          "Train, register and govern classification, regression and forecasting models on your lakehouse data.",
      },
    ],
  }),
});

type ListResult = Awaited<ReturnType<typeof mlListModels>>;

function MlPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const navigate = useNavigate();
  const listFn = useServerFn(mlListModels);
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [task, setTask] = useState<"all" | MlTask>("all");

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      setData(await listFn({ data: { access_token: token } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, listFn]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // A model that is training changes on its own; keep the list honest.
  useEffect(() => {
    if (!data?.models.some((m) => m.live_job)) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [data, reload]);

  const models = data?.models ?? null;
  const filtered = useMemo(() => {
    if (!models) return [];
    const needle = q.trim().toLowerCase();
    return models.filter((m) => {
      if (task !== "all" && m.task !== task) return false;
      if (!needle) return true;
      const src = m.source as MlSource;
      return (
        m.name.toLowerCase().includes(needle) ||
        `${src.schema}.${src.table}`.toLowerCase().includes(needle) ||
        (m.target_column ?? m.item_column ?? "").toLowerCase().includes(needle)
      );
    });
  }, [models, q, task]);

  const stats = useMemo(() => {
    if (!models) return null;
    return {
      total: models.length,
      production: models.filter((m) => m.production).length,
      training: models.filter((m) => m.live_job).length,
      shared: models.filter((m) => m.shared).length,
    };
  }, [models]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Data &amp; BI
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">ML Models</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Train a model on a lakehouse table without writing code, keep every version with its
            metrics and the snapshot it learned from, and let agents and dashboards predict with the
            one you promote.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          <Button size="sm" asChild>
            <Link to="/ml/new">
              <Plus className="mr-1.5 h-4 w-4" /> Train a model
            </Link>
          </Button>
        </div>
      </div>

      {stats ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Models" value={fmtInt(stats.total)} />
          <Stat label="In production" value={fmtInt(stats.production)} />
          <Stat
            label="Training now"
            value={fmtInt(stats.training)}
            accent={stats.training > 0 ? "text-blue-600 dark:text-blue-400" : undefined}
          />
          <Stat label="Shared with you" value={fmtInt(stats.shared)} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search by name, table or target…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          {(["all", ...ML_TASKS] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTask(t)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                task === t
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t === "all" ? "All" : ML_TASK_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {data === null && error !== null ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm font-medium">Could not load models</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : data === null ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : !data.enabled ? (
        <Card>
          <CardContent className="space-y-2 p-6">
            <p className="text-sm font-medium">
              The lakehouse isn&apos;t configured on this deployment
            </p>
            <p className="text-sm text-muted-foreground">
              Models train on lakehouse tables. Set <code>LAKEHOUSE_CATALOG_URL</code> and{" "}
              <code>LAKEHOUSE_DATA_URL</code>, then come back — see the Lakehouse page in the docs.
            </p>
          </CardContent>
        </Card>
      ) : models !== null && models.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="No models yet"
          description="Pick a lakehouse table, choose the column to predict, and the trainer finds the best model under a time budget. Every version keeps its metrics, its training snapshot and a passport."
          action={
            <Button asChild>
              <Link to="/ml/new">
                <Plus className="mr-1.5 h-4 w-4" /> Train your first model
              </Link>
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No models match.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              onOpen={() => void navigate({ to: "/ml/$modelId", params: { modelId: m.id } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tracking-tight tabular-nums", accent)}>{value}</p>
    </Card>
  );
}

function ModelCard({ model, onOpen }: { model: MlModelSummary; onOpen: () => void }) {
  const src = model.source as MlSource;
  const v = model.production ?? model.latest;
  const primary = ML_PRIMARY_METRIC[model.task as MlTask];
  const value = v ? ((v.metrics as Record<string, number | null>)?.[primary] ?? null) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium group-hover:text-primary">{model.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {src.schema}.{src.table} →{" "}
            <span className="font-medium">
              {model.task === "recommendation"
                ? `${model.item_column} for ${model.user_column}`
                : model.task === "clustering"
                  ? "groups of rows"
                  : model.task === "anomaly"
                    ? "unusual rows"
                    : model.target_column}
            </span>
          </p>
        </div>
        <TaskBadge task={model.task} />
      </div>
      <div className="mt-4 flex items-end justify-between gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {v ? metricLabel(primary) : "No version yet"}
          </p>
          <p
            className={cn(
              "text-2xl font-bold tracking-tight tabular-nums",
              metricTone(primary, value) === "good"
                ? "text-emerald-600 dark:text-emerald-400"
                : metricTone(primary, value) === "bad"
                  ? "text-red-600 dark:text-red-400"
                  : "",
            )}
          >
            {model.live_job && !value ? "…" : fmtMetric(primary, value)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {model.live_job ? (
            <Chip label="training" style={JOB_STATUS_STYLE.running} pulse />
          ) : v ? (
            <StageChip stage={v.stage} status={v.status} />
          ) : null}
          {v ? <span className="text-[11px] text-muted-foreground">v{v.version}</span> : null}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t pt-2 text-[11px] text-muted-foreground">
        <span>
          {model.versions_count} version{model.versions_count === 1 ? "" : "s"} · updated{" "}
          {relTime(model.updated_at)}
        </span>
        {model.shared ? (
          <span className="inline-flex items-center gap-1">
            <Share2 className="h-3 w-3" /> shared with you
          </span>
        ) : null}
      </div>
    </button>
  );
}
