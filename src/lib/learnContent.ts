import type { LearnSection } from "@/components/LearnPanel";

/**
 * Educational copy reused across in-app pages.
 * Each entry deep-links into the matching anchor on /learn.
 */

export const learnPlayground: LearnSection = {
  why: "The Playground is where ideas meet reality. Every concept — prompts, RAG, tools, guardrails — only clicks once you watch a real model react to your input.",
  whatToExpect: [
    "A chat surface wired to the agent you select",
    "Live token streaming + tool-call traces",
    "Switchable models across providers",
  ],
  whatYouLearn: [
    "How temperature changes creativity vs. accuracy",
    "Why the same prompt behaves differently per model",
    "How tool calls and citations appear in real responses",
  ],
  howYouLearn: [
    "Pick (or fork) a template agent",
    "Send the suggested prompts in the side tour",
    "Tweak the system prompt and re-send to compare",
  ],
  realLife: [
    "Drafting emails with your own writing voice",
    "A study buddy that quizzes you on PDFs",
    "A code explainer for a repo you're learning",
  ],
  enterprise: [
    "Tier-1 customer support deflection",
    "Internal knowledge search over Confluence/Notion",
    "Sales-engineering RFP responder",
  ],
  learnMoreHash: "playground",
};

export const learnAgents: LearnSection = {
  why: "An agent is just a system prompt + a model + (optional) tools and memory. Building one teaches you the whole stack in 5 minutes.",
  whatToExpect: [
    "Forms for system prompt, model, temperature, max tokens",
    "Knowledge base + tool wiring",
    "Export / share so others can fork your agent",
  ],
  whatYouLearn: [
    "Anatomy of a great system prompt",
    "How provider + model choice shapes cost & quality",
    "When to add tools vs. when to add knowledge",
  ],
  howYouLearn: [
    "Start from a template, then change ONE thing at a time",
    "Test in the Playground after every change",
    "Read the trace to see exactly what the model received",
  ],
  realLife: [
    "Personal finance coach grounded in your statements",
    "DnD dungeon master with a consistent world-bible",
    "Recipe recommender from your fridge inventory",
  ],
  enterprise: [
    "HR policy assistant with audit-grade citations",
    "Compliance pre-screener for legal docs",
    "On-call SRE copilot that summarizes incidents",
  ],
  learnMoreHash: "agents",
};

export const learnKnowledge: LearnSection = {
  why: "LLMs hallucinate. Knowledge bases ground them in YOUR documents so answers come with citations instead of guesses. This is RAG — and its more powerful cousin, Graph RAG, when relationships matter.",
  whatToExpect: [
    "Upload PDFs, docs, URLs",
    "Pick a vector store (local or managed)",
    "Switch to the Graph tab to see entities & relations as a live network",
    "Attach a KB to any agent and watch retrieval happen",
  ],
  whatYouLearn: [
    "Chunking strategies and why size matters",
    "Embeddings, similarity search, re-ranking",
    "Graph RAG: entity/relation extraction and multi-hop traversal",
    "How to detect (and fix) bad retrieval",
  ],
  howYouLearn: [
    "Drop in a single PDF and ask narrow questions",
    "Inspect retrieved chunks shown in the trace",
    "Open the 'Graph RAG Demo — Acme Corp' KB and explore the Graph tab",
    "Run the 'Graph RAG Researcher' swarm to compare graph vs vector retrieval",
  ],
  realLife: [
    "Search across all your saved articles",
    "A tutor for a textbook you're studying",
    "Family-recipe archive with semantic search",
    "Personal knowledge graph: 'who knows what' across your notes",
  ],
  enterprise: [
    "Customer-facing docs Q&A with source links",
    "Sales enablement over product specs",
    "Graph RAG for AML/KYC, customer 360, service-owner-incident networks",
    "Regulated-industry RAG with PII redaction & audit logs",
  ],
  learnMoreHash: "rag",
};

export const learnSwarms: LearnSection = {
  why: "Some tasks are too big for one agent. A swarm splits them: a Router decides who handles what, Workers do the work, Tools ground them in reality.",
  whatToExpect: [
    "A drag-and-drop canvas of nodes and edges",
    "Router → Worker → Tool patterns",
    "Run the whole pipeline end-to-end",
  ],
  whatYouLearn: [
    "Orchestrator vs. peer-to-peer patterns",
    "How handoff messages flow between agents",
    "When splitting an agent into a swarm helps (and when it hurts)",
  ],
  howYouLearn: [
    "Start with a 2-node swarm: Researcher → Writer",
    "Add a Reviewer node and compare outputs",
    "Inspect each step in Traces to see who said what",
  ],
  realLife: [
    "Trip planner: search → budget → itinerary",
    "Newsletter swarm: scout → write → fact-check",
    "Job-hunt swarm: scrape jobs → tailor resume → draft cover letter",
  ],
  enterprise: [
    "Underwriting pipeline: extract → score → review",
    "Procurement: spec → vendor search → comparison report",
    "Multi-step ops automation with HITL approvals",
  ],
  learnMoreHash: "swarms",
};

export const learnIntegrations: LearnSection = {
  why: "Agents become useful when they can DO things — call APIs, read databases, send messages. Integrations and MCP servers expose those abilities safely.",
  whatToExpect: [
    "Connect webhooks, n8n, Zapier-style flows",
    "Add MCP servers for standard tool protocols",
    "Toggle each integration on/off per agent",
  ],
  whatYouLearn: [
    "Function-calling JSON schemas explained simply",
    "Idempotency, retries, and safe-by-default design",
    "Why MCP is becoming the USB-C of agent tools",
  ],
  howYouLearn: [
    "Wire up one read-only tool first (e.g. fetch URL)",
    "Then add a write tool gated by an approval",
    "Watch tool calls light up in the Playground trace",
  ],
  realLife: [
    "Calendar agent that books your dentist",
    "Smart-home agent that dims lights on movie night",
    "Personal CRM that updates contacts after every call",
  ],
  enterprise: [
    "Salesforce / Jira / ServiceNow automations",
    "Internal MCP server fronting your data warehouse",
    "Approval-gated refunds, deletes, and money movement",
  ],
  learnMoreHash: "tools",
};

export const learnTraces: LearnSection = {
  why: "If you can't trace it, you can't trust it. Every token, tool call, latency spike and dollar spent should be inspectable.",
  whatToExpect: [
    "Per-request traces with prompts and responses",
    "Tokens in/out, cost, latency",
    "Filter by agent, model, status",
  ],
  whatYouLearn: [
    "How to read a trace like a senior engineer",
    "Spot prompt drift, model regressions, cost spikes",
    "Build your first eval suite from real traces",
  ],
  howYouLearn: [
    "Run 5-10 chats, then open Traces",
    "Find your worst response — diagnose why",
    "Replay it after fixing the system prompt",
  ],
  realLife: [
    "Debug your AI study tutor when it goes off-topic",
    "Track which prompts burn the most credits",
  ],
  enterprise: [
    "SLA monitoring on agent latency",
    "Cost attribution per team / customer",
    "Audit trails for regulators (SOC2, HIPAA, GDPR)",
  ],
  learnMoreHash: "observability",
};

export const learnBudgets: LearnSection = {
  why: "Agents can spend real money fast. Guardrails and budgets keep curiosity from becoming an invoice.",
  whatToExpect: [
    "Monthly cap + per-agent daily limits",
    "Alert thresholds (50%, 80%, 100%)",
    "Auto-disable when limits trip",
  ],
  whatYouLearn: [
    "How token cost actually accumulates",
    "Why streaming hides cost surprises",
    "Soft vs. hard limits in production",
  ],
  howYouLearn: [
    "Set a $1 cap and try to break it",
    "Watch the dashboard during a long chat",
    "Compare cost across providers for the same prompt",
  ],
  realLife: ["Keep your hobby projects under coffee-money", "Cap a kid's homework helper at $5/mo"],
  enterprise: [
    "Per-team chargeback with hard caps",
    "Anomaly alerts on suspicious spikes",
    "FinOps reports for AI spend governance",
  ],
  learnMoreHash: "guardrails",
};

export const learnPromptCompare: LearnSection = {
  why: "Different models interpret the same prompt differently. Comparing them side-by-side builds intuition for which model fits which task — and why prompt engineering matters.",
  whatToExpect: [
    "Two chat panels running the same prompt simultaneously",
    "Real-time streaming from both models",
    "Latency, token count, and cost comparison cards",
  ],
  whatYouLearn: [
    "How the same prompt produces wildly different outputs",
    "Which models are better at reasoning vs. creativity vs. speed",
    "How to write model-agnostic prompts that work everywhere",
  ],
  howYouLearn: [
    "Pick two models (e.g. GPT-5 Mini vs Gemini Flash)",
    "Try the suggested educational prompts first",
    "Tweak the prompt wording and re-run to see what changes",
  ],
  realLife: [
    "Choosing the cheapest model that still passes your quality bar",
    "Testing a prompt before deploying it in a production agent",
  ],
  enterprise: [
    "Model evaluation for procurement decisions",
    "Regression testing after provider version bumps",
    "Cost-quality Pareto analysis across model tiers",
  ],
  learnMoreHash: "playground",
};

export const learnPromptLibrary: LearnSection = {
  why: "Great agents start with great prompts. A well-crafted system prompt is the single highest-leverage thing you can do — it shapes every response the model gives.",
  whatToExpect: [
    "A library of production-grade system prompts by category",
    "Built-in prompts you can study and fork",
    "Create, edit, and organise your own prompt collection",
  ],
  whatYouLearn: [
    "Anatomy of an effective system prompt (role, constraints, format)",
    "Chain-of-thought, few-shot, and structured-output patterns",
    "How to version and iterate on prompts like code",
  ],
  howYouLearn: [
    "Read 2-3 built-in prompts — notice the patterns they share",
    "Duplicate one and modify it for your own use case",
    "Test your prompt in the Playground, then refine",
  ],
  realLife: [
    "A writing coach prompt that matches your tone",
    "A code reviewer prompt tailored to your stack",
    "Reusable prompts you can share across agents",
  ],
  enterprise: [
    "Standardised prompt templates for compliance",
    "Prompt versioning and A/B testing workflows",
    "Team-shared prompt libraries with review gates",
  ],
  learnMoreHash: "playground",
};

export const learnSkills: LearnSection = {
  why: "Skills are modular playbooks — think of them as plugins for your agent's brain. Instead of one giant system prompt, you compose focused skills that can be mixed and matched.",
  whatToExpect: [
    "A library of reusable skill.md files",
    "AI-assisted skill generation",
    "Attach any combination of skills to any agent",
  ],
  whatYouLearn: [
    "How Anthropic-style skill files work in practice",
    "Composable prompt engineering — build once, reuse everywhere",
    "When to split a monolithic prompt into separate skills",
  ],
  howYouLearn: [
    "Browse the sample skills to see the format",
    "Duplicate a sample and customise it",
    "Attach different skill combos to the same agent and compare",
  ],
  realLife: [
    "A 'tone of voice' skill you attach to every writing agent",
    "A 'citation format' skill for research tasks",
    "Swapping skills to repurpose one agent for different jobs",
  ],
  enterprise: [
    "Compliance skills enforced across all agents organisation-wide",
    "Domain-expert skills maintained by subject-matter teams",
    "Skill marketplaces for internal and external distribution",
  ],
  learnMoreHash: "agents",
};

export const learnMcp: LearnSection = {
  why: "MCP (Model Context Protocol) is the emerging standard for giving agents access to tools and data — like USB-C for AI. Understanding it now puts you ahead of the curve.",
  whatToExpect: [
    "Register MCP-compatible servers (databases, APIs, filesystems)",
    "Each server exposes tools your agents can call",
    "Live connection status and tool discovery",
  ],
  whatYouLearn: [
    "What MCP is and why it's replacing custom tool integrations",
    "How tool discovery and schema negotiation work",
    "Security: authentication, scoping, and least-privilege access",
  ],
  howYouLearn: [
    "Add a sample MCP server and explore its tools",
    "Attach it to an agent and watch tool calls in the trace",
    "Compare MCP tools vs. custom function-calling schemas",
  ],
  realLife: [
    "Connect your agent to a local SQLite database via MCP",
    "Browse files on your machine through an MCP filesystem server",
    "Use community MCP servers for popular APIs (GitHub, Slack)",
  ],
  enterprise: [
    "Standardised tool access across hundreds of agents",
    "Centrally managed MCP server registry with RBAC",
    "Audit logging for every tool invocation",
  ],
  learnMoreHash: "tools",
};

export const learnModelRegistry: LearnSection = {
  why: "The AI model landscape changes weekly. Knowing what's available — and what each model is good at — is a core skill for anyone building with agents.",
  whatToExpect: [
    "A live catalog of models across all major providers",
    "Filter by capability (chat, code, vision, embedding)",
    "Copy model IDs to paste into your agents or swarms",
  ],
  whatYouLearn: [
    "The difference between model families (GPT, Gemini, Claude, Llama)",
    "How to read model specs: context window, modality, pricing",
    "When to use a frontier model vs. a smaller, cheaper one",
  ],
  howYouLearn: [
    "Browse models and read their capability badges",
    "Pick two similar models and compare them in the Prompt Lab",
    "Try the same agent with different models to feel the difference",
  ],
  realLife: [
    "Finding the best model for your budget",
    "Staying current as new models launch weekly",
    "Understanding model deprecation and migration",
  ],
  enterprise: [
    "Model governance: approved model lists per team",
    "Cost forecasting based on model pricing tiers",
    "Multi-provider redundancy and failover planning",
  ],
  learnMoreHash: "foundations",
};

export const learnFailureLabs: LearnSection = {
  why: "You learn agentic AI fastest by fixing what's broken, not by reading happy-path tutorials. Failure Labs hand you a swarm that's deliberately wrong and ask you to diagnose and repair it.",
  whatToExpect: [
    "A pre-loaded broken swarm with a visible symptom",
    "Progressive hints you reveal only when stuck",
    "Automatic checks that turn green when your fix is correct",
  ],
  whatYouLearn: [
    "Why RAG agents hallucinate (missing retrieval, not a dumb model)",
    "How to bound loops and give them an exit condition",
    "Why routers need labeled edges and tools must be enabled, not just prompted",
  ],
  howYouLearn: [
    "Open a lab and run it to observe the failure",
    "Form a hypothesis, edit the canvas, and re-run",
    "Read the diagnosis once the checks pass to lock in the lesson",
  ],
  realLife: [
    "Debugging your own agent that confidently makes things up",
    "Stopping a refinement loop that burns tokens forever",
    "Figuring out why a 'use the calculator' instruction does nothing",
  ],
  enterprise: [
    "Onboarding new engineers to agent failure modes safely",
    "Building a team playbook of common production agent bugs",
    "Pre-deployment review checklists grounded in real failures",
  ],
  learnMoreHash: "patterns",
};
