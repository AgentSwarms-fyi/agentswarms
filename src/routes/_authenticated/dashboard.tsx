// The dashboard: what is happening on this deployment right now.
//
// WHAT THIS PAGE USED TO BE, AND WHY IT CHANGED. Measured on a populated
// account, the previous version was 3,241px tall and the first live number on
// it — anything read from this deployment rather than hard-coded — appeared at
// y=2,039. Above that sat a 920px grid of twelve static feature tiles, a
// static "web embedding" callout and 577px of static swarm templates: about
// 1,500px of brochure, shown identically to somebody on their first day and
// somebody on their four hundredth. The sidebar already lists every one of
// those features, so the brochure was a second copy of the navigation placed
// in front of the data.
//
// A dashboard earns its place by answering one question in the time it takes
// to glance at it. Here that question is "is my platform healthy, and what is
// it costing me?", so the answer is the first thing on the page: a status
// band, then four numbers, then the activity behind them. Discovery has not
// been deleted — it moved to where it is the right answer, which is an account
// that has nothing yet.
//
// The page has two states and they are genuinely different pages:
//   - nothing indexed, no runs → an ordered checklist that leaves real things
//     behind (FirstRun).
//   - anything at all → the console.
// The old page showed the console to everybody, so a new account's first
// impression was five zeroes, a flat 2px sparkline and three "no runs yet"
// messages, which reads as broken rather than as new.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { formatMs } from "@/lib/format";
import { mySpendSince } from "@/lib/budgetSpendClient";
import { greetingName } from "@/lib/greetingName";
import { supabase } from "@/integrations/supabase/client";
import { formatSpend, spendCaveat } from "@/lib/spendCompleteness";
import { activityMetrics, activityWindow, hourlyBuckets, modelMix } from "@/lib/dashboardActivity";
import { SpendPanel } from "@/components/dashboard/SpendPanel";
import { ActivityChart } from "@/components/dashboard/ActivityChart";
import { FirstRun, type Step } from "@/components/dashboard/FirstRun";
import { KpiTile } from "@/components/dashboard/KpiTile";
import { PlatformSurface, type SurfaceItem } from "@/components/dashboard/PlatformSurface";
import { StatusBand, type Attention } from "@/components/dashboard/StatusBand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Activity,
  AlertCircle,
  BookOpen,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Columns,
  Database,
  DollarSign,
  Gauge,
  LayoutTemplate,
  Network,
  PieChart,
  Sigma,
  Warehouse,
  Waypoints,
  Workflow,
  Zap,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

type Trace = {
  id: string;
  agent_name: string;
  llm_model: string;
  llm_provider: string;
  status: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  created_at: string;
  /** Text, not boolean: Postgres `->>` yields "true". */
  pricing_missing?: string | null;
};

/**
 * How many traces the activity card fetches.
 *
 * Shared with activityWindow so the card can tell whether this page was big
 * enough to contain the whole 24 hours. A busy day exceeds it, and the card
 * then says its figures are a floor instead of quietly describing a prefix.
 */
const TRACE_FETCH_LIMIT = 200;

/** A count query that never fails the page — an unmigrated table returns 0. */
async function countOf(table: string): Promise<number> {
  try {
    const { count } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(table as any)
      .select("id", { count: "exact", head: true });
    return count ?? 0;
  } catch {
    return 0;
  }
}

// Time-only stamps read as "today". Runs older than that get the date.
function formatRunTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

type Counts = {
  agents: number;
  swarms: number;
  conversations: number;
  integrations: number;
  knowledgeBases: number;
  pipelines: number;
  lakehouseSchemas: number;
  dashboards: number;
  metrics: number;
  mlModels: number;
  workflows: number;
  sqlModels: number;
  monitors: number;
};

const ZERO: Counts = {
  agents: 0,
  swarms: 0,
  conversations: 0,
  integrations: 0,
  knowledgeBases: 0,
  pipelines: 0,
  lakehouseSchemas: 0,
  dashboards: 0,
  metrics: 0,
  mlModels: 0,
  workflows: 0,
  sqlModels: 0,
  monitors: 0,
};

function DashboardPage() {
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [userName, setUserName] = useState<string>("there");
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  /**
   * Things that are already broken and would otherwise only be found by
   * opening the right tab.
   *
   * Every one of these statuses is already recorded — by the SaaS sync, the
   * warehouse connection test, the swarm scheduler, the pipeline run, the data
   * monitor. Nothing aggregated them, so a source that stopped syncing three
   * weeks ago looked exactly like one that synced this morning from anywhere
   * but its own settings page.
   */
  const [health, setHealth] = useState({
    syncs: 0,
    warehouses: 0,
    schedules: 0,
    pipelineRuns: 0,
    incidents: 0,
    workflows: 0,
    sqlModels: 0,
  });
  /** Month-to-date spend against the cap, computed the same way /budgets does. */
  const [budget, setBudget] = useState<{ spend: number; cap: number } | null>(null);

  useEffect(() => {
    async function load() {
      const [a, s, c, i, k, t, u] = await Promise.all([
        supabase.from("agents").select("id", { count: "exact", head: true }),
        supabase.from("swarms").select("id", { count: "exact", head: true }),
        supabase.from("conversations").select("id", { count: "exact", head: true }),
        supabase.from("integrations").select("id", { count: "exact", head: true }),
        supabase.from("knowledge_bases").select("id", { count: "exact", head: true }),
        supabase
          .from("execution_traces")
          .select(
            // pricing_missing rides along so the Spend card can say when its
            // total is a floor rather than the answer. Postgres `->>` returns
            // it as the text "true".
            "id, agent_name, llm_model, llm_provider, status, latency_ms, tokens_in, tokens_out, cost_usd, created_at, pricing_missing:request_payload->>pricing_missing",
          )
          .order("created_at", { ascending: false })
          .limit(TRACE_FETCH_LIMIT),
        supabase.auth.getUser(),
      ]);
      setCounts((prev) => ({
        ...prev,
        agents: a.count ?? 0,
        swarms: s.count ?? 0,
        conversations: c.count ?? 0,
        integrations: i.count ?? 0,
        knowledgeBases: k.count ?? 0,
      }));
      setTraces((t.data ?? []) as Trace[]);

      // The data-platform counts load separately and never fail the page: a
      // deployment that has not migrated the lakehouse tables yet gets an
      // error back from the count, not a throw, and should still see the rest
      // of its dashboard.
      void Promise.all([
        countOf("etl_pipelines"),
        countOf("lakehouse_schemas"),
        countOf("bi_dashboards"),
        countOf("semantic_models"),
        countOf("ml_models"),
        countOf("workflows"),
        countOf("sql_models"),
        countOf("data_monitors"),
      ]).then(([p, lh, d, sm, ml, wf, sq, dm]) =>
        setCounts((prev) => ({
          ...prev,
          pipelines: p,
          lakehouseSchemas: lh,
          dashboards: d,
          metrics: sm,
          mlModels: ml,
          workflows: wf,
          sqlModels: sq,
          monitors: dm,
        })),
      );

      // Health + budget are loaded SEPARATELY and never allowed to fail the
      // page. A count against a table a deployment has not migrated yet
      // returns an error rather than throwing, and a dashboard that renders
      // nothing because one optional feature is absent is worse than one
      // missing a badge.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [sy, wh, sc, pr, inc, wfb, sqb, cap, spend] = await Promise.all([
        supabase
          .from("saas_connections")
          .select("id", { count: "exact", head: true })
          .in("last_sync_status", ["error", "partial"]),
        supabase
          .from("data_warehouse_connections")
          .select("id", { count: "exact", head: true })
          .eq("last_test_status", "error"),
        supabase
          .from("swarm_schedules")
          .select("id", { count: "exact", head: true })
          .eq("last_run_status", "error"),
        supabase
          .from("etl_runs")
          .select("id", { count: "exact", head: true })
          .eq("status", "failed")
          .gte("created_at", dayAgo),
        // An open data incident is the data half's equivalent of a failed run,
        // and the monitors that raise them are on the scheduler's clock — so
        // nobody is watching unless something says so here.
        supabase
          .from("data_incidents")
          .select("id", { count: "exact", head: true })
          .eq("status", "open"),
        supabase
          .from("workflows")
          .select("id", { count: "exact", head: true })
          .eq("last_run_status", "failed"),
        supabase
          .from("sql_models")
          .select("id", { count: "exact", head: true })
          .eq("last_status", "error"),
        supabase.from("budget_settings").select("monthly_cap_usd").limit(1).maybeSingle(),
        // Aggregated in the database. This used to select every trace row for
        // the month and sum cost_usd in the browser, so a truncated result set
        // — or a failed query's empty array — rendered as the month's total.
        u.data.user?.id
          ? mySpendSince(u.data.user.id, monthStart.toISOString())
          : Promise.resolve({ ok: false as const, error: "not signed in" }),
      ]);
      setHealth({
        syncs: sy.count ?? 0,
        warehouses: wh.count ?? 0,
        schedules: sc.count ?? 0,
        pipelineRuns: pr.count ?? 0,
        incidents: inc.count ?? 0,
        workflows: wfb.count ?? 0,
        sqlModels: sqb.count ?? 0,
      });
      const capUsd = Number(cap.data?.monthly_cap_usd ?? 0);
      // Only show the figure when it is known. A failed lookup used to sum to
      // zero and render as "0% of cap used", which is the most reassuring
      // possible way to display "we have no idea".
      if (capUsd > 0 && spend.ok) setBudget({ spend: spend.spend, cap: capUsd });

      // The name the user actually set lives in `profiles` — that is what the
      // Account page writes and what the sidebar reads. Reading only the auth
      // metadata greeted them by a mangled email prefix while their own name
      // sat one table away. See src/lib/greetingName.ts.
      const meta = u.data.user?.user_metadata as { full_name?: string; name?: string } | undefined;
      const uid = u.data.user?.id;
      const profile = uid
        ? await supabase
            .from("profiles")
            .select("first_name, display_name")
            .eq("user_id", uid)
            .maybeSingle()
        : null;
      setUserName(
        greetingName({
          firstName: profile?.data?.first_name,
          displayName: profile?.data?.display_name,
          metaFullName: meta?.full_name ?? meta?.name,
          email: u.data.user?.email,
        }),
      );
      setCheckedAt(new Date());
      setLoading(false);
    }
    load();
  }, []);

  // Everything on the "last 24h" card is computed over the last 24h — including
  // success rate, latency and spend, which used to be computed over the whole
  // fetched page. See src/lib/dashboardActivity.ts for what that measured.
  const metrics = useMemo(() => {
    const now = Date.now();
    const window = activityWindow(traces, { now, fetchLimit: TRACE_FETCH_LIMIT });
    return {
      ...activityMetrics(window),
      spark: hourlyBuckets(window.rows, now),
      mix: modelMix(window.rows),
      now,
    };
  }, [traces]);

  const recent = traces.slice(0, 6);

  /** Nothing built and nothing run: the checklist, not the console. */
  const firstRun =
    !loading &&
    traces.length === 0 &&
    counts.agents === 0 &&
    counts.swarms === 0 &&
    counts.pipelines === 0 &&
    counts.knowledgeBases === 0;

  const attention: Attention[] = [
    { label: "sources not syncing", count: health.syncs, to: "/integrations" },
    { label: "warehouses unreachable", count: health.warehouses, to: "/integrations" },
    { label: "schedules failing", count: health.schedules, to: "/swarms" },
    { label: "pipeline runs failed today", count: health.pipelineRuns, to: "/etl" },
    { label: "open data incidents", count: health.incidents, to: "/data-monitors" },
    { label: "workflows failed", count: health.workflows, to: "/workflows" },
    { label: "SQL models failing", count: health.sqlModels, to: "/sql-models" },
    {
      label: "of the monthly budget used",
      // The cap was fetched and then never rendered: the old page used it only
      // to decide whether to show a pill, so the one number an owner wants —
      // how much of the month is gone — was computed and thrown away.
      count:
        budget && budget.spend >= budget.cap * 0.8
          ? Math.round((budget.spend / budget.cap) * 100)
          : 0,
      to: "/budgets",
    },
  ];

  const surfaces: SurfaceItem[] = [
    {
      label: "Agents",
      icon: Bot,
      count: counts.agents,
      noun: "built",
      to: "/agents",
      invite: "Build one that can use tools",
    },
    {
      label: "Swarms",
      icon: Network,
      count: counts.swarms,
      noun: "on the canvas",
      to: "/swarms",
      warn: health.schedules ? `${health.schedules} schedule failing` : null,
      invite: "Wire agents into a workflow",
    },
    {
      label: "Knowledge bases",
      icon: BookOpen,
      count: counts.knowledgeBases,
      noun: "collections",
      to: "/knowledge",
      invite: "Give agents something to quote",
    },
    {
      label: "ETL pipelines",
      icon: Waypoints,
      count: counts.pipelines,
      noun: "pipelines",
      to: "/etl",
      warn: health.pipelineRuns ? `${health.pipelineRuns} failed today` : null,
      invite: "Move data in on a schedule",
    },
    {
      label: "Lakehouse",
      icon: Warehouse,
      count: counts.lakehouseSchemas,
      noun: "schemas",
      to: "/lakehouse",
      invite: "A warehouse of your own",
    },
    {
      label: "SQL models",
      icon: Columns,
      count: counts.sqlModels,
      noun: "models",
      to: "/sql-models",
      warn: health.sqlModels ? `${health.sqlModels} failing` : null,
      invite: "Transform raw tables into shaped ones",
    },
    {
      label: "ML models",
      icon: BrainCircuit,
      count: counts.mlModels,
      noun: "trained",
      to: "/ml",
      invite: "Predict, forecast or cluster a table",
    },
    {
      label: "Dashboards",
      icon: PieChart,
      count: counts.dashboards,
      noun: "published",
      to: "/bi",
      invite: "Put charts over your tables",
    },
    {
      label: "Workflows",
      icon: Workflow,
      count: counts.workflows,
      noun: "orchestrated",
      to: "/workflows",
      warn: health.workflows ? `${health.workflows} failed` : null,
      invite: "One graph over everything above",
    },
    {
      label: "Data monitors",
      icon: Activity,
      count: counts.monitors,
      noun: "watching",
      to: "/data-monitors",
      warn: health.incidents ? `${health.incidents} open` : null,
      invite: "Get told when a table goes wrong",
    },
    {
      label: "Metrics",
      icon: Sigma,
      count: counts.metrics,
      noun: "defined",
      to: "/semantics",
      invite: "Define revenue once, for everyone",
    },
    {
      label: "Integrations",
      icon: Database,
      count: counts.integrations,
      noun: "connected",
      to: "/integrations",
      warn:
        health.syncs || health.warehouses ? `${health.syncs + health.warehouses} unhealthy` : null,
      invite: "Connect a model, a warehouse or an app",
    },
  ];

  const steps: Step[] = [
    {
      title: "Connect a model provider",
      why: "Nothing can run until there is a key to run it with.",
      done: counts.integrations > 0,
      to: "/integrations",
      cta: "Connect",
    },
    {
      title: "Build an agent",
      why: "A prompt, a model and the tools it is allowed to call.",
      done: counts.agents > 0,
      to: "/agents",
      cta: "Build one",
    },
    {
      title: "Run it once",
      why: "The first run is what fills this page in.",
      done: traces.length > 0,
      to: "/playground",
      cta: "Open chat",
    },
    {
      title: "Give it something to read",
      why: "A knowledge base is how an agent quotes your documents instead of inventing them.",
      done: counts.knowledgeBases > 0,
      to: "/knowledge",
      cta: "Add documents",
    },
    {
      title: "Bring in your data",
      why: "A pipeline lands a table the analyst, the dashboards and the agents all share.",
      done: counts.pipelines > 0 || counts.lakehouseSchemas > 0,
      to: "/etl",
      cta: "Build a pipeline",
    },
  ];

  const budgetPct = budget ? budget.spend / budget.cap : null;
  // activityMetrics returns successRate as a PERCENTAGE already (0-100), not
  // a fraction. The first version of this page multiplied it by 100 again and
  // rendered "10000%", which is the kind of thing that only a screenshot
  // catches: every type was correct.
  const successTone =
    metrics.successRate === null
      ? "neutral"
      : metrics.successRate >= 95
        ? "good"
        : metrics.successRate >= 80
          ? "warn"
          : "bad";

  return (
    <div className="dot-matrix-bg flex min-h-full font-sans">
      <div className="flex-1 space-y-6 p-6 sm:p-8">
        {/* The greeting is one line now. It was a 350px hero with four
            decorative layers and two blurred colour blobs, which is a lot of
            screen to spend on saying hello every single day. */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Welcome back, <span className="text-gradient-brand">{userName}</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {firstRun
                ? "Nothing has run here yet. The list below is the shortest path to the first answer."
                : "Everything this deployment is running, and what it cost."}
            </p>
          </div>
          {!firstRun && (
            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/playground" search={{ agentId: undefined }}>
                  <Zap className="mr-1.5 h-3.5 w-3.5" /> Agent Chat
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/swarms">
                  <Network className="mr-1.5 h-3.5 w-3.5" /> Design a swarm
                </Link>
              </Button>
            </div>
          )}
        </header>

        {firstRun ? (
          <FirstRun steps={steps} />
        ) : (
          <>
            <StatusBand items={attention} loading={loading} checkedAt={checkedAt} />

            {/* Four numbers that drive a decision. The old page led with five
                counts — agents, swarms, chats, tools, knowledge — which change
                once a week and answer nothing. */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                icon={Activity}
                label="Runs (24h)"
                value={`${metrics.runsAtLeast ? "≥" : ""}${metrics.runs.toLocaleString()}`}
                against={
                  metrics.truncated ? "a floor — the read hit its limit" : "model calls today"
                }
                to="/traces"
                loading={loading}
              />
              <KpiTile
                icon={DollarSign}
                label="Spend (month to date)"
                value={budget ? `$${budget.spend.toFixed(2)}` : formatSpend(metrics.spend)}
                against={
                  budget ? `of $${budget.cap.toFixed(2)} cap` : "no monthly cap set — 24h total"
                }
                progress={budgetPct}
                tone={budgetPct && budgetPct >= 0.8 ? "warn" : "neutral"}
                to="/budgets"
                loading={loading}
              />
              <KpiTile
                icon={CheckCircle2}
                label="Success rate (24h)"
                value={metrics.successRate === null ? "—" : `${metrics.successRate}%`}
                against={metrics.successRate === null ? "no runs to measure" : "of runs completed"}
                tone={successTone}
                to="/traces"
                loading={loading}
              />
              <KpiTile
                icon={Gauge}
                label="Avg latency (24h)"
                value={metrics.avgLatencyMs === null ? "—" : formatMs(metrics.avgLatencyMs)}
                against={metrics.avgLatencyMs === null ? "no runs to measure" : "per model call"}
                to="/traces"
                loading={loading}
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardContent className="p-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
                      <p className="text-xs text-muted-foreground">
                        Runs per hour, last 24 hours
                        {metrics.truncated && " — a floor, the read hit its limit"}
                      </p>
                    </div>
                    <Button asChild size="sm" variant="ghost">
                      <Link to="/traces">View traces</Link>
                    </Button>
                  </div>
                  <ActivityChart buckets={metrics.spark} now={metrics.now} />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <h2 className="text-lg font-semibold tracking-tight">Model mix</h2>
                  <p className="text-xs text-muted-foreground">By tokens, last 24 hours</p>
                  <div className="mt-4 space-y-3">
                    {metrics.mix.entries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {loading
                          ? "Loading…"
                          : "No runs in the last 24h. Open Agent Chat to make one."}
                      </p>
                    ) : (
                      metrics.mix.entries.map((m) => (
                        <div key={m.model}>
                          <div className="mb-1 flex items-baseline justify-between gap-2">
                            <span className="truncate text-xs font-medium">{m.model}</span>
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                              {m.tokens.toLocaleString()}
                            </span>
                          </div>
                          <Progress value={m.share * 100} className="h-1.5" />
                        </div>
                      ))
                    )}
                    {metrics.mix.hidden > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        +{metrics.mix.hidden} more model{metrics.mix.hidden === 1 ? "" : "s"} not
                        shown
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* What this deployment has, counted from its own tables. This is
                the half of the product the old page never mentioned: it listed
                nine agent-side features and none of ETL, the lakehouse, SQL
                models, ML, workflows or monitors as things you might already
                be running. */}
            <section className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="font-display text-lg font-semibold tracking-tight">
                    What you&rsquo;re running
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Counted from this deployment. Anything not set up says so, with the way in.
                  </p>
                </div>
              </div>
              <PlatformSurface items={surfaces} loading={loading} />
            </section>

            <SpendPanel />

            <Card>
              <CardContent className="p-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold tracking-tight">Recent runs</h2>
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/traces">View all</Link>
                  </Button>
                </div>
                {recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {loading ? "Loading…" : "No runs yet. Open Agent Chat to make one."}
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {recent.map((r) => (
                      <div key={r.id} className="flex items-center gap-3 py-2.5">
                        {r.status === "success" ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        ) : r.status === "cancelled" ? (
                          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{r.agent_name}</p>
                          <p className="truncate text-xs text-muted-foreground">{r.llm_model}</p>
                        </div>
                        <div className="hidden shrink-0 text-right sm:block">
                          <p className="text-xs tabular-nums">{formatMs(r.latency_ms)}</p>
                          <p className="text-xs text-muted-foreground tabular-nums">
                            ${Number(r.cost_usd ?? 0).toFixed(4)}
                          </p>
                        </div>
                        <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
                          {formatRunTime(r.created_at)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
                {metrics.spend.partial && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    {spendCaveat(metrics.spend)}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Discovery, once, at the bottom — where somebody who has already
                read the numbers might want it. Not 920px in front of them. */}
            <p className="text-center text-sm text-muted-foreground">
              Looking for something else? Every surface is in the sidebar, or read{" "}
              <Link to="/docs" className="underline underline-offset-4 hover:text-foreground">
                the documentation
              </Link>
              .
            </p>
          </>
        )}
      </div>
    </div>
  );
}
