// Production Deployment Roadmap — what to learn AFTER the curriculum.
// Dual-persona content: technical builders + non-technical product / ops folk.
// Sources: 2025/2026 industry guides on agent deployment (n8n, Cordum, Fast.io,
// Harness Engineering "Replit incident" post-mortem, AWS / Azure / Google
// platform comparisons, OWASP LLM Top 10, NIST AI RMF, Anthropic Contextual
// Retrieval, LangGraph Platform, OpenAI AgentKit, Bedrock AgentCore).
import type { LucideIcon } from "lucide-react";
import {
  Rocket, ShieldCheck, Gauge, Users, Building2, Cloud, Server, Lock,
  GraduationCap, Compass, BookOpen, Wrench, Activity, Workflow,
} from "lucide-react";

export const roadmapIntro = {
  headline:
    "You finished the curriculum. Now what — and how do you actually ship this?",
  child:
    "Learning to build an agent is like learning to cook a great dish at home. Running a restaurant kitchen at dinner rush — that's production. You need a bigger stove, prep lists, fire safety, and someone watching the door. The good news: every great chef started exactly where you are now.",
  engineer:
    "Going from a working agent to a production system is a discipline shift, not a bigger model. You move from 'does it work once?' to 'does it survive 10,000 runs, three providers, two regions, and one bad actor?' The remaining gap is operations: deployment topology, observability, evaluation harnesses, security hardening, change management, and on-call. The 2025 Replit incident (an agent deleted a production database and tried to hide it) wasn't a model failure — it was a missing harness. This roadmap is your harness.",
};

/* ───────────────────────── Persona tracks ───────────────────────── */

export type Persona = "builder" | "leader";

export type RoadmapPhase = {
  id: string;
  number: string;
  icon: LucideIcon;
  title: string;
  duration: string;
  forWhom: Persona[];
  child: string;        // Plain-English / non-technical framing
  engineer: string;     // Engineer / builder framing
  outcomes: string[];
  resources: { label: string; href: string; kind: "doc" | "paper" | "course" | "tool" }[];
};

export const roadmapPhases: RoadmapPhase[] = [
  {
    id: "phase-pilot",
    number: "01",
    icon: Compass,
    title: "Pick a real pilot — narrow, measurable, low blast-radius",
    duration: "1–2 weeks",
    forWhom: ["builder", "leader"],
    child:
      "Don't try to automate the whole company. Pick one repetitive task a real team does every day — answering FAQ tickets, drafting weekly reports, summarising calls. Write down on a sticky note what 'good enough' looks like before you build anything.",
    engineer:
      "Define the unit of work, the success metric, and the failure cost in writing. Pick a workflow with: (1) high volume, (2) verifiable output, (3) tolerant users, (4) a human reviewer already in the loop. Avoid first-deploy cases that touch money, identity, or irreversible state.",
    outcomes: [
      "A one-page PRD: input → output → success metric → kill criteria.",
      "A baseline number — current cost, time, or throughput per task.",
      "A named human owner who reviews quality weekly.",
    ],
    resources: [
      { label: "Anthropic — Building effective agents", href: "https://www.anthropic.com/research/building-effective-agents", kind: "doc" },
      { label: "OpenAI — A practical guide to building agents (PDF)", href: "https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf", kind: "doc" },
    ],
  },
  {
    id: "phase-eval",
    number: "02",
    icon: Activity,
    title: "Build an evaluation harness BEFORE you scale",
    duration: "1–2 weeks",
    forWhom: ["builder", "leader"],
    child:
      "Imagine grading a student. You can't say 'they're doing well' without a test. Same with agents. Write 30–100 example questions with the right answers, and re-grade your agent every time anything changes.",
    engineer:
      "Stand up offline evals (golden set + LLM-as-judge), online evals (sampled human review on prod traffic), and regression evals on every prompt/model/tool change. CI should block merges that drop pass-rate. Track cost-per-successful-task and tail latency, not just averages.",
    outcomes: [
      "A versioned eval set in source control with at least 50 cases.",
      "An LLM-as-judge prompt + human spot-check workflow.",
      "Dashboards for pass-rate, latency p95, $/successful-task, refusal-rate.",
    ],
    resources: [
      { label: "OpenAI Evals", href: "https://github.com/openai/evals", kind: "tool" },
      { label: "Ragas — RAG evaluation framework", href: "https://github.com/explodinggradients/ragas", kind: "tool" },
      { label: "Promptfoo — prompt + agent eval CLI", href: "https://www.promptfoo.dev/", kind: "tool" },
      { label: "LangSmith evaluation docs", href: "https://docs.smith.langchain.com/evaluation", kind: "doc" },
    ],
  },
  {
    id: "phase-security",
    number: "03",
    icon: ShieldCheck,
    title: "Harden it — guardrails, secrets, blast-radius",
    duration: "2–3 weeks",
    forWhom: ["builder", "leader"],
    child:
      "Before you let the agent loose, lock the dangerous drawers. No agent should be able to send all your money or email all your customers without a human nodding. Write down what it's allowed to do, and what needs a human's signature.",
    engineer:
      "Apply OWASP LLM Top 10 controls: input/output guardrails (Llama Guard, Prompt Guard, NeMo), prompt-injection defence on every retrieved doc, egress allow-listing on tools, scoped per-tenant credentials, idempotency keys on writes, tool-level blast-radius tags, and HITL above thresholds. Never let model output cross a trust boundary unsanitised. Run a red-team pass with garak / PyRIT before launch.",
    outcomes: [
      "Tool registry with explicit blast-radius (read / write / billable / external_comm).",
      "Approval workflow for high-risk actions (the same pattern as our Approvals Inbox).",
      "Documented kill-switch reachable in <60 seconds and a practiced runbook.",
    ],
    resources: [
      { label: "OWASP Top 10 for LLM Applications", href: "https://owasp.org/www-project-top-10-for-large-language-model-applications/", kind: "doc" },
      { label: "NIST AI Risk Management Framework", href: "https://www.nist.gov/itl/ai-risk-management-framework", kind: "doc" },
      { label: "garak — LLM vulnerability scanner", href: "https://github.com/leondz/garak", kind: "tool" },
      { label: "Microsoft PyRIT — automated red-teaming", href: "https://github.com/Azure/PyRIT", kind: "tool" },
    ],
  },
  {
    id: "phase-observability",
    number: "04",
    icon: Gauge,
    title: "Observe everything — traces, costs, drift",
    duration: "1–2 weeks",
    forWhom: ["builder"],
    child:
      "Cars have dashboards for a reason. Your agent needs one too — what it did, what it cost, how long it took, and whether anyone was unhappy with the answer.",
    engineer:
      "Emit OpenTelemetry-style traces for every step (prompt, retrieval, tool call, model call). Tag with user_id (hashed), tenant, model, version. Pipe to a purpose-built tool: Langfuse, LangSmith, Arize Phoenix, Datadog LLM Observability, or Helicone. Alert on cost/latency anomalies, refusal spikes, and tool-error spikes — all three are leading indicators of user-visible failures.",
    outcomes: [
      "End-to-end trace per request with PII redacted at the boundary.",
      "Per-tenant + per-feature cost dashboard with budget alerts.",
      "Weekly drift review: top failed cases, top expensive cases, top slow cases.",
    ],
    resources: [
      { label: "Langfuse (open-source LLM observability)", href: "https://langfuse.com/", kind: "tool" },
      { label: "Arize Phoenix (OSS tracing & evals)", href: "https://github.com/Arize-ai/phoenix", kind: "tool" },
      { label: "OpenTelemetry — GenAI semantic conventions", href: "https://opentelemetry.io/docs/specs/semconv/gen-ai/", kind: "doc" },
    ],
  },
  {
    id: "phase-deploy",
    number: "05",
    icon: Cloud,
    title: "Pick where it runs — and how traffic gets there",
    duration: "1–3 weeks",
    forWhom: ["builder"],
    child:
      "You've got the recipe and the safety checks. Now choose the kitchen. Big public cloud, your own servers, or a managed agent service — each has trade-offs in cost, control, and how much plumbing you have to do yourself.",
    engineer:
      "Choose a hosting topology based on data-residency, latency, and team skills (see the platforms table below). Deploy behind a feature flag. Roll out 5% → 25% → 50% → 100% with objective gates between stages (eval pass-rate, p95 latency, error rate, cost ceiling). Keep the previous version warm for instant rollback. Use a model gateway (LiteLLM, Portkey, OpenRouter) so provider failover is one config change, not a code change.",
    outcomes: [
      "Staged rollout plan with named gates and an owner per gate.",
      "Provider failover tested by killing the primary in staging.",
      "Documented rollback procedure rehearsed end-to-end at least once.",
    ],
    resources: [
      { label: "LiteLLM — unified model gateway", href: "https://github.com/BerriAI/litellm", kind: "tool" },
      { label: "Portkey — AI gateway + governance", href: "https://portkey.ai/", kind: "tool" },
      { label: "Cordum — Deploy AI Agents in Production (staged rollout playbook)", href: "https://cordum.io/blog/deploy-ai-agents-production", kind: "doc" },
    ],
  },
  {
    id: "phase-operate",
    number: "06",
    icon: Workflow,
    title: "Operate it — humans, on-call, change management",
    duration: "Ongoing",
    forWhom: ["builder", "leader"],
    child:
      "Once the agent is live, treat it like a new team member. Someone needs to be on call when it misbehaves, someone needs to keep its training material up to date, and someone needs to talk to the people whose work it changes.",
    engineer:
      "Add the agent to your on-call rotation with named SLOs (success-rate, latency, cost). Establish a model/prompt change-management process — every change goes through eval CI and a canary. Set a regular cadence (weekly at first) to review failed traces and feed corrections back into the prompt, the KB, or the eval set. Plan for model deprecation: providers retire models on 6–12 month cycles.",
    outcomes: [
      "Named SRE + product owner; agent on a real incident-response rota.",
      "Change-management doc covering prompts, models, tools, KB, and rollouts.",
      "Quarterly model & cost review against business metrics.",
    ],
    resources: [
      { label: "Google SRE Workbook (free)", href: "https://sre.google/workbook/table-of-contents/", kind: "doc" },
      { label: "Harness Engineering — Production AI Agent Operations Guide", href: "https://harness-engineering.ai/blog/production-ai-agent-deployment-the-complete-operations-guide/", kind: "doc" },
    ],
  },
  {
    id: "phase-scale",
    number: "07",
    icon: Building2,
    title: "Scale across the org — governance, FinOps, enablement",
    duration: "Quarter+",
    forWhom: ["leader"],
    child:
      "When the first agent works, others will want one. That's the moment to write the rules of the road — what's safe, what's allowed, who pays, and how new teams get a head start instead of starting over.",
    engineer:
      "Stand up a thin platform team that owns the gateway, eval CI, observability, secret management, and the agent template repo. Publish golden-path templates so product teams ship in days, not months. Introduce per-team chargeback so cost lands where the value is created. Map every deployment to NIST AI RMF and (if you sell to EU enterprise) the EU AI Act risk tier.",
    outcomes: [
      "Internal AI platform with paved-road templates and shared infra.",
      "Per-team budgets, alerts, and quarterly business-impact reviews.",
      "AI policy document covering data, models, third-party tools, incident response.",
    ],
    resources: [
      { label: "EU AI Act — official summary", href: "https://artificialintelligenceact.eu/high-level-summary/", kind: "doc" },
      { label: "ISO/IEC 42001 — AI management systems", href: "https://www.iso.org/standard/81230.html", kind: "doc" },
      { label: "FinOps Foundation — AI cost management", href: "https://www.finops.org/wg/finops-for-ai/", kind: "doc" },
    ],
  },
];

/* ───────────────────── Where to deploy — platforms ───────────────────── */

export type DeployPlatform = {
  name: string;
  category: "hyperscaler" | "managed-agent" | "framework" | "self-host" | "edge";
  bestFor: string;
  watchOut: string;
  url: string;
};

export const deployPlatforms: DeployPlatform[] = [
  {
    name: "AWS — Bedrock AgentCore + Lambda/ECS",
    category: "hyperscaler",
    bestFor: "AWS-native teams; widest model selection (Anthropic, Meta, Mistral, Amazon); strong VPC + IAM story; PrivateLink keeps data in-account.",
    watchOut: "Steepest learning curve; AgentCore is newer than competitors; per-feature pricing adds up across Bedrock + Knowledge Bases + Guardrails.",
    url: "https://aws.amazon.com/bedrock/agentcore/",
  },
  {
    name: "Azure AI Foundry Agent Service",
    category: "hyperscaler",
    bestFor: "Microsoft 365 / Entra ID shops; tight Copilot integration; enterprise governance, content safety, and EU data residency are first-class.",
    watchOut: "Best when you're committed to Azure end-to-end; non-Microsoft model catalogue is narrower than Bedrock's.",
    url: "https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview",
  },
  {
    name: "Google Vertex AI Agent Builder + Agent Engine",
    category: "hyperscaler",
    bestFor: "Teams using Gemini at scale; great native multimodal; ADK + A2A protocol push toward open multi-agent interop.",
    watchOut: "Strongest where you also use BigQuery / GCP data services; less mature 3rd-party model catalogue than Bedrock.",
    url: "https://cloud.google.com/products/agent-builder",
  },
  {
    name: "OpenAI AgentKit + Responses API",
    category: "managed-agent",
    bestFor: "Fastest path to a polished product agent; built-in tool calling, file-search, computer use, evals, and a hosted runtime.",
    watchOut: "Single-vendor lock-in; less control over hosting region and model choice than a hyperscaler.",
    url: "https://openai.com/index/introducing-agentkit/",
  },
  {
    name: "LangGraph Platform (LangChain)",
    category: "managed-agent",
    bestFor: "Stateful, long-running agents with human-in-the-loop checkpoints; durable execution; pairs naturally with LangSmith for evals.",
    watchOut: "Pythonic; you're buying into the LangChain ecosystem and conventions.",
    url: "https://www.langchain.com/langgraph-platform",
  },
  {
    name: "Temporal / Inngest / Trigger.dev (durable execution)",
    category: "framework",
    bestFor: "Multi-step workflows that must survive crashes, retries, and human approvals — exactly what real agents are.",
    watchOut: "Adds an orchestration layer to learn; you still pick your own model + observability stack.",
    url: "https://temporal.io/",
  },
  {
    name: "Cloudflare Workers AI + Workflows",
    category: "edge",
    bestFor: "Low-latency global edge deployment; pay-per-request; great fit for chat front-ends and lightweight tool-use agents.",
    watchOut: "CPU/memory limits per request; not where you put a 30-minute deep-research swarm.",
    url: "https://developers.cloudflare.com/workers-ai/",
  },
  {
    name: "Modal / Replicate / RunPod (GPU containers)",
    category: "self-host",
    bestFor: "Self-hosted open models (Llama, Mistral, Qwen) when you need data sovereignty or per-token economics flip vs. APIs.",
    watchOut: "You own the eval, scaling, and on-call; only worth it past meaningful volume.",
    url: "https://modal.com/",
  },
  {
    name: "Vercel AI SDK + serverless",
    category: "framework",
    bestFor: "Next.js / Node teams shipping AI features inside an existing web app; great DX for streaming UIs and tool calling.",
    watchOut: "It's an SDK + hosting, not a full agent platform — bring your own evals, traces, and orchestration.",
    url: "https://sdk.vercel.ai/",
  },
];

/* ───────────────── Cloud deployment guide ───────────────── */

export type CloudCapability = {
  feature: string;
  aws: string;
  azure: string;
  gcp: string;
  oci: string;
};

export const cloudCapabilities: CloudCapability[] = [
  { feature: "Managed Agent Runtime", aws: "Bedrock Agents / AgentCore", azure: "AI Foundry Agent Service", gcp: "Vertex AI Agent Builder", oci: "OCI Generative AI Agents" },
  { feature: "Model Hosting (API)", aws: "Bedrock (Anthropic, Meta, Mistral, Amazon Nova)", azure: "Azure OpenAI Service (GPT-4o, o3, o4-mini)", gcp: "Vertex AI (Gemini 2.5, Llama, Claude)", oci: "OCI Generative AI (Cohere, Meta Llama, Mistral)" },
  { feature: "Self-hosted Models", aws: "SageMaker Endpoints / ECS + GPU", azure: "AML Managed Endpoints / AKS + GPU", gcp: "Vertex AI Endpoints / GKE + GPU", oci: "OCI Data Science / OKE + GPU (A10/A100)" },
  { feature: "RAG / Knowledge Base", aws: "Bedrock Knowledge Bases (OpenSearch, Aurora)", azure: "AI Search + Foundry", gcp: "Vertex AI Search + Agent Builder", oci: "OCI Search with OpenSearch" },
  { feature: "Guardrails / Content Safety", aws: "Bedrock Guardrails", azure: "Azure AI Content Safety", gcp: "Vertex AI Safety Filters", oci: "Custom via OCI Functions" },
  { feature: "Tool Calling / Function Calling", aws: "✅ Bedrock action groups", azure: "✅ Foundry tools + Azure Functions", gcp: "✅ Vertex extensions + Cloud Functions", oci: "✅ OCI Functions integration" },
  { feature: "Memory / State", aws: "AgentCore Memory + DynamoDB", azure: "Cosmos DB + Foundry sessions", gcp: "Firestore + Agent Engine state", oci: "OCI NoSQL / Autonomous JSON DB" },
  { feature: "Observability / Tracing", aws: "CloudWatch + X-Ray + Bedrock logs", azure: "Application Insights + Foundry tracing", gcp: "Cloud Trace + Vertex Experiments", oci: "OCI Logging + Monitoring" },
  { feature: "Multi-agent Orchestration", aws: "Bedrock multi-agent (supervisor/routing)", azure: "Semantic Kernel + AutoGen", gcp: "Agent Development Kit (ADK) + A2A", oci: "Custom via OCI Data Flow / Functions" },
  { feature: "Human-in-the-loop (HITL)", aws: "✅ Bedrock return-control + Step Functions", azure: "✅ Logic Apps + approval connectors", gcp: "✅ Vertex HITL + Workflows", oci: "✅ OCI Process Automation" },
  { feature: "Identity & Auth", aws: "IAM + Cognito + PrivateLink", azure: "Entra ID + RBAC + Private Endpoints", gcp: "IAM + Identity Platform + VPC-SC", oci: "IAM + Identity Domains + Private Endpoints" },
  { feature: "Data Residency / Sovereignty", aws: "Region-locked; Dedicated Regions available", azure: "EU Data Boundary; sovereign clouds", gcp: "Region-locked; Assured Workloads", oci: "Sovereign Cloud; EU, US Gov regions" },
];

export type CloudProviderGuide = {
  id: string;
  name: string;
  icon: string;
  color: string;
  tagline: string;
  gettingStarted: string[];
  agentSwarmSkillsMap: { skill: string; maps: string }[];
  bestPractices: string[];
  docs: { label: string; href: string }[];
  supportedModels: string[];
};

export const cloudProviderGuides: CloudProviderGuide[] = [
  {
    id: "aws",
    name: "Amazon Web Services (AWS)",
    icon: "🟧",
    color: "chart-4",
    tagline: "The widest model catalogue and deepest enterprise integration — best when your data already lives in AWS.",
    gettingStarted: [
      "Create a Bedrock Agent in the AWS Console → Agents → Create agent. Give it a system prompt (use your AgentSwarms prompt as a starting point).",
      "Add action groups — each one maps to a tool you configured in AgentSwarms. Define the OpenAPI schema or use Lambda functions.",
      "Attach a Knowledge Base — upload your documents to S3, Bedrock indexes them with embeddings (just like AgentSwarms' Knowledge Base feature).",
      "Enable Guardrails — set up content filters, denied topics, and PII redaction (maps to the guardrail layers you learned in the curriculum).",
      "Test in the Bedrock playground, then deploy via the Agents API or integrate with your app via the AWS SDK.",
      "For multi-agent swarms: use Bedrock's multi-agent collaboration (supervisor or routing mode) — mirrors the swarm topologies from AgentSwarms.",
    ],
    agentSwarmSkillsMap: [
      { skill: "Agent creation & system prompts", maps: "Bedrock Agent instructions + model selection" },
      { skill: "Knowledge Base / RAG", maps: "Bedrock Knowledge Bases (S3 + OpenSearch / Aurora)" },
      { skill: "Tool calling", maps: "Action groups (Lambda functions or API schemas)" },
      { skill: "Guardrails", maps: "Bedrock Guardrails (input/output filters, denied topics, PII)" },
      { skill: "Memory", maps: "AgentCore Memory (STM session + LTM DynamoDB)" },
      { skill: "Swarm orchestration", maps: "Bedrock multi-agent collaboration + Step Functions" },
      { skill: "Tracing & observability", maps: "CloudWatch Logs + X-Ray traces + Bedrock invocation logs" },
      { skill: "Export (LangChain/LangGraph)", maps: "Deploy exported code on Lambda or ECS behind an ALB" },
    ],
    bestPractices: [
      "Use IAM roles (never hardcode keys) — create a least-privilege policy for each agent.",
      "Keep data in-region with VPC endpoints and PrivateLink for Bedrock APIs.",
      "Enable invocation logging to S3 for audit trails — required for compliance.",
      "Use provisioned throughput for latency-sensitive production agents.",
      "Set up CloudWatch alarms on throttling, error rates, and cost anomalies.",
      "Deploy with CDK or Terraform — not click-ops — for reproducible infrastructure.",
    ],
    docs: [
      { label: "Bedrock Agents Developer Guide", href: "https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html" },
      { label: "Bedrock Knowledge Bases", href: "https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html" },
      { label: "Bedrock Guardrails", href: "https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html" },
      { label: "AgentCore (Memory, Tools, Identity)", href: "https://aws.amazon.com/bedrock/agentcore/" },
      { label: "Multi-agent collaboration", href: "https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent.html" },
      { label: "AWS Generative AI Learning Path", href: "https://aws.amazon.com/training/learn-about/generative-ai/" },
    ],
    supportedModels: [
      "Anthropic Claude 4 / 3.7 Sonnet / 3.5 Haiku",
      "Amazon Nova Pro / Lite / Micro",
      "Meta Llama 4 / 3.3",
      "Mistral Large / Small",
      "Cohere Command R / R+",
      "AI21 Jamba 1.5",
      "Stability AI (image generation)",
    ],
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    icon: "🔵",
    color: "primary",
    tagline: "The natural choice for Microsoft 365 shops — strongest enterprise governance, Copilot integration, and EU data boundary.",
    gettingStarted: [
      "Open Azure AI Foundry portal → create a project and deploy a model (GPT-4o, o3, or o4-mini).",
      "Create an Agent — add instructions (your AgentSwarms prompt), attach tools (Azure Functions, Bing search, or code interpreter).",
      "Connect a knowledge store — use Azure AI Search to index your documents (equivalent to AgentSwarms' Knowledge Base).",
      "Enable Azure AI Content Safety for input/output filtering — maps to the guardrail layers from the curriculum.",
      "Use the Agent SDK (Python or C#) to integrate the agent into your application.",
      "For multi-agent patterns: use Semantic Kernel or AutoGen to orchestrate multiple agents — same swarm patterns you built in AgentSwarms.",
    ],
    agentSwarmSkillsMap: [
      { skill: "Agent creation & system prompts", maps: "Foundry Agent + system instructions + model deployment" },
      { skill: "Knowledge Base / RAG", maps: "Azure AI Search + document indexing" },
      { skill: "Tool calling", maps: "Foundry tools (Azure Functions, Bing, code interpreter)" },
      { skill: "Guardrails", maps: "Azure AI Content Safety + Responsible AI dashboard" },
      { skill: "Memory", maps: "Cosmos DB sessions + thread-based conversation state" },
      { skill: "Swarm orchestration", maps: "Semantic Kernel / AutoGen agents + Logic Apps" },
      { skill: "Tracing & observability", maps: "Application Insights + Foundry evaluations + tracing" },
      { skill: "Export (LangChain/LangGraph)", maps: "Deploy on Azure Container Apps or App Service" },
    ],
    bestPractices: [
      "Use Managed Identity (not API keys) for all Azure OpenAI and AI Search calls.",
      "Enable private endpoints to keep traffic on the Azure backbone.",
      "Use Foundry evaluations to run evals before promoting models (mirrors your eval harness).",
      "Set up per-model rate limits and quota alerts in Azure Monitor.",
      "Use Content Safety filters at both system and user message levels.",
      "Deploy with Bicep / Terraform for infrastructure-as-code repeatability.",
    ],
    docs: [
      { label: "Azure AI Foundry Agent Service", href: "https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview" },
      { label: "Azure OpenAI Service", href: "https://learn.microsoft.com/en-us/azure/ai-services/openai/" },
      { label: "Azure AI Search (RAG)", href: "https://learn.microsoft.com/en-us/azure/search/search-what-is-azure-search" },
      { label: "Azure AI Content Safety", href: "https://learn.microsoft.com/en-us/azure/ai-services/content-safety/" },
      { label: "Semantic Kernel (multi-agent)", href: "https://learn.microsoft.com/en-us/semantic-kernel/" },
      { label: "Azure AI certifications (AI-102)", href: "https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-engineer/" },
    ],
    supportedModels: [
      "OpenAI GPT-4o / GPT-4o mini",
      "OpenAI o3 / o4-mini (reasoning)",
      "OpenAI GPT-5 / GPT-5 mini (preview)",
      "Meta Llama 4 / 3.3 (via Models-as-a-Service)",
      "Mistral Large / Small",
      "Cohere Command R+",
      "Phi-4 (Microsoft)",
    ],
  },
  {
    id: "gcp",
    name: "Google Cloud Platform (GCP)",
    icon: "🔴",
    color: "chart-1",
    tagline: "Best native multimodal with Gemini — strongest when you also use BigQuery and want open multi-agent interop (A2A protocol).",
    gettingStarted: [
      "Open Vertex AI in Google Cloud Console → Agent Builder → create a new agent.",
      "Set the agent's goal and instructions (paste your AgentSwarms system prompt as a starting point).",
      "Add tools — create OpenAPI-based tools or use built-in tools (code execution, Vertex AI Search).",
      "Set up a data store for RAG — upload documents or connect BigQuery / Cloud Storage (maps to AgentSwarms Knowledge Base).",
      "Configure safety settings (content filters + grounding with citations).",
      "For multi-agent: use the Agent Development Kit (ADK) to compose agents, or use the A2A protocol for cross-framework interop — this is exactly what the Swarm canvas teaches.",
    ],
    agentSwarmSkillsMap: [
      { skill: "Agent creation & system prompts", maps: "Agent Builder agent + goal/instructions + model selection" },
      { skill: "Knowledge Base / RAG", maps: "Vertex AI Search data stores + grounding" },
      { skill: "Tool calling", maps: "Extensions + OpenAPI tools + code execution" },
      { skill: "Guardrails", maps: "Safety settings + grounding (source citations)" },
      { skill: "Memory", maps: "Firestore sessions + Agent Engine managed state" },
      { skill: "Swarm orchestration", maps: "Agent Development Kit (ADK) + A2A protocol" },
      { skill: "Tracing & observability", maps: "Cloud Trace + Vertex AI Experiments + Logging" },
      { skill: "Export (LangChain/LangGraph)", maps: "Deploy on Cloud Run or GKE" },
    ],
    bestPractices: [
      "Use Workload Identity Federation — avoid service account key files.",
      "Enable VPC Service Controls for data-sensitive workloads.",
      "Use Vertex AI Experiments to track prompt/model iterations (your eval harness on GCP).",
      "Set up grounding with citations to reduce hallucinations and improve trust.",
      "Use Cloud Monitoring alerts for Vertex AI quotas and error rates.",
      "Deploy production agents on Cloud Run (serverless) or GKE (container orchestration).",
    ],
    docs: [
      { label: "Vertex AI Agent Builder", href: "https://cloud.google.com/products/agent-builder" },
      { label: "Agent Development Kit (ADK)", href: "https://google.github.io/adk-docs/" },
      { label: "Vertex AI Search & Conversation", href: "https://cloud.google.com/generative-ai-app-builder/docs/introduction" },
      { label: "Gemini API on Vertex AI", href: "https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal" },
      { label: "A2A Protocol (multi-agent interop)", href: "https://github.com/google/A2A" },
      { label: "Google Cloud AI/ML Certifications", href: "https://cloud.google.com/learn/certification" },
    ],
    supportedModels: [
      "Gemini 2.5 Pro / Flash / Flash-Lite",
      "Gemini 2.0 Flash (Thinking)",
      "Anthropic Claude 3.7 Sonnet (via Model Garden)",
      "Meta Llama 4 / 3.3 (via Model Garden)",
      "Mistral Large (via Model Garden)",
      "Imagen 3 (image generation)",
    ],
  },
  {
    id: "oci",
    name: "Oracle Cloud Infrastructure (OCI)",
    icon: "🟤",
    color: "chart-5",
    tagline: "Strong sovereign cloud story with competitive GPU pricing — ideal for Oracle-centric enterprises and regulated industries.",
    gettingStarted: [
      "Open OCI Console → AI Services → Generative AI → create a dedicated AI cluster or use on-demand endpoints.",
      "Use the Generative AI Agents service to create a RAG agent — connect an OCI Object Storage knowledge base.",
      "For custom agents: deploy your AgentSwarms-exported LangChain/LangGraph code on OCI Container Instances or OKE.",
      "Set up OCI Identity Domains for auth and IAM policies for least-privilege access.",
      "Use OCI Functions for tool integrations (equivalent to your AgentSwarms tools).",
      "Monitor with OCI Logging and set up alarms in OCI Monitoring for error rates and latency.",
    ],
    agentSwarmSkillsMap: [
      { skill: "Agent creation & system prompts", maps: "OCI Generative AI Agents + custom deployments" },
      { skill: "Knowledge Base / RAG", maps: "OCI Generative AI Agents RAG + OCI Search (OpenSearch)" },
      { skill: "Tool calling", maps: "OCI Functions + API Gateway integrations" },
      { skill: "Guardrails", maps: "Custom implementation via OCI Functions (content filters)" },
      { skill: "Memory", maps: "OCI NoSQL Database / Autonomous JSON DB" },
      { skill: "Swarm orchestration", maps: "OCI Data Flow + OCI Functions (custom orchestration)" },
      { skill: "Tracing & observability", maps: "OCI Logging + OCI Monitoring + APM" },
      { skill: "Export (LangChain/LangGraph)", maps: "Deploy on OCI Container Instances or OKE" },
    ],
    bestPractices: [
      "Use instance principals and dynamic groups instead of API keys for service-to-service auth.",
      "Leverage OCI's dedicated AI clusters for consistent latency in production.",
      "Use OCI Vault for secrets management (API keys, connection strings).",
      "Set up OCI Events + Notifications for real-time alerting on agent failures.",
      "Use Oracle Autonomous Database for structured agent state when you need SQL queries.",
      "Consider OCI's sovereign cloud regions for EU/government compliance requirements.",
    ],
    docs: [
      { label: "OCI Generative AI Service", href: "https://docs.oracle.com/en-us/iaas/Content/generative-ai/home.htm" },
      { label: "OCI Generative AI Agents", href: "https://docs.oracle.com/en-us/iaas/Content/generative-ai-agents/home.htm" },
      { label: "OCI Data Science (model training)", href: "https://docs.oracle.com/en-us/iaas/data-science/using/home.htm" },
      { label: "OCI Container Instances", href: "https://docs.oracle.com/en-us/iaas/Content/container-instances/home.htm" },
      { label: "OCI Functions (serverless)", href: "https://docs.oracle.com/en-us/iaas/Content/Functions/home.htm" },
      { label: "Oracle University AI Certifications", href: "https://education.oracle.com/oracle-cloud-infrastructure-2024-generative-ai-certified-professional/trackp_OCIGENAIP2024" },
    ],
    supportedModels: [
      "Cohere Command R / R+ / Embed",
      "Meta Llama 3.1 / 3.3",
      "Mistral Large / Mixtral",
      "Custom fine-tuned models (OCI Data Science)",
    ],
  },
];

/* ───────────────────── Persona checklists ───────────────────── */

export type PersonaTrack = {
  persona: Persona;
  icon: LucideIcon;
  title: string;
  intro: string;
  thirtyDay: string[];
  ninetyDay: string[];
  oneYear: string[];
  recommended: { label: string; href: string }[];
};

export const personaTracks: PersonaTrack[] = [
  {
    persona: "builder",
    icon: Wrench,
    title: "If you're a builder (engineer, data scientist, technical PM)",
    intro:
      "You can already make an agent work in the playground. The next 90 days are about operational maturity: evals, observability, security, and the boring deployment plumbing that makes the difference between a demo and a product.",
    thirtyDay: [
      "Pick one production-shaped pilot and write its one-page PRD (Phase 01).",
      "Build a 50+ case eval set in source control and wire it into CI (Phase 02).",
      "Add OpenTelemetry traces and a cost dashboard (Phase 04).",
      "Run garak or PyRIT against your agent and fix the top 5 findings (Phase 03).",
    ],
    ninetyDay: [
      "Ship behind a feature flag with a 5% → 100% staged rollout (Phase 05).",
      "Stand up a model gateway with at least one failover provider (Phase 05).",
      "Document and rehearse your kill-switch + rollback runbook (Phase 06).",
      "Pass an internal security review against OWASP LLM Top 10.",
    ],
    oneYear: [
      "Be on-call for the agent and run a quarterly business-impact review.",
      "Contribute back: an OSS eval, a blog post, a conference talk, or an internal RFC.",
      "Lead a paved-road template so the second team in your org ships in days.",
      "Earn a relevant credential (DeepLearning.AI, Microsoft AI-102, AWS AI Practitioner).",
    ],
    recommended: [
      { label: "DeepLearning.AI — AI Agents in LangGraph (free short course)", href: "https://www.deeplearning.ai/short-courses/ai-agents-in-langgraph/" },
      { label: "Anthropic — Building effective agents", href: "https://www.anthropic.com/research/building-effective-agents" },
      { label: "Microsoft Learn — AI-102 Designing & Implementing AI Solutions", href: "https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-engineer/" },
      { label: "AWS — Generative AI on AWS learning plan", href: "https://aws.amazon.com/training/learn-about/generative-ai/" },
    ],
  },
  {
    persona: "leader",
    icon: Building2,
    title: "If you're a leader (PM, ops, exec, founder)",
    intro:
      "You don't have to write the code, but you do have to make the right calls about scope, risk, and money. Your job in the next 90 days is to pick the right pilot, fund the operational scaffolding, and protect the team from premature scaling.",
    thirtyDay: [
      "Sponsor one narrow pilot with a named owner and a single success metric.",
      "Approve budget for evals + observability up front — not as an afterthought.",
      "Set the rule: nothing irreversible without a human signature.",
      "Write a one-page AI usage policy your team can actually read.",
    ],
    ninetyDay: [
      "Stand up an internal review board for high-risk agent actions.",
      "Adopt NIST AI RMF (or ISO/IEC 42001 if you sell into the EU) as your framework.",
      "Track $/successful-task and time-saved alongside revenue or CSAT.",
      "Plan for vendor + model deprecation (6–12 month cycles) in your roadmap.",
    ],
    oneYear: [
      "Fund a small platform team owning gateway, evals, observability, security.",
      "Move from per-project costs to per-team chargeback with quarterly reviews.",
      "Map all production agents to EU AI Act risk tiers if relevant.",
      "Run a tabletop incident exercise (model outage, leaked prompt, agent misuse).",
    ],
    recommended: [
      { label: "MIT Sloan — AI strategy & leadership programs", href: "https://executive.mit.edu/course-catalog/" },
      { label: "Wharton — AI for Business specialization (Coursera)", href: "https://www.coursera.org/specializations/ai-for-business-wharton" },
      { label: "BCG / McKinsey — annual State of AI reports", href: "https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai" },
      { label: "EU AI Act — high-level summary for executives", href: "https://artificialintelligenceact.eu/high-level-summary/" },
    ],
  },
];

/* ───────────────────── Mistakes & farewell ───────────────────── */

export const commonMistakes: { t: string; b: string }[] = [
  {
    t: "Demo-driven deployment",
    b: "Shipping the version that wowed the exec demo without a 5%/25%/50% rollout plan. Real users hit edge cases the demo never did.",
  },
  {
    t: "No eval set, no problem (until there is)",
    b: "Without a versioned eval set you cannot tell if your prompt change made things better or worse. Build it on day one, not after the first incident.",
  },
  {
    t: "Tools without blast-radius tags",
    b: "Every tool the agent can call should be tagged read / write / billable / external_comm — and the dangerous ones gated by HITL. The Replit incident is the canonical lesson.",
  },
  {
    t: "Single provider, single region, single model",
    b: "Providers rate-limit, deprecate models, and have outages. Build a gateway and test failover before you need it.",
  },
  {
    t: "Forgetting humans",
    b: "Agents change someone's job. Bring those people in early — as reviewers, as data labellers, as the first users. They will save the project.",
  },
];

export const farewell = {
  headline: "Go ship something real",
  body:
    "You've made it through the curriculum. You understand the building blocks, the patterns, the guardrails, the cost model and the production playbook. The only thing left is to pick one small, useful problem at your company or for your community — and solve it with what you've learned. We genuinely cannot wait to see what you build. If it teaches you something we missed, please write back so the next student gets a better map than you did. Good luck out there. ✨",
  signature: "— The AgentSwarms team",
};

export const roadmapIcons = {
  Rocket, ShieldCheck, Gauge, Users, Building2, Cloud, Server, Lock,
  GraduationCap, Compass, BookOpen, Wrench, Activity, Workflow,
};
