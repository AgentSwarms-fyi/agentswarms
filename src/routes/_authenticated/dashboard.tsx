import { createFileRoute, Link } from "@tanstack/react-router";
import { formatMs } from "@/lib/format";
import { useEffect, useMemo, useState } from "react";
import { mySpendSince } from "@/lib/budgetSpendClient";
import { supabase } from "@/integrations/supabase/client";
import { SpendPanel } from "@/components/dashboard/SpendPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Bot,
  MessageSquare,
  Puzzle,
  BookOpen,
  Network,
  Activity,
  ArrowUpRight,
  Zap,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertCircle,
  Cpu,
  LayoutTemplate,
  Workflow,
  PieChart,
  Database,
  NotebookPen,
  Image as ImageIcon,
  Columns,
  Code2,
  Wrench,
} from "lucide-react";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";
import { cn } from "@/lib/utils";

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
};

const cardCls = "rounded-xl border border-border bg-card shadow-sm";

// Curated feature highlights — the areas of the platform worth discovering
// first, each with its own accent so the grid reads as a map, not a list.
const FEATURES = [
  {
    title: "BI Workspace",
    desc: "AI-generated dashboards, 20+ visuals, ontology maps, schedules & alerts.",
    to: "/bi" as const,
    icon: PieChart,
    badge: null,
    color: "text-fuchsia-600 bg-fuchsia-50 dark:text-fuchsia-300 dark:bg-fuchsia-500/15",
  },
  {
    title: "Data & SQL Agents",
    desc: "Chat with CSVs, Postgres, MySQL and warehouses; visual prep flows.",
    to: "/data-sql" as const,
    icon: Database,
    badge: null,
    color: "text-sky-600 bg-sky-50 dark:text-sky-300 dark:bg-sky-500/15",
  },
  {
    title: "Knowledge & RAG",
    desc: "Vector search over your documents with BYOK embeddings and re-ranking.",
    to: "/knowledge" as const,
    icon: BookOpen,
    badge: null,
    color: "text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15",
  },
  {
    title: "Developer workspace",
    desc: "Production Python notebooks on sandboxed server kernels.",
    to: "/notebooks" as const,
    icon: NotebookPen,
    badge: "New",
    color: "text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15",
  },
  {
    title: "MCP Builder",
    desc: "Write MCP servers in Python (FastMCP) and expose them as APIs.",
    to: "/mcp-builder" as const,
    icon: Wrench,
    badge: "New",
    color: "text-cyan-600 bg-cyan-50 dark:text-cyan-300 dark:bg-cyan-500/15",
  },
  {
    title: "Playground",
    desc: "Chat with any model or saved agent — tools, memory and RAG included.",
    to: "/playground" as const,
    icon: MessageSquare,
    badge: null,
    color: "text-violet-600 bg-violet-50 dark:text-violet-300 dark:bg-violet-500/15",
  },
  {
    title: "Image Playground",
    desc: "Generate and iterate on images with your connected providers.",
    to: "/image-playground" as const,
    icon: ImageIcon,
    badge: null,
    color: "text-rose-600 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15",
  },
  {
    title: "Prompt Compare",
    desc: "Run one prompt across models side by side and pick a winner.",
    to: "/prompt-compare" as const,
    icon: Columns,
    badge: null,
    color: "text-indigo-600 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-500/15",
  },
  {
    title: "Integrations",
    desc: "Bring your own keys: LLM providers, warehouses, MCP servers and secrets.",
    to: "/integrations" as const,
    icon: Puzzle,
    badge: null,
    color: "text-teal-600 bg-teal-50 dark:text-teal-300 dark:bg-teal-500/15",
  },
];

// Time-only stamps read as "today". Runs older than that get the date.
function formatRunTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function DashboardPage() {
  const [stats, setStats] = useState({
    agents: 0,
    swarms: 0,
    conversations: 0,
    integrations: 0,
    knowledgeBases: 0,
  });
  const [traces, setTraces] = useState<Trace[]>([]);
  const [userName, setUserName] = useState<string>("there");
  const [loading, setLoading] = useState(true);

  /**
   * Things that are already broken and would otherwise only be found by
   * opening the right tab.
   *
   * Every one of these statuses is already recorded — by the SaaS sync, the
   * warehouse connection test, the swarm scheduler. Nothing aggregated them,
   * so a source that stopped syncing three weeks ago looked exactly like one
   * that synced this morning from anywhere but its own settings page.
   */
  const [health, setHealth] = useState({ syncs: 0, warehouses: 0, schedules: 0 });
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
            "id, agent_name, llm_model, llm_provider, status, latency_ms, tokens_in, tokens_out, cost_usd, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(200),
        supabase.auth.getUser(),
      ]);
      setStats({
        agents: a.count ?? 0,
        swarms: s.count ?? 0,
        conversations: c.count ?? 0,
        integrations: i.count ?? 0,
        knowledgeBases: k.count ?? 0,
      });
      setTraces((t.data ?? []) as Trace[]);

      // Health + budget are loaded SEPARATELY and never allowed to fail the
      // page. A count against a table a deployment has not migrated yet
      // returns an error rather than throwing, and a dashboard that renders
      // nothing because one optional feature is absent is worse than one
      // missing a badge.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [sy, wh, sc, cap, spend] = await Promise.all([
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
      });
      const capUsd = Number(cap.data?.monthly_cap_usd ?? 0);
      // Only show the badge when the figure is known. A failed lookup used to
      // sum to zero and render as "0% of cap used", which is the most
      // reassuring possible way to display "we have no idea".
      if (capUsd > 0 && spend.ok) {
        setBudget({ spend: spend.spend, cap: capUsd });
      }
      const meta = u.data.user?.user_metadata as { full_name?: string; name?: string } | undefined;
      const fullName = meta?.full_name ?? meta?.name ?? "";
      const first = fullName.trim().split(/\s+/)[0];
      const email = u.data.user?.email ?? "";
      const fallback = email.split("@")[0] || "there";
      setUserName(first || fallback.charAt(0).toUpperCase() + fallback.slice(1));
      setLoading(false);
    }
    load();
  }, []);

  const metrics = useMemo(() => {
    if (traces.length === 0) {
      return {
        runs24h: 0,
        successRate: 0,
        avgLatency: 0,
        totalCost: 0,
        totalTokens: 0,
        topModel: "—",
        spark: Array(24).fill(0),
        modelMix: [] as { model: string; count: number; share: number }[],
      };
    }
    const now = Date.now();
    const last24 = traces.filter((r) => now - new Date(r.created_at).getTime() < 86_400_000);
    // A user pressing Stop is not a failure: cancelled turns leave the
    // success-rate denominator entirely rather than dragging it down.
    const decided = traces.filter((r) => r.status !== "cancelled");
    const ok = decided.filter((r) => r.status === "success").length;
    const cost = traces.reduce((s, r) => s + (r.cost_usd || 0), 0);
    const tokens = traces.reduce((s, r) => s + (r.tokens_in || 0) + (r.tokens_out || 0), 0);
    const avgLat = Math.round(traces.reduce((s, r) => s + (r.latency_ms || 0), 0) / traces.length);
    const buckets = Array(24).fill(0);
    last24.forEach((r) => {
      const h = new Date(r.created_at).getHours();
      buckets[h] += 1;
    });
    const modelCounts = new Map<string, number>();
    traces.forEach((r) => modelCounts.set(r.llm_model, (modelCounts.get(r.llm_model) ?? 0) + 1));
    const modelMix = Array.from(modelCounts.entries())
      .map(([model, count]) => ({ model, count, share: (count / traces.length) * 100 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
    return {
      runs24h: last24.length,
      successRate: decided.length ? Math.round((ok / decided.length) * 100) : 100,
      avgLatency: avgLat,
      totalCost: cost,
      totalTokens: tokens,
      topModel: modelMix[0]?.model ?? "—",
      spark: buckets,
      modelMix,
    };
  }, [traces]);

  const sparkMax = Math.max(1, ...metrics.spark);
  const recent = traces.slice(0, 6);

  const heroStats = [
    {
      label: "Agents",
      value: stats.agents,
      icon: Bot,
      to: "/agents",
      color: "text-violet-600 bg-violet-50 dark:text-violet-300 dark:bg-violet-500/15",
    },
    {
      label: "Swarms",
      value: stats.swarms,
      icon: Network,
      to: "/swarms",
      color: "text-indigo-600 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-500/15",
    },
    {
      label: "Chats",
      value: stats.conversations,
      icon: MessageSquare,
      to: "/playground",
      color: "text-sky-600 bg-sky-50 dark:text-sky-300 dark:bg-sky-500/15",
    },
    {
      label: "Tools",
      value: stats.integrations,
      icon: Puzzle,
      to: "/integrations",
      color: "text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15",
    },
    {
      label: "Knowledge",
      value: stats.knowledgeBases,
      icon: BookOpen,
      to: "/knowledge",
      color: "text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15",
    },
  ] as const;

  const actionTiles = [
    {
      title: "Open the Playground",
      desc: "Chat with any model and prototype instantly.",
      to: "/playground" as const,
      icon: MessageSquare,
      accent: "text-violet-600 bg-violet-50 dark:text-violet-300 dark:bg-violet-500/15",
      search: undefined as undefined | Record<string, unknown>,
    },
    {
      title: "Build a Standalone Agent",
      desc: "Open the agent builder and ship a single agent.",
      to: "/agents" as const,
      icon: Bot,
      accent: "text-primary bg-primary/10 dark:bg-primary/15",
      search: { new: 1 } as Record<string, unknown>,
    },
    {
      title: "Design a Swarm",
      desc: "Open a blank canvas and wire agents together.",
      to: "/swarms" as const,
      icon: Workflow,
      accent: "text-sky-600 bg-sky-50 dark:text-sky-300 dark:bg-sky-500/15",
      search: undefined,
    },
    {
      title: "Open BI Workspace",
      desc: "Let AI build dashboards over your data.",
      to: "/bi" as const,
      icon: PieChart,
      accent: "text-fuchsia-600 bg-fuchsia-50 dark:text-fuchsia-300 dark:bg-fuchsia-500/15",
      search: undefined,
    },
  ];

  // Curated, visually-interesting multi-agent swarm templates that open straight on the canvas.
  const FEATURED_SWARM_IDS = [
    "support-copilot",
    "revops-analyst",
    "research-desk",
    "secops-triage",
  ];
  const featuredTemplates = FEATURED_SWARM_IDS.map((id) =>
    SWARM_TEMPLATES.find((t) => t.id === id),
  ).filter((t): t is (typeof SWARM_TEMPLATES)[number] => Boolean(t));
  const openCanvasSearch = (templateId: string) => ({
    template: templateId,
    view: "canvas" as const,
  });

  const isEmpty = !loading && stats.agents === 0 && stats.swarms === 0 && traces.length === 0;

  return (
    <div className="dot-matrix-bg flex min-h-full font-sans">
      <div className="flex-1 space-y-6 p-6 sm:p-8">
        {/* ───── Central "Lab" anchor card ───── */}
        <section className={cn(cardCls, "relative overflow-hidden p-6 sm:p-8")}>
          <div
            aria-hidden
            className="bg-grid-faint pointer-events-none absolute inset-0 opacity-60"
          />
          <div aria-hidden className="bg-hero-glow pointer-events-none absolute inset-0" />
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-32 -left-16 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl"
          />
          <header className="relative">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Welcome back, <span className="text-gradient-brand">{userName}</span>
            </h1>
            <p className="mt-1.5 text-base text-muted-foreground">
              Pick up where you left off, or start something new.
            </p>
          </header>

          {/* Attention strip — only rendered when something needs attention.
              A permanent "all good" banner trains people to stop reading it. */}
          {(health.syncs > 0 ||
            health.warehouses > 0 ||
            health.schedules > 0 ||
            (budget && budget.spend >= budget.cap * 0.8)) && (
            <div className="relative mt-5 flex flex-wrap items-center gap-2">
              {health.syncs > 0 && (
                <Link
                  to="/integrations"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive ring-1 ring-destructive/20 transition hover:bg-destructive/15"
                >
                  {health.syncs} data {health.syncs === 1 ? "source" : "sources"} failed to sync
                </Link>
              )}
              {health.warehouses > 0 && (
                <Link
                  to="/integrations"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive ring-1 ring-destructive/20 transition hover:bg-destructive/15"
                >
                  {health.warehouses}{" "}
                  {health.warehouses === 1 ? "connection is" : "connections are"} unreachable
                </Link>
              )}
              {health.schedules > 0 && (
                <Link
                  to="/swarms"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive ring-1 ring-destructive/20 transition hover:bg-destructive/15"
                >
                  {health.schedules} scheduled {health.schedules === 1 ? "run" : "runs"} failed
                </Link>
              )}
              {budget && budget.spend >= budget.cap * 0.8 && (
                <Link
                  to="/budgets"
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition ${
                    budget.spend >= budget.cap
                      ? "bg-destructive/10 text-destructive ring-destructive/20 hover:bg-destructive/15"
                      : "bg-amber-500/10 text-amber-600 ring-amber-500/20 hover:bg-amber-500/15 dark:text-amber-500"
                  }`}
                >
                  {Math.round((budget.spend / budget.cap) * 100)}% of this month&rsquo;s budget used
                </Link>
              )}
            </div>
          )}

          {/* Action Tiles */}
          <div className="relative mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {actionTiles.map((tile) => (
              <Link
                key={tile.title}
                to={tile.to}
                {...(tile.search ? { search: tile.search } : {})}
                aria-label={tile.title}
                className="surface-raised glow-card group flex items-start gap-3 rounded-xl border border-border bg-card p-5 transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div
                  className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-border/50 transition-transform group-hover:scale-105",
                    tile.accent,
                  )}
                >
                  <tile.icon className="h-5 w-5" strokeWidth={1.6} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-foreground">{tile.title}</p>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{tile.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* ───── Explore the platform ───── */}
        <section className={cn(cardCls, "p-6 sm:p-8")}>
          <header className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Explore the platform
            </h2>
            <p className="text-sm text-muted-foreground">
              The important pieces of AgentSwarms, one click away.
            </p>
          </header>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <Link
                key={f.title}
                to={f.to}
                aria-label={f.title}
                className="group flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border transition hover:-translate-y-0.5 hover:shadow-md hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className="flex items-start justify-between">
                  <div
                    className={cn(
                      "grid h-10 w-10 place-items-center rounded-lg transition-transform group-hover:scale-105",
                      f.color,
                    )}
                  >
                    <f.icon className="h-5 w-5" strokeWidth={1.6} />
                  </div>
                  {f.badge && (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                      {f.badge}
                    </span>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{f.title}</p>
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* ───── Web embedding callout — the workspace lives at /embeds ───── */}
        <div
          className={cn(
            cardCls,
            "flex flex-col items-center gap-3 p-5 text-center sm:flex-row sm:text-left",
          )}
        >
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <Code2 className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-foreground">
              Web Embedding
              <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wider text-primary">
                New
              </span>
            </div>
            <div className="text-sm text-muted-foreground">
              Put your chat agents, multi-agent swarms and BI dashboards on any website with an
              iframe — secured by embed keys and domain allow-lists.
            </div>
          </div>
          <Button asChild>
            <Link to="/embeds">Open Web Embedding</Link>
          </Button>
        </div>

        {/* ───── Featured swarms ───── */}
        <section className={cn(cardCls, "p-6 sm:p-8")}>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Get started with a featured swarm
              </h2>
              <p className="text-sm text-muted-foreground">
                Curated templates with knowledge bases, tools, and prompts pre-wired.
              </p>
            </div>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground hover:text-foreground"
            >
              <Link to="/swarms">
                Browse all
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {featuredTemplates.map((tpl) => (
              <Link
                key={tpl.id}
                to="/swarms"
                search={openCanvasSearch(tpl.id)}
                aria-label={`Open swarm on canvas: ${tpl.title}`}
                className="group flex flex-col gap-2 rounded-xl bg-card p-4 ring-1 ring-border transition hover:-translate-y-0.5 hover:shadow-md hover:ring-primary/40"
              >
                <div className="flex items-start justify-between">
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary transition-transform group-hover:scale-105">
                    <Network className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <Badge
                    variant="secondary"
                    className="bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border"
                  >
                    {tpl.category}
                  </Badge>
                </div>
                <div className="mt-1">
                  <p className="line-clamp-1 text-sm font-medium text-foreground">{tpl.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tpl.tagline}</p>
                </div>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {tpl.nodes.length} nodes
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition group-hover:opacity-100">
                    Open canvas <ArrowUpRight className="h-3 w-3" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* ───── Quick stat tiles ───── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {heroStats.map((c) => (
            <Link
              key={c.label}
              to={c.to}
              className={cn(
                cardCls,
                "group flex items-center justify-between p-4 transition hover:-translate-y-0.5 hover:shadow-md",
              )}
            >
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {c.label}
                </span>
                <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
                  {c.value}
                </div>
              </div>
              <div className={cn("grid h-10 w-10 place-items-center rounded-lg", c.color)}>
                <c.icon className="h-5 w-5" strokeWidth={1.6} />
              </div>
            </Link>
          ))}
        </div>

        {/* ───── Empty state ───── */}
        {isEmpty && (
          <div
            className={cn(
              cardCls,
              "flex flex-col items-center gap-3 p-6 text-center sm:flex-row sm:text-left",
            )}
          >
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <LayoutTemplate className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-foreground">
                Your lab is empty — let's fix that.
              </div>
              <div className="text-sm text-muted-foreground">
                Spin up a featured swarm in seconds to see agents, swarms, traces, and costs come
                alive.
              </div>
            </div>
            <Button asChild>
              <Link to="/swarms">Browse swarms</Link>
            </Button>
          </div>
        )}

        {/* ───── Spend & usage (scoped, server-backed) ─────
            Separate from the tiles above because those read the caller's own
            traces under RLS; this one can answer "my team" and "the whole
            organisation", which requires the server to authorise the scope
            first. */}
        <SpendPanel />

        {/* ───── Activity + Model mix ───── */}
        <div className="grid gap-4 lg:grid-cols-3">
          <section className={cn(cardCls, "p-6 lg:col-span-2")}>
            <header className="flex items-start justify-between pb-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Activity className="h-4 w-4 text-primary" />
                  Activity — last 24h
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Hourly run volume across all your agents and swarms.
                </p>
              </div>
              <Badge
                variant="secondary"
                className="gap-1 bg-muted text-muted-foreground ring-1 ring-border"
              >
                <TrendingUp className="h-3 w-3" />
                {metrics.runs24h} runs
              </Badge>
            </header>
            <div className="flex h-32 items-end gap-1">
              {metrics.spark.map((v, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t bg-gradient-to-t from-primary/15 to-primary/70 transition-all hover:to-primary"
                  style={{ height: `${(v / sparkMax) * 100}%`, minHeight: v > 0 ? "4px" : "2px" }}
                  title={`${i}:00 — ${v} runs`}
                />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border/60 pt-3 text-xs">
              <div>
                <div className="text-muted-foreground">Success rate</div>
                <div className="mt-0.5 flex items-center gap-1 font-semibold text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> {metrics.successRate}%
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Avg latency</div>
                <div className="mt-0.5 flex items-center gap-1 font-semibold text-foreground">
                  <Clock className="h-3 w-3 text-sky-500" /> {formatMs(metrics.avgLatency)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Spend</div>
                <div className="mt-0.5 flex items-center gap-1 font-semibold text-foreground">
                  <Zap className="h-3 w-3 text-amber-500" /> ${metrics.totalCost.toFixed(2)}
                </div>
              </div>
            </div>
          </section>

          <section className={cn(cardCls, "p-6")}>
            <header className="pb-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Cpu className="h-4 w-4 text-indigo-500" />
                Model mix
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">Where your tokens went</p>
            </header>
            <div className="space-y-3">
              {metrics.modelMix.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No runs yet. Provision a template to populate.
                </p>
              ) : (
                metrics.modelMix.map((m) => (
                  <div key={m.model}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="truncate font-medium text-foreground">{m.model}</span>
                      <span className="text-muted-foreground tabular-nums">{m.count}</span>
                    </div>
                    <Progress value={m.share} className="h-1.5" />
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* ───── Recent runs ───── */}
        <section className={cn(cardCls, "p-6")}>
          <header className="flex items-center justify-between pb-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Recent runs</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Latest agent executions across your workspace
              </p>
            </div>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground hover:text-foreground"
            >
              <Link to="/traces">
                View all
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </header>
          {recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No runs yet. Open the Playground or provision a template.
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {recent.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
                  {r.status === "success" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : r.status === "cancelled" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{r.agent_name}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.llm_model}</div>
                  </div>
                  <div className="hidden text-right text-xs text-muted-foreground sm:block">
                    <div className="tabular-nums">{formatMs(r.latency_ms)}</div>
                    <div className="tabular-nums">${(r.cost_usd || 0).toFixed(4)}</div>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {formatRunTime(r.created_at)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
