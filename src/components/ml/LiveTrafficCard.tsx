// Live traffic on a model's Predictions tab (R545): the last day of online
// requests, measured against the training data the way a batch run is. Its
// owner's only (the window sums every caller's requests).
import { useServerFn } from "@tanstack/react-start";
import { Activity } from "lucide-react";
import { useEffect, useState } from "react";

import { relTime } from "@/components/ml/mlFormat";
import { Card, CardContent } from "@/components/ui/card";
import { MISSING_RISE as MISSING_RISE_POINTS, sharePct } from "@/lib/mlMissingInputs";
import { driftBand, type DriftBand } from "@/lib/mlTraffic";
import {
  mlLiveTraffic,
  type LiveTrafficVersion,
  type LiveTrafficView,
} from "@/utils/mlConsole.functions";

const TONE: Record<DriftBand, string> = {
  stable: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  moderate: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
};

const fmt = (n: number) => n.toLocaleString();

function VersionLine({ v, minRows }: { v: LiveTrafficVersion; minRows: number }) {
  const top = Object.entries(v.features)
    .slice(0, 3)
    .map(([k, s]) => `${k} ${s.toFixed(2)}`)
    .join(", ");
  return (
    <li className="space-y-0.5 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {v.version !== null ? `Version ${v.version}` : "A version"}
          {v.production ? " (production)" : ""}
        </span>
        {v.score !== null ? (
          <span
            className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${TONE[driftBand(v.score)]}`}
          >
            {driftBand(v.score)} · {v.score.toFixed(2)}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {fmt(v.rows)} row{v.rows === 1 ? "" : "s"} from {fmt(v.requests)} request
        {v.requests === 1 ? "" : "s"}
        {v.ownerRows < v.rows ? `, ${fmt(v.ownerRows)} of them yours` : ""}
        {v.score === null && v.rows < minRows
          ? `. Drift is measured from ${fmt(minRows)} rows.`
          : top
            ? `. Moved most: ${top}.`
            : "."}
        {v.truncated ? " Only the newest requests were read." : ""}
      </p>
      {v.missing?.length ? (
        // R549: what drift cannot see. It measures the values that arrived.
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Arriving empty:{" "}
          {v.missing
            .slice(0, 4)
            .map(
              (m) =>
                `${m.feature} in ${sharePct(m.rate)} of rows (${m.training === null ? "not recorded at training" : `${sharePct(m.training)} in training`})`,
            )
            .join(", ")}
          {v.missing.length > 4 ? `, and ${v.missing.length - 4} more` : ""}. Those rows were scored
          on a filled-in value; retraining will not fix it.
        </p>
      ) : null}
    </li>
  );
}

export function LiveTrafficCard({ token, modelId }: { token: string; modelId: string }) {
  const fn = useServerFn(mlLiveTraffic);
  const [view, setView] = useState<LiveTrafficView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fn({ data: { access_token: token, modelId } })
      .then((res) => {
        if (!live) return;
        if (res.ok) setView(res.traffic);
        else setError(res.error);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "Could not read the live traffic");
      });
    return () => {
      live = false;
    };
  }, [fn, token, modelId]);

  if (view === null) return null;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Live traffic</h3>
          {view?.checkedAt ? (
            <span className="ml-auto text-[11px] text-muted-foreground">
              checked {relTime(view.checkedAt)}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Requests answered online in the last {view?.windowHours ?? 24} hours, measured against the
          training data the way a batch run is. Only counts are kept: no value a caller sent is
          stored.
        </p>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : view === undefined ? (
          <p className="text-xs text-muted-foreground">Reading…</p>
        ) : (
          <>
            {view.productionUnmeasured !== null ? (
              // FOUND FROM THE UI (R545): such a model's requests keep no
              // counts, and the card used to say there had been none.
              <p className="text-xs text-muted-foreground">
                Version {view.productionUnmeasured}, in production, holds no record of how its
                training data was distributed (it was trained before drift was recorded, or
                imported), so the requests it answers cannot be measured. A version trained now
                records one.
              </p>
            ) : view.versions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No online requests in the last {view.windowHours} hours. Requests through the API, a
                warm endpoint or the playground are measured here from {fmt(view.minRows)} rows.
              </p>
            ) : null}
            {view.versions.length ? (
              <ul className="divide-y">
                {view.versions.map((v) => (
                  <VersionLine key={v.versionId} v={v} minRows={view.minRows} />
                ))}
              </ul>
            ) : null}
          </>
        )}
        {view ? (
          <p className="text-[11px] text-muted-foreground">
            Checked every hour. Above PSI {view.threshold.toFixed(2)} you are told once a day, and
            an ML pipeline set to start on this model&apos;s drift starts when your own requests
            drifted too. A feature that arrives empty in at least{" "}
            {Math.round(MISSING_RISE_POINTS * 100)} more of every 100 rows than it did in training
            is named here, counted from {fmt(view.missingMinRows)} rows, and you are told once a
            day; that starts nothing, because retraining would not fix it.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
