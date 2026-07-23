import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Brain,
  CheckCircle2,
  Compass,
  Database,
  GraduationCap,
  LineChart,
  ListChecks,
  Map,
  MessageSquare,
  Network,
  Play,
  Rocket,
  ShieldCheck,
  Workflow,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

import { Telescope } from "lucide-react";

export const Route = createFileRoute("/curriculum")({
  head: () => ({
    meta: [
      { title: "Curriculum — AgentSwarms: 8 tracks, 50+ hands-on lessons" },
      {
        name: "description",
        content:
          "8 tracks covering Foundations, Patterns, Memory, SQL Agents, Multi-Agent Swarms, Scaling. 50+ lessons and 50+ runnable agents & swarms — free.",
      },
      { property: "og:title", content: "AgentSwarms Curriculum — Beginner to Production" },
      {
        property: "og:description",
        content:
          '8 learning tracks, 50+ lessons, 50+ runnable real-world agents & swarms. From "what is a model" to multi-agent swarms in production.',
      },
      { property: "og:url", content: "https://agentswarms.fyi/curriculum" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "AgentSwarms Curriculum" },
      {
        name: "twitter:description",
        content:
          "8 tracks, 50+ lessons, 50+ runnable agents & swarms — beginner to production. Free.",
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
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/curriculum" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Course",
          name: "AgentSwarms — Learn Agentic AI by Building It",
          description:
            "A complete, hands-on curriculum for Agentic AI: foundations, RAG, tools, guardrails, SQL agents, multi-agent swarms, scaling and enterprise patterns.",
          provider: {
            "@type": "Organization",
            name: "AgentSwarms",
            sameAs: "https://agentswarms.fyi",
          },
          educationalLevel: "Beginner to Advanced",
          isAccessibleForFree: true,
          inLanguage: "en",
          hasCourseInstance: [
            {
              "@type": "CourseInstance",
              courseMode: "Online",
              courseWorkload: "PT20H",
            },
          ],
        }),
      },
    ],
  }),
  component: CurriculumPage,
});

type Track = {
  id: string;
  number: string;
  icon: typeof MessageSquare;
  title: string;
  level: string;
  estTime: string;
  summary: string;
  hash: string;
  topics: string[];
  templates?: string[];
};

const tracks: Track[] = [
  {
    id: "track-foundations",
    number: "Track 01",
    icon: BookOpen,
    title: "Foundations of Generative & Agentic AI",
    level: "Beginner",
    estTime: "~3 hours",
    summary:
      "Start here if you've never built with LLMs. Every concept is explained twice: once like you're 10, once for the engineer in the room.",
    hash: "foundations",
    topics: [
      "What is a model? (LLM families, base vs instruct, open vs closed)",
      "Tokens, context windows, and why they cost money",
      "Prompts, system messages, and few-shot patterns",
      "Embeddings, vector search, and the retrieval mindset",
      'What makes something an "agent" vs a chatbot',
      "Glossary of every term you'll see in the wild",
    ],
    templates: ["First Prompt Lab", "Token Counter Demo"],
  },
  {
    id: "track-patterns",
    number: "Track 02",
    icon: Workflow,
    title: "Patterns, Tools & Guardrails",
    level: "Beginner → Intermediate",
    estTime: "~4 hours",
    summary:
      "The seven canonical agentic patterns — wired up live. Tool use, RAG, planner-executor, reflection, routing, parallel fan-out, and HITL approvals.",
    hash: "patterns",
    topics: [
      "Tool / function calling — the OpenAI schema in plain English",
      "Retrieval-Augmented Generation (RAG) with citations",
      "Modern RAG variants: hybrid search, contextual retrieval, agentic & multi-modal",
      "Graph RAG — entities, relations, multi-hop reasoning (Microsoft GraphRAG style)",
      "Planner → Executor pattern",
      "Reflection & self-critique loops",
      "Routing & classifier-as-controller",
      "Parallel fan-out / map-reduce agents",
      "Human-in-the-Loop approvals for risky actions",
      "Input/output guardrails: PII, prompt injection, schema validation",
    ],
    templates: [
      "Product Support Bot (RAG)",
      "Graph RAG Researcher swarm (Acme Corp demo KB)",
      "Code Reviewer (Tools + Guardrails)",
      "Approval Inbox demo",
      "Planner-Executor sandbox",
    ],
  },
  {
    id: "track-memory",
    number: "Track 03",
    icon: Brain,
    title: "Agent Memory: Short-Term & Long-Term",
    level: "Beginner → Advanced",
    estTime: "~2.5 hours",
    summary:
      "Why a chatbot forgets you and an agent doesn't. The two memory tiers (STM and LTM), how recall actually works under the hood, and how to configure both per-agent and per-swarm-node — live, on the platform.",
    hash: "memory",
    topics: [
      "The mental model: scratchpad (STM) vs notebook (LTM)",
      "Sliding window + rolling summary — how STM survives long chats",
      "Long-term memory items: facts, preferences, episodic notes, instructions",
      "Recall: keyword overlap + score + recency (and where embeddings fit later)",
      "Auto-extraction after every turn — what gets saved, what gets skipped",
      "Memory tools the agent can call: remember, recall, forget, set, get",
      "Swarm scope: share memory with the agent, isolate to one run, or none",
      "PII safety, capacity caps, and pruning low-value items",
    ],
    templates: [
      "Personal Assistant with LTM",
      "Long-Conversation Tutor (STM summarizer)",
      "Swarm with shared scratchpad",
    ],
  },
  {
    id: "track-engineering",
    number: "Track 04",
    icon: Wrench,
    title: "Engineering Rigor & Deep Mental Models",
    level: "Intermediate → Advanced",
    estTime: "~3.5 hours",
    summary:
      "The senior-engineer view of agents: state, planning, multi-agent protocols, control topology, deterministic vs emergent design, failure handling, eval at scale, and system design under latency/cost constraints. With diagrams, code, and citations to the canonical papers.",
    hash: "engineering",
    topics: [
      "The four axes: state, planning, communication, control topology",
      "Deterministic workflows vs emergent agentic loops (Anthropic's line)",
      "Failure handling: timeouts, jittered retries, circuit breakers, sagas",
      "Idempotency keys + structured-output validation with repair loop",
      "Loop detection and step / token / cost ceilings",
      "The 4-layer eval pyramid: unit → golden → trajectory → online",
      "System design under constraints: latency budgets, model cascading, caching, parallel tools",
      "Centralised vs hierarchical vs peer-to-peer vs market topologies",
    ],
    templates: [
      "Failure-handling diagrams",
      "Eval flywheel reference",
      "τ-bench / AgentBench links",
    ],
  },
  {
    id: "track-sql",
    number: "Track 05",
    icon: Database,
    title: "Text-to-SQL & Data Agents",
    level: "Intermediate",
    estTime: "~3 hours",
    summary:
      "Turn natural language into safe SQL. AST validation, table allow-listing, schema-aware prompting, and the realities of running this in production (Uber QueryGPT-style).",
    hash: "sql-agents",
    topics: [
      "Why text-to-SQL is harder than it looks",
      "Schema introspection and few-shot grounding",
      "AST parsing and validating generated SQL before execution",
      "Read-only enforcement and table allow-lists",
      "Cost & row-limit guardrails",
      "Case study: Uber QueryGPT, Snowflake Cortex Analyst",
      "Hands-on: query the SaaS sales lakehouse with English",
    ],
    templates: ["SQL Analyst Agent", "RevOps Multi-Agent Swarm"],
  },
  {
    id: "track-swarms",
    number: "Track 06",
    icon: Network,
    title: "Multi-Agent Swarms",
    level: "Intermediate → Advanced",
    estTime: "~4 hours",
    summary:
      "When one agent isn't enough. Build researcher → writer → reviewer pipelines, peer-to-peer collaboration, A2A handoffs, and shared memory across the swarm.",
    hash: "swarms",
    topics: [
      "Orchestrator vs peer-to-peer architectures",
      "Handoff messages, shared scratchpads, and turn limits",
      "A2A (Agent-to-Agent) protocol basics",
      "When to split a single agent into a swarm",
      "Per-node memory scoping (agent / swarm / none)",
      "Cost & loop-detection guardrails for swarms",
      "Visual swarm canvas — drag, wire, run",
    ],
    templates: [
      "Research → Writer → Reviewer swarm",
      "Customer Support Triage swarm",
      "RevOps SQL Analytics swarm",
    ],
  },
  {
    id: "track-scaling",
    number: "Track 07",
    icon: Rocket,
    title: "Scaling, Observability & Enterprise",
    level: "Advanced",
    estTime: "~3 hours",
    summary:
      "Production reality: traces, evals, ROI math, security, OpenAI-compatible gateways, multi-provider strategy. Real case studies from Klarna, Uber, Salesforce.",
    hash: "scaling",
    topics: [
      "Reading execution traces and debugging cost spikes",
      "Production eval ops: regression gates in CI, drift alarms, weekly failure review",
      "Token, latency & cost dashboards",
      "AI security: prompt injection, data exfiltration, PII",
      "OpenAI-compatible gateways and multi-provider routing",
      "ROI formulas and enterprise cost scenarios",
      "Maturity model: from prototype to org-wide platform",
      "Case studies: Klarna, Uber, Salesforce Agentforce, BMW",
    ],
    templates: ["Trace Inspector", "Budget Caps demo", "Multi-Provider Gateway"],
  },
  {
    id: "track-deep-dives",
    number: "Track 08",
    icon: Telescope,
    title: "Deep Dives — the production gaps most curriculums skip",
    level: "Advanced → Expert",
    estTime: "~4 hours",
    summary:
      "Five hard-won lessons from real production failures: orchestration architecture, deterministic skeletons vs probabilistic workers, MCP security (Confused Deputy + Tool Description Hijacking), Actor-Model swarms with durable state, and heterogeneous routing economics. Assumes you finished Tracks 01–07.",
    hash: "deep-dives",
    topics: [
      "Hub-and-Spoke beats both monolithic master agents AND peer-to-peer mesh",
      "Thin Agent pattern: deterministic state machine + ephemeral <150-line workers",
      "MCP attack surface: Tool Description Hijacking, Confused Deputy, Shadow AI infra",
      "Actor Model runtimes: thousands of I/O-bound agents per host with durable checkpoints",
      "Heterogeneous routing: SLM routers + frontier-LLM escalation = positive ROI",
      "Mapping AgentSwarms to the Levels-of-Autonomy framework (L1 → L5)",
    ],
    templates: [
      "Frameworks deep dive (CrewAI / LangGraph / AutoGen)",
      "Stack examples by industry",
    ],
  },
];

const stats = [
  { v: "8", label: "learning tracks" },
  { v: "50+", label: "in-depth lessons" },
  { v: "Python", label: "in-browser notebook lab" },
  { v: "50+", label: "one-click agents & swarms" },
] as const;

// Highlights for the Python Lab (/notebooks) — user-authored, in-browser
// notebooks with a built-in helper for calling connected models.
const pythonLabHighlights = [
  {
    label: "Real CPython, zero setup",
    blurb:
      "Powered by Pyodide (WebAssembly). Cells share one interpreter, top-level await works, and bundled packages like numpy and pandas load on import.",
  },
  {
    label: "Your models, from Python",
    blurb:
      "The built-in agentswarms.chat() helper calls any provider you've connected — or the instance default OpenRouter — with IAM rules and traces applied.",
  },
  {
    label: "Guided from the first cell",
    blurb:
      "Every new notebook opens with model-usage notes and runnable samples: a chat call, structured JSON output, and a pure-Python experiment.",
  },
] as const;

const upcoming = [
  {
    icon: Database,
    title: "Vector recall for memory",
    when: "next",
    body: "Upgrade Long-Term Memory from keyword overlap to embeddings — semantic recall, hybrid search, and when each one wins.",
  },
  {
    icon: Map,
    title: "Build-along projects",
    when: "soon",
    body: "Multi-day guided projects: ship a customer-support agent, an internal data analyst, and a full RevOps swarm — end-to-end with case-study writeups.",
  },
  {
    icon: ShieldCheck,
    title: "Red-team playbook for agents",
    when: "soon",
    body: "Hands-on adversarial labs: jailbreaks, tool-chain hijacks, indirect prompt injection via RAG, and how to write the eval that catches each one.",
  },
  {
    icon: LineChart,
    title: "FinOps for agentic systems",
    when: "soon",
    body: "Per-tenant chargeback, model cascading economics, prompt caching ROI, and budget caps that actually hold under load.",
  },
] as const;

// ──────────────────────────────────────────────────────────────────
// One-click runnables — every swarm + standalone agent shipped today.
// Kept in sync with src/lib/swarmTemplates.ts and src/lib/realTemplates.ts.
// ──────────────────────────────────────────────────────────────────
type Runnable = { name: string; tagline: string };
type RunnableGroup = { category: string; swarms: Runnable[]; agents: Runnable[] };

const runnableGroups: RunnableGroup[] = [
  {
    category: "Customer Support",
    swarms: [
      {
        name: "Customer Support Triage",
        tagline: "Classifier → Responder → QA reviewer with human approval",
      },
      {
        name: "LLM-as-a-Judge — Support QA",
        tagline: "Tone + Policy + Technical sub-judges → Chief Magistrate scorecard",
      },
    ],
    agents: [
      {
        name: "Product Support Assistant",
        tagline: "Grounded RAG over a real help-center KB, with citations & refusals",
      },
      {
        name: "Support Ticket Triage Agent",
        tagline: "Auto-tags category + priority for incoming tickets",
      },
      {
        name: "SLA Breach Detector",
        tagline: "Calculates ticket age against SLA and flags every breach",
      },
    ],
  },
  {
    category: "Sales & RevOps",
    swarms: [
      {
        name: "Sales Lead Enrichment",
        tagline: "Intake → Enricher → Scorer → Email drafter (approval-gated)",
      },
      {
        name: "SaaS RevOps — Multi-Agent SQL Analyst",
        tagline:
          "VP prompt → SQL Planner → Local DB → RevOps Analyst → Strategic Synthesizer → Deal Desk",
      },
    ],
    agents: [
      {
        name: "Sales Outreach Drafter",
        tagline: "Personalized outbound drafts — humans approve before sending",
      },
      {
        name: "CRM Data Cleanser",
        tagline: "Coerces messy text into strict JSON for HubSpot / Salesforce ingestion",
      },
    ],
  },
  {
    category: "Research & Knowledge",
    swarms: [
      {
        name: "Research → Report Writer",
        tagline: "Planner → Researcher → Synthesizer → Editor pipeline",
      },
      {
        name: "Graph RAG Researcher",
        tagline: "Graph search → Document RAG → Synthesizer for multi-hop questions",
      },
      {
        name: "gRED-style Drug Discovery Research",
        tagline: "Planner → Literature + Assay + Internal-data → Reconciliation → Hypothesis memo",
      },
    ],
    agents: [
      {
        name: "Research Q&A on AI Papers",
        tagline: "Cited answers over a curated library of foundational AI papers",
      },
      {
        name: "Long-Context Document Analyst",
        tagline: "Claude-powered summarizer for contracts & long transcripts",
      },
      {
        name: "Graph RAG Explorer (Acme Corp)",
        tagline: "Multi-hop questions over a pre-built entity-relation knowledge graph",
      },
    ],
  },
  {
    category: "Engineering & Quality",
    swarms: [
      {
        name: "Code Review Pipeline",
        tagline: "Static summarizer → Security + Style reviewers → Merged comment",
      },
      {
        name: "RAG Evaluation Harness — LLM as a Judge",
        tagline: "Two candidates → GPT-5 judge → structured rubric scorecard",
      },
      {
        name: "Content Moderation QA with Evaluate Node",
        tagline: "Toxicity + Misinfo + Policy → Moderator → quality-gate Evaluate node",
      },
    ],
    agents: [
      {
        name: "Code Review Assistant",
        tagline: "Reviews a pasted diff for bugs, style and security issues",
      },
      {
        name: "Python Traceback Fixer",
        tagline: "Reads a Python error log and writes the exact fix",
      },
      {
        name: "Regex Generator",
        tagline: "Translates plain English into ready-to-use regular expressions",
      },
      {
        name: "SQL Dialect Translator",
        tagline: "Converts queries between MySQL, Postgres, SQL Server, and SQLite",
      },
    ],
  },
  {
    category: "Failure-pattern labs (debugging)",
    swarms: [
      {
        name: "Infinite Tool Loop",
        tagline: "Watch an agent burn tokens calling the same tool forever — then see the fix",
      },
      {
        name: "JSON Wrapper Crash",
        tagline: 'An LLM adds "Sure! Here\'s the JSON:" — the next agent throws SyntaxError',
      },
      {
        name: "Context Window Collapse",
        tagline: "Three workers dump 40 pages into one Synthesizer — watch it forget the question",
      },
    ],
    agents: [],
  },
  {
    category: "Financial Services",
    swarms: [
      {
        name: "Earnings Call Analyst Desk",
        tagline: "Numbers + Tone + Risk → Compliance check → Analyst memo",
      },
      {
        name: "Stock Investment — CIO Swarm",
        tagline: "Fundamental + News + Quant + Risk → CIO investment memo",
      },
      {
        name: "Responsible AI Guardrails (Banking)",
        tagline: "PII Redactor → Safety Classifier → Guardrailed Responder ⊕ Refusal → Audit Log",
      },
      {
        name: "Financial Variance — ERP + RAG",
        tagline: "Orchestrator → ERP Data + RAG Doc Agent → FP&A Synthesizer",
      },
    ],
    agents: [],
  },
  {
    category: "Healthcare & Life Sciences",
    swarms: [
      {
        name: "Clinical Intake & Prior-Authorization",
        tagline:
          "Symptom intake → Triage → Differential → Coding → Prior-auth → Clinician approval",
      },
      {
        name: "Agentic RAG — Drug Safety Investigation",
        tagline: "Router → parallel KB + Graph + SQL retrievers → Self-Eval loop → Synthesizer",
      },
    ],
    agents: [],
  },
  {
    category: "Legal, HR & Operations",
    swarms: [
      {
        name: "Contract Redline & Risk Review",
        tagline:
          "Clause splitter → parallel risk / definitions / jurisdiction reviewers → Partner approval",
      },
      {
        name: "Frontline Hiring Orchestrator",
        tagline: "Manager → Sourcing + Screener + Scheduler + Onboarding → Recruiter approval",
      },
      {
        name: "Disaster Response — Crisis Triage at Scale",
        tagline: "Intake classifier → Severity scorer → Resource matcher → Field-team router",
      },
    ],
    agents: [
      {
        name: "Meeting Action-Item Extractor",
        tagline: "Pulls assigned tasks and deadlines out of long meeting transcripts",
      },
    ],
  },
  {
    category: "Industry verticals",
    swarms: [
      {
        name: "Auto-Claims FNOL Triage (Insurance)",
        tagline: "Intake → Coverage Check (RAG) → Fraud Signals (SQL) → Reserve & Routing",
      },
      {
        name: "Manufacturing — Quality NCR Root-Cause",
        tagline: "Defect intake → Spec lookup → History query → 5-Whys → CAPA draft",
      },
      {
        name: "SOC Alert Triage (Cybersecurity)",
        tagline: "Alert intake → ATT&CK enrichment → SQL correlation → Containment proposal",
      },
      {
        name: "Retail Returns & Reverse-Logistics",
        tagline: "Return intake → Policy RAG → Customer-history SQL → Disposition decision",
      },
      {
        name: "Adaptive Socratic Tutor + Auto-Grader (Education)",
        tagline: "Diagnose misconception → Curriculum RAG → Socratic hint → Grader",
      },
    ],
    agents: [],
  },
  {
    category: "Marketing, Web & Content",
    swarms: [
      {
        name: "Autonomous Localization & Compliance",
        tagline: "Creative Director → parallel Copywriter + Designer → Compliance loop",
      },
      {
        name: "Autonomous Ad Campaign Engine",
        tagline: "Brief + reference photo → parallel copy & image gen → vision QA → approved ad",
      },
    ],
    agents: [
      {
        name: "Landing Page Roaster",
        tagline: "Critiques marketing copy against direct-response copywriting frameworks",
      },
      {
        name: "SEO Meta-Tag Generator",
        tagline: "SEO titles + meta descriptions within strict character limits",
      },
      {
        name: "Brand Voice Translator",
        tagline: "Rewrites copy in any persona, from Gen-Z to Victorian novelist",
      },
      {
        name: "Firecrawl Web Summarizer",
        tagline: "Scrapes a live URL and answers a precise question about its content",
      },
      {
        name: "Competitor Feature Tracker",
        tagline: "Scrapes a changelog and surfaces the updates you care about",
      },
      {
        name: "GitHub Repo Explainer",
        tagline: "Reads a public README and explains it for a non-technical audience",
      },
      {
        name: "Invoice Parser",
        tagline: "Extracts vendor, totals, tax and due dates from pasted invoice text",
      },
    ],
  },
];

function CurriculumPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main id="main-content">
        {/* Hero */}
        <section className="border-b border-border/60 bg-muted/20">
          <div className="mx-auto max-w-4xl px-6 py-20 text-center sm:py-24">
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
              Full curriculum
            </p>
            <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
              Beginner to production, <span className="text-primary">one curriculum.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
              Eight tracks. 50+ in-depth lessons. 50+ runnable real-world agents &amp; swarms. Every
              concept is paired with a live demo you can fork in one click. All free.
            </p>

            <dl className="mx-auto mt-10 grid max-w-2xl grid-cols-2 gap-4 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-card p-4">
                  <dt className="text-2xl font-extrabold text-foreground">{s.v}</dt>
                  <dd className="mt-1 text-xs text-muted-foreground">{s.label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Tracks */}
        <section className="py-16">
          <div className="mx-auto max-w-6xl px-6">
            <div className="mb-12 text-center">
              <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                Learning tracks
              </p>
              <h2 className="text-3xl font-bold tracking-tight">A clear path, in order</h2>
              <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
                Start at Track 01 if you're new. Skip ahead if you've shipped with LLMs before —
                every track stands on its own.
              </p>
            </div>

            {/* Field manuals callout */}
            <div className="mb-10 rounded-2xl border-l-4 border-l-primary border-y border-r border-border bg-card p-6">
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                Field manuals · Senior depth
              </p>
              <h3 className="text-lg font-bold tracking-tight">
                Five field manuals turn this curriculum into a senior-engineer reference.
              </h3>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                At the end of <strong>Foundations</strong>, <strong>Engineering Rigor</strong>,{" "}
                <strong>SQL &amp; BI Agents</strong>, <strong>Production &amp; Business</strong>,
                and <strong>RAG &amp; Frameworks</strong>, long-form field manuals go one level
                below the chapter — tokenization economics, KV-cache math, schema-linking failure
                modes, EU AI Act obligations, Reciprocal Rank Fusion, embedding lifecycle, framework
                lock-in — with worked numerical examples and primary-source citations. If you only
                have time for one pass, the manuals are the difference between knowing the words and
                knowing the system.
              </p>
            </div>

            <ol className="space-y-5">
              {tracks.map((t) => (
                <li
                  key={t.id}
                  className="grid gap-5 rounded-xl border border-border bg-card p-6 sm:grid-cols-[200px_1fr]"
                >
                  <div>
                    <div className="inline-flex items-center gap-2">
                      <div className="inline-flex rounded-lg bg-primary/10 p-2">
                        <t.icon className="h-5 w-5 text-primary" />
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {t.number}
                      </span>
                    </div>
                    <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-primary">
                      {t.level}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{t.estTime}</p>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold">{t.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {t.summary}
                    </p>

                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          What's inside
                        </p>
                        <ul className="mt-2 space-y-1.5">
                          {t.topics.map((topic) => (
                            <li
                              key={topic}
                              className="flex items-start gap-2 text-sm text-muted-foreground"
                            >
                              <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                              <span>{topic}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      {t.templates && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Live templates included
                          </p>
                          <ul className="mt-2 space-y-1.5">
                            {t.templates.map((tp) => (
                              <li
                                key={tp}
                                className="flex items-start gap-2 text-sm text-muted-foreground"
                              >
                                <Play className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                                <span>{tp}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    <div className="mt-5">
                      <Link to="/learn" hash={t.hash}>
                        <Button variant="outline" size="sm" className="gap-1.5">
                          Open this track <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ════════ Python Lab — your own in-browser notebooks ════════ */}
        <section id="notebooks" className="border-t border-border/60 bg-background py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="text-center">
              <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                Developer workspace
              </p>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Your own notebook lab,{" "}
                <span className="text-primary">in your browser — no setup</span>
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
                Create Python notebooks to experiment with code and frameworks. Every notebook is a
                real Jupyter-style workspace with editable cells and live execution — and a built-in
                helper for calling models through your connected providers.
              </p>
            </div>

            <div className="mt-12 grid gap-4 sm:grid-cols-3">
              {pythonLabHighlights.map((h) => (
                <div
                  key={h.label}
                  className="rounded-xl border border-border bg-card p-5 transition hover:border-primary/60 hover:shadow-md"
                >
                  <h3 className="text-base font-bold">{h.label}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{h.blurb}</p>
                </div>
              ))}
            </div>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link to="/notebooks">
                <Button size="lg" className="gap-1.5">
                  Open the Developer workspace <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link to="/learn">
                <Button size="lg" variant="outline">
                  See the full curriculum
                </Button>
              </Link>
            </div>

            <p className="mt-6 text-center text-xs text-muted-foreground">
              Real CPython · real model calls · editable cells · no install
            </p>
          </div>
        </section>

        {/* ════════ One-click runnables — real swarms & agents ════════ */}
        <section id="runnables" className="border-t border-border/60 bg-muted/30 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="text-center">
              <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                One-click runnables
              </p>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Don't just read about multi-agent systems —{" "}
                <span className="text-primary">run real ones</span>
              </h2>
              <p className="mx-auto mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Every track ships with production-shaped agents and swarms you can launch in a
                single click — wired with knowledge bases, SQL tools, RAG retrievers, guardrails,
                approval gates and observable traces. Open the canvas, fire the suggested prompt,
                watch each node light up in real time, then fork it and break it.
              </p>
              <div className="mx-auto mt-6 grid max-w-3xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
                {[
                  { k: "Live canvas", v: "See every handoff, tool call & token as it streams" },
                  { k: "Real KBs", v: "Pre-seeded help-center, research & ERP corpora" },
                  { k: "HITL approvals", v: "Risky actions pause for a human, just like prod" },
                  { k: "Fork & remix", v: "Edit the system prompt, swap models, re-run" },
                ].map((f) => (
                  <div key={f.k} className="rounded-lg border border-border bg-card p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      {f.k}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{f.v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                <Link to="/swarms">
                  <Button size="lg" className="gap-2">
                    <Network className="h-4 w-4" /> Browse all swarms
                  </Button>
                </Link>
                <Link to="/templates">
                  <Button size="lg" variant="outline" className="gap-2">
                    <Bot className="h-4 w-4" /> Browse standalone agents
                  </Button>
                </Link>
              </div>
            </div>

            <div className="mt-12 space-y-6">
              {runnableGroups.map((g) => (
                <div key={g.category} className="rounded-2xl border border-border bg-card p-6">
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <h3 className="text-lg font-bold tracking-tight">{g.category}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      {g.swarms.length} swarm{g.swarms.length === 1 ? "" : "s"}
                      {g.agents.length > 0 &&
                        ` · ${g.agents.length} agent${g.agents.length === 1 ? "" : "s"}`}
                    </span>
                  </div>

                  <div className={`grid gap-5 ${g.agents.length > 0 ? "lg:grid-cols-2" : ""}`}>
                    {g.swarms.length > 0 && (
                      <div>
                        <p className="mb-3 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          <Network className="h-3 w-3" /> Multi-agent swarms
                        </p>
                        <ul className="space-y-2">
                          {g.swarms.map((s) => (
                            <li
                              key={s.name}
                              className="rounded-lg border border-border bg-muted/30 p-3"
                            >
                              <p className="text-sm font-semibold text-foreground">{s.name}</p>
                              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                {s.tagline}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {g.agents.length > 0 && (
                      <div>
                        <p className="mb-3 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          <Bot className="h-3 w-3" /> Standalone agents
                        </p>
                        <ul className="space-y-2">
                          {g.agents.map((a) => (
                            <li
                              key={a.name}
                              className="rounded-lg border border-border bg-muted/30 p-3"
                            >
                              <p className="text-sm font-semibold text-foreground">{a.name}</p>
                              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                {a.tagline}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-10 rounded-2xl border-l-4 border-l-primary border-y border-r border-border bg-card p-6 text-center">
              <p className="text-sm leading-relaxed text-muted-foreground">
                <strong className="text-foreground">Why this matters for learning:</strong> Agentic
                AI is a systems discipline — handoffs, loops, retries, guardrails, traces. You can't
                internalize that from prose. Every swarm above is the lesson made tangible: the
                moment you watch the QA reviewer reject the responder's draft and trigger a retry,
                or see the Evaluate node fail-close on a toxic generation, the theory clicks. Each
                runnable is the laboratory for the chapter that introduced it.
              </p>
            </div>
          </div>
        </section>

        {/* Memory deep-dive — beginner + advanced explainer */}
        <section id="memory-deep-dive" className="border-t border-border/60 py-20">
          <div className="mx-auto max-w-5xl px-6">
            <div className="text-center">
              <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                Spotlight · Agent Memory
              </p>
              <h2 className="text-3xl font-bold tracking-tight">
                Why a chatbot forgets you — and an agent doesn't
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
                Memory is the single biggest leap from "stateless chatbot" to "real assistant."
                Here's the same concept explained two ways — once for beginners, once for engineers
                — with everything you can actually configure on AgentSwarms today.
              </p>
            </div>

            {/* Two-column explainer */}
            <div className="mt-10 grid gap-5 lg:grid-cols-2">
              {/* Beginner */}
              <div className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg bg-primary/10 p-2">
                    <BookOpen className="h-4 w-4 text-primary" />
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                    For beginners
                  </span>
                </div>
                <h3 className="mt-3 text-xl font-bold">Think of it like a person at a desk</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  An LLM has no memory by itself — every request starts from scratch. AgentSwarms
                  gives every agent two memory aids:
                </p>
                <ul className="mt-4 space-y-3 text-sm">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold text-foreground">
                        Short-Term Memory (STM) — the scratchpad
                      </p>
                      <p className="text-muted-foreground">
                        Whatever was said recently in this chat. When the chat gets too long, older
                        parts get squeezed into a one-paragraph summary so the agent never "forgets"
                        the earlier topic.
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold text-foreground">
                        Long-Term Memory (LTM) — the notebook
                      </p>
                      <p className="text-muted-foreground">
                        Durable notes the agent jots down across <em>every</em> conversation — your
                        name, what you're working on, your preferences. Next week, in a brand-new
                        chat, it still remembers.
                      </p>
                    </div>
                  </li>
                </ul>
                <p className="mt-4 rounded-md border border-border/50 bg-background/50 p-3 text-xs text-muted-foreground">
                  <strong className="text-foreground">In one sentence:</strong> STM is "what we just
                  talked about," LTM is "what I know about you."
                </p>
              </div>

              {/* Advanced */}
              <div className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg bg-primary/10 p-2">
                    <Wrench className="h-4 w-4 text-primary" />
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                    For engineers
                  </span>
                </div>
                <h3 className="mt-3 text-xl font-bold">How it actually works under the hood</h3>
                <ul className="mt-4 space-y-3 text-sm">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold text-foreground">
                        STM = sliding window + rolling summary
                      </p>
                      <p className="text-muted-foreground">
                        Last <code className="font-mono text-[11px]">N</code> messages (default 20)
                        are sent verbatim. Anything older is folded into a running summary stored on
                        <code className="font-mono text-[11px]"> conversation_memory.summary</code>
                        and prepended as a system block on every turn.
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold text-foreground">
                        LTM = typed memory items + scored recall
                      </p>
                      <p className="text-muted-foreground">
                        Items are <code className="font-mono text-[11px]">fact</code> /
                        <code className="font-mono text-[11px]"> preference</code> /
                        <code className="font-mono text-[11px]"> episodic</code> /
                        <code className="font-mono text-[11px]"> instruction</code>. Recall ranks by
                        keyword overlap (GIN index) + stored score + recency, top-K injected as a
                        "What you remember about this user" block. Pluggable to embeddings later.
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold text-foreground">
                        Auto-extraction with PII filter
                      </p>
                      <p className="text-muted-foreground">
                        After each assistant turn, a structured-output pass proposes durable items.
                        Anything matching redaction placeholders (
                        <code className="font-mono text-[11px]">[EMAIL]</code>,
                        <code className="font-mono text-[11px]">[PHONE]</code>, …) is dropped before
                        storage.
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold text-foreground">Agent-callable tools</p>
                      <p className="text-muted-foreground">
                        <code className="font-mono text-[11px]">memory_remember</code>,
                        <code className="font-mono text-[11px]"> memory_recall</code>,
                        <code className="font-mono text-[11px]"> memory_forget</code>, plus{" "}
                        <code className="font-mono text-[11px]">memory_set</code> /
                        <code className="font-mono text-[11px]"> memory_get</code> for a
                        per-conversation JSON scratchpad shared across swarm nodes.
                      </p>
                    </div>
                  </li>
                </ul>
              </div>
            </div>

            {/* Three pillars */}
            <div className="mt-6 grid gap-5 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                  Per-agent
                </p>
                <h4 className="mt-2 text-base font-semibold">Memory tab in Agent Builder</h4>
                <p className="mt-2 text-sm text-muted-foreground">
                  Toggle STM/LTM, set the window size, top-K recall, max items, and inspect or
                  delete remembered facts — all without code.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                  Per-swarm-node
                </p>
                <h4 className="mt-2 text-base font-semibold">Three LTM scopes</h4>
                <p className="mt-2 text-sm text-muted-foreground">
                  <strong>agent</strong> shares with the agent's normal sessions.{" "}
                  <strong>swarm</strong> isolates to one run (uses{" "}
                  <code className="font-mono text-[11px]">swarm_run_id</code> as the key).{" "}
                  <strong>none</strong> turns LTM off entirely for that node.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                  Observable
                </p>
                <h4 className="mt-2 text-base font-semibold">Recall chip in chat</h4>
                <p className="mt-2 text-sm text-muted-foreground">
                  Every assistant message shows how many LTM items were recalled (and a preview), so
                  you can see exactly what the agent "remembered" — no guessing.
                </p>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link to="/learn" hash="memory">
                <Button size="sm" className="gap-1.5">
                  Open the Memory track <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
              <Link to="/agents">
                <Button variant="outline" size="sm">
                  Configure memory on an agent
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Deep Dives — short pointer (full lessons live in /learn) */}
        <section id="deep-dives" className="border-t border-border/40 py-16">
          <div className="mx-auto max-w-4xl px-6 text-center">
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
              Track 08 · Deep Dives
            </p>
            <h2 className="text-3xl font-bold tracking-tight">
              The five production gaps most curriculums skip
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
              Orchestration architecture, deterministic skeletons, MCP security, Actor-Model swarms,
              and heterogeneous routing economics. Full lessons — including the L1→L5 autonomy
              mapping — live in the Deep Dives chapter inside the lessons.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link to="/learn" hash="autonomy-levels">
                <Button size="sm" className="gap-1.5">
                  Open the Deep Dives chapter <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* ════════ After the curriculum — Production Roadmap teaser ════════ */}
        <section className="border-t border-border/40 py-20">
          <div className="mx-auto max-w-5xl px-6">
            <div className="text-center">
              <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                After you finish
              </p>
              <h2 className="text-3xl font-bold tracking-tight">
                Then comes the real fun: shipping it to production
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
                Finishing the curriculum gets you to a working agent. The next 12 months are about
                turning that into a system real users depend on. We mapped the whole journey — for
                builders <em>and</em> for the leaders who fund them.
              </p>
            </div>

            <div className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  n: "01",
                  t: "Pick a real pilot",
                  b: "Narrow scope, measurable success, low blast-radius.",
                  icon: Compass,
                },
                {
                  n: "02",
                  t: "Build evals first",
                  b: "50+ case golden set wired into CI before you scale.",
                  icon: LineChart,
                },
                {
                  n: "03",
                  t: "Harden it",
                  b: "OWASP LLM Top 10, guardrails, HITL on dangerous tools.",
                  icon: ShieldCheck,
                },
                {
                  n: "04",
                  t: "Observe everything",
                  b: "Traces, cost, drift, weekly failure review.",
                  icon: Brain,
                },
                {
                  n: "05",
                  t: "Choose where it runs",
                  b: "Bedrock, Azure AI Foundry, Vertex, AgentKit, edge — pick on data + skills, not hype.",
                  icon: Network,
                },
                {
                  n: "06",
                  t: "Operate it",
                  b: "On-call, change management, model deprecations every 6–12 months.",
                  icon: Workflow,
                },
                {
                  n: "07",
                  t: "Scale across the org",
                  b: "Platform team, FinOps chargeback, AI policy, regulatory mapping.",
                  icon: GraduationCap,
                },
                {
                  n: "★",
                  t: "Persona checklists",
                  b: "30 / 90 / 365-day plans for both Builders and Leaders.",
                  icon: ListChecks,
                },
              ].map((p) => (
                <div key={p.n} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center justify-between">
                    <div className="inline-flex rounded-lg bg-primary/10 p-2">
                      <p.icon className="h-4 w-4 text-primary" />
                    </div>
                    <span className="text-xs font-bold text-primary/60">{p.n}</span>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold">{p.t}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.b}</p>
                </div>
              ))}
            </div>

            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/learn" hash="roadmap">
                <Button size="lg" className="gap-2 px-8">
                  Open the production roadmap <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link to="/learn" hash="roadmap-personas">
                <Button variant="outline" size="lg">
                  Pick your persona track
                </Button>
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-border/40 bg-card/20 py-20">
          <div className="mx-auto max-w-5xl px-6">
            <div className="text-center">
              <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                What's coming
              </p>
              <h2 className="text-3xl font-bold tracking-tight">The curriculum keeps growing</h2>
              <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
                We're adding new tracks every few weeks. Here's what's on deck — vote with your
                feedback on the contact page.
              </p>
            </div>

            <div className="mt-10 grid gap-5 sm:grid-cols-2">
              {upcoming.map((u) => (
                <div key={u.title} className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-center justify-between">
                    <div className="inline-flex rounded-lg bg-primary/10 p-2">
                      <u.icon className="h-5 w-5 text-primary" />
                    </div>
                    <span className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                      {u.when}
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold">{u.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{u.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20">
          <div className="mx-auto max-w-2xl px-6 text-center">
            <GraduationCap className="mx-auto h-8 w-8 text-primary" />
            <h2 className="mt-4 text-3xl font-bold tracking-tight">Ready to start Track 01?</h2>
            <p className="mt-3 text-muted-foreground">
              Sign up free, no credit card. The whole curriculum is yours.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/login">
                <Button size="lg" className="gap-2 px-8">
                  Start Learning Free <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link to="/learn">
                <Button variant="outline" size="lg">
                  Open the curriculum
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
