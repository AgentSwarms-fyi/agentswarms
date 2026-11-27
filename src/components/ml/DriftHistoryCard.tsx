// Drift over time on a model's Predictions tab (R548): each batch run's PSI
// and each day's live-traffic PSI, against the alert threshold. The owner's
// only, as the live card is: the daily verdicts sum every caller's requests.
import { useServerFn } from "@tanstack/react-start";
import { LineChart as LineChartIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import {
  driftAxis,
  driftHistoryLine,
  driftHistoryRows,
  driftPlotRows,
  type DriftPlotRow,
} from "@/lib/mlDriftHistory";
import { TRAFFIC_MIN_ROWS } from "@/lib/mlTraffic";
import { mlDriftHistory, type DriftHistoryView } from "@/utils/mlConsole.functions";

export function DriftHistoryCard({ token, modelId }: { token: string; modelId: string }) {
  const fn = useServerFn(mlDriftHistory);
  const [view, setView] = useState<DriftHistoryView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fn({ data: { access_token: token, modelId } })
      .then((res) => {
        if (!live) return;
        if (res.ok) setView(res.history);
        else setError(res.error);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "Could not read the drift history");
      });
    return () => {
      live = false;
    };
  }, [fn, token, modelId]);

  const rows = useMemo(() => (view ? driftHistoryRows(view.batch, view.daily) : []), [view]);
  const line = view ? driftHistoryLine(rows, view.threshold) : null;
  const plot = useMemo(() => driftPlotRows(rows), [rows]);
  const axis = useMemo(() => driftAxis(rows, view?.threshold ?? 0.25), [rows, view]);

  if (view === null) return null;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Drift over time</h3>
        </div>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : view === undefined ? (
          <p className="text-xs text-muted-foreground">Reading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing measured in the last {view.days} days. A batch run of ten rows or more, or a day
            with {TRAFFIC_MIN_ROWS} online rows, puts a point here.
            {view.dailyKept ? "" : " Live traffic history needs migration 20261208000000."}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {line}
              {view.dailyKept ? "" : " Live traffic history needs migration 20261208000000."}
            </p>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={plot} margin={{ left: 4, right: 16, top: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} minTickGap={24} />
                  {/* FOUND FROM THE UI (R548): one run at PSI 6.3 flattened the
                      threshold onto the floor of a linear axis. */}
                  <YAxis
                    scale="log"
                    domain={axis.domain}
                    ticks={axis.ticks}
                    allowDataOverflow
                    tick={{ fontSize: 10 }}
                    width={40}
                  />
                  <Tooltip
                    // The real reading, not the one drawn on the axis's floor.
                    formatter={(_value: number, name: string, item: { payload?: DriftPlotRow }) => {
                      const r = item.payload;
                      const v = name === "batch runs" ? r?.batch : r?.live;
                      return [typeof v === "number" ? v.toFixed(2) : "—", name];
                    }}
                    labelFormatter={(day: string) => {
                      const r = rows.find((x) => x.day === day);
                      return r?.versions.length ? `${day} · version ${r.versions.join(", ")}` : day;
                    }}
                  />
                  <Legend />
                  <ReferenceLine
                    y={view.threshold}
                    stroke="var(--destructive)"
                    strokeDasharray="4 3"
                    label={{ value: "alert", fontSize: 10, position: "insideTopRight" }}
                  />
                  <ReferenceLine y={view.moderate} stroke="var(--border)" strokeDasharray="2 3" />
                  {/* FOUND FROM THE UI (R548): the dots took the line's zero
                      stroke and a white fill, and could not be seen. */}
                  <Line
                    dataKey="batchPlot"
                    name="batch runs"
                    stroke="var(--chart-1)"
                    strokeWidth={0}
                    dot={{
                      r: 3.5,
                      fill: "var(--chart-1)",
                      stroke: "var(--chart-1)",
                      strokeWidth: 1,
                    }}
                    activeDot={{ r: 5, fill: "var(--chart-1)" }}
                    legendType="circle"
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  <Line
                    dataKey="livePlot"
                    name="live traffic"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: "var(--chart-2)", stroke: "var(--chart-2)" }}
                    isAnimationActive={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Population stability against the training data: below {view.moderate} stable, from{" "}
              {view.threshold} the alert. A batch run is one table scored at once; live traffic is a
              day of requests. They are drawn apart because they are different rows.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
