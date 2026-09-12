// Is the confidence number real, and where should the line be?
//
// Between "was the model right" and "was it right for everyone" sits the
// question both of those quietly assume: that 0.8 means eighty percent. For a
// tree ensemble it usually does not — it votes 8 of 10 and prints 0.8 — and
// this product has shown that number next to the word "confidence" from the
// first release. So the panel shows the reliability curve, which is the only
// honest way to answer it: what the model said, beside what actually happened.
//
// The second half of the panel is the operating point. Every threshold in the
// table was MEASURED by the trainer on the holdout; nothing here is
// interpolated, and nothing here is a recommendation. Picking one is a
// business judgement about which mistake costs more, and the person making it
// is the one reading this screen.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Gauge, Info, Loader2, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  balancedThreshold,
  calibrationBand,
  calibrationVerdict,
  effectiveScores,
  readCalibration,
  readThresholdSweep,
  sweepRowAt,
  thresholdChange,
  type MlCalibrationScores,
  type MlSweepRow,
} from "@/lib/mlCalibration";
import { mlDecisionSettings, mlSetDecisionThreshold } from "@/utils/ml.functions";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const sig = (n: number) => n.toFixed(4);

const BAND_COPY: Record<string, string> = {
  tight: "Typically within 5 points of the truth — safe to use in a rule.",
  usable: "Typically within 15 points — fine for ranking, loose for a rule.",
  loose: "Off by more than 15 points on average — treat these as ranks, not probabilities.",
};

const BAND_TONE: Record<string, string> = {
  tight: "text-emerald-600 dark:text-emerald-400",
  usable: "text-amber-600 dark:text-amber-400",
  loose: "text-destructive",
};

/**
 * Predicted against observed, with the diagonal that would mean "honest".
 *
 * A point above the line is a model under-selling itself; below, over-selling.
 * Radius carries the bin count, because a bin holding four rows landing far
 * off the line is noise and one holding four hundred is a problem.
 */
function ReliabilityChart({
  before,
  after,
}: {
  before: MlCalibrationScores;
  after: MlCalibrationScores | null;
}) {
  const w = 260;
  const h = 200;
  const pad = 28;
  const x = (v: number) => pad + v * (w - pad * 2);
  const y = (v: number) => h - pad - v * (h - pad * 2);
  const maxN = Math.max(
    1,
    ...before.curve.map((b) => b.n),
    ...(after?.curve ?? []).map((b) => b.n),
  );
  const r = (n: number) => 2.5 + 4 * Math.sqrt(n / maxN);

  const path = (c: MlCalibrationScores["curve"]) =>
    c.length < 2
      ? ""
      : c.map((b, i) => `${i ? "L" : "M"}${x(b.predicted)},${y(b.observed)}`).join("");

  return (
    <svg
      width={w}
      height={h}
      role="img"
      aria-label="Reliability curve: predicted probability against observed frequency"
      className="max-w-full"
    >
      <rect
        x={pad}
        y={pad}
        width={w - pad * 2}
        height={h - pad * 2}
        fill="none"
        className="stroke-border"
        strokeWidth="1"
      />
      {/* Perfect calibration. Everything is read as distance from this. */}
      <line
        x1={x(0)}
        y1={y(0)}
        x2={x(1)}
        y2={y(1)}
        className="stroke-muted-foreground"
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <path
        d={path(before.curve)}
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth="1.5"
      />
      {before.curve.map((b, i) => (
        <circle
          key={`b${i}`}
          cx={x(b.predicted)}
          cy={y(b.observed)}
          r={r(b.n)}
          className="fill-muted-foreground/40"
        />
      ))}
      {after ? (
        <>
          <path d={path(after.curve)} fill="none" className="stroke-primary" strokeWidth="1.75" />
          {after.curve.map((b, i) => (
            <circle
              key={`a${i}`}
              cx={x(b.predicted)}
              cy={y(b.observed)}
              r={r(b.n)}
              className="fill-primary/70"
            />
          ))}
        </>
      ) : null}
      <text x={pad} y={h - 8} className="fill-muted-foreground text-[9px]">
        0
      </text>
      <text x={w - pad - 6} y={h - 8} className="fill-muted-foreground text-[9px]">
        1
      </text>
      <text x={w / 2 - 34} y={h - 8} className="fill-muted-foreground text-[9px]">
        model said
      </text>
      <text
        x={-h / 2 - 26}
        y={10}
        transform="rotate(-90)"
        className="fill-muted-foreground text-[9px]"
      >
        actually happened
      </text>
    </svg>
  );
}

export function CalibrationPanel({
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
  const loadFn = useServerFn(mlDecisionSettings);
  const saveFn = useServerFn(mlSetDecisionThreshold);

  const [state, setState] = useState<Awaited<ReturnType<typeof mlDecisionSettings>> | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await loadFn({ data: { access_token: token, model_id: modelId } });
    setState(res);
    setPicked(res.threshold);
  }, [loadFn, token, modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = useMemo(() => readCalibration(state?.metrics), [state]);
  const sweep = useMemo(() => readThresholdSweep(state?.metrics), [state]);

  if (task !== "classification") {
    return null;
  }

  if (state && !state.version_id) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Nothing is in production yet. Calibration and the decision threshold describe the version
          that is actually deciding, so they appear once a version is promoted.
        </CardContent>
      </Card>
    );
  }

  const verdict = calibrationVerdict(report);
  const scores = report ? effectiveScores(report) : null;
  const band = scores ? calibrationBand(scores.calibration_error) : null;
  const live = state?.threshold ?? null;
  const dirty = picked !== live;
  const change = sweep && dirty ? thresholdChange(sweep, live ?? 0.5, picked ?? 0.5) : null;
  const currentRow: MlSweepRow | null = sweep ? sweepRowAt(sweep, picked ?? 0.5) : null;

  const save = async () => {
    if (!state?.version_id) return;
    const target = picked;
    const body =
      target === null
        ? "Predictions go back to the model's own choice, which is whichever class scores highest."
        : `Rows scoring ${pct(target)} or higher are called "${sweep?.positive_label ?? "positive"}". On the last holdout that would have been ${currentRow?.selected ?? "—"} rows, at ${currentRow ? pct(currentRow.precision) : "—"} precision.`;
    if (
      !(await confirmAsk({
        title:
          target === null ? "Remove the decision threshold?" : "Change where the line is drawn?",
        // This takes effect on the NEXT prediction, not the next retrain, and
        // saying so is the difference between a considered change and a
        // surprise in tomorrow's batch.
        body: `${body}\n\nThis applies from the next prediction onwards. The model is not retrained.`,
        actionLabel: target === null ? "Remove threshold" : "Move the line",
      }))
    )
      return;
    setBusy(true);
    const res = await saveFn({
      data: {
        access_token: token,
        version_id: state.version_id,
        threshold: target,
        positive_label: target === null ? null : (sweep?.positive_label ?? null),
      },
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(target === null ? "Threshold removed" : `Line moved to ${pct(target)}`);
    void load();
  };

  return (
    <Card>
      <CardContent className="space-y-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Gauge className="h-4 w-4" /> Confidence and the decision line
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Every prediction carries a probability. This is where you find out whether it is one —
            and where you choose how high it has to be before the model acts.
          </p>
        </div>

        {/* ── Is 0.8 really 80%? ─────────────────────────────────────────── */}
        {!report ? (
          <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
            This version was trained before calibration was measured. Retrain it to get a
            reliability curve; until then, read the confidence column as a ranking rather than a
            probability.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <div className="rounded-md border p-3">
              <ReliabilityChart
                before={report.before}
                after={report.calibrated ? report.after : null}
              />
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-3 rounded bg-muted-foreground/60" />
                  {report.calibrated ? "before" : "measured"}
                </span>
                {report.calibrated ? (
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-3 rounded bg-primary" /> after calibration
                  </span>
                ) : null}
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-3 border-t border-dashed border-muted-foreground" />{" "}
                  honest
                </span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {verdict === "calibrated" ? (
                  <Badge variant="outline" className="gap-1 text-emerald-600">
                    <CheckCircle2 className="h-3 w-3" /> Calibrated ({report.method})
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <Info className="h-3 w-3" /> Left uncalibrated
                  </Badge>
                )}
                {band ? (
                  <span className={cn("text-xs font-medium", BAND_TONE[band])}>
                    {BAND_COPY[band]}
                  </span>
                ) : null}
              </div>

              {scores ? (
                <div className="grid grid-cols-2 gap-3">
                  <Fig
                    label="Calibration error"
                    value={sig(scores.calibration_error)}
                    was={
                      report.calibrated && report.after
                        ? sig(report.before.calibration_error)
                        : null
                    }
                    hint="mean gap between said and happened"
                  />
                  <Fig
                    label="Brier score"
                    value={sig(scores.brier)}
                    was={report.calibrated && report.after ? sig(report.before.brier) : null}
                    hint="squared error of the probabilities, lower is better"
                  />
                </div>
              ) : null}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {report.calibrated
                  ? `The probabilities were remapped with ${report.method} regression and kept, because doing so improved both figures on the holdout.`
                  : "Calibration was tried and discarded: it did not improve both figures on the holdout, so the original probabilities were kept. Check the version's notes for the numbers."}
              </p>
            </div>
          </div>
        )}

        {/* ── Where the line is ──────────────────────────────────────────── */}
        <div className="border-t pt-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="h-4 w-4" /> Operating point
          </h4>
          {!sweep ? (
            <p className="mt-1 text-xs text-muted-foreground">
              A single threshold only means something for a two-class model. This one predicts more
              than two classes, so each prediction is simply whichever class scores highest.
            </p>
          ) : (
            <>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                Every row below was measured on the holdout. Raising the line means acting on fewer
                rows and being right more often about the ones you do act on; lowering it means the
                reverse. Which trade is correct is a fact about your business, not about the model —
                the balanced point is marked, not recommended.
              </p>

              <div className="mt-3 overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Line at</th>
                      <th className="px-3 py-2 text-right font-medium">Rows acted on</th>
                      <th className="px-3 py-2 text-right font-medium">Right when it acts</th>
                      <th className="px-3 py-2 text-right font-medium">Caught</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {sweep.rows.map((row) => {
                      const isPicked = picked !== null && Math.abs(row.threshold - picked) < 1e-9;
                      const isLive = live !== null && Math.abs(row.threshold - live) < 1e-9;
                      const isBalanced = Math.abs(row.threshold - balancedThreshold(sweep)) < 1e-9;
                      return (
                        <tr
                          key={row.threshold}
                          data-threshold={row.threshold}
                          className={cn(
                            "border-t",
                            !shared && "hover:bg-muted/40",
                            isPicked && "bg-primary/10",
                          )}
                        >
                          {/* A real radio, not a clickable row. Picking one of
                              nineteen operating points IS a radio group, and
                              saying so gets keyboard and screen-reader
                              behaviour that a <tr onClick> never has: arrow
                              keys move between points, the group announces
                              itself, and the row keeps its table semantics
                              instead of claiming to be a button. */}
                          <td className="px-3 py-1.5">
                            <label
                              className={cn("flex items-center gap-2", !shared && "cursor-pointer")}
                            >
                              <input
                                type="radio"
                                name="ml-operating-point"
                                className="h-3.5 w-3.5 accent-primary"
                                checked={isPicked}
                                disabled={shared}
                                onChange={() => setPicked(row.threshold)}
                                aria-label={`Draw the line at ${row.threshold.toFixed(2)}: ${row.selected} rows, ${pct(row.precision)} right when it acts`}
                              />
                              <span className="font-mono text-xs tabular-nums">
                                {row.threshold.toFixed(2)}
                              </span>
                            </label>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{row.selected}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {pct(row.precision)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{pct(row.recall)}</td>
                          <td className="px-3 py-1.5 text-right">
                            <span className="flex justify-end gap-1">
                              {isLive ? (
                                <Badge variant="secondary" className="text-[10px]">
                                  in use
                                </Badge>
                              ) : null}
                              {isBalanced ? (
                                <Badge variant="outline" className="text-[10px]">
                                  balanced
                                </Badge>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* A retrain does not carry the line forward, and a scheduled
                  one that promotes when the metric improves would otherwise
                  put production back on argmax with nobody deciding to. The
                  fact is stated; the choice is still the operator's, because a
                  threshold only means the same thing across two versions whose
                  probabilities do. */}
              {state?.inherited && !dirty ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="flex-1">
                    Version {state.inherited.version} was drawing the line at{" "}
                    <strong className="tabular-nums">{state.inherited.threshold.toFixed(2)}</strong>
                    . This version was promoted without one, so it is deciding by whichever class
                    scores highest. A line is not carried across a retrain — it only means the same
                    thing if the new version&apos;s probabilities do.
                  </span>
                  {!shared ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPicked(state.inherited!.threshold)}
                    >
                      Draw it there again
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <p className="mt-2 text-[11px] text-muted-foreground">
                &ldquo;{sweep.positive_label}&rdquo; is the class the line is about. Rows scoring at
                or above it get that label.
                {live === null
                  ? " No line is set, so the model picks whichever class scores highest — the same as a line at 50%, but chosen by nobody."
                  : null}
              </p>

              {change ? (
                <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
                  {/* The two counts, not a share of a total this table does not
                      know. The lowest measured line is not the holdout size —
                      it is only the rows that scored above 0.05 — and calling
                      it "the holdout" would be a denominator the platform
                      never measured, in a sentence about being precise. */}
                  <strong className="font-semibold">What changes:</strong> on the last holdout the
                  model would act on <span className="tabular-nums">{change.to.selected}</span> rows
                  instead of <span className="tabular-nums">{change.from.selected}</span>, it would
                  be right{" "}
                  <span className="tabular-nums">
                    {change.precision_delta >= 0 ? "+" : ""}
                    {pct(change.precision_delta)}
                  </span>{" "}
                  of the time when it acts, and it would catch{" "}
                  <span className="tabular-nums">
                    {change.recall_delta >= 0 ? "+" : ""}
                    {pct(change.recall_delta)}
                  </span>{" "}
                  of what is out there.
                </div>
              ) : null}

              {!shared ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={save} disabled={busy || !dirty}>
                    {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {/* The label names the action this press would take, which
                        is not the same as the state it is in. With no line set
                        and none picked the button is disabled anyway, and
                        "Remove the line" then offers to remove something that
                        is not there — found by reading the screen after a
                        retrain had cleared it. */}
                    {picked !== null
                      ? `Draw the line at ${picked.toFixed(2)}`
                      : live !== null
                        ? "Remove the line"
                        : "No line set"}
                  </Button>
                  {dirty ? (
                    <Button size="sm" variant="ghost" onClick={() => setPicked(live)}>
                      Cancel
                    </Button>
                  ) : null}
                  {live !== null && !dirty ? (
                    <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                      Remove the line
                    </Button>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground">
                    Takes effect on the next prediction. No retraining.
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Fig({
  label,
  value,
  was,
  hint,
}: {
  label: string;
  value: string;
  was: string | null;
  hint: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">
        {value}
        {was ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground line-through">{was}</span>
        ) : null}
      </p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
