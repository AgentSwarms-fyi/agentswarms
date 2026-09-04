// Predictions for one model: score a lakehouse table into a lakehouse table,
// try a single row from a form the feature schema generates, and the history
// of runs with their logs. Forecast models show their training forecast.
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, ScrollText, Sparkles, Table2, XCircle } from "lucide-react";
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
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  mlCancelPrediction,
  mlListPredictions,
  mlListSources,
  mlPredictBatch,
  mlPredictRows,
  type MlSourceTable,
} from "@/utils/ml.functions";
import type { MlModelRow, MlVersionRow } from "@/utils/ml/access.server";
import type { MlPredictionRow, MlRowsPredictResult } from "@/utils/ml/predict.server";
import { ML_JOB_LIVE, type MlFeatureSchemaEntry, type MlForecastPoint } from "@/utils/ml/types";
import { JobStatusChip, fmtDuration, fmtInt, relTime } from "@/components/ml/mlUi";

const LIVE = new Set<string>(ML_JOB_LIVE);

export function PredictionsPanel({
  token,
  model,
  versions,
  shared,
}: {
  token: string;
  model: MlModelRow;
  versions: MlVersionRow[];
  shared: boolean;
}) {
  const listFn = useServerFn(mlListPredictions);
  const cancelFn = useServerFn(mlCancelPrediction);
  const [runs, setRuns] = useState<MlPredictionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [logsFor, setLogsFor] = useState<MlPredictionRow | null>(null);

  const ready = useMemo(() => versions.filter((v) => v.status === "ready"), [versions]);
  const production = ready.find((v) => v.id === model.production_version_id) ?? ready[0] ?? null;

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      const r = await listFn({ data: { access_token: token, model_id: model.id } });
      setRuns(r.predictions);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, listFn, model.id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const anyLive = runs?.some((r) => LIVE.has(r.status)) ?? false;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [anyLive, reload]);

  const cancel = async (run: MlPredictionRow) => {
    if (!(await confirmAsk({ title: "Cancel this prediction run?" }))) return;
    await cancelFn({ data: { access_token: token, prediction_id: run.id } });
    await reload();
  };

  if (!production) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Predictions need a trained version. Train one first.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {model.task === "forecast" ? (
        <ForecastServing version={production} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <TryIt token={token} model={model} version={production} onDone={() => void reload()} />
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="inline-flex items-center gap-2 text-sm font-medium">
                <Table2 className="h-4 w-4 text-primary" /> Score a whole table
              </p>
              <p className="text-xs text-muted-foreground">
                Read a lakehouse table with the same columns, write every row back with a{" "}
                <code>prediction</code> column (and class probabilities), as a new lakehouse table
                you own. Agents and dashboards can query it like any other.
              </p>
              <Button size="sm" onClick={() => setBatchOpen(true)}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Batch prediction
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Run</th>
              <th className="px-3 py-2 font-medium">Input → output</th>
              <th className="px-3 py-2 text-right font-medium">Rows</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {runs === null && error ? (
              <tr>
                <td className="px-3 py-6 text-red-600" colSpan={7}>
                  {error}
                </td>
              </tr>
            ) : runs === null ? (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={7}>
                  No predictions yet.
                </td>
              </tr>
            ) : (
              runs.map((r) => {
                const input = r.input as {
                  kind: string;
                  schema?: string;
                  table?: string;
                  where?: string;
                  count?: number;
                };
                const output = r.output as { schema: string; table: string } | null;
                return (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground">{relTime(r.created_at)}</td>
                    <td className="px-3 py-2">
                      <JobStatusChip status={r.status} />
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs">{r.kind}</span>{" "}
                      <span className="text-[11px] text-muted-foreground">via {r.via}</span>
                    </td>
                    <td className="max-w-md px-3 py-2 text-xs">
                      {input.kind === "rows" ? (
                        <span>{input.count ?? "?"} row(s)</span>
                      ) : (
                        <span>
                          {input.schema}.{input.table}
                          {input.where ? (
                            <span className="text-muted-foreground"> where {input.where}</span>
                          ) : null}
                        </span>
                      )}
                      {output ? (
                        <span>
                          {" "}
                          →{" "}
                          <span className="font-medium">
                            {output.schema}.{output.table}
                          </span>
                        </span>
                      ) : null}
                      {r.error ? (
                        <p className="mt-0.5 text-red-600 dark:text-red-400">
                          {r.error.slice(0, 160)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.row_count)}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {fmtDuration(r.started_at ?? r.created_at, r.finished_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {LIVE.has(r.status) && !shared ? (
                        <Button size="sm" variant="ghost" onClick={() => void cancel(r)}>
                          <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setLogsFor(r)}>
                        <ScrollText className="mr-1 h-3.5 w-3.5" /> Logs
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <BatchDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        token={token}
        model={model}
        versions={ready}
        defaultVersion={production}
        onStarted={() => void reload()}
      />

      <Dialog open={logsFor !== null} onOpenChange={(o) => !o && setLogsFor(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Prediction logs</DialogTitle>
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

function ForecastServing({ version }: { version: MlVersionRow }) {
  const f = version.forecast as { points: MlForecastPoint[] } | null;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-medium">Forecast, as trained</p>
        <p className="text-xs text-muted-foreground">
          A forecast model serves the periods it projected when it trained (v{version.version});
          train a new version to move the horizon forward. Agents read these through{" "}
          <code>ml_predict</code>.
        </p>
        {f?.points?.length ? (
          <div className="max-h-64 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium">Period</th>
                  <th className="px-2 py-1 text-right font-medium">Forecast</th>
                  <th className="px-2 py-1 text-right font-medium">Low</th>
                  <th className="px-2 py-1 text-right font-medium">High</th>
                </tr>
              </thead>
              <tbody>
                {f.points.map((p) => (
                  <tr key={p.period} className="border-t">
                    <td className="px-2 py-1">{p.period}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{p.yhat.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {p.lo.toFixed(2)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {p.hi.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

type TryResult = MlRowsPredictResult;

function TryIt({
  token,
  model,
  version,
  onDone,
}: {
  token: string;
  model: MlModelRow;
  version: MlVersionRow;
  onDone: () => void;
}) {
  const predictFn = useServerFn(mlPredictRows);
  const schema = (version.feature_schema ?? []) as MlFeatureSchemaEntry[];
  const features = schema.filter((e) => e.role === "feature");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      features.map((f) => [
        f.name,
        f.dtype === "numeric"
          ? String(f.median ?? f.min ?? 0)
          : f.dtype === "categorical"
            ? (f.categories?.[0] ?? "")
            : f.dtype === "boolean"
              ? "true"
              : f.dtype === "datetime"
                ? new Date().toISOString().slice(0, 10)
                : "",
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const row: Record<string, unknown> = {};
      for (const f of features) {
        const v = values[f.name];
        row[f.name] =
          f.dtype === "numeric"
            ? v === ""
              ? null
              : Number(v)
            : f.dtype === "boolean"
              ? v === "true"
              : v;
      }
      const r = await predictFn({
        data: { access_token: token, model_id: model.id, version_id: version.id, rows: [row] },
      });
      setResult(r);
      if (!r.ok) toast.error(r.error);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pred = result?.ok ? result.rows[0] : null;
  const idx = result?.ok ? Object.fromEntries(result.columns.map((c, i) => [c, i])) : {};
  const probas = result?.ok
    ? result.columns
        .filter((c) => c.startsWith("proba_"))
        .map((c) => ({ label: c.slice(6), p: Number(pred?.[idx[c]] ?? 0) }))
    : [];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="inline-flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> Try it
        </p>
        <p className="text-xs text-muted-foreground">
          One row through v{version.version}. Runs in a sandbox, so allow half a minute.
        </p>
        <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.name} className="space-y-1">
              <Label className="text-[11px]">{f.name}</Label>
              {f.dtype === "categorical" && f.categories?.length ? (
                <select
                  className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                  value={values[f.name]}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                >
                  {f.categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : f.dtype === "boolean" ? (
                <select
                  className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                  value={values[f.name]}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <Input
                  className="h-8 text-xs"
                  type={f.dtype === "numeric" ? "number" : f.dtype === "datetime" ? "date" : "text"}
                  value={values[f.name]}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={() => void run()}>
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Predict
          </Button>
          {busy ? (
            <span className="text-xs text-muted-foreground">Scoring in a sandbox…</span>
          ) : null}
        </div>
        {result?.ok && pred ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Predicted {model.target_column}
            </p>
            <p className="text-2xl font-bold tracking-tight tabular-nums">
              {String(pred[idx.prediction] ?? "—")}
              {idx.probability !== undefined ? (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {(Number(pred[idx.probability]) * 100).toFixed(1)}% confidence
                </span>
              ) : null}
            </p>
            {probas.length ? (
              <div className="mt-2 space-y-1">
                {probas
                  .sort((a, b) => b.p - a.p)
                  .slice(0, 6)
                  .map((c) => (
                    <div key={c.label} className="flex items-center gap-2 text-[11px]">
                      <span className="w-24 truncate">{c.label}</span>
                      <div className="h-1.5 flex-1 rounded bg-muted">
                        <div
                          className="h-1.5 rounded bg-[var(--chart-1)]"
                          style={{ width: `${Math.round(c.p * 100)}%` }}
                        />
                      </div>
                      <span className="w-12 text-right tabular-nums">
                        {(c.p * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
              </div>
            ) : null}
            <p className="mt-2 text-[11px] text-muted-foreground">
              {result.algorithm} · {result.elapsedSeconds ?? "?"}s · run{" "}
              {result.predictionId.slice(0, 8)} is audited with a digest
            </p>
          </div>
        ) : result && !result.ok ? (
          <p className="rounded-md bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
            {result.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BatchDialog({
  open,
  onOpenChange,
  token,
  model,
  versions,
  defaultVersion,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string;
  model: MlModelRow;
  versions: MlVersionRow[];
  defaultVersion: MlVersionRow;
  onStarted: () => void;
}) {
  const sourcesFn = useServerFn(mlListSources);
  const batchFn = useServerFn(mlPredictBatch);
  const src = model.source as { schema: string; table: string };
  const [tables, setTables] = useState<MlSourceTable[] | null>(null);
  const [input, setInput] = useState(`${src.schema}.${src.table}`);
  const [where, setWhere] = useState("");
  const [outSchema, setOutSchema] = useState(src.schema);
  const [outTable, setOutTable] = useState(
    `${
      model.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "model"
    }_predictions`,
  );
  const [versionId, setVersionId] = useState(defaultVersion.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || tables !== null) return;
    void sourcesFn({ data: { access_token: token } })
      .then((r) => setTables(r.tables))
      .catch((e) => setErr((e as Error).message));
  }, [open, tables, sourcesFn, token]);
  const schemas = useMemo(() => [...new Set((tables ?? []).map((t) => t.schema))], [tables]);

  const submit = async () => {
    const [schema, table] = input.split(".");
    if (!schema || !table) return setErr("Pick an input table");
    setBusy(true);
    setErr(null);
    try {
      const r = await batchFn({
        data: {
          access_token: token,
          model_id: model.id,
          version_id: versionId,
          input: { schema, table, where: where.trim() || undefined },
          output: { schema: outSchema, table: outTable.trim() },
        },
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      toast.success("Batch prediction started");
      onOpenChange(false);
      onStarted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Batch prediction</DialogTitle>
          <DialogDescription>
            Scores every row of a lakehouse table and writes a new table you own. Rows the model
            never saw columns for are scored with those columns treated as missing.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Input table</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            >
              {(tables ?? [{ schema: src.schema, table: src.table, columns: [] }]).map((t) => (
                <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>
                  {t.schema}.{t.table}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Only rows where (optional)</Label>
            <Input
              className="font-mono text-xs"
              placeholder="signed_up_on >= '2026-01-01'"
              value={where}
              onChange={(e) => setWhere(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Output schema (yours)</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={outSchema}
              onChange={(e) => setOutSchema(e.target.value)}
            >
              {(schemas.length ? schemas : [src.schema]).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Output table</Label>
            <Input value={outTable} onChange={(e) => setOutTable(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Version</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version} · {v.algorithm ?? "?"} · {v.stage}
                </option>
              ))}
            </select>
          </div>
        </div>
        {err ? (
          <p className={cn("rounded-md bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400")}>
            {err}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Predict
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
