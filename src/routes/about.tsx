import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  Brain,
  CheckCircle2,
  Compass,
  GraduationCap,
  Layers,
  Network,
  ShieldCheck,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About AgentSwarms — Learning-first Agentic AI platform" },
      {
        name: "description",
        content:
          "Why AgentSwarms exists and how it differs from Langflow, Dify, and Flowise. An education-first playground for agents and multi-agent swarms.",
      },
      { property: "og:title", content: "About AgentSwarms" },
      {
        property: "og:description",
        content:
          "A learning-first interactive platform for Agentic AI — guided lessons, runnable templates, real case studies.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/about" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "About AgentSwarms" },
      {
        name: "twitter:description",
        content: "A learning-first interactive platform for Agentic AI.",
      },
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
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/about" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "AboutPage",
          name: "About AgentSwarms",
          url: "https://agentswarms.fyi/about",
          description:
            "Why AgentSwarms exists and how it differs from Langflow, Dify, and Flowise — an education-first playground for agents and multi-agent swarms.",
          isPartOf: { "@type": "WebSite", name: "AgentSwarms", url: "https://agentswarms.fyi/" },
        }),
      },
    ],
  }),
  component: AboutPage,
});

const principles = [
  {
    icon: GraduationCap,
    title: "Learning is the product",
    body: "Most agent builders ship a canvas and call it a day. We start from the lesson — every node, every template, every tour exists to teach a concept that maps to real production systems.",
  },
  {
    icon: BookOpen,
    title: "Concepts, then clicks",
    body: "You read a one-page explainer, then run the exact pattern live: RAG, tool use, planner-executor, HITL, multi-agent swarms, text-to-SQL. No copy-pasting from random tutorials.",
  },
  {
    icon: ShieldCheck,
    title: "Production realism, not toy demos",
    body: "Approvals, budgets, traces, RLS-protected SQL agents, table allow-lists. The platform mirrors patterns used inside Uber QueryGPT, Snowflake Cortex, Salesforce Agentforce.",
  },
];

const comparisons = [
  {
    them: "Langflow / Flowise",
    they: "Visual LangChain pipeline builders. Powerful, but assume you already know what RAG, planners, and tool use are.",
    we: "We teach those concepts first with guided lessons, then let you build them — so the visual canvas actually makes sense.",
  },
  {
    them: "Dify",
    they: "Production AI app platform with strong RAG and team workflows. Dense and operationally focused.",
    we: "We optimize for understanding: every template ships with a step-by-step tour, glossary entry, and case study.",
  },
  {
    them: "Closed courses (Udacity, Coursera)",
    they: "Linear video lessons with sandboxed code. Great theory; weak hands-on environments.",
    we: "Lessons are wired into a real, multi-provider playground. You read, click, run, and remix in one place.",
  },
];

const features = [
  "8 learning tracks from prompts to multi-agent swarms, plus an in-browser Python notebook lab",
  "Runnable templates: RAG bot, SQL analyst, RevOps swarm, planner-executor",
  "Multi-provider model gateway: OpenAI, Anthropic, Gemini, Bedrock, Azure, OCI, Qwen, Grok",
  "Built-in HITL approvals inbox + per-agent budget caps",
  "Text-to-SQL agents with AST validation and table allow-listing",
  "Trace inspector with token, latency, and cost per call",
  "0 setup to start (Learn Mode) — bring your own API keys when you scale (Build Mode)",
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <main id="main-content">
        {/* Hero */}
        <section className="border-b border-border/40 bg-card/20">
          <div className="mx-auto max-w-4xl px-6 py-20 text-center sm:py-28">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Compass className="h-3.5 w-3.5" /> About
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
              We're building the school for <span className="text-primary">Agentic AI.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
              AgentSwarms is an interactive, education-first platform for anyone who wants to
              actually understand — and ship — agents, tools, guardrails, and multi-agent swarms.
            </p>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Free and open source — MIT licensed
            </div>
          </div>
        </section>

        {/* Mission */}
        <section className="py-20">
          <div className="mx-auto max-w-3xl px-6 text-center">
            <Target className="mx-auto h-8 w-8 text-primary" />
            <h2 className="mt-4 text-3xl font-bold tracking-tight">Our mission</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Most people learning Agentic AI today read scattered blog posts, watch YouTube demos,
              then get stuck the moment they try to build something real. We're closing that gap
              with a single, guided, hands-on environment where every concept comes paired with a
              runnable example you can fork and remix.
            </p>
          </div>
        </section>

        {/* Principles */}
        <section className="border-t border-border/40 bg-card/20 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="text-center">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <Layers className="h-3.5 w-3.5" /> Principles
              </div>
              <h2 className="text-3xl font-bold tracking-tight">
                What makes AgentSwarms different
              </h2>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2">
              {principles.map((p) => (
                <div
                  key={p.title}
                  className="rounded-xl border border-border/50 bg-card/60 p-6 backdrop-blur-sm"
                >
                  <div className="inline-flex rounded-lg bg-primary/10 p-2">
                    <p.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="mt-3 text-lg font-semibold">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Comparison */}
        <section className="py-20">
          <div className="mx-auto max-w-5xl px-6">
            <div className="text-center">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <Brain className="h-3.5 w-3.5" /> Where we fit
              </div>
              <h2 className="text-3xl font-bold tracking-tight">
                How we compare to Langflow, Dify, and the rest
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
                Those are great tools. We're not trying to replace them — we're the layer that gets
                you ready to use them.
              </p>
            </div>
            <div className="mt-10 space-y-4">
              {comparisons.map((c) => (
                <div key={c.them} className="rounded-xl border border-border/60 bg-card/40 p-6">
                  <h3 className="text-base font-semibold text-primary">vs {c.them}</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Them
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{c.they}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                        AgentSwarms
                      </p>
                      <p className="mt-1 text-sm text-foreground">{c.we}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-t border-border/40 bg-card/20 py-20">
          <div className="mx-auto max-w-4xl px-6">
            <div className="text-center">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <Network className="h-3.5 w-3.5" /> What's inside
              </div>
              <h2 className="text-3xl font-bold tracking-tight">Everything ships in one place</h2>
            </div>
            <ul className="mx-auto mt-10 grid max-w-3xl gap-3 sm:grid-cols-2">
              {features.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-3 rounded-lg border border-border/40 bg-card/40 p-4 text-sm"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20">
          <div className="mx-auto max-w-2xl px-6 text-center">
            <h2 className="text-3xl font-bold tracking-tight">Want to help shape what we build?</h2>
            <p className="mt-3 text-muted-foreground">
              We're early. Tell us what's missing, what's confusing, what would make this the
              platform you'd recommend to a friend.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/contact">
                <Button size="lg" className="gap-2">
                  Talk to us <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link to="/login">
                <Button variant="outline" size="lg">
                  Try it free
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
