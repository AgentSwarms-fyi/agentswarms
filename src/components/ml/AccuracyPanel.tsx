// Was the model right?
//
// The Predictions tab answers "what did it say"; drift answers "do the rows
// still look familiar". Neither answers this one, and this one is what an
// owner is actually accountable for. So the panel leads with the number —
// today's score against the score the model trained to — and treats coverage
// as part of that number rather than a footnote: a metric measured over 6% of
// the scored rows belongs to whoever answered first, and they are rarely a
// random sample.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Target, TrendingDown, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { relTime } from "@/components/ml/mlUi";
import { higherIsBetter, type MlOutcomeSource } from "@/lib/mlEvaluation";
import {
  mlEvaluatePrediction,
  mlListEvaluations,
  mlListPredictions,
  mlSetOutcomeSource,
  type MlEvaluationRow,
} from "@/utils/ml.functions";

const EVALUABLE = new Set(["classification", "regression", "forecast"]);

function verdictBadge(row: MlEvaluationRow) {
  if (row.verdict === "degraded") {
    return (
      <Badge variant="destructive" className="gap-1">
        <TrendingDown className="h-3 w-3" /> Degraded
      </Badge>
    );
  }
  if (row.verdict === "improved") {
    // Deliberately not a success colour. A model markedly better than its own
    // validation score is usually leakage or a mismatched join, and dressing
    // that as good news is how it goes unexamined.
    return (
      <Badge variant="secondary" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> Better than training
      </Badge>
    );
  }
  if (row.verdict === "stable") {
    return (
      <Badge variant="outline" className="gap-1 text-emerald-600">
        <CheckCircle2 className="h-3 w-3" /> Holding
      </Badge>
    );
  }
  return <Badge variant="outline">No baseline</Badge>;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const num = (n: number | null) => (n === null || n === undefined ? "—" : n.toFixed(4));

export function AccuracyPanel({
  token,
  modelId,
  task,
  shared,
}: {
  token: string;
  modelId: string;
  task: string;
  shared: boolean;
}) {
  const listFn = useServerFn(mlListEvaluations);
  const setFn = useServerFn(mlSetOutcomeSource);
  const evalFn = useServerFn(mlEvaluatePrediction);
  const predictionsFn = useServerFn(mlListPredictions);

  const [rows, setRows] = useState<MlEvaluationRow[] | null>(null);
  const [source, setSource] = useState<MlOutcomeSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ schema: "", table: "", keys: "", outcome: "" });

  const load = useCallback(async () => {
    const res = await listFn({ data: { access_token: token, model_id: modelId } });
    setRows(res.evaluations);
    setSource(res.source);
    if (res.source) {
      setForm({
        schema: res.source.schema,
        table: res.source.table,
        keys: res.source.key_columns.join(", "),
        outcome: res.source.outcome_column,
      });
    }
  }, [listFn, token, modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!EVALUABLE.has(task)) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          A {task} model has no recorded outcome to be measured against, so there is nothing to
          compare. Drift, on the Predictions tab, is the signal to watch here.
        </CardContent>
      </Card>
    );
  }

  const save = async () => {
    setBusy(true);
    const res = await setFn({
      data: {
        access_token: token,
        model_id: modelId,
        source: {
          schema: form.schema.trim(),
          table: form.table.trim(),
          key_columns: form.keys
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          outcome_column: form.outcome.trim(),
        },
      },
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Outcome source saved");
    setEditing(false);
    void load();
  };

  const clear = async () => {
    if (
      !(await confirmAsk({
        title: "Stop measuring this model against outcomes?",
        body: "Evaluations already recorded are kept. Nothing new is measured until an outcome source is set again.",
        actionLabel: "Stop measuring",
      }))
    )
      return;
    setBusy(true);
    const res = await setFn({ data: { access_token: token, model_id: modelId, source: null } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setSource(null);
    setEditing(false);
    toast.success("Outcome source cleared");
    void load();
  };

  /** Measure the most recent batch run now, instead of waiting for the sweep. */
  const measureNow = async () => {
    setBusy(true);
    try {
      const { predictions } = await predictionsFn({
        data: { access_token: token, model_id: modelId },
      });
      const batch = predictions.find((p) => p.kind === "batch" && p.status === "succeeded");
      if (!batch) {
        toast.error("No successful batch run to measure yet");
        return;
      }
      const res = await evalFn({ data: { access_token: token, prediction_id: batch.id } });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Measured ${res.evaluation.matched_rows} rows with an outcome`);
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  const latest = rows?.[0];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Target className="h-4 w-4" /> Measured against real outcomes
              </h3>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                Drift says the rows arriving now look different from the ones this model trained on.
                That is a warning. This is the verdict: the model&apos;s own training metric,
                recomputed on the scored rows whose real answer has since arrived.
              </p>
            </div>
            {!shared && source && !editing && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Change
                </Button>
                <Button size="sm" onClick={measureNow} disabled={busy}>
                  {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  Measure now
                </Button>
              </div>
            )}
          </div>

          {!source && !editing && (
            <div className="rounded-md border border-dashed p-4 text-sm">
              <p className="text-muted-foreground">
                This model is not measured against outcomes yet. Point it at the table where the
                real answers land — an order that shipped, a customer who did churn — and every
                batch run is scored against it as the answers arrive.
              </p>
              {!shared && (
                <Button size="sm" className="mt-3" onClick={() => setEditing(true)}>
                  Set an outcome source
                </Button>
              )}
            </div>
          )}

          {editing && (
            <div className="space-y-3 rounded-md border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs">Schema</Label>
                  <Input
                    value={form.schema}
                    onChange={(e) => setForm({ ...form, schema: e.target.value })}
                    placeholder="analytics"
                  />
                </div>
                <div>
                  <Label className="text-xs">Table</Label>
                  <Input
                    value={form.table}
                    onChange={(e) => setForm({ ...form, table: e.target.value })}
                    placeholder="plan_outcomes"
                  />
                </div>
                <div>
                  <Label className="text-xs">Key columns</Label>
                  <Input
                    value={form.keys}
                    onChange={(e) => setForm({ ...form, keys: e.target.value })}
                    placeholder="customer_id"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Comma separated, and present in both tables with the same values.
                  </p>
                </div>
                <div>
                  <Label className="text-xs">Outcome column</Label>
                  <Input
                    value={form.outcome}
                    onChange={(e) => setForm({ ...form, outcome: e.target.value })}
                    placeholder="actual_plan"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    What actually happened. Rows where it is still null are skipped.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={busy}>
                  {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                {source && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={clear}>
                    <X className="mr-1 h-3 w-3" /> Stop measuring
                  </Button>
                )}
              </div>
            </div>
          )}

          {source && !editing && (
            <p className="text-xs text-muted-foreground">
              Outcomes read from{" "}
              <code className="font-mono">
                {source.schema}.{source.table}
              </code>
              , joined on <code className="font-mono">{source.key_columns.join(", ")}</code>, truth
              in <code className="font-mono">{source.outcome_column}</code>.
            </p>
          )}

          {latest && (
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat
                label={`${latest.metric_name} now`}
                value={num(latest.metric_value)}
                hint={higherIsBetter(latest.metric_name) ? "higher is better" : "lower is better"}
              />
              <Stat
                label="At training"
                value={num(latest.baseline_value)}
                hint="validation split"
              />
              <Stat
                label="Change"
                value={latest.decay_ratio === null ? "—" : pct(-latest.decay_ratio)}
                hint={latest.decay_ratio === null ? "no baseline" : "against training"}
              />
              <Stat
                label="Coverage"
                value={pct(latest.scored_rows ? latest.matched_rows / latest.scored_rows : 0)}
                hint={`${latest.matched_rows} of ${latest.scored_rows} scored rows`}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {rows && rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Measured</th>
                <th className="px-3 py-2 text-left font-medium">Metric</th>
                <th className="px-3 py-2 text-right font-medium">Now</th>
                <th className="px-3 py-2 text-right font-medium">Training</th>
                <th className="px-3 py-2 text-right font-medium">Rows</th>
                <th className="px-3 py-2 text-left font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 text-muted-foreground">{relTime(r.created_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.metric_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(r.metric_value)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {num(r.baseline_value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.matched_rows} / {r.scored_rows}
                  </td>
                  <td className="px-3 py-2">{verdictBadge(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows && rows.length === 0 && source && (
        <p className="text-xs text-muted-foreground">
          Nothing measured yet. A batch run is measured once a day while it is less than a month
          old, or press <strong>Measure now</strong>.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
