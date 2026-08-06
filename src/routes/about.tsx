import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  Compass,
  Layers,
  Network,
  PieChart,
  ShieldCheck,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

const GITHUB_URL = "https://github.com/AgentSwarms-fyi/agentswarms";

// lucide-react no longer ships brand icons, so the GitHub mark is inlined.
function Github({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About AgentSwarms — Source-available, self-hosted agentic AI & BI" },
      {
        name: "description",
        content:
          "Why AgentSwarms exists: one source-available, self-hosted platform that unifies AI agents, multi-agent swarms and an AI-native BI suite — on your own infrastructure, with your database and your model keys. Elastic License 2.0.",
      },
      { property: "og:title", content: "About AgentSwarms" },
      {
        property: "og:description",
        content:
          "One source-available platform for agents, multi-agent swarms and AI-native BI — self-hosted, BYOK, Elastic License 2.0.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/about" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "About AgentSwarms" },
      {
        name: "twitter:description",
        content: "Source-available, self-hosted platform for agents, swarms and AI-native BI.",
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
            "One source-available, self-hosted platform that unifies AI agents, multi-agent swarms and an AI-native BI suite — on your own infrastructure, with your own model keys.",
          isPartOf: { "@type": "WebSite", name: "AgentSwarms", url: "https://agentswarms.fyi/" },
        }),
      },
    ],
  }),
  component: AboutPage,
});

const principles = [
  {
    icon: ShieldCheck,
    title: "You own the platform",
    body: "Everything runs on infrastructure you control — your database, your model keys, your budgets. No usage caps, no per-seat pricing, no black boxes. Row-level security protects every record, and provider keys are encrypted at rest.",
  },
  {
    icon: Network,
    title: "A real builder, not a toy",
    body: "A visual Agent Builder and drag-and-drop swarm canvas with tools, memory, RAG, guardrails, evals and human-approval gates — the full prototyping loop. Connect MCP servers, delegate to remote A2A agents, and export any swarm to LangGraph, CrewAI or the OpenAI Agents SDK.",
  },
  {
    icon: PieChart,
    title: "Agents and BI, unified",
    body: "The same instance that runs your agents also runs a full AI-native BI suite — dashboards, an analyst that writes and runs the SQL, scheduled refreshes with data alerts, and warehouse connectors. One data estate, one login, one stack to operate.",
  },
];

const comparisons = [
  {
    them: "Langflow · Flowise",
    they: "Mature, genuinely open-source visual builders with large communities and a big library of components. If your job is to wire up an LLM pipeline quickly and iterate on it, they are excellent at exactly that, and they have been doing it longer than we have.",
    we: "We put our effort into what happens after the graph: multi-agent swarms with human approval gates, evaluation nodes, per-node guardrails and budgets — plus a BI suite on the same instance. That is more surface area to learn, and it is only worth it if you need those things.",
  },
  {
    them: "Dify",
    they: "A polished, well-documented AI-app platform with a strong hosted offering and a large plugin ecosystem. If you want a managed service and a proven app-building workflow, it is a very solid choice.",
    we: "We optimise for running it yourself on infrastructure you already have — Docker plus a Supabase project, your own model keys, no hosted tier required — and for having dashboards and an AI analyst in the same place as the agents.",
  },
  {
    them: "A framework + a BI tool + a gateway",
    they: "LangGraph and CrewAI are powerful, well-tested libraries with far more control than any canvas; Metabase and Superset are mature BI products with years of polish. Composed yourself, this stack gives you the best tool for each job and no lock-in to our choices.",
    we: "We trade some of that depth for one system to deploy, secure and observe — agents, BI, model gateway, traces and IAM sharing one login and one permission model. When you outgrow the canvas, every swarm exports to LangGraph, CrewAI, Strands or the OpenAI Agents SDK, so this is a starting point rather than a destination.",
  },
];

const features = [
  "Visual Agent Builder + drag-and-drop multi-agent swarm canvas with routers, conditions, loops and functions",
  "RAG, tools, MCP servers, remote A2A agents, and export to LangGraph / CrewAI / the OpenAI Agents SDK",
  "AI-native BI: dashboards, an analyst that writes the SQL, 27 chart types, scheduled refresh and data alerts",
  "22 database & warehouse connectors — PostgreSQL, MySQL, Oracle, Snowflake, BigQuery, Databricks, Redshift, Synapse, Trino/Starburst, Athena, ClickHouse and more",
  "Human-in-the-loop approvals, per-user budgets with alerts, and a full trace for every model call",
  "IAM with groups & model rules, SAML SSO, and a write-only encrypted secrets vault",
  "One Docker command on any Node host, Supabase as the backend, any model provider",
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
              One open platform for agents, swarms &amp; <span className="text-primary">BI.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
              AgentSwarms unifies AI agents, multi-agent swarms and an AI-native BI suite in a
              single platform you run yourself — on your own infrastructure, with your database and
              your model keys.
            </p>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Source-available — Elastic License 2.0
            </div>
          </div>
        </section>

        {/* Mission */}
        <section className="py-20">
          <div className="mx-auto max-w-3xl px-6 text-center">
            <Target className="mx-auto h-8 w-8 text-primary" />
            <h2 className="mt-4 text-3xl font-bold tracking-tight">Why we built it</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Most teams stitch together an agent framework, a separate BI tool, a vector store, a
              model gateway and an observability stack — then rent it all from vendors with usage
              caps and per-seat pricing. We think the whole stack should be one thing you own:
              deploy it with a single command, point it at your Supabase and your model keys, and
              run agents and dashboards side by side, with full traces and nothing hidden.
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
            <div className="mt-12 grid gap-5 sm:grid-cols-3">
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
                How we fit alongside other tools
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
                These are all good projects, and several of them are more mature than we are in
                their own area. They solve different shapes of the problem — here is what each is
                strong at, and where we put our effort, so you can judge which fits your situation.
              </p>
            </div>
            <div className="mt-10 space-y-4">
              {comparisons.map((c) => (
                <div key={c.them} className="rounded-xl border border-border/60 bg-card/40 p-6">
                  <h3 className="text-base font-semibold text-primary">{c.them}</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        What they're strong at
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{c.they}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                        Where we put our effort
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
            <h2 className="text-3xl font-bold tracking-tight">Built in the open.</h2>
            <p className="mt-3 text-muted-foreground">
              AgentSwarms is source-available under the Elastic License 2.0 — read the source, run
              it yourself, modify it for your own use. Star it, open an issue, or tell us what would
              make it the platform you'd deploy for your team.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                <Button size="lg" className="gap-2">
                  <Github className="h-4 w-4" /> View on GitHub
                </Button>
              </a>
              <Link to="/contact">
                <Button variant="outline" size="lg" className="gap-2">
                  Talk to us <ArrowRight className="h-4 w-4" />
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
