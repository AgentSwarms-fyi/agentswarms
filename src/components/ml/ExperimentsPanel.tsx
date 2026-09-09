// Experiments: what was tried, with what settings, and how it scored.
//
// The registry answers "what are we serving". This answers the question that
// used to have no answer a month later — "why is this the learning rate, and
// did anyone try the obvious thing?" — because the twenty runs behind the one
// kept version used to live in a notebook's output cells until somebody re-ran
// it.
//
// The panel is a table, not a form. Nothing is created here: runs are logged
// from wherever the training happens. What the UI owns is reading them, seeing
// which parameter actually differed between two attempts, and promoting the
// one worth serving.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowUpRight, ChevronRight, FlaskConical, Loader2, Terminal, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import {
  asScalarMap,
  curveOf,
  isStepKey,
  metricColumns,
  varyingParams as varyingParamsOf,
  type Scalar,
} from "@/lib/experiments";
import { cn } from "@/lib/utils";
import {
  experimentDelete,
  experimentRunDelete,
  experimentRunRegister,
  experimentRunsList,
  experimentSave,
  experimentsList,
  type ExperimentRow,
  type RunRow,
} from "@/utils/mlExperiments.functions";

function fmt(v: Scalar): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) >= 0.001 ? v.toFixed(4) : v.toExponential(2);
  }
  return String(v);
}

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function Sparkline({ points }: { points: { step: number; value: number }[] }) {
  if (points.length < 2) return null;
  const w = 132;
  const h = 28;
  const vs = points.map((p) => p.value);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((p.value - lo) / span) * (h - 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible" role="img" aria-label="metric by step">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.25" className="text-primary" />
    </svg>
  );
}

const statusTone: Record<string, string> = {
  running: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  finished: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function ExperimentsPanel({ token }: { token: string }) {
  const listFn = useServerFn(experimentsList);
  const runsFn = useServerFn(experimentRunsList);
  const delExpFn = useServerFn(experimentDelete);
  const delRunFn = useServerFn(experimentRunDelete);
  const registerFn = useServerFn(experimentRunRegister);
  const saveFn = useServerFn(experimentSave);

  const [experiments, setExperiments] = useState<ExperimentRow[]>([]);
  const [models, setModels] = useState<{ id: string; name: string; task: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [target, setTarget] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const res = await listFn({ data: { accessToken: token } });
    if (res.ok) {
      setExperiments(res.experiments);
      setModels(res.models);
      setSelected((cur) => cur ?? res.experiments[0]?.id ?? null);
    } else toast.error(res.error);
    setLoading(false);
  }, [listFn, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setNote(experiments.find((e) => e.id === selected)?.description ?? "");
  }, [selected, experiments]);

  useEffect(() => {
    if (!selected) return setRuns([]);
    let live = true;
    setLoadingRuns(true);
    void (async () => {
      const res = await runsFn({ data: { accessToken: token, experimentId: selected } });
      if (!live) return;
      if (res.ok) setRuns(res.runs);
      else toast.error(res.error);
      setLoadingRuns(false);
    })();
    return () => {
      live = false;
    };
  }, [selected, runsFn, token]);

  /** Metric columns: the run's scores, not the points of its curves. */
  const metricKeys = useMemo(() => metricColumns(runs), [runs]);

  /**
   * Which parameters actually differed. In a list of twenty runs the ones that
   * were held constant are noise; the one that moved is the experiment.
   */
  const varyingParams = useMemo(() => varyingParamsOf(runs), [runs]);

  const sorted = useMemo(() => {
    if (!sortBy) return runs;
    return [...runs].sort((a, b) => {
      const av = asScalarMap(a.metrics)[sortBy];
      const bv = asScalarMap(b.metrics)[sortBy];
      if (typeof av !== "number") return 1;
      if (typeof bv !== "number") return -1;
      return bv - av;
    });
  }, [runs, sortBy]);

  /** An experiment is a named question; this is where the question goes. */
  async function saveNote() {
    const current = experiments.find((e) => e.id === selected);
    if (!current || (current.description ?? "") === note.trim()) return;
    const res = await saveFn({
      data: {
        accessToken: token,
        id: current.id,
        description: note.trim() || null,
        model_id: current.model_id,
      },
    });
    if (!res.ok) return toast.error(res.error);
    setExperiments((cur) =>
      cur.map((e) => (e.id === current.id ? { ...e, description: note.trim() || null } : e)),
    );
  }

  async function removeExperiment(e: ExperimentRow) {
    const ok = await confirmAsk({
      title: `Delete the experiment ${e.name}?`,
      body: `Its ${e.runs} run${e.runs === 1 ? "" : "s"} go with it. Model versions promoted from those runs stay where they are — this deletes the record of how they were arrived at, not the models.`,
      actionLabel: "Delete experiment",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await delExpFn({ data: { accessToken: token, id: e.id } });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Deleted ${e.name}`, {
        description: res.deletedRuns ? `${res.deletedRuns} runs deleted with it.` : undefined,
      });
      setSelected(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeRun(r: RunRow) {
    const ok = await confirmAsk({
      title: "Delete this run?",
      body: r.registered_version_id
        ? "A model version was registered from this run. The version stays; what goes is the record of the attempt behind it."
        : "The record of this attempt is deleted.",
      actionLabel: "Delete run",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await delRunFn({ data: { accessToken: token, id: r.id } });
      if (!res.ok) return toast.error(res.error);
      setRuns((cur) => cur.filter((x) => x.id !== r.id));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function register(r: RunRow) {
    const modelId = target[r.id];
    if (!modelId) return toast.error("Pick the model to register this run into");
    setBusy(true);
    try {
      const res = await registerFn({
        data: { accessToken: token, runId: r.id, modelId, promote: false },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Registered as version ${res.version}`, {
        description:
          "It is a candidate — promote it from the model's Versions tab when you are ready.",
        duration: 8000,
      });
      const back = await runsFn({ data: { accessToken: token, experimentId: selected! } });
      if (back.ok) setRuns(back.runs);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading experiments…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-2 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <FlaskConical className="h-4 w-4 text-primary" /> Experiments
          </p>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            The registry keeps what you <strong>shipped</strong>. This keeps what you{" "}
            <strong>tried</strong>: every run with the settings it used and the scores it got, so
            &quot;why is this the learning rate&quot; still has an answer next quarter, and the
            obvious idea that did not work is visible instead of being tried again. A run that
            recorded an artifact can be registered as a model version from here.
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing is created in this panel. Log a run from a notebook or a script:
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed">
            {`import agentswarms

with agentswarms.start_run("churn-v2", params={"lr": 0.01}) as run:
    for epoch in range(10):
        run.log_metric("loss", loss, step=epoch)
    run.log_metric("auc", 0.91)
    run.save_model(pipe, features=list(X.columns), task="classification")
    run.register("churn", task="classification",
                 source={"schema": "analytics", "table": "customers"},
                 target_column="churned")`}
          </pre>
        </CardContent>
      </Card>

      {experiments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <Terminal className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">No runs logged yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              The first <code className="font-mono">start_run()</code> call creates its experiment.
              Nothing needs to be set up here first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            {experiments.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  setSelected(e.id);
                  setOpen(null);
                  setSortBy(null);
                }}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors",
                  selected === e.id ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                )}
              >
                <p className="truncate text-sm font-medium">{e.name}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {e.runs} run{e.runs === 1 ? "" : "s"}
                  {e.running > 0 ? ` · ${e.running} running` : ""}
                  {e.last_run_at ? ` · ${new Date(e.last_run_at).toLocaleDateString()}` : ""}
                </p>
              </button>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              {loadingRuns ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
                </div>
              ) : runs.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">
                  This experiment has no runs yet.
                </p>
              ) : (
                <>
                  <div className="border-b p-3">
                    <input
                      value={note}
                      onChange={(ev) => setNote(ev.target.value)}
                      onBlur={() => void saveNote()}
                      placeholder="What is this experiment asking?"
                      aria-label="Experiment description"
                      className="mb-2 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 focus:underline focus:decoration-dotted"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {runs.length} run{runs.length === 1 ? "" : "s"}
                        {varyingParams.size > 0 ? (
                          <>
                            {" · "}
                            <span className="text-foreground">
                              {[...varyingParams].slice(0, 4).join(", ")}
                            </span>{" "}
                            varied
                          </>
                        ) : null}
                      </p>
                      {selected ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            const e = experiments.find((x) => x.id === selected);
                            if (e) void removeExperiment(e);
                          }}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete experiment
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Run</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          {metricKeys.map((k) => (
                            <th key={k} className="px-3 py-2 font-medium">
                              <button
                                type="button"
                                className={cn(
                                  "font-mono hover:text-foreground",
                                  sortBy === k && "text-primary",
                                )}
                                onClick={() => setSortBy(sortBy === k ? null : k)}
                                title="Sort by this metric, highest first"
                              >
                                {k}
                              </button>
                            </th>
                          ))}
                          <th className="px-3 py-2 font-medium">Took</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((r) => {
                          const metrics = asScalarMap(r.metrics);
                          const params = asScalarMap(r.params);
                          const expanded = open === r.id;
                          return (
                            <Fragment key={r.id}>
                              <tr
                                className={cn(
                                  "border-b last:border-0 hover:bg-muted/40",
                                  expanded && "bg-muted/40",
                                )}
                              >
                                <td className="px-3 py-2">
                                  {/*
                                    The disclosure is a real button rather than a
                                    click handler on the row: a row that is only
                                    clickable is not in the tab order, Enter does
                                    nothing on it, and a screen reader is never
                                    told it is a control.
                                  */}
                                  <button
                                    type="button"
                                    aria-expanded={expanded}
                                    className="flex w-full items-center gap-1.5 text-left"
                                    onClick={() => setOpen(expanded ? null : r.id)}
                                  >
                                    <ChevronRight
                                      className={cn(
                                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                        expanded && "rotate-90",
                                      )}
                                    />
                                    <span className="truncate font-medium">
                                      {r.name || new Date(r.started_at).toLocaleString()}
                                    </span>
                                    {r.registered_version_id ? (
                                      <Badge variant="outline" className="ml-1 text-[10px]">
                                        registered
                                      </Badge>
                                    ) : null}
                                  </button>
                                </td>
                                <td className="px-3 py-2">
                                  <span
                                    className={cn(
                                      "rounded border px-1.5 py-0.5 text-[10px]",
                                      statusTone[r.status] ?? "",
                                    )}
                                  >
                                    {r.status}
                                  </span>
                                </td>
                                {metricKeys.map((k) => (
                                  <td key={k} className="px-3 py-2 font-mono text-xs tabular-nums">
                                    {fmt(metrics[k] ?? null)}
                                  </td>
                                ))}
                                <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                  {duration(r.duration_ms)}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void removeRun(r)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </td>
                              </tr>
                              {expanded ? (
                                <tr className="border-b last:border-0">
                                  <td colSpan={metricKeys.length + 4} className="bg-muted/20 p-4">
                                    <div className="grid gap-4 md:grid-cols-2">
                                      <div>
                                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          Parameters
                                        </p>
                                        {Object.keys(params).length === 0 ? (
                                          <p className="text-xs text-muted-foreground">
                                            None logged.
                                          </p>
                                        ) : (
                                          <dl className="space-y-0.5 text-xs">
                                            {Object.entries(params).map(([k, v]) => (
                                              <div key={k} className="flex gap-2">
                                                <dt
                                                  className={cn(
                                                    "min-w-32 font-mono",
                                                    varyingParams.has(k)
                                                      ? "text-primary"
                                                      : "text-muted-foreground",
                                                  )}
                                                  title={
                                                    varyingParams.has(k)
                                                      ? "This one differed between runs"
                                                      : "Held constant across these runs"
                                                  }
                                                >
                                                  {k}
                                                </dt>
                                                <dd className="font-mono tabular-nums">{fmt(v)}</dd>
                                              </div>
                                            ))}
                                          </dl>
                                        )}
                                        <p className="mt-3 text-[11px] text-muted-foreground">
                                          Logged from {r.source}
                                          {r.session_id ? " (sandbox session)" : ""} ·{" "}
                                          {new Date(r.started_at).toLocaleString()}
                                        </p>
                                        {r.tags?.length ? (
                                          <div className="mt-2 flex flex-wrap gap-1">
                                            {r.tags.map((t) => (
                                              <Badge
                                                key={t}
                                                variant="secondary"
                                                className="text-[10px] font-normal"
                                              >
                                                {t}
                                              </Badge>
                                            ))}
                                          </div>
                                        ) : null}
                                        {r.notes ? <p className="mt-2 text-xs">{r.notes}</p> : null}
                                        {r.error ? (
                                          <p className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
                                            {r.error}
                                          </p>
                                        ) : null}
                                      </div>

                                      <div>
                                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          Metrics
                                        </p>
                                        <dl className="space-y-1 text-xs">
                                          {Object.entries(metrics)
                                            .filter(([k]) => !isStepKey(k))
                                            .map(([k, v]) => {
                                              const curve = curveOf(r.metrics, k);
                                              return (
                                                <div key={k} className="flex items-center gap-2">
                                                  <dt className="min-w-32 font-mono text-muted-foreground">
                                                    {k}
                                                  </dt>
                                                  <dd className="font-mono tabular-nums">
                                                    {fmt(v)}
                                                  </dd>
                                                  {curve.length > 1 ? (
                                                    <span
                                                      title={`${curve.length} steps: ${fmt(curve[0].value)} → ${fmt(curve[curve.length - 1].value)}`}
                                                    >
                                                      <Sparkline points={curve} />
                                                    </span>
                                                  ) : null}
                                                </div>
                                              );
                                            })}
                                        </dl>

                                        <div className="mt-4 border-t pt-3">
                                          {r.registered_version_id ? (
                                            <p className="text-xs text-muted-foreground">
                                              Registered as a model version.
                                            </p>
                                          ) : r.artifact_uri && r.artifact_sha256 ? (
                                            <div className="space-y-1.5">
                                              <p className="font-mono text-[11px] text-muted-foreground">
                                                {r.artifact_uri}
                                              </p>
                                              <div className="flex flex-wrap items-center gap-2">
                                                <select
                                                  className="h-8 rounded-md border bg-background px-2 text-xs"
                                                  value={target[r.id] ?? ""}
                                                  onChange={(e) =>
                                                    setTarget({ ...target, [r.id]: e.target.value })
                                                  }
                                                >
                                                  <option value="">Register into…</option>
                                                  {models.map((m) => (
                                                    <option key={m.id} value={m.id}>
                                                      {m.name}
                                                    </option>
                                                  ))}
                                                </select>
                                                <Button
                                                  size="sm"
                                                  disabled={busy || !target[r.id]}
                                                  onClick={() => void register(r)}
                                                >
                                                  <ArrowUpRight className="mr-1 h-3.5 w-3.5" />{" "}
                                                  Register as a version
                                                </Button>
                                              </div>
                                              <p className="text-[11px] text-muted-foreground">
                                                It arrives as a candidate. Promoting it to
                                                production is a separate, deliberate step.
                                              </p>
                                            </div>
                                          ) : (
                                            <p className="text-xs text-muted-foreground">
                                              No artifact recorded, so there is nothing to register.
                                              Pass <code className="font-mono">artifact_uri</code>{" "}
                                              and <code className="font-mono">artifact_sha256</code>{" "}
                                              to <code className="font-mono">finish()</code>.
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
