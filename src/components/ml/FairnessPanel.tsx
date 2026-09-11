// Does the model treat groups differently?
//
// Two numbers, side by side, because each hides the other. The SELECTION RATE
// ratio asks how often each group gets the favourable answer — it needs no
// outcomes and it is what employment and lending law is written about. The
// TRUE-POSITIVE-RATE GAP asks whether the model is WRONG more often for one
// group, which needs outcomes. A model can be even on the first and badly off
// on the second, so the panel never shows one without room for the other.
//
// Two deliberate refusals in the copy: the verdict is "review", never "unfair"
// — that is a judgement about a context this platform cannot see — and a group
// too small to judge is still shown, greyed, because hiding one is how a real
// problem stays invisible for a quarter.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, Scale, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { relTime } from "@/components/ml/mlUi";
import { MIN_GROUP_FOR_VERDICT } from "@/lib/mlFairness";
import {
  mlListFairness,
  mlListPredictions,
  mlNarrateFairness,
  mlRunFairnessCheck,
  mlSetFairnessConfig,
  mlSuggestSensitiveColumns,
  type MlFairnessRow,
  type MlSensitiveSuggestion,
} from "@/utils/ml.functions";

type Group = {
  group: string;
  n: number;
  selection_rate: number | null;
  true_positive_rate: number | null;
  false_positive_rate: number | null;
  accuracy: number | null;
};

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;

function verdictBadge(v: string | null) {
  if (v === "review")
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> Worth a review
      </Badge>
    );
  if (v === "even")
    return (
      <Badge variant="outline" className="gap-1 text-emerald-600">
        <CheckCircle2 className="h-3 w-3" /> Groups came out even
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1">
      <HelpCircle className="h-3 w-3" /> Not measurable
    </Badge>
  );
}

export function FairnessPanel({
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
  const listFn = useServerFn(mlListFairness);
  const setFn = useServerFn(mlSetFairnessConfig);
  const runFn = useServerFn(mlRunFairnessCheck);
  const suggestFn = useServerFn(mlSuggestSensitiveColumns);
  const narrateFn = useServerFn(mlNarrateFairness);
  const predictionsFn = useServerFn(mlListPredictions);

  const [checks, setChecks] = useState<MlFairnessRow[] | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [favourable, setFavourable] = useState("");
  const [suggestions, setSuggestions] = useState<MlSensitiveSuggestion[] | null>(null);
  const [busy, setBusy] = useState<null | "save" | "run" | "suggest" | "narrate">(null);

  const load = useCallback(async () => {
    const res = await listFn({ data: { access_token: token, model_id: modelId } });
    setChecks(res.checks);
    setColumns(res.sensitive_columns);
    setCandidates(res.candidates);
    setFavourable(res.favourable_label ?? "");
  }, [listFn, token, modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (task !== "classification") {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Fairness here is about a decision — how often each group gets the favourable answer, and
          whether the model is wrong more often for one of them. A {task} model does not make a
          decision of that shape, so there is nothing to compare.
        </CardContent>
      </Card>
    );
  }

  const toggle = (c: string) =>
    setColumns((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const save = async () => {
    setBusy("save");
    const res = await setFn({
      data: {
        access_token: token,
        model_id: modelId,
        sensitive_columns: columns,
        favourable_label: favourable.trim() || null,
      },
    });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Saved");
    void load();
  };

  const suggest = async () => {
    setBusy("suggest");
    const res = await suggestFn({ data: { access_token: token, model_id: modelId } });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    setSuggestions(res.suggestions);
    if (!res.suggestions.length) toast.info("Nothing stood out from the column names");
  };

  const run = async () => {
    setBusy("run");
    try {
      const { predictions } = await predictionsFn({
        data: { access_token: token, model_id: modelId },
      });
      const batch = predictions.find((p) => p.kind === "batch" && p.status === "succeeded");
      if (!batch) return toast.error("No successful batch run to compare yet");
      const res = await runFn({ data: { access_token: token, prediction_id: batch.id } });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Compared ${res.checks.length} column(s)`);
        void load();
      }
    } finally {
      setBusy(null);
    }
  };

  const narrate = async (id: string) => {
    setBusy("narrate");
    const res = await narrateFn({ data: { access_token: token, check_id: id } });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    void load();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Scale className="h-4 w-4" /> How groups are treated
              </h3>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                How often each group gets the favourable answer, and — where real outcomes are known
                — whether the model is wrong more often for one of them. A model can be even on the
                first and badly off on the second, so both are reported.
              </p>
            </div>
            {!shared && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={suggest} disabled={busy !== null}>
                  {busy === "suggest" ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 h-3 w-3" />
                  )}
                  Suggest columns
                </Button>
                <Button size="sm" onClick={run} disabled={busy !== null || !columns.length}>
                  {busy === "run" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  Compare now
                </Button>
              </div>
            )}
          </div>

          {suggestions && (
            <div className="rounded-md border border-dashed p-3">
              <p className="text-xs font-medium">Suggested by the assistant — tick what applies</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Only column names and types were sent, never any values. Nothing is enabled until
                you save: which attributes are protected is a legal question about your context, not
                one this platform can answer for you.
              </p>
              <div className="mt-2 space-y-1.5">
                {suggestions.length === 0 && (
                  <p className="text-xs text-muted-foreground">Nothing stood out.</p>
                )}
                {suggestions.map((s) => (
                  <label key={s.column} className="flex cursor-pointer items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-primary"
                      checked={columns.includes(s.column)}
                      onChange={() => toggle(s.column)}
                    />
                    <span>
                      <span className="font-mono">{s.column}</span>
                      {s.proxy && (
                        <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[10px]">
                          stands in for one
                        </Badge>
                      )}
                      <span className="text-muted-foreground"> — {s.reason}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {!shared && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Compare groups by</Label>
                <div className="mt-1 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-md border p-2">
                  {candidates.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      No feature schema on the production version yet.
                    </span>
                  )}
                  {candidates.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggle(c)}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                        columns.includes(c)
                          ? "border-primary bg-primary/10 text-primary"
                          : "text-muted-foreground"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs">The favourable answer</Label>
                <Input
                  className="mt-1"
                  value={favourable}
                  onChange={(e) => setFavourable(e.target.value)}
                  placeholder="approved"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  The predicted label that counts as the good outcome. Named by you and never
                  guessed — &ldquo;approved&rdquo; is favourable, &ldquo;fraud&rdquo; is not, and
                  &ldquo;churn&rdquo; depends who is asking.
                </p>
                <Button size="sm" className="mt-2" onClick={save} disabled={busy !== null}>
                  {busy === "save" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Save
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {checks?.map((c) => {
        const groups = (c.groups ?? []) as unknown as Group[];
        return (
          <Card key={c.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{c.column_name}</span>
                  {verdictBadge(c.verdict)}
                  <span className="text-[11px] text-muted-foreground">{relTime(c.created_at)}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span>
                    selection ratio{" "}
                    <strong className="tabular-nums">
                      {c.disparate_impact === null ? "—" : c.disparate_impact.toFixed(2)}
                    </strong>
                  </span>
                  <span>
                    largest error gap{" "}
                    <strong className="tabular-nums">{pct(c.equal_opportunity_gap)}</strong>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 text-left font-medium">Group</th>
                      <th className="py-1 text-right font-medium">Rows</th>
                      <th className="py-1 text-right font-medium">Selected</th>
                      <th className="py-1 text-right font-medium">Found (TPR)</th>
                      <th className="py-1 text-right font-medium">False alarms (FPR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const small = g.n < MIN_GROUP_FOR_VERDICT;
                      return (
                        <tr
                          key={g.group}
                          className={`border-t ${small ? "text-muted-foreground" : ""}`}
                          title={small ? "Too few rows to judge; shown, but not compared" : ""}
                        >
                          <td className="py-1">
                            {g.group}
                            {small && <span className="ml-1 text-[10px]">(too few to judge)</span>}
                          </td>
                          <td className="py-1 text-right tabular-nums">{g.n}</td>
                          <td className="py-1 text-right tabular-nums">{pct(g.selection_rate)}</td>
                          <td className="py-1 text-right tabular-nums">
                            {pct(g.true_positive_rate)}
                          </td>
                          <td className="py-1 text-right tabular-nums">
                            {pct(g.false_positive_rate)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {c.narrative ? (
                <div className="rounded-md bg-muted/40 p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    In words
                  </p>
                  <p className="mt-1 text-xs">{c.narrative}</p>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    Written by the assistant from the figures above — every number it was given was
                    measured here, and the table is the record.
                  </p>
                </div>
              ) : (
                !shared && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => narrate(c.id)}
                    disabled={busy !== null}
                  >
                    {busy === "narrate" ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1 h-3 w-3" />
                    )}
                    Explain this in words
                  </Button>
                )
              )}
            </CardContent>
          </Card>
        );
      })}

      {checks && checks.length === 0 && columns.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing compared yet — press <strong>Compare now</strong>.
        </p>
      )}
    </div>
  );
}
