// Runs per hour for the last 24 hours.
//
// This was twenty-four `<div>`s with an inline height percentage. It read as a
// chart from a distance and behaved like nothing at all up close: no axis, no
// hover beyond a `title` attribute, no zero baseline, and a flat 2px line for
// an empty account that looked like a rendering failure rather than a quiet
// day. Recharts is already a dependency and is already wrapped by the app's
// own chart primitive on four other pages, so the hand-rolled version was the
// odd one out as well as the weakest.
//
// The class components are cast through `any` for the same reason the
// analytics page does it: React 19's stricter JSX typing rejects them.

import * as Recharts from "recharts";

import { bucketHour } from "@/lib/dashboardActivity";

const ResponsiveContainer = Recharts.ResponsiveContainer as any;
const AreaChart = Recharts.AreaChart as any;
const Area = Recharts.Area as any;
const XAxis = Recharts.XAxis as any;
const YAxis = Recharts.YAxis as any;
const Tooltip = Recharts.Tooltip as any;
const CartesianGrid = Recharts.CartesianGrid as any;

export function ActivityChart({
  buckets,
  now,
  height = 180,
}: {
  buckets: number[];
  /** The same `now` the buckets were built from, so the labels agree with them. */
  now: number;
  height?: number;
}) {
  // `hourlyBuckets` returns chronological buckets, and `bucketHour` maps a
  // bucket index to the wall-clock hour it covers — so the index goes in as-is.
  const data = buckets.map((runs, i) => ({
    hour: `${String(bucketHour(i, now)).padStart(2, "0")}:00`,
    runs,
  }));
  const busiest = Math.max(0, ...buckets);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="dash-activity" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            // Every fourth label: 24 of them at this width overlap into a
            // grey smear that reads as noise rather than as hours.
            interval={3}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            // A quiet day should still draw a floor-to-ceiling axis rather
            // than collapsing to a single line at zero.
            domain={[0, busiest > 0 ? "auto" : 1]}
            width={40}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)" }}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            formatter={(v: number) => [`${v} run${v === 1 ? "" : "s"}`, ""]}
          />
          <Area
            type="monotone"
            dataKey="runs"
            stroke="var(--primary)"
            strokeWidth={2}
            fill="url(#dash-activity)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
