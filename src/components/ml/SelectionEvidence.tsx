// How this version's number was arrived at, and what it is worth.
//
// A single metric on a card invites a precision nobody measured. Two things
// make it honest, and both are read from what the trainer recorded:
//
//   WHAT THE FOLDS DID. Selection scored every candidate across folds inside
//   the training rows. The spread between those folds is how much the score
//   moves when the same model meets different rows — which is exactly the
//   scale a reader needs before comparing two versions, or believing a decay
//   alert.
//
//   WHAT THE HELD-BACK ROWS SAID. Nothing in selection was allowed to read
//   them, so this is the estimate that has not been optimised against. Showing
//   it BESIDE the fold mean, rather than instead of it, is the point: when the
//   two disagree, that disagreement is information.
//
// Nothing here computes a metric. Every number is read.
import { Info, Layers } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  holdoutGap,
  readCrossValidation,
  relativeSpread,
  spreadBand,
  strategyLabel,
  type MlCrossValidation,
} from "@/lib/mlCrossValidation";
import { fmtMetric, metricLabel } from "@/components/ml/mlUi";

const BAND_COPY: Record<string, string> = {
  tight: "The folds agreed closely, so this score is a firm number.",
  moderate: "The folds moved around a little; treat small differences between versions as noise.",
  wide: "The folds disagreed a lot. A single score from this model is a rough guide, not a figure to set a rule by.",
  unmeasured: "",
};

const BAND_TONE: Record<string, string> = {
  tight: "text-emerald-600 dark:text-emerald-400",
  moderate: "text-amber-600 dark:text-amber-400",
  wide: "text-destructive",
  unmeasured: "text-muted-foreground",
};

/** Each fold's score on one line, so the spread is a shape and not a decimal. */
function FoldStrip({ cv }: { cv: MlCrossValidation }) {
  if (cv.scores.length < 2) return null;
  const lo = Math.min(...cv.scores);
  const hi = Math.max(...cv.scores);
  const span = hi - lo || 1;
  return (
    <div className="mt-2">
      <div className="flex h-6 items-end gap-1">
        {cv.scores.map((s, i) => (
          <div
            key={i}
            title={`fold ${i + 1}: ${fmtMetric(cv.metric, s)}`}
            className="flex-1 rounded-sm bg-primary/30"
            // A floor of 20% so a fold that happens to be the minimum is still
            // a visible bar rather than an invisible one.
            style={{ height: `${20 + (80 * (s - lo)) / span}%` }}
          />
        ))}
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {cv.scores.length} folds, {fmtMetric(cv.metric, lo)} to {fmtMetric(cv.metric, hi)}
      </p>
    </div>
  );
}

export function SelectionEvidence({ metrics }: { metrics: unknown }) {
  const cv = readCrossValidation(metrics);

  if (!cv) {
    // Deliberately not silent. A version trained before this existed had its
    // winner chosen on the very rows it reports from, so its headline number
    // is optimistic by an unknown amount — and saying nothing would let it sit
    // beside a newer version's honest figure as though they were comparable.
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-start gap-2 py-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This version was trained before selection and reporting were separated, so the algorithm
            that won was chosen on the same rows this score is measured on. Expect the number to
            flatter the model a little. Retrain to get a score nothing optimised against, and a
            spread to read it with.
          </span>
        </CardContent>
      </Card>
    );
  }

  const band = spreadBand(cv);
  const rel = relativeSpread(cv);
  const gap = holdoutGap(cv);
  const label = metricLabel(cv.metric);

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Layers className="h-4 w-4" /> How this score was reached
          </h3>
          <Badge variant="outline" className="text-[10px]">
            {strategyLabel(cv.strategy)}
            {cv.scores.length > 1 ? ` · ${cv.folds}` : ""}
          </Badge>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {cv.scores.length > 1 ? "Across the folds" : "On the selection split"}
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {cv.mean === null ? "—" : fmtMetric(cv.metric, cv.mean)}
              {cv.scores.length > 1 && cv.std !== null ? (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  ± {fmtMetric(cv.metric, cv.std)}
                </span>
              ) : null}
            </p>
            <p className="text-[11px] text-muted-foreground">
              what chose the winner, inside {cv.training_rows.toLocaleString()} training rows
            </p>
            <FoldStrip cv={cv} />
          </div>

          <div className="rounded-md border p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              On the held-back rows
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {cv.holdout_value === null ? "—" : fmtMetric(cv.metric, cv.holdout_value)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {cv.holdout_rows.toLocaleString()} rows nothing above was allowed to read — this is
              the {label} the version reports
            </p>
            {gap !== null ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {Math.abs(gap) < (cv.std ?? 0) || Math.abs(gap) < 1e-9 ? (
                  <>The two agree, which is the reassuring case.</>
                ) : gap > 0 ? (
                  <>
                    Better than the folds expected by{" "}
                    <span className="tabular-nums">{fmtMetric(cv.metric, Math.abs(gap))}</span> —
                    with a holdout this size that is usually luck rather than news.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-amber-600 dark:text-amber-400">
                      Worse than the folds expected
                    </span>{" "}
                    by <span className="tabular-nums">{fmtMetric(cv.metric, Math.abs(gap))}</span> —
                    the winner did not repeat itself on rows nothing had touched.
                  </>
                )}
              </p>
            ) : null}
          </div>
        </div>

        {band !== "unmeasured" ? (
          <p className={cn("text-xs font-medium", BAND_TONE[band])}>
            {BAND_COPY[band]}
            {rel !== null ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                Folds varied by {(rel * 100).toFixed(0)}% of the score.
              </span>
            ) : null}
          </p>
        ) : null}

        <p className="text-[11px] leading-relaxed text-muted-foreground">{cv.reason}.</p>
      </CardContent>
    </Card>
  );
}
