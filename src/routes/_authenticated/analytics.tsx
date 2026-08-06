import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { TeamSpend } from "@/components/observability/TeamSpend";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import * as Recharts from "recharts";
// React 19's stricter JSX component typing rejects recharts class components.
// Cast each one through `any` so JSX accepts them without per-callsite casts.
const ResponsiveContainer = Recharts.ResponsiveContainer as any;
const AreaChart = Recharts.AreaChart as any;
const Area = Recharts.Area as any;
const XAxis = Recharts.XAxis as any;
const YAxis = Recharts.YAxis as any;
const Tooltip = Recharts.Tooltip as any;
const CartesianGrid = Recharts.CartesianGrid as any;
const PieChart = Recharts.PieChart as any;
const Pie = Recharts.Pie as any;
const Cell = Recharts.Cell as any;
const Legend = Recharts.Legend as any;
import {
  DollarSign,
  Cpu,
  Gauge,
  Bot,
  TrendingUp,
  TrendingDown,
  Sparkles,
  CalendarIcon,
} from "lucide-react";
import {
  format,
  subDays,
  subHours,
  subMonths,
  startOfMonth,
  startOfHour,
  startOfDay,
  startOfWeek,
  differenceInHours,
  differenceInDays,
} from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useServerFn } from "@tanstack/react-start";
import { seedTraces } from "@/utils/observability.functions";
import { toast } from "sonner";
import type { DateRange } from "react-day-picker";

type RangePreset = "24h" | "7d" | "1m" | "6m" | "custom";
const PRESETS: { id: RangePreset; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "1m", label: "1m" },
  { id: "6m", label: "6m" },
  { id: "custom", label: "Custom" },
];

export const Route = createFileRoute("/_authenticated/analytics")({
  component: AnalyticsPage,
});

type Trace = {
  id: string;
  agent_name: string;
  llm_provider: string;
  llm_model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  status: string;
  created_at: string;
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "hsl(142 71% 45%)",
  anthropic: "hsl(25 95% 55%)",
  google: "hsl(217 91% 60%)",
  local: "hsl(280 65% 60%)",
  openrouter: "hsl(190 90% 50%)",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  local: "Local",
  openrouter: "OpenRouter",
};

// Theme chart ramp (resolves per-theme; provider colours above stay semantic
// because a provider's identity colour carries meaning a ramp would erase).
const AGENT_COLORS = [
  "var(--chart-1)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--nexus-glow)",
];

const tooltipStyle = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--foreground)",
} as const;

function AnalyticsPage() {
  const { user } = useAuth();
  const seedFn = useServerFn(seedTraces);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [preset, setPreset] = useState<RangePreset>("1m");
  const [customRange, setCustomRange] = useState<DateRange | undefined>();

  const load = async () => {
    const sinceDate = subDays(new Date(), 30).toISOString();
    const { data } = await supabase
      .from("execution_traces")
      .select(
        "id, agent_name, llm_provider, llm_model, latency_ms, tokens_in, tokens_out, cost_usd, status, created_at",
      )
      .gte("created_at", sinceDate)
      .order("created_at", { ascending: false })
      .limit(2000);
    setTraces((data ?? []) as Trace[]);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) return;
    load();
  }, [user]);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const result = await seedFn();
      if (result.seeded) {
        toast.success(`Seeded ${result.count} example traces`);
        await load();
      } else {
        toast.info(result.message);
      }
    } catch {
      toast.error("Seed failed");
    }
    setSeeding(false);
  };

  // KPI calculations
  const monthStart = startOfMonth(new Date()).getTime();
  const lastWeekStart = subDays(new Date(), 7).getTime();
  const prevWeekStart = subDays(new Date(), 14).getTime();

  const mtdSpend = traces
    .filter((t) => new Date(t.created_at).getTime() >= monthStart)
    .reduce((acc, t) => acc + Number(t.cost_usd), 0);

  const lastWeekSpend = traces
    .filter((t) => {
      const ts = new Date(t.created_at).getTime();
      return ts >= lastWeekStart;
    })
    .reduce((acc, t) => acc + Number(t.cost_usd), 0);

  const prevWeekSpend = traces
    .filter((t) => {
      const ts = new Date(t.created_at).getTime();
      return ts >= prevWeekStart && ts < lastWeekStart;
    })
    .reduce((acc, t) => acc + Number(t.cost_usd), 0);

  const spendTrend =
    prevWeekSpend > 0 ? ((lastWeekSpend - prevWeekSpend) / prevWeekSpend) * 100 : 0;

  const totalTokensIn = traces.reduce((a, t) => a + t.tokens_in, 0);
  const totalTokensOut = traces.reduce((a, t) => a + t.tokens_out, 0);
  const avgLatency = traces.length
    ? Math.round(traces.reduce((a, t) => a + t.latency_ms, 0) / traces.length)
    : 0;
  const activeAgents = new Set(traces.map((t) => t.agent_name)).size;

  // (Spend chart now built from active range below)

  // Resolve active range
  const { rangeStart, rangeEnd, granularity, rangeLabel } = useMemo(() => {
    const now = new Date();
    let start: Date;
    let end: Date = now;
    let label = "";
    if (preset === "24h") {
      start = subHours(now, 24);
      label = "Last 24 hours";
    } else if (preset === "7d") {
      start = subDays(now, 7);
      label = "Last 7 days";
    } else if (preset === "1m") {
      start = subDays(now, 30);
      label = "Last 30 days";
    } else if (preset === "6m") {
      start = subMonths(now, 6);
      label = "Last 6 months";
    } else {
      start = customRange?.from ?? subDays(now, 7);
      end = customRange?.to ?? now;
      label = `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
    }
    const hours = differenceInHours(end, start);
    const days = differenceInDays(end, start);
    let g: "hour" | "day" | "week" = "day";
    if (hours <= 36) g = "hour";
    else if (days > 60) g = "week";
    return { rangeStart: start, rangeEnd: end, granularity: g, rangeLabel: label };
  }, [preset, customRange]);

  // Spend chart data, bucketed by granularity
  const spendChart = useMemo(() => {
    const buckets: Record<string, { date: string; ts: number; cost: number; tokens: number }> = {};
    const startMs = rangeStart.getTime();
    const endMs = rangeEnd.getTime();
    const stepMs =
      granularity === "hour" ? 3_600_000 : granularity === "day" ? 86_400_000 : 604_800_000;
    const fmt =
      granularity === "hour" ? "MMM d HH:00" : granularity === "day" ? "MMM dd" : "'W'ww MMM d";
    const bucketStart = (d: Date) =>
      granularity === "hour"
        ? startOfHour(d)
        : granularity === "day"
          ? startOfDay(d)
          : startOfWeek(d, { weekStartsOn: 1 });

    for (let t = bucketStart(rangeStart).getTime(); t <= endMs; t += stepMs) {
      const key = format(new Date(t), fmt);
      buckets[key] = { date: key, ts: t, cost: 0, tokens: 0 };
    }
    traces.forEach((tr) => {
      const ts = new Date(tr.created_at).getTime();
      if (ts < startMs || ts > endMs) return;
      const key = format(bucketStart(new Date(ts)), fmt);
      if (buckets[key]) {
        buckets[key].cost += Number(tr.cost_usd);
        buckets[key].tokens += tr.tokens_in + tr.tokens_out;
      }
    });
    return Object.values(buckets)
      .sort((a, b) => a.ts - b.ts)
      .map((b) => ({ ...b, cost: Number(b.cost.toFixed(4)) }));
  }, [traces, rangeStart, rangeEnd, granularity]);

  // Cost by provider
  const costByProvider = useMemo(() => {
    const m: Record<string, number> = {};
    traces.forEach((t) => {
      m[t.llm_provider] = (m[t.llm_provider] ?? 0) + Number(t.cost_usd);
    });
    return Object.entries(m).map(([name, value]) => ({
      name: PROVIDER_LABELS[name] ?? name,
      rawName: name,
      value: Number(value.toFixed(4)),
    }));
  }, [traces]);

  // Cost by agent
  const costByAgent = useMemo(() => {
    const m: Record<string, number> = {};
    traces.forEach((t) => {
      m[t.agent_name] = (m[t.agent_name] ?? 0) + Number(t.cost_usd);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: Number(value.toFixed(4)) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [traces]);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (traces.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Observability
            </p>
            <h1 className="font-display text-3xl font-semibold tracking-tight">Analytics</h1>
            <p className="text-muted-foreground mt-1">
              Real-time observability for your agent fleet.
            </p>
          </div>
        </div>
        <Card className="p-12 text-center border-dashed">
          <Sparkles className="h-12 w-12 text-primary mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">No execution data yet</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
            Once your agents start running, traces will appear here automatically. Want to explore
            the dashboard with realistic sample data?
          </p>
          <Button onClick={handleSeed} disabled={seeding}>
            {seeding ? "Seeding..." : "Generate sample data"}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Observability
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground mt-1">
            {traces.length.toLocaleString()} traces over the last 30 days
          </p>
        </div>
      </div>

      {/* Admin-only: instance-wide spend by user and group */}
      <TeamSpend />

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={DollarSign}
          label="Spend (MTD)"
          value={`$${mtdSpend.toFixed(2)}`}
          trend={spendTrend}
          trendLabel="vs last week"
        />
        <KpiCard
          icon={Cpu}
          label="Total Tokens"
          value={`${((totalTokensIn + totalTokensOut) / 1000).toFixed(1)}K`}
          subtext={`${(totalTokensIn / 1000).toFixed(0)}K in · ${(totalTokensOut / 1000).toFixed(0)}K out`}
        />
        <KpiCard
          icon={Gauge}
          label="Avg Latency"
          value={`${avgLatency}ms`}
          subtext="p50 across all models"
        />
        <KpiCard
          icon={Bot}
          label="Active Agents"
          value={String(activeAgents)}
          subtext="ran in last 30 days"
        />
      </div>

      {/* Spend over time */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Spend over time</CardTitle>
            <p className="text-xs text-muted-foreground">
              {rangeLabel} · bucketed by {granularity}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="inline-flex rounded-md border border-border bg-background p-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                    preset === p.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 text-xs">
                    <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
                    {customRange?.from
                      ? customRange.to
                        ? `${format(customRange.from, "MMM d")} – ${format(customRange.to, "MMM d")}`
                        : format(customRange.from, "MMM d, yyyy")
                      : "Pick dates"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    selected={customRange}
                    onSelect={setCustomRange}
                    numberOfMonths={2}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={spendChart}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: "var(--foreground)" }}
                itemStyle={{ color: "var(--foreground)" }}
                formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]}
              />
              <Area
                type="monotone"
                dataKey="cost"
                stroke="var(--primary)"
                strokeWidth={2}
                fill="url(#costGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Donut charts */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by provider</CardTitle>
            <p className="text-xs text-muted-foreground">Last 30 days</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={costByProvider}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  stroke="var(--card)"
                  strokeWidth={2}
                  cornerRadius={4}
                >
                  {costByProvider.map((e) => (
                    <Cell key={e.rawName} fill={PROVIDER_COLORS[e.rawName] ?? "var(--muted)"} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: "var(--foreground)" }}
                  itemStyle={{ color: "var(--foreground)" }}
                  formatter={(v: number) => `$${v.toFixed(4)}`}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11 }}
                  iconType="circle"
                  iconSize={8}
                  formatter={(value: string) => (
                    <span style={{ color: "var(--foreground)" }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by agent</CardTitle>
            <p className="text-xs text-muted-foreground">Top 6 spenders</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={costByAgent}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  stroke="var(--card)"
                  strokeWidth={2}
                  cornerRadius={4}
                >
                  {costByAgent.map((_, i) => (
                    <Cell key={i} fill={AGENT_COLORS[i % AGENT_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: "var(--foreground)" }}
                  itemStyle={{ color: "var(--foreground)" }}
                  formatter={(v: number) => `$${v.toFixed(4)}`}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11 }}
                  iconType="circle"
                  iconSize={8}
                  formatter={(value: string) => (
                    <span style={{ color: "var(--foreground)" }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  trend,
  trendLabel,
  subtext,
}: {
  icon: any;
  label: string;
  value: string;
  trend?: number;
  trendLabel?: string;
  subtext?: string;
}) {
  const isUp = (trend ?? 0) > 0;
  const isDown = (trend ?? 0) < 0;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        {trend !== undefined ? (
          <div className="flex items-center gap-1 mt-1.5">
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 h-4 ${
                isUp
                  ? "text-red-400 border-red-500/30 bg-red-500/5"
                  : isDown
                    ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
                    : "text-muted-foreground"
              }`}
            >
              {isUp ? (
                <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
              ) : isDown ? (
                <TrendingDown className="h-2.5 w-2.5 mr-0.5" />
              ) : null}
              {(trend > 0 ? "+" : "") + trend.toFixed(1)}%
            </Badge>
            <span className="text-[10px] text-muted-foreground">{trendLabel}</span>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground mt-1.5">{subtext}</p>
        )}
      </CardContent>
    </Card>
  );
}
