// Curriculum module: "Scaling Agentic AI in the Enterprise"
//
// Goal: explain — to a beginner AND a senior engineer — that building an agent
// is one job, and running thousands of them reliably for paying customers is a
// completely different job. We cover the pillars where scale shows up,
// resiliency / HA, real case studies with public links, and best practices.
import type { LucideIcon } from "lucide-react";
import {
  Activity, AlertTriangle, BarChart3, Boxes, Building2, Cloud, Cpu,
  DollarSign, Gauge, Layers, Network, Rocket, Scale, Shield, ShieldCheck,
  Sparkles, Workflow, Zap,
} from "lucide-react";

/* ───────────────────────── Intro card ───────────────────────── */

export const scalingIntro = {
  child:
    "Imagine you bake one cookie at home — easy. Now imagine 10,000 people order a cookie at the same time, every cookie has to be perfect, you can't run out of flour, the oven can't break, and someone is timing how long each cookie takes. That's the difference between building an AI agent for yourself and running it for a whole company. Same recipe — but you need many ovens, backup ovens, a way to know if any oven is misbehaving, and a manager making sure no single customer eats all the dough.",
  engineer:
    "A prototype agent is a single inference loop on a happy path. A production agent is a distributed system with the same hard problems as any SaaS — capacity planning, multi-tenancy, isolation, observability, cost governance, graceful degradation, blast-radius control — PLUS new ones unique to LLMs: non-determinism, prompt-injection, runaway tool-calls, model drift, provider outages, token-economics, and evaluation at scale. Scaling means designing for the 99th percentile, the bad day, the noisy neighbor, and the auditor — not the demo.",
  whyEveryoneShouldCare: [
    "A demo that works once isn't a product — users notice flakiness instantly with chat UIs.",
    "Cost grows non-linearly: a single buggy loop can spend $10k overnight if you have no caps.",
    "Trust collapses fast — one hallucinated email to a customer can undo months of adoption.",
    "Regulators (EU AI Act, NIST AI RMF, ISO 42001) now require evidence of how your agent behaves under load and failure.",
  ],
};

/* ───────────────────────── Scaling pillars ───────────────────────── */

export type ScalingPillar = {
  id: string;
  number: string;
  icon: LucideIcon;
  title: string;
  child: string;
  engineer: string;
  whatToDo: string[];
  signals: string[]; // metrics / SLOs to watch
};

export const scalingPillars: ScalingPillar[] = [
  {
    id: "traffic-concurrency",
    number: "P1",
    icon: Gauge,
    title: "Traffic & concurrency",
    child:
      "If 10 people use your agent it's fine. If 10,000 do at the same time, the system can get overwhelmed — like a single cashier at a packed store. You need many cashiers, and a queue so nobody gets ignored.",
    engineer:
      "Inference is bursty and long-tailed. Plan for p50, p95, p99 latency separately. Use admission control (queues with backpressure), per-tenant concurrency caps, async job patterns for >5s tasks, and stream tokens to the UI to keep perceived latency low. Choose between sticky-session for stateful chat vs. stateless workers for tools.",
    whatToDo: [
      "Stream responses (SSE / WebSocket) so users see progress in <1s",
      "Queue heavy tasks (Cloud Tasks, SQS, Inngest, Trigger.dev) instead of holding HTTP requests open",
      "Set per-user, per-org, and per-agent concurrency limits",
      "Load-test with realistic burst patterns (1×, 10×, 100× traffic) before launch",
    ],
    signals: ["p95 / p99 first-token latency", "Queue depth", "Concurrent active sessions", "Saturation %"],
  },
  {
    id: "model-capacity",
    number: "P2",
    icon: Cpu,
    title: "Model capacity & provider routing",
    child:
      "Your AI model lives somewhere else (like at OpenAI or Google). Sometimes their factory is busy and slows down or breaks. A scaled system has Plan A, Plan B, and Plan C models so users never see an outage.",
    engineer:
      "Provider rate limits (RPM, TPM), regional outages, and model deprecations are facts of life. Build a model gateway with: per-tenant key pools, automatic failover (e.g. Sonnet → Haiku → GPT-4o-mini), regional redundancy, request hedging for tail-latency, and circuit breakers. Decouple your prompt logic from a single SDK.",
    whatToDo: [
      "Abstract provider behind a gateway (LiteLLM, Portkey, OpenRouter, or your own)",
      "Configure cascading fallbacks per task tier (reasoning / extraction / embedding)",
      "Cache embeddings and idempotent completions (semantic + exact-match cache)",
      "Track per-provider error rate; auto-shed traffic when it spikes",
    ],
    signals: ["Provider error %", "Failover invocations", "Tokens/sec per region", "Cache hit rate"],
  },
  {
    id: "cost-economics",
    number: "P3",
    icon: DollarSign,
    title: "Cost & token economics",
    child:
      "Every word the AI reads or writes costs a tiny bit of money. Multiply that by millions of conversations and a small leak becomes a flood. Scaled systems watch the meter all the time.",
    engineer:
      "Unit economics decide if a feature is viable. Track $/conversation, $/successful_task, and $/active_user. Pre-compute budgets per tenant; hard-cap runaway loops; downshift models when context grows; cache aggressively (prompt prefix caching is now native on Anthropic, Gemini, OpenAI). Accept that 80% of cost optimization is router intelligence — using the cheapest model that still meets the eval bar.",
    whatToDo: [
      "Per-user and per-org daily/monthly spend caps with alerts at 50/80/95%",
      "Model router that picks Haiku/Flash for easy turns, Sonnet/Pro for hard ones",
      "Enable prompt caching wherever the system prompt is >1024 tokens",
      "Trim context aggressively — summarize old turns, retrieve only top-k",
    ],
    signals: ["$/successful_task", "Tokens-in vs tokens-out ratio", "Cache hit %", "Cost per tenant"],
  },
  {
    id: "memory-context",
    number: "P4",
    icon: Layers,
    title: "Memory, context & RAG at scale",
    child:
      "An agent's 'memory' is what it can read in one moment. As more people pile in with more documents, finding the right paragraph for each person without mixing them up becomes hard.",
    engineer:
      "RAG pipelines fail in production for boring reasons: stale indexes, cross-tenant leakage, bad chunking, missing re-rankers, no eval. At scale you need: tenant-scoped vector namespaces, incremental re-indexing, hybrid search (BM25 + dense), a re-ranker, and a freshness SLO. Long-term agent memory needs episodic + semantic stores with a forgetting policy, not unbounded growth.",
    whatToDo: [
      "Strict tenant_id filter on every vector query — test it with a red-team",
      "Add a re-ranker (Cohere Rerank, BGE, Voyage) above your top-50 candidates",
      "Schedule incremental re-embedding when source docs change",
      "Build a RAG eval set per tenant; track recall@k weekly",
    ],
    signals: ["Retrieval recall@k", "Cross-tenant leak tests passing", "Index freshness lag", "Avg context tokens"],
  },
  {
    id: "tools-side-effects",
    number: "P5",
    icon: Workflow,
    title: "Tools, side-effects & blast radius",
    child:
      "Some agent tools just look things up — safe. Others send emails, charge cards, or delete files — dangerous. At scale, even a 0.1% bug rate means hundreds of wrong emails a day.",
    engineer:
      "Treat every tool as untrusted glue between a non-deterministic brain and a real system. Use idempotency keys, dry-run modes, scoped credentials per agent, allow-lists, and HITL approvals for destructive actions. Apply MCP for standardization and to keep credentials out of the model context. Always cap tool-call depth and total tool calls per turn.",
    whatToDo: [
      "Tag every tool with a blast_radius (read / write / billable / external_comm)",
      "Require human approval for high-blast tools above a confidence threshold",
      "Idempotency keys on every external write — replays must be safe",
      "Hard limit: max 8–15 tools visible per turn; route to subsets",
    ],
    signals: ["Tool error rate", "Approvals pending / approved / rejected", "Avg tool calls per task", "Loop depth max"],
  },
  {
    id: "observability-evals",
    number: "P6",
    icon: BarChart3,
    title: "Observability, traces & continuous evals",
    child:
      "If you can't see what your agent is doing, you can't fix it. At scale, you need cameras everywhere — and tests that re-run every night to catch when the AI quietly gets worse.",
    engineer:
      "You need three loops: (1) live traces with full prompt/tool/IO capture (Langfuse, Arize Phoenix, LangSmith, Helicone, OpenLLMetry), (2) offline eval suites that block deploys (LLM-as-judge + golden answers + rubrics), (3) online experiments (shadow-traffic, A/B, model rollouts). Drift is real — frontier models change behavior even on stable version strings.",
    whatToDo: [
      "Capture every step: prompt, tools, retrieved chunks, latency, cost, tokens",
      "Build a 50–500 example golden eval set per critical task",
      "Run nightly evals; gate prod deploys on regression-free results",
      "Shadow new model versions on 1–5% of traffic before flipping",
    ],
    signals: ["Eval pass rate", "Latency p99", "Hallucination rate (judged)", "User thumbs-down %"],
  },
  {
    id: "security-isolation",
    number: "P7",
    icon: Shield,
    title: "Security, multi-tenancy & data isolation",
    child:
      "If two companies use the same agent, you must promise that company A can never accidentally see company B's data. At scale, this is the most important promise.",
    engineer:
      "Threats: prompt injection, indirect injection via retrieved docs, tool abuse, data exfiltration via clever outputs, cross-tenant leakage in caches/vectors/logs. Defenses: per-tenant encryption keys, RLS on every store, output filters, content-security policies on tool outputs, signed tool calls, input/output guardrails (Llama Guard, Prompt Guard, Lakera), and a clear secret-management story (no keys in prompts ever).",
    whatToDo: [
      "Row-level security on every table the agent touches",
      "Strip tool outputs through a sanitizer before re-feeding the model",
      "Log redaction for PII in traces and shared eval sets",
      "Run prompt-injection red-teams against every new tool you ship",
    ],
    signals: ["Cross-tenant leak findings", "Injection block rate", "Auth failures on tools", "PII detected in logs"],
  },
  {
    id: "deployment-rollout",
    number: "P8",
    icon: Rocket,
    title: "Deployment, versioning & safe rollouts",
    child:
      "Imagine the chef changes the recipe overnight without telling anyone. Customers wake up to different cookies. Scaled systems change recipes one table at a time, watching for complaints.",
    engineer:
      "Prompts are code. Models are dependencies. Both need versioning, staged rollouts (canary → 1% → 10% → 100%), feature flags per tenant, and one-click rollback. Tag every trace with prompt_version + model_version so regressions are attributable. Use shadow runs to compare old vs. new on real traffic without user impact.",
    whatToDo: [
      "Version system prompts in git; never edit live",
      "Feature-flag every new tool / model / prompt by tenant cohort",
      "Canary deploys with auto-rollback on eval or latency regression",
      "Maintain a model deprecation calendar — frontier providers retire models often",
    ],
    signals: ["Rollback frequency", "Deploy → incident lead time", "% traffic on canary", "Time to rollback"],
  },
  {
    id: "ha-resiliency",
    number: "P9",
    icon: ShieldCheck,
    title: "High availability & resiliency",
    child:
      "Things break. The AI provider goes down, a tool is slow, the internet is patchy. A scaled agent has a backup plan for everything — like a power generator turning on when the lights go out.",
    engineer:
      "Design for failure as the default state. Use timeouts at every hop, retries with exponential backoff + jitter, circuit breakers around providers, bulkheads (per-tenant thread pools) to contain noisy neighbors, and graceful degradation (e.g. plain answer when tools fail). Multi-region active/active for the gateway; multi-provider for the model; replay-able event logs so you can re-run failed agent steps without losing context. Practice it: run game days and chaos experiments.",
    whatToDo: [
      "Set timeouts at every level: tool, model call, full agent turn",
      "Circuit-break flapping providers and route to fallbacks",
      "Replayable event log per session (so a partial failure doesn't lose user state)",
      "Game days: kill the primary provider in staging and watch what users see",
    ],
    signals: ["Uptime SLO (e.g. 99.9%)", "MTTR", "Failover success rate", "Error budget burn rate"],
  },
  {
    id: "governance-compliance",
    number: "P10",
    icon: Scale,
    title: "Governance, audit & compliance",
    child:
      "Big companies and governments want to see receipts: who built it, what data it used, what it said, and how to turn it off. At scale, the agent has to keep its own diary.",
    engineer:
      "Map your system to NIST AI RMF / ISO 42001 / EU AI Act categories. Maintain model cards, data sheets, system cards. Log every decision with enough fidelity to reconstruct an answer for an auditor a year later. Have an emergency stop, an escalation path, and a documented owner for every agent. SOC 2 / HIPAA / FedRAMP customers will ask — so will your insurer.",
    whatToDo: [
      "Per-agent owner, change log, and approval workflow",
      "Immutable audit log of prompts, tools, and outputs (with retention policy)",
      "Documented kill-switch reachable in <60 seconds",
      "Annual model risk review; align with NIST AI RMF",
    ],
    signals: ["Audit findings open", "Kill-switch drill time", "Policy coverage %", "Time-to-fulfill data deletion"],
  },
];

/* ───────────────────────── Real-world case studies ───────────────────────── */

export type CaseStudy = {
  org: string;
  title: string;
  what: string;
  takeaways: string[];
  links: { label: string; href: string }[];
};

export const caseStudies: CaseStudy[] = [
  {
    org: "Klarna",
    title: "AI assistant doing the work of 700 customer service agents",
    what:
      "Klarna's OpenAI-powered assistant handled 2.3M chats in its first month — about two-thirds of all customer service conversations. Same satisfaction scores as human agents, and resolution time dropped from 11 minutes to under 2.",
    takeaways: [
      "Scale showed up as conversation volume, not just one-off queries",
      "Required deep integration with refunds, returns, payments — i.e. high-blast-radius tools with HITL gates",
      "Multilingual at scale (35+ languages) — eval suite multiplied by language count",
    ],
    links: [
      { label: "Klarna press release", href: "https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/" },
    ],
  },
  {
    org: "Morgan Stanley",
    title: "GPT-4 over 100,000+ internal research documents",
    what:
      "Wealth advisors get instant, citation-backed answers from Morgan Stanley's internal knowledge base. Built with OpenAI on top of a curated, evaluated RAG pipeline that runs across thousands of advisors.",
    takeaways: [
      "Tenant-scoped RAG with strict access control was the hard part — not the prompt",
      "Continuous evals against expert-curated answers gate every prompt change",
      "Citations are mandatory output — non-negotiable for a regulated industry",
    ],
    links: [
      { label: "OpenAI customer story", href: "https://openai.com/index/morgan-stanley/" },
    ],
  },
  {
    org: "Cursor",
    title: "Coding agent serving millions of developers",
    what:
      "Cursor routes millions of completions and agent runs across multiple frontier models with aggressive caching, prompt prefix re-use, and a custom inference stack to hit sub-second latency at scale.",
    takeaways: [
      "Multi-provider routing is table stakes, not optional",
      "Latency budget is the product — every 100ms loses users",
      "Prompt caching and speculative decoding move the unit economics dial more than picking a smarter model",
    ],
    links: [
      { label: "Cursor engineering blog", href: "https://www.cursor.com/blog" },
    ],
  },
  {
    org: "Lindy / Decagon / Sierra (vertical agent platforms)",
    title: "Multi-tenant agent platforms running thousands of customer agents",
    what:
      "These platforms each run thousands of customer-built agents in production, providing the gateway, observability, evals, and HITL layers as a managed product.",
    takeaways: [
      "Per-tenant isolation, RBAC, and audit are the platform — the LLM is a commodity",
      "Eval-as-a-service is what customers actually pay for",
      "Approval inboxes and sandboxes for destructive actions are core, not extras",
    ],
    links: [
      { label: "Sierra — Build trust at scale", href: "https://sierra.ai/" },
      { label: "Decagon", href: "https://decagon.ai/" },
    ],
  },
  {
    org: "GitHub Copilot",
    title: "Code AI used by 1M+ developers across enterprises",
    what:
      "Copilot serves real-time completions to millions, handles enterprise SSO + audit, and proxies models through a gateway with SLOs per tier.",
    takeaways: [
      "Enterprise tier added: tenant data exclusion, audit logging, IP indemnification — features that only matter at scale",
      "Telemetry feeds back into model fine-tuning continuously",
      "Outages are public events — SLA / SLO discipline matters",
    ],
    links: [
      { label: "GitHub Copilot Trust Center", href: "https://resources.github.com/copilot-trust-center/" },
    ],
  },
  {
    org: "Anthropic — Building effective agents",
    title: "Reference patterns from production deployments",
    what:
      "Anthropic distilled what they see across their largest agent customers into a public guide: prefer simple workflows over complex agents, add complexity only when it pays off, and instrument relentlessly.",
    takeaways: [
      "Most production 'agents' are workflows with one or two LLM steps — not autonomous loops",
      "Complexity is a cost; only buy it when an eval proves it helps",
      "Composable patterns (router, parallelization, evaluator-optimizer, orchestrator) compose at scale",
    ],
    links: [
      { label: "Anthropic — Building effective agents", href: "https://www.anthropic.com/engineering/building-effective-agents" },
    ],
  },
];

/* ───────────────────────── Best practices checklist ───────────────────────── */

export type Practice = { area: string; rule: string; why: string };

export const bestPractices: Practice[] = [
  { area: "Prompts", rule: "Version every system prompt in git; tag traces with the version", why: "Reproducibility and rollback when behavior shifts" },
  { area: "Models", rule: "Always have a fallback chain (primary → secondary → cheaper)", why: "Provider outages and rate limits are a question of when, not if" },
  { area: "Tools", rule: "Idempotency keys on every external write; HITL on destructive ones", why: "Non-determinism × side-effects = production incidents" },
  { area: "RAG", rule: "Tenant-scope every query; add a re-ranker; track recall@k weekly", why: "Most 'AI quality' issues are actually retrieval issues" },
  { area: "Cost", rule: "Hard caps per user/tenant + alerts at 50/80/95% + auto-disable", why: "A loop bug can burn $10k overnight" },
  { area: "Latency", rule: "Stream tokens; queue heavy work; budget p99 not p50", why: "Users feel the worst 1%, not the average" },
  { area: "Observability", rule: "Capture prompts, tools, retrievals, costs on every step", why: "You can't debug what you can't see; auditors will ask" },
  { area: "Evals", rule: "Golden set + nightly run + deploy gate; LLM-as-judge for soft metrics", why: "Models drift — silent regressions are the worst kind" },
  { area: "Security", rule: "Treat retrieved content as untrusted; sanitize tool outputs; log PII redacted", why: "Indirect prompt injection is the #1 emerging attack" },
  { area: "Multi-tenancy", rule: "RLS, per-tenant keys, per-tenant rate limits, per-tenant evals", why: "Noisy neighbors and data leaks kill enterprise trust instantly" },
  { area: "Rollouts", rule: "Canary + shadow + auto-rollback on eval / latency regression", why: "A bad prompt deploy can affect every user in seconds" },
  { area: "Resiliency", rule: "Timeouts and circuit breakers at every hop; replayable event log", why: "Failures must be recoverable without losing user state" },
  { area: "Governance", rule: "Owner, kill-switch, audit log, model card per agent", why: "EU AI Act, NIST AI RMF, and your CISO will all ask" },
  { area: "People", rule: "Pager rotation, runbooks, game days — same as any production system", why: "Agents fail in novel ways; humans need practice" },
];

/* ───────────────────────── Maturity model ───────────────────────── */

export const maturityStages = [
  {
    stage: "L1 — Demo",
    color: "from-muted/40 to-muted/20",
    audience: "1 user, you",
    looksLike: "Notebook or quick app, single model, hardcoded prompt, no evals",
    risks: "Works once, breaks silently",
    nextStep: "Add traces and a 20-example eval set",
  },
  {
    stage: "L2 — Pilot",
    color: "from-chart-2/30 to-chart-2/10",
    audience: "10–100 internal users",
    looksLike: "Auth, basic logging, manual model fallback, weekly eval run",
    risks: "First production bugs surface, costs start to matter",
    nextStep: "Add cost caps, queueing, structured outputs",
  },
  {
    stage: "L3 — Production",
    color: "from-primary/30 to-primary/10",
    audience: "1k–100k users / multi-tenant",
    looksLike: "Gateway with fallbacks, RLS, full traces, nightly evals, HITL on destructive tools",
    risks: "Tail-latency, cross-tenant issues, prompt-injection, drift",
    nextStep: "Canary deploys, shadow evals, per-tenant SLOs",
  },
  {
    stage: "L4 — Scale",
    color: "from-nexus-glow/40 to-primary/20",
    audience: "Millions of users / regulated industry",
    looksLike: "Multi-region, multi-provider, model router, eval-gated CI, audit, kill-switch, model risk reviews",
    risks: "Regulatory, brand, cascading failures across tenants",
    nextStep: "Continuous game-days, model risk committee, customer-facing SLAs",
  },
];

/* ───────────────────────── Glossary additions ───────────────────────── */

export const scalingGlossary: [string, string][] = [
  ["SLO / SLA", "Service Level Objective / Agreement — measurable promises about latency, uptime, and quality."],
  ["p95 / p99", "The latency the slowest 5% (or 1%) of users see. The number that actually matters at scale."],
  ["Circuit breaker", "Auto-stops calls to a failing dependency for a cooldown so you don't make things worse."],
  ["Bulkhead", "Resource isolation so one noisy tenant can't starve everyone else (separate pools/queues)."],
  ["Canary deploy", "Roll a change to 1–5% of traffic first; monitor; then expand."],
  ["Shadow traffic", "Run the new version in parallel without showing its output to users; compare offline."],
  ["HITL", "Human-in-the-loop — a human approves a step before the agent proceeds (e.g. send the email)."],
  ["Blast radius", "How much damage a single failed action can cause (read-only vs. send-money)."],
  ["Game day", "Planned exercise where you intentionally break parts of the system to test resiliency."],
  ["Model gateway", "A proxy in front of multiple LLM providers for routing, fallback, caching, logging."],
  ["Drift", "Slow degradation in model quality over time — same prompt, gradually worse outputs."],
  ["Eval gate", "A CI step that blocks deploy if the prompt/model/tool change regresses the eval suite."],
];
