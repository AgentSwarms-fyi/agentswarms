// Train a model — four steps: the table, the target, the options, the review.
// Everything the wizard suggests comes from a real profile of the table
// (SUMMARIZE + a sample), never from column names alone.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  Database,
  Loader2,
  Radar,
  Search,
  Sparkles,
  Target,
  ThumbsUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  mlCreateModel,
  mlListModels,
  mlListSources,
  mlProfileSource,
  mlValidatePrep,
  type MlColumnProfile,
  type MlLimits,
  type MlSourceTable,
} from "@/utils/ml.functions";
import {
  ML_PERIODS,
  ML_PERIOD_LABEL,
  ML_TARGET_TASKS,
  ML_TASK_LABEL,
  ML_TUNING_LABEL,
  type MlPeriod,
  type MlPrepConfig,
  type MlTask,
  type MlTuning,
} from "@/utils/ml/types";
import { TaskBadge, fmtInt } from "@/components/ml/mlUi";
import { PrepOptions } from "@/components/ml/PrepOptions";

type Goal = "predict" | "cluster" | "anomaly" | "recommend";
const GOALS: { id: Goal; label: string; blurb: string; icon: typeof Target }[] = [
  {
    id: "predict",
    label: "Predict a column",
    blurb: "A category, a number, or the next periods of a series.",
    icon: Target,
  },
  {
    id: "cluster",
    label: "Find groups",
    blurb: "Rows that resemble each other, with a profile of every group.",
    icon: Boxes,
  },
  {
    id: "anomaly",
    label: "Find anomalies",
    blurb: "Rows unlike the rest, each with a score.",
    icon: Radar,
  },
  {
    id: "recommend",
    label: "Recommend items",
    blurb: "What each user is likely to want next, from past interactions.",
    icon: ThumbsUp,
  },
];
const goalOf = (t: MlTask): Goal =>
  t === "clustering"
    ? "cluster"
    : t === "anomaly"
      ? "anomaly"
      : t === "recommendation"
        ? "recommend"
        : "predict";

export const Route = createFileRoute("/_authenticated/ml_/new")({
  component: TrainWizard,
  head: () => ({ meta: [{ title: "Train a model — AgentSwarms" }] }),
});

const STEPS = ["Data", "Goal", "Options", "Review"] as const;

const KIND_STYLE: Record<MlColumnProfile["kind"], string> = {
  numeric: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  categorical: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  boolean: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  datetime: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  text: "bg-muted text-muted-foreground",
  identifier: "bg-muted text-muted-foreground",
  constant: "bg-muted text-muted-foreground",
};

type Profile = Awaited<ReturnType<typeof mlProfileSource>>;

function TrainWizard() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const navigate = useNavigate();
  const sourcesFn = useServerFn(mlListSources);
  const profileFn = useServerFn(mlProfileSource);
  const createFn = useServerFn(mlCreateModel);
  const listFn = useServerFn(mlListModels);
  const validatePrepFn = useServerFn(mlValidatePrep);

  const [step, setStep] = useState(0);
  const [sources, setSources] = useState<MlSourceTable[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [limits, setLimits] = useState<MlLimits | null>(null);
  const [q, setQ] = useState("");
  const [table, setTable] = useState<MlSourceTable | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profiling, setProfiling] = useState(false);
  const [target, setTarget] = useState("");
  const [task, setTask] = useState<MlTask>("classification");
  const [timeColumn, setTimeColumn] = useState("");
  const [horizon, setHorizon] = useState(12);
  const [aggregation, setAggregation] = useState<"sum" | "mean">("sum");
  const [period, setPeriod] = useState<MlPeriod>("auto");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [features, setFeatures] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState<number | "">("");
  const [maxRows, setMaxRows] = useState<number | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [prep, setPrep] = useState<MlPrepConfig>({});
  const [tuning, setTuning] = useState<MlTuning>("none");
  const [nClusters, setNClusters] = useState<number | "">("");
  const [contamination, setContamination] = useState<number | "">("");
  const [userColumn, setUserColumn] = useState("");
  const [itemColumn, setItemColumn] = useState("");
  const [ratingColumn, setRatingColumn] = useState("");
  const goal = goalOf(task);
  const needsTarget = ML_TARGET_TASKS.includes(task);
  const tunable = task === "classification" || task === "regression";

  useEffect(() => {
    if (!token) return;
    void sourcesFn({ data: { access_token: token } })
      .then((r) => {
        if (!r.enabled) setSourcesError("The lakehouse isn't configured on this deployment.");
        setSources(r.tables);
      })
      .catch((e) => setSourcesError((e as Error).message));
    void listFn({ data: { access_token: token } })
      .then((r) => setLimits(r.limits))
      .catch(() => {});
  }, [token, sourcesFn, listFn]);

  const pickTable = useCallback(
    async (t: MlSourceTable) => {
      setTable(t);
      setProfile(null);
      setTarget("");
      setUserColumn("");
      setItemColumn("");
      setRatingColumn("");
      setProfiling(true);
      try {
        const p = await profileFn({
          data: { access_token: token, schema: t.schema, table: t.table },
        });
        setProfile(p);
        if (!nameTouched) setName(`${t.table} model`);
        setFeatures(
          new Set(
            p.columns
              .filter((c) => c.kind !== "identifier" && c.kind !== "constant")
              .map((c) => c.name),
          ),
        );
        const firstTime = p.columns.find((c) => c.kind === "datetime");
        setTimeColumn(firstTime?.name ?? "");
      } catch (e) {
        toast.error((e as Error).message);
        setTable(null);
      } finally {
        setProfiling(false);
      }
    },
    [profileFn, token, nameTouched],
  );

  const pickTarget = (c: MlColumnProfile) => {
    setTarget(c.name);
    if (c.suggested_task) setTask(c.suggested_task);
    // Names are unique per user; "<table> model" collides the second time.
    if (!nameTouched && table) setName(`${table.table} · ${c.name}`);
    setFeatures((prev) => {
      const next = new Set(prev);
      next.delete(c.name);
      return next;
    });
  };

  const pickGoal = (g: Goal) => {
    const next: MlTask =
      g === "cluster"
        ? "clustering"
        : g === "anomaly"
          ? "anomaly"
          : g === "recommend"
            ? "recommendation"
            : ML_TARGET_TASKS.includes(task)
              ? task
              : "classification";
    setTask(next);
    if (!nameTouched && table) {
      setName(
        g === "cluster"
          ? `${table.table} · groups`
          : g === "anomaly"
            ? `${table.table} · anomalies`
            : g === "recommend"
              ? `${table.table} · recommendations`
              : target
                ? `${table.table} · ${target}`
                : `${table.table} model`,
      );
    }
  };

  const datetimeColumns = useMemo(
    () => profile?.columns.filter((c) => c.kind === "datetime") ?? [],
    [profile],
  );
  const keyColumns = useMemo(
    () => profile?.columns.filter((c) => c.kind !== "constant" && c.kind !== "datetime") ?? [],
    [profile],
  );
  const numericColumns = useMemo(
    () => profile?.columns.filter((c) => c.kind === "numeric") ?? [],
    [profile],
  );
  const filteredSources = useMemo(() => {
    if (!sources) return [];
    const needle = q.trim().toLowerCase();
    return needle
      ? sources.filter((t) => `${t.schema}.${t.table}`.toLowerCase().includes(needle))
      : sources;
  }, [sources, q]);
  const grouped = useMemo(() => {
    const m = new Map<string, MlSourceTable[]>();
    for (const t of filteredSources) m.set(t.schema, [...(m.get(t.schema) ?? []), t]);
    return [...m.entries()];
  }, [filteredSources]);

  const canNext =
    step === 0
      ? Boolean(table && profile)
      : step === 1
        ? goal === "predict"
          ? Boolean(target) && (task !== "forecast" || Boolean(timeColumn))
          : goal === "recommend"
            ? Boolean(userColumn && itemColumn && userColumn !== itemColumn)
            : true
        : step === 2
          ? name.trim().length > 0
          : true;

  const submit = async () => {
    if (!table || (needsTarget && !target)) return;
    setSubmitting(true);
    try {
      const r = await createFn({
        data: {
          access_token: token,
          name: name.trim(),
          description: description.trim() || undefined,
          task,
          source: { kind: "lakehouse", schema: table.schema, table: table.table },
          target_column: needsTarget ? target : undefined,
          time_column: task === "forecast" ? timeColumn : undefined,
          horizon: task === "forecast" ? horizon : undefined,
          aggregation: task === "forecast" ? aggregation : undefined,
          period: task === "forecast" ? period : undefined,
          user_column: task === "recommendation" ? userColumn : undefined,
          item_column: task === "recommendation" ? itemColumn : undefined,
          rating_column: task === "recommendation" && ratingColumn ? ratingColumn : undefined,
          n_clusters: task === "clustering" && nClusters !== "" ? Number(nClusters) : undefined,
          contamination:
            task === "anomaly" && contamination !== "" ? Number(contamination) / 100 : undefined,
          feature_columns:
            task === "forecast" || task === "recommendation"
              ? undefined
              : profile && features.size < profile.columns.length - (needsTarget ? 1 : 0)
                ? [...features]
                : undefined,
          time_budget_minutes: budget === "" ? undefined : Number(budget),
          max_rows: maxRows === "" ? undefined : Number(maxRows),
          prep: Object.keys(prep).length ? prep : undefined,
          tuning,
        },
      });
      if (!r.ok) {
        setSubmitError(r.error);
        toast.error(r.error);
        if (r.model_id) void navigate({ to: "/ml/$modelId", params: { modelId: r.model_id } });
        return;
      }
      toast.success("Training started");
      void navigate({ to: "/ml/$modelId", params: { modelId: r.model_id } });
    } catch (e) {
      setSubmitError((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          to="/ml"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> ML Models
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">Train a model</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Choose a table and what the model should do. The trainer profiles the data, tries several
          algorithms under a time budget, and keeps the best one with its metrics.
        </p>
      </div>

      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <button
              type="button"
              disabled={i > step}
              onClick={() => setStep(i)}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                i === step
                  ? "border-primary bg-primary text-primary-foreground"
                  : i < step
                    ? "border-primary/40 text-primary hover:bg-primary/10"
                    : "border-border text-muted-foreground",
              )}
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-background/20 text-[10px]">
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 ? <span className="h-px w-6 bg-border" /> : null}
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardContent className="p-5">
            {step === 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="font-medium">Which table has the rows to learn from?</p>
                  <p className="text-sm text-muted-foreground">
                    Lakehouse tables you own or that were shared with you. One row per example; the
                    column you want to predict must be in it.
                  </p>
                </div>
                {sourcesError ? (
                  <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
                    {sourcesError}
                  </p>
                ) : sources === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                ) : sources.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No lakehouse tables yet. Load one on the Lakehouse page or through an ETL
                    pipeline, then come back.
                  </p>
                ) : (
                  <>
                    <div className="relative max-w-sm">
                      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        className="pl-8"
                        placeholder="Filter tables…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                      />
                    </div>
                    <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-2">
                      {grouped.map(([schema, tables]) => (
                        <div key={schema}>
                          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {schema}
                          </p>
                          {tables.map((t) => {
                            const selected = table?.schema === t.schema && table?.table === t.table;
                            return (
                              <button
                                key={`${t.schema}.${t.table}`}
                                type="button"
                                onClick={() => void pickTable(t)}
                                className={cn(
                                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                  selected ? "bg-primary/10 text-primary" : "hover:bg-muted",
                                )}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Database className="h-3.5 w-3.5 opacity-60" /> {t.table}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {t.columns.length} columns
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {profiling ? (
                  <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Profiling {table?.table}…
                  </p>
                ) : profile && table ? (
                  <ProfileTable profile={profile} highlight={target} />
                ) : null}
              </div>
            ) : step === 1 ? (
              <div className="space-y-5">
                <div>
                  <p className="font-medium">What should the model do?</p>
                  <p className="text-sm text-muted-foreground">
                    Predict a column, find natural groups, flag unusual rows, or recommend items.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {GOALS.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      data-goal={g.id}
                      onClick={() => pickGoal(g.id)}
                      className={cn(
                        "rounded-lg border p-3 text-left text-sm transition-colors",
                        goal === g.id
                          ? "border-primary bg-primary/10"
                          : "hover:border-primary/40 hover:bg-muted/50",
                      )}
                    >
                      <span className="inline-flex items-center gap-2 font-medium">
                        <g.icon className="h-4 w-4 text-primary" /> {g.label}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">{g.blurb}</p>
                    </button>
                  ))}
                </div>
                {goal === "predict" ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Pick the target column. Identifiers and constant columns cannot be predicted;
                      free text becomes features; dates can be forecast.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {profile?.columns.map((c) => {
                        const disabled =
                          c.kind === "identifier" || c.kind === "text" || c.kind === "constant";
                        const selected = target === c.name;
                        return (
                          <button
                            key={c.name}
                            type="button"
                            disabled={disabled}
                            onClick={() => pickTarget(c)}
                            className={cn(
                              "flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                              selected
                                ? "border-primary bg-primary/10"
                                : disabled
                                  ? "cursor-not-allowed opacity-50"
                                  : "hover:border-primary/40 hover:bg-muted/50",
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{c.name}</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {c.kind === "identifier"
                                  ? "identifier"
                                  : c.kind === "constant"
                                    ? "constant — nothing to predict"
                                    : c.kind === "text"
                                      ? "free text"
                                      : c.suggested_task
                                        ? `${ML_TASK_LABEL[c.suggested_task]} · ${fmtInt(c.approx_distinct)} distinct`
                                        : c.kind}
                              </span>
                            </span>
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px]",
                                KIND_STYLE[c.kind],
                              )}
                            >
                              {c.type.toLowerCase()}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {target ? (
                      <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                        <p className="text-sm font-medium">How should it predict {target}?</p>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {(["classification", "regression", "forecast"] as MlTask[]).map((t) => {
                            const off = t === "forecast" && datetimeColumns.length === 0;
                            return (
                              <button
                                key={t}
                                type="button"
                                disabled={off}
                                onClick={() => setTask(t)}
                                className={cn(
                                  "rounded-lg border p-3 text-left text-sm transition-colors",
                                  task === t
                                    ? "border-primary bg-background"
                                    : off
                                      ? "cursor-not-allowed opacity-50"
                                      : "hover:border-primary/40",
                                )}
                              >
                                <TaskBadge task={t} />
                                <p className="mt-2 text-xs text-muted-foreground">
                                  {t === "classification"
                                    ? "Which category a row belongs to."
                                    : t === "regression"
                                      ? "A number for each row."
                                      : off
                                        ? "Needs a date or timestamp column."
                                        : "The next periods of a series over time."}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                        {task === "forecast" ? (
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="space-y-1">
                              <Label className="text-xs">Time column</Label>
                              <select
                                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                value={timeColumn}
                                onChange={(e) => setTimeColumn(e.target.value)}
                              >
                                {datetimeColumns.map((c) => (
                                  <option key={c.name} value={c.name}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Period</Label>
                              <select
                                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                value={period}
                                onChange={(e) => setPeriod(e.target.value as MlPeriod)}
                              >
                                {ML_PERIODS.map((p) => (
                                  <option key={p} value={p}>
                                    {ML_PERIOD_LABEL[p]}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Periods ahead</Label>
                              <Input
                                type="number"
                                min={1}
                                max={1000}
                                value={horizon}
                                onChange={(e) =>
                                  setHorizon(Math.max(1, Number(e.target.value) || 1))
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Rows in one period</Label>
                              <select
                                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                value={aggregation}
                                onChange={(e) => setAggregation(e.target.value as "sum" | "mean")}
                              >
                                <option value="sum">add up (totals)</option>
                                <option value="mean">average</option>
                              </select>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : goal === "cluster" ? (
                  <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <p className="text-sm font-medium">How many groups?</p>
                    <p className="text-xs text-muted-foreground">
                      Leave it blank and the trainer tries two to ten groups and keeps the number
                      with the best silhouette. Every feature column describes a row; the profile of
                      each group is shown when training finishes.
                    </p>
                    <div className="max-w-xs space-y-1">
                      <Label className="text-xs">Number of groups</Label>
                      <Input
                        type="number"
                        min={2}
                        max={50}
                        placeholder="automatic"
                        value={nClusters}
                        onChange={(e) =>
                          setNClusters(
                            e.target.value === "" ? "" : Math.max(2, Number(e.target.value)),
                          )
                        }
                      />
                    </div>
                  </div>
                ) : goal === "anomaly" ? (
                  <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <p className="text-sm font-medium">
                      How many rows do you expect to be unusual?
                    </p>
                    <p className="text-xs text-muted-foreground">
                      An isolation forest scores every row; rows that are easy to isolate from the
                      rest are anomalies. Two percent are flagged unless you give the share you
                      expect; every row gets a score either way.
                    </p>
                    <div className="max-w-xs space-y-1">
                      <Label className="text-xs">Expected share of anomalies (%)</Label>
                      <Input
                        type="number"
                        min={0.1}
                        max={50}
                        step={0.1}
                        placeholder="2"
                        value={contamination}
                        onChange={(e) =>
                          setContamination(
                            e.target.value === ""
                              ? ""
                              : Math.min(50, Math.max(0.1, Number(e.target.value))),
                          )
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <p className="text-sm font-medium">Who interacted with what?</p>
                    <p className="text-xs text-muted-foreground">
                      Each row is one interaction: a user and an item, optionally with a strength
                      such as a rating, a quantity or an amount. Items that the same users chose are
                      recommended to each other's users; a user without history gets the most
                      popular items.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-xs">User column</Label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={userColumn}
                          onChange={(e) => setUserColumn(e.target.value)}
                        >
                          <option value="">choose…</option>
                          {keyColumns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name} · {fmtInt(c.approx_distinct)} distinct
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Item column</Label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={itemColumn}
                          onChange={(e) => setItemColumn(e.target.value)}
                        >
                          <option value="">choose…</option>
                          {keyColumns
                            .filter((c) => c.name !== userColumn)
                            .map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name} · {fmtInt(c.approx_distinct)} distinct
                              </option>
                            ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Strength (optional)</Label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={ratingColumn}
                          onChange={(e) => setRatingColumn(e.target.value)}
                        >
                          <option value="">every row counts once</option>
                          {numericColumns
                            .filter((c) => c.name !== userColumn && c.name !== itemColumn)
                            .map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : step === 2 ? (
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={name}
                      onChange={(e) => {
                        setNameTouched(true);
                        setName(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Description (optional)</Label>
                    <Textarea
                      rows={2}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What this model is for and who relies on it"
                    />
                  </div>
                </div>
                {task !== "forecast" && task !== "recommendation" && profile ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Features</Label>
                      <span className="text-[11px] text-muted-foreground">
                        {features.size} of {profile.columns.length - (needsTarget ? 1 : 0)} columns
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Identifier-like columns are off by default; the trainer also drops constant
                      and empty columns and says so.
                    </p>
                    <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
                      {profile.columns
                        .filter((c) => c.name !== target)
                        .map((c) => (
                          <label
                            key={c.name}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
                          >
                            <input
                              type="checkbox"
                              checked={features.has(c.name)}
                              onChange={(e) =>
                                setFeatures((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(c.name);
                                  else next.delete(c.name);
                                  return next;
                                })
                              }
                            />
                            <span className="truncate">{c.name}</span>
                            <span
                              className={cn(
                                "ml-auto rounded px-1.5 py-0.5 text-[10px]",
                                KIND_STYLE[c.kind],
                              )}
                            >
                              {c.kind}
                            </span>
                          </label>
                        ))}
                    </div>
                  </div>
                ) : null}
                <PrepOptions
                  task={task}
                  value={prep}
                  onChange={setPrep}
                  tuning={tuning}
                  onTuningChange={setTuning}
                  onCheck={
                    table && (target || !needsTarget)
                      ? (p) =>
                          validatePrepFn({
                            data: {
                              access_token: token,
                              source: {
                                kind: "lakehouse",
                                schema: table.schema,
                                table: table.table,
                              },
                              target_column: needsTarget ? target : undefined,
                              prep: p,
                            },
                          })
                      : undefined
                  }
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Time budget (minutes)</Label>
                    <Input
                      type="number"
                      min={1}
                      placeholder={limits ? String(limits.train_time_budget_minutes) : ""}
                      value={budget}
                      onChange={(e) =>
                        setBudget(e.target.value === "" ? "" : Number(e.target.value))
                      }
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Candidates stop being tried once 85% is spent; the best so far is kept.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max training rows</Label>
                    <Input
                      type="number"
                      min={100}
                      placeholder={limits ? String(limits.train_max_rows) : ""}
                      value={maxRows}
                      onChange={(e) =>
                        setMaxRows(e.target.value === "" ? "" : Number(e.target.value))
                      }
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Larger tables are reservoir-sampled. The deployment limit is{" "}
                      {limits ? fmtInt(limits.train_max_rows) : "…"} rows.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="font-medium">Ready to train</p>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <Row k="Name" v={name} />
                  <Row k="Task" v={ML_TASK_LABEL[task]} />
                  <Row k="Table" v={table ? `${table.schema}.${table.table}` : ""} />
                  {needsTarget ? <Row k="Target" v={target} /> : null}
                  {task === "recommendation" ? (
                    <>
                      <Row k="Users" v={userColumn} />
                      <Row k="Items" v={itemColumn} />
                      <Row k="Strength" v={ratingColumn || "every row counts once"} />
                    </>
                  ) : null}
                  {task === "clustering" ? (
                    <Row
                      k="Groups"
                      v={nClusters === "" ? "chosen by silhouette" : String(nClusters)}
                    />
                  ) : null}
                  {task === "anomaly" ? (
                    <Row
                      k="Expected anomalies"
                      v={contamination === "" ? "2% (default)" : `${contamination}%`}
                    />
                  ) : null}
                  {task === "forecast" ? (
                    <>
                      <Row k="Time column" v={timeColumn} />
                      <Row k="Period" v={ML_PERIOD_LABEL[period]} />
                      <Row
                        k="Horizon"
                        v={`${horizon} periods, ${aggregation === "sum" ? "totals" : "averages"} per period`}
                      />
                    </>
                  ) : task === "recommendation" ? null : (
                    <Row k="Features" v={`${features.size} columns`} />
                  )}
                  <Row k="Rows" v={profile ? fmtInt(profile.row_count) : ""} />
                  <Row
                    k="Preparation"
                    v={
                      prep.sql
                        ? "custom SELECT"
                        : prep.where
                          ? `where ${prep.where}`
                          : "whole table"
                    }
                  />
                  {tunable ? <Row k="Tuning" v={ML_TUNING_LABEL[tuning]} /> : null}
                  <Row
                    k="Time budget"
                    v={`${budget === "" ? (limits?.train_time_budget_minutes ?? "default") : budget} min`}
                  />
                </dl>
                {submitError ? (
                  <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
                    {submitError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Training runs in an isolated sandbox that reads the table as of the current
                  lakehouse snapshot. The run is audited and the version keeps a passport, so what
                  the model learned from can be shown later.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardContent className="space-y-3 p-4 text-sm">
              <p className="inline-flex items-center gap-2 font-medium">
                <Sparkles className="h-4 w-4 text-primary" /> Summary
              </p>
              <Summary label="Table" value={table ? `${table.schema}.${table.table}` : "—"} />
              <Summary label="Rows" value={profile ? fmtInt(profile.row_count) : "—"} />
              <Summary
                label={task === "recommendation" ? "Items" : "Target"}
                value={
                  (task === "recommendation" ? itemColumn : target) || (needsTarget ? "—" : "none")
                }
              />
              <Summary label="Task" value={target || !needsTarget ? ML_TASK_LABEL[task] : "—"} />
              {task === "forecast" && target ? (
                <Summary
                  label="Horizon"
                  value={`${horizon} ${period === "auto" ? "periods" : ML_PERIOD_LABEL[period].replace(/ly$/, "s").replace("dais", "days")} × ${timeColumn || "?"}`}
                />
              ) : null}
            </CardContent>
          </Card>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button size="sm" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Next <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" disabled={submitting || !canNext} onClick={() => void submit()}>
                {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Train
              </Button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</dt>
      <dd className="font-medium">{v || "—"}</dd>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  );
}

function ProfileTable({ profile, highlight }: { profile: Profile; highlight: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className="font-medium tabular-nums">{fmtInt(profile.row_count)}</span> rows ·{" "}
        {profile.columns.length} columns
      </p>
      <div className="max-h-64 overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="text-left">
              <th className="px-2 py-1.5 font-medium">Column</th>
              <th className="px-2 py-1.5 font-medium">Kind</th>
              <th className="px-2 py-1.5 text-right font-medium">Distinct</th>
              <th className="px-2 py-1.5 text-right font-medium">Nulls</th>
              <th className="px-2 py-1.5 font-medium">Sample</th>
            </tr>
          </thead>
          <tbody>
            {profile.columns.map((c) => (
              <tr key={c.name} className={cn("border-t", highlight === c.name && "bg-primary/5")}>
                <td className="px-2 py-1 font-medium">{c.name}</td>
                <td className="px-2 py-1">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px]", KIND_STYLE[c.kind])}>
                    {c.kind}
                  </span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtInt(c.approx_distinct)}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {c.null_pct === null ? "—" : `${c.null_pct.toFixed(1)}%`}
                </td>
                <td className="max-w-[16rem] truncate px-2 py-1 text-muted-foreground">
                  {c.samples.join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
