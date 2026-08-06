import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BarChart3,
  BellRing,
  Bot,
  ChevronDown,
  Code2,
  Container,
  Cpu,
  Database,
  Gauge,
  GraduationCap,
  KeyRound,
  LayoutDashboard,
  LineChart,
  LogOut,
  Menu,
  Network,
  Plug,
  Settings,
  Share2,
  ShieldCheck,
  Wand2,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SiteFooter } from "@/components/SiteChrome";
import { BrowserFrame } from "@/components/marketing/BrowserFrame";
import { GlowCard } from "@/components/marketing/GlowCard";
import { Reveal } from "@/components/marketing/Reveal";
import { DeckMock } from "@/components/marketing/HomeMocks";
import { BiDashboardMock, GenerateFlowMock } from "@/components/marketing/BiMocks";
import { SectionHeading } from "@/components/marketing/SectionHeading";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";

// Public source repository for this build. Self-hosters running a fork
// should point this at their own repo.
const GITHUB_URL = "https://github.com/AgentSwarms-fyi/agentswarms";

// lucide-react no longer ships brand icons, so the GitHub mark is inlined.
function Github({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function HoverMoreMenu() {
  // Docs deliberately absent: it has its own top-level link in the header, and
  // listing it here too showed the same destination twice on sm+ widths.
  // Architecture/Security/Licensing were in the MOBILE menu only, which left
  // the pages written for desktop procurement reviewers with no desktop link
  // anywhere on the site.
  const items = [
    { to: "/architecture", label: "Architecture" },
    { to: "/security", label: "Security" },
    { to: "/license", label: "Licensing" },
    { to: "/about", label: "About" },
    { to: "/contact", label: "Contact" },
  ] as const;
  return (
    <div className="group relative hidden sm:inline-flex">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        More
        <ChevronDown className="h-3 w-3 transition group-hover:rotate-180" />
      </button>
      {/* invisible bridge so the menu doesn't collapse between trigger & panel */}
      <div className="pointer-events-none absolute left-0 right-0 top-full h-2 group-hover:pointer-events-auto" />
      <div
        className="invisible absolute right-0 top-[calc(100%+0.5rem)] z-50 w-48 rounded-xl border border-border/60 bg-popover/95 p-1 opacity-0 shadow-2xl backdrop-blur-xl transition-all duration-150 group-hover:visible group-hover:opacity-100"
        role="menu"
      >
        {items.map((it) => (
          <Link
            key={it.to}
            to={it.to}
            role="menuitem"
            className="block rounded-md px-2 py-1.5 text-sm text-foreground/90 transition hover:bg-accent hover:text-foreground"
          >
            {it.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AgentSwarms — Source-Available, Self-Hosted Agentic AI Platform" },
      {
        name: "description",
        content:
          "Run AI agents, multi-agent swarms and AI-native BI on your own infrastructure. Visual builder, RAG, MCP, dashboards with an AI analyst, scheduled alerts, warehouse connectors, budgets, and full traces. One Supabase project, one Docker command, any model provider. Source-available (Elastic License 2.0).",
      },
      {
        name: "keywords",
        content:
          "self-hosted AI agents, source-available agentic AI platform, multi-agent swarms, deploy AI agents Docker, BYOK LLM platform, agent orchestration, MCP, RAG platform, LangGraph export, self-hosted LLM tools",
      },
      { property: "og:title", content: "AgentSwarms — Self-Hosted Agentic AI Platform" },
      {
        property: "og:description",
        content:
          "Deploy your own agentic AI platform: agents, swarms, RAG, and AI-native BI — dashboards, alerts, and an analyst that writes the SQL. Your Supabase, your model keys, one Docker command. Source-available (Elastic License 2.0).",
      },
      { name: "twitter:title", content: "AgentSwarms — Self-Hosted Agentic AI Platform" },
      {
        name: "twitter:description",
        content:
          "Run agents and swarms on your own infrastructure. Any model provider, full traces, source-available (Elastic License 2.0), deployed with one Docker command.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: "/og-image.png" },
      { name: "twitter:image", content: "/og-image.png" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "AgentSwarms",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Self-hosted (Docker, Node.js, Kubernetes)",
          description:
            "Source-available, self-hosted agentic AI platform: visual agent builder, multi-agent swarm canvas, RAG, tools, MCP, budgets, and execution traces. Bring your own Supabase project and model provider keys.",
          license: "https://www.elastic.co/licensing/elastic-license",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          codeRepository: GITHUB_URL,
        }),
      },
    ],
  }),
  component: LandingPage,
});

const deploySteps = [
  {
    step: "01",
    icon: Database,
    title: "Create a Supabase project",
    body: "The free tier is the entire backend — Postgres, auth, storage, vector search. One `npx supabase db push` applies the full schema.",
  },
  {
    step: "02",
    icon: KeyRound,
    title: "Fill in .env",
    body: "Four Supabase values, plus one optional OpenRouter key if you want instance-wide, zero-config chat. Users can always bring their own keys.",
  },
  {
    step: "03",
    icon: Container,
    title: "docker compose up",
    body: "Public config is baked at build, secrets are read at runtime. Ship it on a $5 VPS, Fly.io, Railway, Render, or Kubernetes.",
  },
] as const;

function TerminalMock() {
  const lines = [
    { prompt: true, text: `git clone ${GITHUB_URL.replace("https://", "")} && cd agentswarms` },
    { prompt: true, text: "cp .env.example .env", comment: "# your Supabase + model keys" },
    { prompt: true, text: "npx supabase db push", comment: "# entire schema, one command" },
    { prompt: true, text: "docker compose up --build", comment: "" },
    { prompt: false, text: "➜  ready — http://localhost:8080" },
  ];
  return (
    <div className="glow-card overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/30 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-3 font-mono text-[10px] text-muted-foreground">
          deploy — 4 commands
        </span>
      </div>
      <div className="space-y-2.5 overflow-x-auto p-5 font-mono text-[11px] leading-relaxed sm:text-xs">
        {lines.map((l) => (
          <div key={l.text} className="whitespace-nowrap">
            {l.prompt ? <span className="select-none text-primary">$ </span> : null}
            <span className={l.prompt ? "text-foreground/90" : "text-emerald-500"}>{l.text}</span>
            {l.comment ? (
              <span className="text-muted-foreground/70">
                {"   "}
                {l.comment}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const exportTargets = ["LangGraph", "CrewAI", "OpenAI SDK", "Strands"] as const;

function ExportMock() {
  const codeLines = [
    {
      indent: 0,
      tokens: [
        { t: "from", c: "text-sky-400" },
        { t: " langgraph.graph ", c: "text-foreground/80" },
        { t: "import", c: "text-sky-400" },
        { t: " StateGraph", c: "text-foreground/80" },
      ],
    },
    {
      indent: 0,
      tokens: [
        { t: "graph", c: "text-foreground/80" },
        { t: " = ", c: "text-muted-foreground" },
        { t: "StateGraph", c: "text-emerald-500" },
        { t: "(ResearchState)", c: "text-foreground/80" },
      ],
    },
    {
      indent: 0,
      tokens: [
        { t: "graph.", c: "text-foreground/80" },
        { t: "add_node", c: "text-emerald-500" },
        { t: "(", c: "text-foreground/80" },
        { t: '"researcher"', c: "text-amber-400" },
        { t: ", researcher_agent)", c: "text-foreground/80" },
      ],
    },
    {
      indent: 0,
      tokens: [
        { t: "graph.", c: "text-foreground/80" },
        { t: "add_node", c: "text-emerald-500" },
        { t: "(", c: "text-foreground/80" },
        { t: '"writer"', c: "text-amber-400" },
        { t: ", writer_agent)", c: "text-foreground/80" },
      ],
    },
    {
      indent: 0,
      tokens: [
        { t: "graph.", c: "text-foreground/80" },
        { t: "add_edge", c: "text-emerald-500" },
        { t: "(", c: "text-foreground/80" },
        { t: '"researcher"', c: "text-amber-400" },
        { t: ", ", c: "text-foreground/80" },
        { t: '"writer"', c: "text-amber-400" },
        { t: ")", c: "text-foreground/80" },
      ],
    },
    {
      indent: 0,
      tokens: [
        { t: "app", c: "text-foreground/80" },
        { t: " = ", c: "text-muted-foreground" },
        { t: "graph.", c: "text-foreground/80" },
        { t: "compile", c: "text-emerald-500" },
        { t: "()", c: "text-foreground/80" },
      ],
    },
  ];
  return (
    <div className="glow-card overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-muted/30 px-4 py-2.5">
        {exportTargets.map((t, i) => (
          <span
            key={t}
            className={
              i === 0
                ? "rounded-md bg-primary/15 px-2 py-1 text-[10px] font-semibold text-primary"
                : "rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground"
            }
          >
            {t}
          </span>
        ))}
      </div>
      <div className="space-y-1.5 overflow-x-auto p-5 font-mono text-[11px] leading-relaxed">
        {codeLines.map((line, i) => (
          <div key={i} className="whitespace-nowrap">
            {line.tokens.map((tok, j) => (
              <span key={j} className={tok.c}>
                {tok.t}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          exported from swarm: <span className="text-foreground/80">research-pipeline</span>
        </span>
      </div>
    </div>
  );
}

function LandingPage() {
  const { isAuthenticated, loading, user, signOut } = useAuth();
  const showAuthed = isAuthenticated && !loading;
  const userInitial = user?.email?.[0]?.toUpperCase() ?? "U";
  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto grid h-16 max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 sm:flex sm:justify-between sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link to="/" className="flex min-w-0 items-center gap-2">
              <img
                src={agentSwarmsLogo}
                alt="AgentSwarms logo"
                width={36}
                height={36}
                fetchPriority="high"
                className="h-9 w-9 shrink-0 rounded-lg object-cover"
              />
              <span className="flex min-w-0 flex-col leading-none">
                <span className="truncate text-base font-bold tracking-tight sm:text-lg">
                  AgentSwarms
                </span>
                <span className="mt-0.5 hidden truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:inline">
                  Unified Agentic AI &amp; Business Intelligence
                </span>
              </span>
            </Link>
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-3">
            <Link
              to="/docs"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Docs
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>

            {/* Secondary destinations live in a compact "More" menu so the
                bar stays scannable between sm and xl widths. */}
            <HoverMoreMenu />
            <ThemeToggle />
            {/* Mobile menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Open menu"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/60 bg-card/60 text-foreground transition hover:border-primary/50 hover:bg-card sm:hidden"
                >
                  <Menu className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem asChild>
                  <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/docs">Docs</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/architecture">Architecture</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/security">Security</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/license">Licensing</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/about">About</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/contact">Contact</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {showAuthed ? (
                  <DropdownMenuItem asChild>
                    <Link to="/dashboard">Open dashboard</Link>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem asChild>
                    <Link to="/login">Sign in</Link>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {showAuthed ? (
              <>
                <Link to="/dashboard" className="hidden sm:inline">
                  <Button size="sm" className="gap-1.5">
                    Open dashboard <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Account menu"
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-card/60 text-sm font-semibold text-foreground transition hover:border-primary/50 hover:bg-card"
                    >
                      {userInitial}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="truncate">
                      {user?.email ?? "Signed in"}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/dashboard" className="flex items-center gap-2">
                        <LayoutDashboard className="h-4 w-4" /> Dashboard
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link to="/account" className="flex items-center gap-2">
                        <Settings className="h-4 w-4" /> Account settings
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        void signOut();
                      }}
                      className="text-destructive focus:text-destructive"
                    >
                      <LogOut className="mr-2 h-4 w-4" /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <Link to="/login" className="hidden sm:inline">
                  <Button variant="ghost" size="sm">
                    Sign in
                  </Button>
                </Link>
                <Link to="/login" className="hidden sm:inline-flex">
                  <Button size="sm" className="gap-1.5">
                    Get Started <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      <main id="main-content">
        {/* Hero — technical split-screen */}
        <section className="relative flex min-h-[90vh] items-center justify-center overflow-hidden px-6 pt-24 pb-16 md:px-12 lg:px-16">
          <div className="bg-hero-glow pointer-events-none absolute inset-0" />
          <div className="pointer-events-none absolute left-1/2 top-1/3 h-[400px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-nexus-glow/10 blur-[120px]" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-background" />

          <div className="relative z-10 grid w-full min-w-0 max-w-7xl grid-cols-1 items-center gap-16 lg:grid-cols-12 lg:gap-20">
            {/* Left — content */}
            <div className="space-y-10 lg:col-span-5">
              <motion.div
                className="space-y-6"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: [0.21, 0.47, 0.32, 0.98] }}
              >
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  Source-available &middot; Elastic License 2.0
                </div>
                <h1 className="font-display text-[2.5rem] font-semibold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-7xl">
                  Run <span className="text-gradient-brand">agents, swarms &amp; BI</span> on your
                  own infrastructure
                </h1>
                <p className="max-w-xl text-lg leading-relaxed text-muted-foreground lg:text-xl">
                  The source-available agentic AI platform you deploy yourself: visual agent
                  builder, multi-agent swarm canvas, RAG, and a full AI-native BI suite —
                  dashboards, alerts, and an analyst that writes the SQL. One Supabase project. One
                  Docker command. Any model provider.
                </p>
              </motion.div>

              <motion.div
                className="flex flex-wrap items-center gap-4"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.1, ease: [0.21, 0.47, 0.32, 0.98] }}
              >
                <Link to={showAuthed ? "/dashboard" : "/login"}>
                  <Button size="lg" className="gap-2 px-8 text-base">
                    {showAuthed ? "Open dashboard" : "Get Started"}{" "}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="lg" className="gap-2 px-8 text-base">
                    <Github className="h-4 w-4" /> Deploy Your Own
                  </Button>
                </a>
              </motion.div>

              <motion.div
                className="grid grid-cols-3 gap-6 border-t border-border/60 pt-10 md:grid-cols-6"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.2, ease: [0.21, 0.47, 0.32, 0.98] }}
              >
                {[
                  { n: "10+", l: "Model Providers" },
                  { n: "1", l: "Command Deploy" },
                  { n: "19", l: "BI Visual Types" },
                  { n: "27", l: "Data Connectors" },
                  { n: "ELv2", l: "Licensed" },
                  { n: "100%", l: "Your Data" },
                ].map((s) => (
                  <div key={s.l} className="space-y-1">
                    <div className="text-xl font-bold tracking-tight text-foreground">{s.n}</div>
                    <div className="text-[10px] font-bold uppercase leading-tight tracking-widest text-muted-foreground">
                      {s.l}
                    </div>
                  </div>
                ))}
              </motion.div>

              <motion.p
                className="text-xs text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.55, delay: 0.3 }}
              >
                Source-available (Elastic License 2.0) · Bring your own keys · Docker, bare Node, or
                Kubernetes
              </motion.p>
            </div>

            {/* Right — swarm visual */}
            <motion.div
              className="relative hidden h-[600px] items-center justify-center lg:col-span-7 lg:flex"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.7, delay: 0.2, ease: [0.21, 0.47, 0.32, 0.98] }}
            >
              <div className="hero-node-pulse absolute h-64 w-64 rounded-full bg-nexus-glow/15 blur-[100px]" />

              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 800 500"
                fill="none"
              >
                <path
                  d="M180 250 L250 250"
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1.5"
                />
                <path
                  d="M180 250 L250 250"
                  stroke="currentColor"
                  className="hero-animate-flow text-foreground/30"
                  strokeWidth="1.5"
                />
                <path
                  d="M410 250 C 460 250, 460 140, 520 140"
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1.5"
                />
                <path
                  d="M410 250 C 460 250, 460 140, 520 140"
                  stroke="currentColor"
                  className="hero-animate-flow text-muted-foreground/50"
                  strokeWidth="1.5"
                  style={{ animationDelay: "0.2s" }}
                />
                <path
                  d="M410 250 C 460 250, 460 360, 520 360"
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1.5"
                />
                <path
                  d="M410 250 C 460 250, 460 360, 520 360"
                  stroke="currentColor"
                  className="hero-animate-flow text-muted-foreground/50"
                  strokeWidth="1.5"
                  style={{ animationDelay: "0.4s" }}
                />
                <path
                  d="M680 140 C 720 140, 720 250, 750 250"
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1.5"
                />
                <path
                  d="M680 360 C 720 360, 720 250, 750 250"
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1.5"
                />
              </svg>

              {/* Node: Input */}
              <div className="absolute left-0 top-1/2 -translate-y-1/2">
                <div className="w-40 rounded-xl border border-border bg-card p-4 shadow-2xl">
                  <div className="mb-2 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                    </div>
                    <span className="text-[11px] font-bold tracking-tight text-foreground">
                      Transcript Source
                    </span>
                  </div>
                  <p className="truncate font-mono text-[9px] text-muted-foreground">
                    Q3_Earnings_Call.pdf
                  </p>
                </div>
              </div>

              {/* Node: Orchestrator */}
              <div className="absolute left-[240px] top-1/2 -translate-y-1/2">
                <div className="w-44 rounded-xl border border-border bg-card p-4 shadow-[0_0_40px_-10px_hsl(var(--primary)/0.15)] ring-1 ring-foreground/10">
                  <div className="mb-2 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background shadow-lg">
                      <svg
                        className="h-4 w-4 animate-spin [animation-duration:4s]"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </div>
                    <span className="text-[11px] font-bold tracking-tight text-foreground">
                      Lead Orchestrator
                    </span>
                  </div>
                  <p className="animate-pulse font-mono text-[9px] italic text-muted-foreground">
                    Delegating tasks…
                  </p>
                </div>
              </div>

              {/* Node: Financial Extractor */}
              <div className="absolute right-[80px] top-[80px]">
                <div className="w-52 rounded-xl border border-border bg-card/80 p-4 shadow-xl backdrop-blur-md">
                  <div className="mb-2 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded border border-border bg-muted/40 text-sky-400">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
                        />
                      </svg>
                    </div>
                    <span className="text-[11px] font-bold tracking-tight text-foreground">
                      Financial Extractor
                    </span>
                  </div>
                  <div className="space-y-1 font-mono text-[9px]">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Revenue:</span>
                      <span className="text-emerald-500">$12.4B</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>EPS:</span>
                      <span className="text-emerald-500">$1.12</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Node: Sentiment */}
              <div className="absolute bottom-[80px] right-[80px]">
                <div className="w-52 rounded-xl border border-border bg-card/80 p-4 shadow-xl backdrop-blur-md">
                  <div className="mb-2 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded border border-border bg-muted/40 text-rose-400">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                        />
                      </svg>
                    </div>
                    <span className="text-[11px] font-bold tracking-tight text-foreground">
                      Sentiment Analyzer
                    </span>
                  </div>
                  <p className="font-mono text-[9px] text-muted-foreground">
                    Analyzing CEO Q&amp;A tone…
                  </p>
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted/40">
                    <div className="h-full w-[70%] animate-pulse bg-emerald-500/50" />
                  </div>
                </div>
              </div>

              {/* Node: Synthesis */}
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <div className="w-44 rounded-xl border border-border bg-card p-4 shadow-2xl ring-1 ring-foreground/5">
                  <div className="mb-2 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded bg-emerald-500/10 text-emerald-500">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                        />
                      </svg>
                    </div>
                    <span className="text-[11px] font-bold tracking-tight text-foreground">
                      Synthesis Engine
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="block h-1 w-1 animate-ping rounded-full bg-emerald-500" />
                    <p className="font-mono text-[9px] text-foreground/80">Final Memo Generated.</p>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Multi-agent swarms — flagship band */}
        <section id="swarms" className="relative overflow-hidden border-t border-border/60 py-24">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_60%_at_50%_0%,color-mix(in_oklch,var(--primary)_8%,transparent),transparent)]" />
          <div className="relative mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-14 max-w-3xl"
              eyebrow="Multi-Agent Swarms"
              title="Design agent teams on a visual canvas."
              lede="Drag agents, routers, conditions, loops, sandboxed functions, evals and human-approval gates onto a canvas, wire typed inputs to outputs, and run the whole flow live with a full trace — no orchestration code. Export to LangGraph or CrewAI when you outgrow it."
            />

            <Reveal>
              <div className="relative">
                <div className="pointer-events-none absolute -inset-6 rounded-3xl bg-[radial-gradient(60%_55%_at_50%_40%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)] blur-2xl" />
                <BrowserFrame url="localhost:8080/swarms" className="relative">
                  {/* Served from public/ (not a bundled import) so a missing
                      file degrades to an empty frame instead of breaking the
                      build. Drop the screenshot at public/swarm-canvas.png. */}
                  <img
                    src="/swarm-canvas.png"
                    alt="The AgentSwarms swarm canvas — an Earnings Call Analyst Desk flow of agents, a human-approval gate, and typed inputs and outputs"
                    loading="lazy"
                    width={1856}
                    height={902}
                    className="block w-full"
                  />
                </BrowserFrame>
              </div>
            </Reveal>

            {/* Node-type grid */}
            <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Bot,
                  title: "Agents & routers",
                  body: "Agent nodes make LLM calls with tools, memory and guardrails; router agents read the input and pick one of N downstream paths.",
                },
                {
                  icon: Workflow,
                  title: "Conditions & loops",
                  body: "YES/NO condition gates branch the flow, and loop nodes retry a step until it returns DONE — real control flow, no code.",
                },
                {
                  icon: Code2,
                  title: "Sandboxed functions",
                  body: "Function nodes run sandboxed JavaScript transforms with a 2-second timeout to reshape data as it passes between agents.",
                },
                {
                  icon: ShieldCheck,
                  title: "Human-approval gates",
                  body: "Approval nodes pause the run for a person to review and release, with risk flags surfaced inline before anything ships.",
                },
                {
                  icon: Gauge,
                  title: "LLM-as-a-judge evals",
                  body: "Evaluate nodes score outputs judge-style, so quality gates live inside the flow instead of a separate pipeline.",
                },
                {
                  icon: Share2,
                  title: "Remote agents & export",
                  body: "Delegate to remote A2A agents, or export any swarm to LangGraph, CrewAI or the OpenAI Agents SDK when you outgrow the canvas.",
                },
              ].map((c, i) => (
                <Reveal key={c.title} delay={0.05 * i}>
                  <GlowCard className="h-full">
                    <div className="mb-3 inline-flex rounded-lg bg-primary/10 p-2">
                      <c.icon className="h-4 w-4 text-primary" />
                    </div>
                    <h3 className="text-base font-semibold">{c.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                  </GlowCard>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Business Intelligence — flagship band */}
        <section id="bi" className="relative overflow-hidden border-t border-border/60 py-24">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_60%_at_50%_0%,color-mix(in_oklch,var(--primary)_8%,transparent),transparent)]" />
          <div className="relative mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-14 max-w-3xl"
              eyebrow="Business Intelligence"
              title="A full AI-native BI suite, self-hosted."
              lede="Not a chart library bolted on — dashboards, an analyst that writes and runs the SQL, scheduled refreshes with data alerts, and an AI-built ontology of your whole data estate. All on the same instance as your agents."
            />

            <div className="grid items-center gap-12 lg:grid-cols-12">
              <div className="space-y-6 lg:col-span-5">
                <div className="space-y-4">
                  {[
                    {
                      icon: Wand2,
                      title: "One goal in, a dashboard out",
                      body: "Describe the goal — the analyst plans the questions, writes the SQL, runs it, picks the charts and lays everything out. Ask follow-ups in plain English, blend in knowledge-base documents, and insert any answer as a widget.",
                    },
                    {
                      icon: BellRing,
                      title: "Dashboards that act",
                      body: "Server-side scheduled refreshes (no browser needed) with data alerts — a rule fires once when a metric crosses its threshold, re-arms when it clears, and lands in your notification bell.",
                    },
                    {
                      icon: Network,
                      title: "An ontology of everything",
                      body: "The AI maps every table, warehouse and knowledge base into a drillable knowledge graph — real sample data in, field-level relationships with quoted evidence out.",
                    },
                  ].map((f, i) => (
                    <Reveal key={f.title} delay={0.06 * i}>
                      <div className="flex gap-4">
                        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <f.icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <h3 className="text-base font-semibold">{f.title}</h3>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {f.body}
                          </p>
                        </div>
                      </div>
                    </Reveal>
                  ))}
                </div>
                <Reveal delay={0.2}>
                  <GenerateFlowMock />
                </Reveal>
              </div>
              <Reveal className="lg:col-span-7" delay={0.1}>
                <div className="relative">
                  <div className="pointer-events-none absolute -inset-6 rounded-3xl bg-[radial-gradient(60%_60%_at_50%_40%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)] blur-2xl" />
                  <BiDashboardMock />
                </div>
              </Reveal>
            </div>

            {/* BI capability grid */}
            <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: BarChart3,
                  title: "19 visual types",
                  body: "Bars to box plots, KPI targets, gauges, funnels, waterfalls, pivots, filled & bubble maps, treemaps, heatmaps — plus the AI-built ontology.",
                },
                {
                  icon: LineChart,
                  title: "Analyst-grade interactions",
                  body: "Click-to-drill hierarchies, cross-filtering, date-grain switching, prior-period overlays, trend lines and σ-banded forecasts.",
                },
                {
                  icon: Database,
                  title: "27 data connectors",
                  body: "22 databases and warehouses — Postgres, MySQL, SQL Server, Oracle, Snowflake, BigQuery, Databricks, Redshift, Synapse, Trino, Athena, ClickHouse, CockroachDB and more — plus 5 apps: Google Sheets, Stripe, Shopify, HubSpot, Salesforce. Encrypted credentials, strictly read-only.",
                },
                {
                  icon: Share2,
                  title: "Publish anywhere",
                  body: "Unguessable public links, chrome-less iframe embeds, IAM group sharing, and PDF / CSV / PNG export. Viewers get their own Ask-AI panel.",
                },
                {
                  icon: Activity,
                  title: "Visual data prep",
                  body: "Drag-and-drop joins with auto-detected keys, semantic column types, live previews — materialised as reusable datasets.",
                },
                {
                  icon: Cpu,
                  title: "Your models, governed",
                  body: "Every generative feature runs on the model you pick from your own integrations — BYOK, with IAM model rules enforced server-side.",
                },
              ].map((c, i) => (
                <Reveal key={c.title} delay={0.05 * i}>
                  <GlowCard className="h-full">
                    <div className="mb-3 inline-flex rounded-lg bg-primary/10 p-2">
                      <c.icon className="h-4 w-4 text-primary" />
                    </div>
                    <h3 className="text-base font-semibold">{c.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                  </GlowCard>
                </Reveal>
              ))}
            </div>

            {/* Enterprise strip */}
            <Reveal delay={0.1}>
              <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    icon: ShieldCheck,
                    title: "IAM & model rules",
                    body: "Groups, invites, per-group model allowlists, read-only resource grants.",
                  },
                  {
                    icon: KeyRound,
                    title: "SAML SSO",
                    body: "Bring your identity provider; invite-only mode for locked-down instances.",
                  },
                  {
                    icon: Settings,
                    title: "Secrets vault",
                    body: "Write-only secrets referenced as {{secret:NAME}} across connections.",
                  },
                  {
                    icon: Activity,
                    title: "Budgets & traces",
                    body: "Per-user spend caps with alerts, and a full trace for every call.",
                  },
                ].map((e) => (
                  <div key={e.title} className="bg-card p-5">
                    <div className="flex items-center gap-2">
                      <e.icon className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold">{e.title}</h3>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{e.body}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* Deploy — terminal + steps */}
        <section id="deploy" className="relative border-t border-border/60 bg-muted/30 py-24">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--primary)_3%,transparent),transparent)]" />
          <div className="relative mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-16"
              align="center"
              eyebrow="Deploy"
              title="Live before your coffee cools."
              lede="No separate backend to run — a free-tier Supabase project is the database, auth, and storage. The app itself is one container."
            />

            <div className="grid items-center gap-12 lg:grid-cols-2">
              <div className="space-y-6">
                {deploySteps.map((s, i) => (
                  <Reveal key={s.step} delay={0.08 * i}>
                    <div className="glow-card flex gap-5 rounded-xl border border-border bg-card p-6">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 font-mono text-sm font-bold text-primary">
                        {s.step}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-semibold">{s.title}</h3>
                          <s.icon className="h-4 w-4 text-primary" />
                        </div>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          {s.body}
                        </p>
                      </div>
                    </div>
                  </Reveal>
                ))}
              </div>
              <Reveal delay={0.15}>
                <TerminalMock />
              </Reveal>
            </div>

            <div className="mt-10 text-center">
              <a
                href={`${GITHUB_URL}/blob/main/docs/INSTALL.md`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                Read the full installation guide <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </section>

        {/* Capabilities — alternating feature rows */}
        <section className="border-t border-border/60 bg-muted/30 py-24">
          <div className="mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-20"
              align="center"
              eyebrow="Capabilities"
              title="Everything a platform needs, batteries included"
              lede="The pieces you'd otherwise glue together yourself — observability, interoperability, and the guidance to use them well."
            />

            <div className="space-y-20">
              {/* Observability */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div>
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <Activity className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Traces & budgets
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">
                      See everything your agents do
                    </h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Every tool call, token, and cost lands in a full execution trace. Set per-user
                      budgets with email alerts before a runaway loop becomes a bill — it's your key
                      on the line, so the meter is yours too.
                    </p>
                  </div>
                  <img
                    src="/traces.png"
                    alt="An AgentSwarms execution trace — every tool call, token count and cost for an agent run"
                    loading="lazy"
                    width={1632}
                    height={845}
                    className="block w-full rounded-xl border border-border shadow-2xl"
                  />
                </div>
              </Reveal>

              {/* Interoperability */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div className="lg:order-2">
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <Plug className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        MCP · A2A · Export
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">
                      Interoperable by default
                    </h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Connect MCP servers as agent tools, expose swarms over an A2A endpoint, and
                      when you outgrow the canvas, export any swarm to LangGraph, CrewAI, the OpenAI
                      Agents SDK, or Strands — your work is never trapped here.
                    </p>
                  </div>
                  <div className="lg:order-1">
                    <ExportMock />
                  </div>
                </div>
              </Reveal>

              {/* Learning guidance */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div>
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <GraduationCap className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Built-in guidance
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">
                      Your whole team on one instance
                    </h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Agents, swarms, BI dashboards, and interactive notebooks all ship in one
                      workspace — so the people you invite don't just get a login, they get a shared
                      place to build, analyze, and ship together.
                    </p>
                    <Link
                      to="/docs"
                      className="group mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary"
                    >
                      Read the documentation
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  <DeckMock />
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* CTA — glow panel */}
        <section className="py-20">
          <div className="mx-auto max-w-5xl px-6">
            <Reveal>
              <div className="relative overflow-hidden rounded-3xl border border-border bg-card px-6 py-20 text-center">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)]" />
                <div className="relative">
                  <h2 className="font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                    Agents, swarms and BI — deploy it all as your own
                  </h2>
                  <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
                    One Supabase project, one Docker command, any model provider. Demo agents and
                    sample data are already seeded when you sign in.
                  </p>
                  <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                    <Link to={showAuthed ? "/dashboard" : "/login"}>
                      <Button size="lg" className="gap-2 px-10 text-base">
                        {showAuthed ? "Open dashboard" : "Get Started"}{" "}
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                    <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                      <Button variant="ghost" size="lg" className="gap-2 px-6 text-base">
                        <Github className="h-4 w-4" /> Star on GitHub
                      </Button>
                    </a>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
