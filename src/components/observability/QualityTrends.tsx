import { useEffect, useMemo, useState } from "react";
import * as Recharts from "recharts";
import { format } from "date-fns";
import { Gauge, TrendingUp, TrendingDown, Minus, ClipboardCheck, Target } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  parseEvalScorecard,
  buildQualityTrends,
  type QualityItem,
  type QualityTrends as Trends,
} from "@/lib/evalScorecard";

// React 19's stricter JSX typing rejects recharts' class components — cast via any.
const ResponsiveContainer = Recharts.ResponsiveContainer as any;
const AreaChart = Recharts.AreaChart as any;
const Area = Recharts.Area as any;
const XAxis = Recharts.XAxis as any;
const YAxis = Recharts.YAxis as any;
const Tooltip = Recharts.Tooltip as any;
const CartesianGrid = Recharts.CartesianGrid as any;

const pct = (n: number | null | undefined) => (n == null ? "—" : Math.round(n * 100) + "%");
const scoreColor = (n: number | null | undefined) =>
  n == null
    ? "text-muted-foreground"
    : n >= 0.8
      ? "text-emerald-500"
      : n >= 0.6
        ? "text-amber-500"
        : "text-red-500";
const barColor = (n: number) =>
  n >= 0.8 ? "bg-emerald-500" : n >= 0.6 ? "bg-amber-500" : "bg-red-500";

type StepRow = {
  started_at: string;
  output: string | null;
  swarm_runs: { swarm_name: string | null } | { swarm_name: string | null }[] | null;
};

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold tracking-tight mt-1 ${valueClass ?? ""}`}>{value}</p>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

export function QualityTrends() {
  const { user } = useAuth();
  const [items, setItems] = useState<QualityItem[] | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data } = await supabase
        .from("swarm_run_steps")
        .select("started_at, output, swarm_runs(swarm_name)")
        .eq("node_kind", "evaluate")
        .gte("started_at", since)
        .order("started_at", { ascending: true })
        .limit(2000);
      const parsed: QualityItem[] = [];
      for (const row of (data ?? []) as StepRow[]) {
        const card = parseEvalScorecard(row.output);
        if (!card) continue;
        const run = Array.isArray(row.swarm_runs) ? row.swarm_runs[0] : row.swarm_runs;
        parsed.push({
          started_at: row.started_at,
          swarm_name: run?.swarm_name ?? "Untitled swarm",
          overall: card.overall,
          pass: card.pass,
          metrics: card.metrics,
        });
      }
      setItems(parsed);
    })();
  }, [user]);

  const trends: Trends | null = useMemo(() => (items ? buildQualityTrends(items) : null), [items]);

  if (!trends) {
    return <Skeleton className="h-40" />;
  }

  // Nothing to show — keep the page clean but discoverable.
  if (trends.total === 0) {
    return (
      <Card className="p-4 border-dashed">
        <div className="flex items-start gap-3">
          <Gauge className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Quality trends.</span> Add an{" "}
            <span className="font-medium">Evaluate</span> node to a swarm to score answers
            (accuracy, tone, safety…) with an LLM judge. Scores from the last 30 days will chart
            here so you can catch quality drift over time.
          </p>
        </div>
      </Card>
    );
  }

  const deltaBadge = (() => {
    if (trends.delta == null) return <span className="text-muted-foreground">—</span>;
    const pts = Math.round(trends.delta * 100);
    if (pts === 0)
      return (
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <Minus className="h-3 w-3" /> flat
        </span>
      );
    const up = pts > 0;
    return (
      <span
        className={`inline-flex items-center gap-1 ${up ? "text-emerald-500" : "text-red-500"}`}
      >
        {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        {up ? "+" : ""}
        {pts} pts vs prior 7d
      </span>
    );
  })();

  const chartData = trends.byDay.map((d) => ({
    day: format(new Date(d.day + "T00:00:00"), "MMM dd"),
    score: Number((d.avg * 100).toFixed(1)),
    count: d.count,
  }));

  const worstMetrics = trends.byMetric.slice(0, 6);
  const topSwarms = trends.bySwarm.slice(0, 6);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold tracking-tight">Quality trends</h2>
        <span className="text-xs text-muted-foreground">
          LLM-judge scores from Evaluate nodes · last 30 days
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Evaluations" value={String(trends.total)} sub="scorecards" />
        <StatCard
          label="Avg quality"
          value={pct(trends.avgOverall)}
          valueClass={scoreColor(trends.avgOverall)}
          sub={deltaBadge}
        />
        <StatCard
          label="Pass rate"
          value={pct(trends.passRate)}
          valueClass={scoreColor(trends.passRate)}
          sub={trends.passRate == null ? "no threshold set" : "meet threshold"}
        />
        <StatCard
          label="Swarms evaluated"
          value={String(trends.bySwarm.length)}
          sub="with eval nodes"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Average quality over time</h3>
          </div>
          {chartData.length <= 1 ? (
            <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
              Not enough days of data yet to chart a trend.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="qtrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <YAxis
                  domain={[0, 100]}
                  tickFormatter={(v: number) => v + "%"}
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid hsl(var(--border))",
                    background: "hsl(var(--popover))",
                  }}
                  formatter={(v: number, _n: string, p: any) => [
                    `${v}%  ·  ${p?.payload?.count ?? 0} evals`,
                    "Avg quality",
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="score"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#qtrend)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Target className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Weakest metrics</h3>
          </div>
          {worstMetrics.length === 0 ? (
            <p className="text-xs text-muted-foreground">No per-metric scores recorded.</p>
          ) : (
            <div className="space-y-2.5">
              {worstMetrics.map((m) => (
                <div key={m.metric}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="truncate font-medium" title={m.metric}>
                      {m.metric}
                    </span>
                    <span className={`font-mono ${scoreColor(m.avg)}`}>{pct(m.avg)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full ${barColor(m.avg)}`}
                      style={{ width: `${Math.max(2, Math.round(m.avg * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Quality by swarm</h3>
        </div>
        <div className="space-y-1">
          {topSwarms.map((s) => (
            <div key={s.name} className="flex items-center gap-3 text-sm py-1">
              <span className="flex-1 truncate" title={s.name}>
                {s.name}
              </span>
              <span className="text-xs text-muted-foreground w-16 text-right">
                {s.count} eval{s.count === 1 ? "" : "s"}
              </span>
              <span className="text-xs text-muted-foreground w-24 text-right">
                pass {s.passRate == null ? "—" : Math.round(s.passRate * 100) + "%"}
              </span>
              <span className={`font-mono font-medium w-14 text-right ${scoreColor(s.avg)}`}>
                {pct(s.avg)}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
