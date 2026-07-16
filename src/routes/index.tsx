import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  BookOpen,
  Compass,
  Cpu,
  FlaskConical,
  Hammer,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Network,
  Notebook as NotebookIcon,
  Presentation as PresentationIcon,
  Rocket,
  Settings,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SiteFooter } from "@/components/SiteChrome";
import { BrowserFrame } from "@/components/marketing/BrowserFrame";
import { GlowCard } from "@/components/marketing/GlowCard";
import { Reveal } from "@/components/marketing/Reveal";
import {
  RealBuilderMock,
  DeckMock,
  BrokenSwarmMock,
  NotebookMock,
  VramMock,
} from "@/components/marketing/HomeMocks";
import { SectionHeading } from "@/components/marketing/SectionHeading";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
import playgroundPreview from "@/assets/playground-preview.png";
import playgroundVideo from "@/assets/playground.mp4.asset.json";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useRef, useState } from "react";

function HoverMoreMenu() {
  const items = [
    { to: "/learn", label: "Learn" },
    { to: "/interview-questions", label: "Interview Questions" },
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
      { title: "AgentSwarms — Learn Agentic AI Hands-On (Free)" },
      {
        name: "description",
        content:
          "Hands-on playground for Agentic AI. Free: 8 tracks, 50+ lessons, 50+ runnable agents & swarms, 10 build-along labs — RAG, tools, guardrails, swarms.",
      },
      {
        name: "keywords",
        content:
          "learn agentic AI, agentic AI playground, agentic AI tutorial, hands-on AI agents, build AI agents, multi-agent systems course, RAG tutorial, AI agent builder, free agentic AI course, agent orchestration, swarm AI",
      },
      { property: "og:title", content: "AgentSwarms — Learn Agentic AI by Building It" },
      {
        property: "og:description",
        content:
          "8 tracks, 50+ lessons, 50+ live agents & swarms, 10 build-along labs. Hands-on playground for Agentic AI — RAG, tools, guardrails, swarms. Free.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/" },
      { name: "twitter:title", content: "AgentSwarms — Learn Agentic AI by Building It" },
      {
        name: "twitter:description",
        content:
          "The only hands-on playground for Agentic AI. 50+ lessons, 50+ live agents & swarms, 9 interactive decks, 10 build-along labs. Free forever.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1776452942019-Captsvvsvsure.webp",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1776452942019-Captsvvsvsure.webp",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "AgentSwarms",
          url: "https://agentswarms.fyi/",
          description:
            "The only interactive, hands-on playground for learning Agentic AI. Free curriculum covering RAG, tools, guardrails, SQL agents, and multi-agent swarms.",
          publisher: {
            "@type": "Organization",
            name: "AgentSwarms",
            url: "https://agentswarms.fyi/",
          },
          potentialAction: {
            "@type": "SearchAction",
            target: "https://agentswarms.fyi/learn?q={search_term_string}",
            "query-input": "required name=search_term_string",
          },
        }),
      },
    ],
  }),
  component: LandingPage,
});

/* Only show 3 highlight lessons on the homepage */
const highlightLessons = [
  {
    icon: MessageSquare,
    chip: "Lesson 01",
    hash: "prompts",
    title: "Prompts & System Messages",
    description:
      "Shape an agent's personality, role, and constraints with a system prompt. Same model, wildly different behaviour — just by changing words.",
    youWillLearn: [
      "Anatomy of a great system prompt",
      "Few-shot vs zero-shot patterns",
      "How temperature changes creativity vs accuracy",
    ],
  },
  {
    icon: Wrench,
    chip: "Lesson 03",
    hash: "tools",
    title: "Tools & Function Calling",
    description:
      "Give your agent superpowers. Connect it to APIs, MCP servers, and webhooks so it can fetch data, send emails, run SQL.",
    youWillLearn: [
      "OpenAI tool-call schema, plain English",
      "MCP servers in 5 minutes",
      "Designing safe, idempotent tools",
    ],
  },
  {
    icon: Network,
    chip: "Lesson 05",
    hash: "swarms",
    title: "Multi-Agent Swarms",
    description:
      "One agent is a worker. A swarm is a team. Build researcher → writer → reviewer pipelines with explicit handoffs.",
    youWillLearn: [
      "Orchestrator vs peer-to-peer patterns",
      "Routing and handoff messages",
      "When to split an agent into a swarm",
    ],
  },
];

const learningPath = [
  {
    step: "01",
    icon: BookOpen,
    title: "Try a Live Demo",
    body: "Pick any template — Product Support, Research Assistant, Code Reviewer — and a working agent is provisioned in seconds.",
  },
  {
    step: "02",
    icon: Compass,
    title: "Follow the Guided Tour",
    body: "Each demo opens with a side-panel lesson. Suggested prompts walk you through RAG, guardrails, and approvals.",
  },
  {
    step: "03",
    icon: Wrench,
    title: "Fork & Experiment",
    body: "Tweak the system prompt, swap models, wire up your own knowledge base. Break things — that's how you learn.",
  },
  {
    step: "04",
    icon: Rocket,
    title: "Build Your Own",
    body: "Compose your own agents, chain them into a swarm, and watch traces light up in the observability dashboard.",
  },
];

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
                alt="AgentSwarms AI School logo"
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
                  School of Agentic AI
                </span>
              </span>
            </Link>
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-3">
            <Link
              to="/curriculum"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Curriculum
            </Link>
            <Link
              to="/docs"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Docs
            </Link>

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
                  <Link to="/curriculum">Curriculum</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/interview-questions">Interview Questions</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/learn">Learn</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/docs">Docs</Link>
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
                    <Link to="/dashboard">Open the lab</Link>
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
                    Open the lab <ArrowRight className="h-3.5 w-3.5" />
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
                    Start Learning <ArrowRight className="h-3.5 w-3.5" />
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
                <h1 className="font-display text-[2.5rem] font-semibold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-7xl">
                  <span className="sm:whitespace-nowrap">
                    Master <span className="text-muted-foreground">AI Agents</span>
                  </span>{" "}
                  through hands-on building
                </h1>
                <p className="max-w-xl text-lg leading-relaxed text-muted-foreground lg:text-xl">
                  50+ lessons paired with 50+ runnable agents and swarms: ReAct, Reflexion, Graph
                  RAG, text-to-SQL. Open one in your browser, fork it, and break it.
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
                    {showAuthed ? "Open the lab" : "Start Learning Free"}{" "}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link to="/curriculum">
                  <Button variant="outline" size="lg" className="px-8 text-base">
                    Browse Curriculum
                  </Button>
                </Link>
              </motion.div>

              <motion.div
                className="grid grid-cols-3 gap-6 border-t border-border/60 pt-10 md:grid-cols-6"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.2, ease: [0.21, 0.47, 0.32, 0.98] }}
              >
                {[
                  { n: "8", l: "Tracks" },
                  { n: "50+", l: "Lessons" },
                  { n: "50+", l: "Agents & Swarms" },
                  { n: "20+", l: "Notebooks" },
                  { n: "9", l: "Decks" },
                  { n: "10", l: "Build Labs" },
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
                Free forever · No credit card · Runs in your browser
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

        {/* Product preview */}
        <section className="-mt-8 overflow-hidden pb-16 sm:-mt-12">
          <div className="mx-auto max-w-6xl px-6">
            <Reveal className="relative">
              <div className="pointer-events-none absolute -inset-x-8 -top-12 bottom-0 bg-[radial-gradient(50%_50%_at_50%_30%,color-mix(in_oklch,var(--primary)_10%,transparent),transparent)] blur-2xl" />
              <BrowserFrame url="agentswarms.fyi/swarms" className="relative">
                <video
                  src={playgroundVideo.url}
                  poster={playgroundPreview}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  aria-label="AgentSwarms playground — building and running a multi-agent flow in the browser"
                  width={1920}
                  height={953}
                  className="block w-full"
                />
              </BrowserFrame>
            </Reveal>
          </div>
        </section>

        {/* Why AgentSwarms — differentiation band */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-14 max-w-3xl"
              eyebrow="Why AgentSwarms"
              title="Most courses make you watch. We make you build and break."
              lede="This is a learning and POC platform, not a production runtime. The fastest way to actually understand agentic AI is to run it, wire it, and watch it fail."
            />
            <div className="grid gap-4 lg:grid-cols-3 lg:grid-rows-2">
              <Reveal className="lg:col-span-2 lg:row-span-2">
                <GlowCard featured className="flex h-full flex-col p-6 sm:p-8">
                  <div className="mb-4 inline-flex self-start rounded-lg bg-primary/10 p-2.5">
                    <Network className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="text-xl font-semibold">A real builder, not a toy</h3>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                    The same visual Agent Builder and drag-and-drop swarm canvas you'd prototype
                    with — guardrails, tools, memory, RAG, evals, and human approval included.
                  </p>
                  {/* Mini canvas mock — echoes the real swarm canvas */}
                  <RealBuilderMock />
                </GlowCard>
              </Reveal>
              {[
                {
                  icon: Hammer,
                  title: "Learn by building, not watching",
                  body: "Every concept maps to a runnable agent or swarm you open in the browser. Read it, run it, fork it — no setup, no API keys to start.",
                },
                {
                  icon: FlaskConical,
                  title: "We teach the failure modes",
                  body: "Diagnose and repair deliberately-broken swarms in Failure-Mode Labs — hallucinating RAG, runaway loops, dead branches. Almost nobody else teaches this.",
                },
              ].map((c, i) => (
                <Reveal key={c.title} delay={0.08 * (i + 1)}>
                  <GlowCard className="h-full">
                    <div className="mb-4 inline-flex rounded-lg bg-primary/10 p-2.5">
                      <c.icon className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold">{c.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                  </GlowCard>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Curriculum highlights — 3 cards */}
        <section id="curriculum" className="relative border-t border-border/60 bg-muted/30 py-24">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--primary)_3%,transparent),transparent)]" />
          <div className="relative mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-16"
              align="center"
              eyebrow="Curriculum"
              title={`From "what's an agent?" to "I shipped a swarm."`}
              lede="Every lesson is interactive — read a concept, then run a live agent that demonstrates it."
            />

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {highlightLessons.map((c, i) => (
                <Reveal key={c.title} delay={0.08 * i}>
                  <Link
                    to="/learn"
                    hash={c.hash}
                    className="glow-card group flex h-full flex-col rounded-xl border border-border bg-card p-6"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <c.icon className="h-5 w-5 text-primary" />
                      </div>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {c.chip}
                      </span>
                    </div>
                    <h3 className="text-lg font-semibold">{c.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {c.description}
                    </p>
                    <ul className="mt-4 space-y-1.5">
                      {c.youWillLearn.map((item) => (
                        <li
                          key={item}
                          className="flex items-start gap-2 text-xs text-muted-foreground"
                        >
                          <span className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary opacity-60 transition-opacity group-hover:opacity-100">
                      Read the full lesson <ArrowRight className="h-3 w-3" />
                    </div>
                  </Link>
                </Reveal>
              ))}
            </div>

            <div className="mt-10 text-center">
              <Link
                to="/curriculum"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                View full curriculum (8 tracks, 50+ lessons) <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </section>

        {/* New ways to learn — interactive modes */}
        <section className="border-t border-border/60 bg-muted/30 py-24">
          <div className="mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-20"
              align="center"
              eyebrow="New ways to learn"
              title="More than a curriculum"
              lede="Pick the format that fits how you learn — animated explainers, guided builds, or hands-on debugging."
            />

            <div className="space-y-20">
              {/* Interactive Presentations */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div>
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <PresentationIcon className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        9 decks
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">
                      Interactive Presentations
                    </h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Animated, click-through decks on LLMs, prompting, RAG, agentic patterns,
                      orchestration, security, observability, and inference internals.
                    </p>
                    <Link
                      to="/learn"
                      hash="presentations"
                      className="group mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary"
                    >
                      Open presentations
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  {/* Deck mock */}
                  <DeckMock />
                </div>
              </Reveal>

              {/* Build-Along Labs */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div className="lg:order-2">
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <Hammer className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        10 labs
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">Build-Along Labs</h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Step-by-step guides that build 5 standalone agents and 5 multi-agent swarms in
                      the real builder — with diagrams, exact settings, and deep links.
                    </p>
                    <Link
                      to="/learn"
                      hash="build-along"
                      className="group mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary"
                    >
                      Start building
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  <BrowserFrame url="agentswarms.fyi/playground" className="lg:order-1">
                    <img
                      src={playgroundPreview}
                      alt="The AgentSwarms playground with an agent conversation and trace inspector"
                      loading="lazy"
                      className="block w-full"
                    />
                  </BrowserFrame>
                </div>
              </Reveal>

              {/* Failure-Mode Labs */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div>
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <FlaskConical className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        4 labs
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">Failure-Mode Labs</h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Fix swarms that are deliberately broken. The platform verifies your repair —
                      the fastest way to build real intuition for what goes wrong.
                    </p>
                    <Link
                      to="/swarms"
                      className="group mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary"
                    >
                      Diagnose a swarm
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  {/* Broken swarm mock */}
                  <BrokenSwarmMock />
                </div>
              </Reveal>

              {/* Interactive Notebooks */}
              <Reveal>
                <div className="grid items-center gap-12 lg:grid-cols-2">
                  <div className="lg:order-2">
                    <div className="mb-3 flex items-center gap-3">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <NotebookIcon className="h-5 w-5 text-primary" />
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        67 notebooks
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">Interactive Notebooks</h3>
                    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                      Runnable TypeScript notebooks in your browser — foundations, advanced topics,
                      and every major framework (LangChain, LlamaIndex, OpenAI Agents SDK, Vercel AI
                      SDK, Google ADK), plus 10 reproduced failure-mode examples.
                    </p>
                    <Link
                      to="/notebooks"
                      className="group mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary"
                    >
                      Open notebooks
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  {/* Notebook mock */}
                  <NotebookMock />
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* Learning Path */}
        <section id="path" className="py-24">
          <div className="mx-auto max-w-7xl px-6">
            <SectionHeading
              className="mb-16"
              align="center"
              eyebrow="How it works"
              title="Four steps from zero to swarm"
              lede="No installs. No API keys to start. Open a demo, follow the guided prompts, then make it your own."
            />

            <div className="relative grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div className="absolute left-[12%] right-[12%] top-11 hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block" />
              {learningPath.map((s, i) => (
                <Reveal key={s.step} delay={0.08 * i}>
                  <div className="glow-card relative h-full rounded-xl border border-border bg-card p-6">
                    <div className="mb-4 flex items-center justify-between">
                      <span className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border border-primary/30 bg-primary/10 font-mono text-sm font-bold text-primary">
                        {s.step}
                      </span>
                      <s.icon className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="text-base font-semibold">{s.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                </Reveal>
              ))}
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
                    Your first agent is one click away
                  </h2>
                  <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
                    Open a template, send the suggested prompt, watch the trace stream. The whole
                    thing takes a minute.
                  </p>
                  <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                    <Link to={showAuthed ? "/dashboard" : "/login"}>
                      <Button size="lg" className="gap-2 px-10 text-base">
                        {showAuthed ? "Open the lab" : "Start the First Lesson"}{" "}
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Link to="/curriculum">
                      <Button variant="ghost" size="lg" className="px-6 text-base">
                        Peek at the curriculum
                      </Button>
                    </Link>
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
