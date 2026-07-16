import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Brain,
  CheckCircle2,
  Clock,
  Code2,
  Compass,
  GraduationCap,
  Lightbulb,
  ListTree,
  Menu,
  MessageSquare,
  Network,
  ShieldCheck,
  Sparkles,
  Target,
  Telescope,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  Layers,
  Puzzle,
  Bot,
  GitBranch,
  Workflow,
  Database,
  Cpu,
  Activity,
  AlertTriangle,
  BarChart3,
  Building2,
  DollarSign,
  Gauge,
  Rocket,
  Scale,
  Shield,
  ChevronRight,
  BrainCircuit,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PresentationsSection } from "@/components/presentations/PresentationsSection";
import { BuildAlongSection } from "@/components/learn/BuildAlongSection";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
import { foundations, foundationGlossary, type Foundation } from "@/lib/learnFoundations";
import {
  scalingIntro,
  scalingPillars,
  caseStudies,
  bestPractices,
  maturityStages,
  scalingGlossary,
  type ScalingPillar,
} from "@/lib/learnScaling";
import {
  openAICompatIntro,
  openAICompatBenefits,
  openAICompatRequest,
  agentSwarmsCompat,
  aiSecurityIntro,
  aiSecurityWhyItMatters,
  aiSecurityThreats,
  aiSecurityHowToAchieve,
  roiIntro,
  roiFormulas,
  enterpriseCostScenarios,
  useCaseFitness,
  greenFlags,
  redFlags,
} from "@/lib/learnEnterprise";
import {
  Plug,
  ShieldAlert,
  TrendingUp,
  Coins,
  ThumbsUp,
  ThumbsDown,
  Calculator,
  MapPin,
  ListChecks,
  Route as RouteIcon,
  Briefcase,
  MessageCircle,
} from "lucide-react";
import { userGuideIntro, userJourney, sectionGuides, workflows } from "@/lib/learnUserGuide";
import {
  sqlAgentIntro,
  sqlPipeline,
  sqlSafety,
  sqlInAgentSwarms,
  sqlExampleQueries,
  sqlPitfalls,
  sqlRealWorld,
} from "@/lib/learnSqlAgents";
import {
  evalsIntro,
  evalPatterns,
  evalMetrics,
  evalWhenToRun,
  evalPitfalls,
  evalsInAgentSwarms,
} from "@/lib/learnEvaluations";
import {
  guardrailsIntro,
  guardrailLayers,
  injectionTypes,
  guardrailsInAgentSwarms,
  realWorldArchitectures,
  guardrailPitfalls,
} from "@/lib/learnGuardrails";
import {
  biAgentIntro,
  biPipeline,
  biSemanticLayer,
  biUnderTheHood,
  biBuildYourOwn,
  biIntegrationPatterns,
  biPitfalls,
  biRealWorld,
} from "@/lib/learnBiAgent";
import { QuizModule } from "@/components/QuizModule";
import { CurriculumProgress } from "@/components/CurriculumProgress";
import {
  roadmapIntro,
  roadmapPhases,
  deployPlatforms,
  personaTracks,
  commonMistakes,
  farewell,
  cloudCapabilities,
  cloudProviderGuides,
} from "@/lib/learnRoadmap";
import {
  EmbeddingsVisual,
  AttentionVisual,
  DiffusionVisual,
  RAGVisual,
  ReActVisual,
  PlanExecuteVisual,
  SwarmVisual,
  ToolCallVisual,
  MemoryVisual,
  AgenticRagVisual,
  GraphRagVisual,
  EvalPyramidVisual,
  SqlAgentVisual,
  SecurityThreatVisual,
  FrameworkStackVisual,
  FrameworkDecisionVisual,
} from "@/components/LearnVisuals";
import { frameworksDeep, stackExamples, doYouNeedItAll } from "@/lib/learnFrameworks";
import { deepDives, autonomyLevels } from "@/lib/learnDeepDives";
import {
  engineeringIntro,
  agentAxes,
  determinismIntro,
  detEmergentTable,
  failureIntro,
  failureModes,
  evalIntro,
  evalLayers,
  systemDesignIntro,
  designLevers,
  diagramTopologies,
  diagramFailure,
  diagramEvalLoop,
  diagramAgenticRag,
  engineeringPitfalls,
  engineeringFurtherReading,
} from "@/lib/learnEngineering";
import {
  productionDepthIntro,
  depthSections,
  productionDepthClosing,
} from "@/lib/learnProductionDepth";
import {
  foundationsDepthIntro,
  foundationsDepthSections,
  foundationsDepthClosing,
} from "@/lib/learnFoundationsDepth";
import {
  specializedDepthIntro,
  specializedDepthSections,
  specializedDepthClosing,
} from "@/lib/learnSpecializedDepth";
import {
  businessDepthIntro,
  businessDepthSections,
  businessDepthClosing,
} from "@/lib/learnBusinessDepth";
import {
  deepDivesDepthIntro,
  deepDivesDepthSections,
  deepDivesDepthClosing,
} from "@/lib/learnDeepDivesDepth";

export const Route = createFileRoute("/learn")({
  head: () => ({
    meta: [
      { title: "Learn Agentic AI — AgentSwarms Curriculum" },
      {
        name: "description",
        content:
          "An open, deep curriculum for Agentic & Generative AI: prompts, RAG, tools, guardrails, multi-agent swarms, observability, and evals — with real examples.",
      },
      { property: "og:title", content: "Learn Agentic AI — AgentSwarms" },
      {
        property: "og:description",
        content:
          "From your first prompt to multi-agent swarms in production. Hands-on lessons with code, examples, and real-world use cases.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/learn" },
      { name: "twitter:title", content: "Learn Agentic AI — AgentSwarms" },
      {
        name: "twitter:description",
        content:
          "From your first prompt to multi-agent swarms in production. Hands-on lessons with code, examples, and real-world use cases.",
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
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/learn" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Course",
          name: "Learn Agentic AI — AgentSwarms Curriculum",
          description:
            "An open, deep curriculum for Agentic & Generative AI: prompts, RAG, tools, guardrails, multi-agent swarms, observability, and evals.",
          url: "https://agentswarms.fyi/learn",
          provider: {
            "@type": "EducationalOrganization",
            name: "AgentSwarms",
            url: "https://agentswarms.fyi/",
          },
          inLanguage: "en",
          isAccessibleForFree: true,
          hasCourseInstance: {
            "@type": "CourseInstance",
            courseMode: "online",
            courseWorkload: "PT40H",
          },
        }),
      },
    ],
  }),
  component: LearnPage,
});

/* ─────────────────────────── CHAPTERS ─────────────────────────── */
// Curriculum is split into bite-sized chapters so learners aren't dropped
// into 4,000 lines of scrolling. One chapter renders at a time; prev/next
// + a sidebar TOC + a top progress bar keep them oriented. Last-read
// chapter persists in localStorage so resumes are painless.

type Chapter = {
  id: string;
  title: string;
  blurb: string;
  icon: typeof BookOpen;
  /** Estimated reading time in minutes for this chapter. */
  minutes: number;
  /** Anchor IDs inside this chapter (used for in-chapter jump-links). */
  anchors: { id: string; label: string }[];
};

const chapters: Chapter[] = [
  {
    id: "welcome",
    title: "Welcome & Choose Your Path",
    blurb: "Why this curriculum exists, what's inside, and three paths through it.",
    icon: Compass,
    minutes: 4,
    anchors: [
      { id: "intro", label: "Introduction" },
      { id: "paths", label: "Three learning paths" },
    ],
  },
  {
    id: "platform-handbook",
    title: "Use the Platform — Practical Handbook",
    blurb: "How to actually drive AgentSwarms day-to-day.",
    icon: MessageSquare,
    minutes: 12,
    anchors: [{ id: "using-agentswarms", label: "Using AgentSwarms" }],
  },
  {
    id: "foundations",
    title: "Foundations & Core Concepts",
    blurb: "Tokens, embeddings, attention, RAG, agents, memory — the vocabulary.",
    icon: BookOpen,
    minutes: 25,
    anchors: [
      { id: "foundations", label: "Foundations (10 building blocks)" },
      { id: "what-is-an-agent", label: "So… what is an agent?" },
      { id: "quiz-track-foundations", label: "📝 Quiz: Foundations" },
      { id: "foundations-depth", label: "Foundations field manual (deep)" },
      { id: "concepts", label: "Core concepts (10 patterns)" },
      { id: "quiz-track-patterns", label: "📝 Quiz: Patterns & Tools" },
      { id: "quiz-track-memory", label: "📝 Quiz: Agent Memory" },
    ],
  },
  {
    id: "engineering",
    title: "Engineering Rigor — Senior Mental Models",
    blurb: "Think about agents like a systems engineer: topology, determinism, failure, evals.",
    icon: Cpu,
    minutes: 18,
    anchors: [
      { id: "engineering", label: "Engineering rigor" },
      { id: "evaluations", label: "Evaluations — measuring agent quality" },
      { id: "production-depth", label: "Production field manual (deep)" },
    ],
  },
  {
    id: "specialized",
    title: "Specialized Agents — SQL & BI",
    blurb: "Agents that talk to your data: text-to-SQL pipelines and chat-with-charts.",
    icon: Database,
    minutes: 20,
    anchors: [
      { id: "sql-agents", label: "SQL & data-grounded agents" },
      { id: "quiz-track-sql", label: "📝 Quiz: Text-to-SQL Agents" },
      { id: "bi-agent", label: "BI Agent — chat with charts" },
      { id: "specialized-depth", label: "SQL & BI field manual (deep)" },
    ],
  },
  {
    id: "production",
    title: "Production & Business",
    blurb: "Scaling, OpenAI-compatible APIs, security, and real-world ROI math.",
    icon: Building2,
    minutes: 22,
    anchors: [
      { id: "guardrails-deep", label: "Guardrails deep dive" },
      { id: "scaling", label: "Scaling in the enterprise" },
      { id: "quiz-track-scaling", label: "📝 Quiz: Scaling & Responsible AI" },
      { id: "quiz-track-swarms", label: "📝 Quiz: Multi-Agent Swarms" },
      { id: "openai-compat", label: "OpenAI-compatible API" },
      { id: "security", label: "AI security" },
      { id: "roi", label: "ROI & economics" },
      { id: "business-depth", label: "Production & Business field manual (deep)" },
    ],
  },
  {
    id: "deep-dives",
    title: "Deep Dives — RAG & Frameworks",
    blurb: "Modern RAG variants, Graph RAG, frameworks, and protocols.",
    icon: Network,
    minutes: 24,
    anchors: [
      { id: "rag-variants", label: "Modern RAG variants" },
      { id: "graph-rag", label: "Graph RAG in AgentSwarms" },
      { id: "agentic-rag", label: "Agentic RAG — agents that decide what to retrieve" },
      { id: "frameworks", label: "Open-source frameworks" },
      { id: "frameworks-deep", label: "Frameworks deep dive — LangChain → PydanticAI" },
      { id: "protocols", label: "Protocols & vendor SDKs" },
      { id: "autonomy-levels", label: "Levels of autonomy (L1 → L5)" },
      { id: "dd-orchestration-dilemma", label: "DD · Orchestration dilemma" },
      {
        id: "dd-deterministic-skeletons",
        label: "DD · Deterministic skeletons, probabilistic workers",
      },
      { id: "dd-mcp-security", label: "DD · MCP security paradox" },
      { id: "dd-distributed-swarms", label: "DD · High-horizon autonomy & Actor Model" },
      { id: "dd-economics", label: "DD · Swarm economics & heterogeneous routing" },
      { id: "deep-dives-depth", label: "RAG & Frameworks field manual (deep)" },
    ],
  },
  {
    id: "build-here",
    title: "Build with AgentSwarms",
    blurb: "How AgentSwarms builds agents, runs swarms, and the tools shipped in-app.",
    icon: Wrench,
    minutes: 22,
    anchors: [
      { id: "how-we-build", label: "How AgentSwarms builds agents" },
      { id: "kb-internals", label: "Knowledge bases — how RAG works here" },
      { id: "memory-internals", label: "Agent memory under the hood" },
      { id: "skills-internals", label: "Skills — reusable capabilities" },
      { id: "swarm-runtime", label: "Swarm execution engine" },
      { id: "export-formats", label: "Export formats" },
      { id: "tools-deep", label: "Tools — full deep dive" },
      { id: "tools-here", label: "Tools in AgentSwarms" },
    ],
  },
  {
    id: "roadmap",
    title: "Roadmap, Glossary & What's Next",
    blurb: "Production roadmap, where to deploy, and your 30/90/365-day plan.",
    icon: RouteIcon,
    minutes: 14,
    anchors: [
      { id: "glossary", label: "Glossary" },
      { id: "roadmap", label: "Production roadmap" },
      { id: "cloud-deployment-guide", label: "Running agents on AWS / Azure / GCP / OCI" },
      { id: "next", label: "What next" },
    ],
  },
];

const TOTAL_CHAPTERS = chapters.length;
const LEARN_LAST_CHAPTER_KEY = "learn:lastChapter";
const LEARN_LAST_ANCHOR_PREFIX = "learn:lastAnchor:"; // + chapterIdx
const ANCHOR_TO_CHAPTER: Record<string, number> = {};
chapters.forEach((c, idx) => {
  c.anchors.forEach((a) => {
    ANCHOR_TO_CHAPTER[a.id] = idx;
  });
});

/* ─────────────────────────── DATA ─────────────────────────── */

type Concept = {
  id: string;
  number: string;
  icon: typeof MessageSquare;
  title: string;
  oneLiner: string;
  beginner: string;
  advanced: string;
  example: { title: string; language: string; code: string };
  realLife: string[];
  enterprise: string[];
  pitfalls: string[];
  furtherReading?: { label: string; href: string }[];
};

const concepts: Concept[] = [
  {
    id: "prompts",
    number: "01",
    icon: MessageSquare,
    title: "Prompts & System Messages",
    oneLiner:
      "The system prompt is your agent's constitution. Everything else — tools, RAG, swarms — sits on top of it.",
    beginner:
      "A prompt is just text you send to the model. The 'system' prompt is a special, sticky instruction that tells the model who it is and how to behave. The 'user' prompt is what the human asks. Models read both as one big conversation. Change the system prompt and the same model will talk like a teacher, a lawyer, or a sarcastic pirate.",
    advanced:
      "System prompts are the cheapest, highest-leverage place to encode policies, output schemas, refusal rules, and persona. Treat them like configuration: version them, write evals against them, and never let users override them via prompt-injection. Pair with structured outputs (JSON schema mode) to make the model's contract enforceable, not aspirational. Few-shot exemplars belong in the system prompt only when role-shaping fails — otherwise they bloat tokens and reduce instruction-following.",
    example: {
      title: "A reusable system-prompt template",
      language: "txt",
      code: `You are {{role}}, a helpful assistant for {{audience}}.

# Goals
- {{primary_goal}}
- Always cite sources when using retrieved context.

# Tone
- Friendly, concise, never condescending.

# Refusals
- If asked for medical, legal, or financial advice,
  acknowledge limits and suggest a professional.

# Output format
Respond in markdown. For lists, use "-".
For code, use fenced blocks with the language tag.`,
    },
    realLife: [
      "A study buddy that always quizzes back with 1 question",
      "A cooking assistant that converts units before answering",
      "A journaling coach that mirrors your mood",
    ],
    enterprise: [
      "Brand-voice enforcement across 50+ marketing agents",
      "Refusal policies for regulated content",
      "Locale-aware compliance disclaimers",
    ],
    pitfalls: [
      "Stuffing it with examples instead of rules",
      "Letting user input override system instructions",
      "Forgetting to version it — drift kills evals",
    ],
    furtherReading: [
      {
        label: "OpenAI prompting guide",
        href: "https://platform.openai.com/docs/guides/prompt-engineering",
      },
      {
        label: "Anthropic prompt library",
        href: "https://docs.anthropic.com/claude/prompt-library",
      },
    ],
  },
  {
    id: "rag",
    number: "02",
    icon: Brain,
    title: "RAG & Knowledge Bases",
    oneLiner:
      "Retrieval-Augmented Generation grounds the model in YOUR documents so answers come with citations instead of guesses.",
    beginner:
      "LLMs are trained on the public internet. They don't know your company handbook or your textbook. RAG fixes that: we (1) chop your docs into chunks, (2) embed them as vectors, (3) at query time, find the most-similar chunks and (4) paste them into the prompt. The model now answers from real text it can cite — not memory.",
    advanced:
      "Chunking is the single biggest lever. Semantic chunking outperforms fixed-size for narrative docs; recursive character splitting wins for code. Re-rank top-k with a cross-encoder before stuffing context — it cuts hallucinations dramatically. For multi-tenant RAG, namespace by tenant in your vector store and ALWAYS filter at query time, not in the prompt. Watch for retrieval failure modes: lost-in-the-middle, query/document mismatch (use HyDE or multi-query), and stale embeddings after model upgrades.",
    example: {
      title: "Minimal RAG loop (pseudocode)",
      language: "ts",
      code: `// 1. Index time
const chunks = chunkDocument(doc, { size: 500, overlap: 50 });
const vectors = await embed(chunks);
await vectorStore.upsert(vectors);

// 2. Query time
const queryVec = await embed([userQuestion]);
const top = await vectorStore.search(queryVec, { k: 8 });
const reranked = await rerank(userQuestion, top); // <- huge quality win

const prompt = \`
Answer using ONLY the context below. Cite as [1], [2].
Context:
\${reranked.map((c, i) => \`[\${i+1}] \${c.text}\`).join("\\n\\n")}

Question: \${userQuestion}
\`;
return llm.chat(prompt);`,
    },
    realLife: [
      "Q&A over a textbook you're studying",
      "Search across all your saved Pocket articles",
      "Family-recipe archive with semantic search",
    ],
    enterprise: [
      "Customer support over product docs (with citation links)",
      "Legal-discovery assistant scoped to one matter",
      "Internal HR/policy bot with audit-grade sources",
    ],
    pitfalls: [
      "Chunk size too large → retrieval is noisy",
      "Forgetting to dedupe near-duplicate chunks",
      "Trusting cosine similarity without re-ranking",
    ],
    furtherReading: [
      { label: "Pinecone — RAG mistakes", href: "https://www.pinecone.io/learn/series/rag/" },
      { label: "LlamaIndex docs", href: "https://docs.llamaindex.ai/" },
      { label: "Microsoft GraphRAG", href: "https://microsoft.github.io/graphrag/" },
      {
        label: "Anthropic — Contextual Retrieval",
        href: "https://www.anthropic.com/news/contextual-retrieval",
      },
    ],
  },
  {
    id: "tools",
    number: "03",
    icon: Wrench,
    title: "Tools, Function Calling & MCP",
    oneLiner:
      "Tools turn an LLM from a talker into a doer. MCP is becoming the standard wire-format for exposing them.",
    beginner:
      "A 'tool' is just a function the model can choose to call. You describe it (name, params, what it does) in JSON. The model decides when to call it, you actually run it, and feed the result back. That's how agents check the weather, send emails, or query a database.",
    advanced:
      "Design tools to be idempotent and side-effect-explicit. Always return structured results (not freeform strings) so downstream agents can parse them. For dangerous tools, gate behind HITL approvals. MCP (Model Context Protocol) standardizes this so the SAME tool server works with Claude Desktop, your custom agent, and any compatible client — like USB-C for AI tools. Avoid mega-tools; prefer many small, composable tools — the model's tool-selection accuracy degrades fast above ~15 tools, so use a router agent to gate which tools are visible per turn.",
    example: {
      title: "OpenAI-style tool definition",
      language: "json",
      code: `{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a city.",
    "parameters": {
      "type": "object",
      "properties": {
        "city":  { "type": "string", "description": "e.g. 'Berlin'" },
        "units": { "type": "string", "enum": ["c", "f"], "default": "c" }
      },
      "required": ["city"]
    }
  }
}`,
    },
    realLife: [
      "Calendar agent that books appointments",
      "Smart-home agent that dims lights on movie night",
      "Personal CRM that updates contacts after every call",
    ],
    enterprise: [
      "Salesforce / Jira / ServiceNow automation",
      "Internal MCP server fronting your data warehouse",
      "Approval-gated refunds, deletes, money movement",
    ],
    pitfalls: [
      "Vague descriptions → model picks the wrong tool",
      "Letting the model see 50 tools at once",
      "No timeouts → hung tool calls eat budget",
    ],
    furtherReading: [
      { label: "Model Context Protocol", href: "https://modelcontextprotocol.io" },
      {
        label: "OpenAI function calling",
        href: "https://platform.openai.com/docs/guides/function-calling",
      },
    ],
  },
  {
    id: "guardrails",
    number: "04",
    icon: ShieldCheck,
    title: "Guardrails & Human-in-the-Loop",
    oneLiner:
      "Production agents need brakes. Filters at the input, schemas at the output, humans for the scary stuff.",
    beginner:
      "A guardrail is anything that says 'no' or 'wait'. Examples: redact emails before sending to the model (input filter), refuse to return a SQL DROP statement (output filter), or pause and ask a human before refunding $10,000 (HITL approval). They keep your agent safe and your users (and lawyers) happy.",
    advanced:
      "Layer guardrails: input validation → prompt-injection defense → output schema validation → policy classifier → HITL approval gate for high-risk actions. Treat prompt-injection as inevitable, not preventable; design tools so the worst-case unauthorized call is recoverable. For HITL, design for fast async approvals (Slack/email) rather than blocking tool calls — agents that wait too long get killed. Track approval latency as a first-class metric.",
    example: {
      title: "HITL approval pattern",
      language: "ts",
      code: `async function refundCustomer(args: RefundArgs) {
  // 1. Check policy
  if (args.amount > 1000) {
    const approval = await approvals.create({
      action_title: \`Refund $\${args.amount} to \${args.customerId}\`,
      action_type:  "refund",
      risk_level:   "high",
      payload:      args,
    });
    return { status: "pending_approval", id: approval.id };
  }
  // 2. Auto-approve small refunds
  return stripe.refunds.create(args);
}`,
    },
    realLife: [
      "Email-drafting agent that pauses before SENDING",
      "Smart-home agent that asks before unlocking the door",
      "Trading bot that won't execute over $X without you",
    ],
    enterprise: [
      "PII redaction for GDPR/HIPAA compliance",
      "SOC2-compliant approval workflows",
      "Policy-as-code with OPA / Cedar integration",
    ],
    pitfalls: [
      "Trusting model self-policing ('please don't do X')",
      "Approval queues that take days → agents abandoned",
      "No rollback path when a guardrail fires mid-flow",
    ],
  },
  {
    id: "swarms",
    number: "05",
    icon: Network,
    title: "Multi-Agent Swarms",
    oneLiner:
      "One agent is a worker. A swarm is a team. Routers delegate, workers specialize, reviewers verify.",
    beginner:
      "Imagine a research project. You wouldn't ask one person to find sources, write the report, AND fact-check it. A swarm splits those jobs: a Researcher agent finds info, a Writer agent drafts, a Reviewer agent checks. Each one is simpler and better at its job. They pass messages between each other.",
    advanced:
      "Two dominant patterns: (1) Orchestrator-workers — a central router decides who works next, gives clean handoffs, easy to trace; (2) Peer-to-peer — agents broadcast and self-organize, more emergent but harder to debug. Start with orchestrator. Use shared scratchpad memory (a typed object) for state between handoffs rather than stuffing prior messages. Watch for cascading hallucinations: a downstream agent treating an upstream agent's guess as fact. Mitigate with structured outputs + verifier agents on critical paths.",
    example: {
      title: "Researcher → Writer → Reviewer pattern",
      language: "ts",
      code: `// Orchestrator pseudocode
const research = await researcher.run({ topic });
//  research = { sources: [...], notes: "..." }

const draft = await writer.run({ research });
//  draft = { markdown: "...", citations: [...] }

const review = await reviewer.run({ draft, sources: research.sources });
//  review = { approved: bool, issues: [...] }

if (!review.approved) {
  return writer.run({ research, feedback: review.issues });
}
return draft;`,
    },
    realLife: [
      "Trip planner: search → budget → itinerary",
      "Newsletter swarm: scout → write → fact-check",
      "Job hunt: scrape jobs → tailor resume → cover letter",
    ],
    enterprise: [
      "Underwriting pipeline: extract → score → review",
      "RFP response: parse → draft → legal review → format",
      "Multi-step ops automation with HITL approvals",
    ],
    pitfalls: [
      "Splitting too early — 1 good agent beats 3 confused ones",
      "Loose handoffs (free text instead of typed objects)",
      "No global timeout → infinite agent ping-pong",
    ],
  },
  {
    id: "observability",
    number: "06",
    icon: Telescope,
    title: "Observability & Evals",
    oneLiner: "If you can't trace it, you can't trust it. If you can't eval it, you can't ship it.",
    beginner:
      "Every agent run produces a 'trace' — the prompt, the response, tokens used, tools called, cost, latency. Looking at traces is how you debug. 'Evals' are little tests: did the answer cite the right doc? Was it under 200 words? Did it refuse the bad request? Run evals on every change so you don't break things.",
    advanced:
      "Evals come in three flavors: (1) deterministic checks (regex, JSON schema, citation presence), (2) LLM-as-judge (cheap, noisy — always sample-validate against humans), (3) human-graded golden sets (gold standard, expensive). Build all three. Track regressions per-prompt-version, per-model. Cost & latency are first-class quality metrics — a correct answer that costs $5 and takes 30s is a bug. Wire traces into your existing observability stack (OpenTelemetry → Datadog/Honeycomb).",
    example: {
      title: "A tiny eval suite",
      language: "ts",
      code: `const cases = [
  { q: "What is our refund policy?",
    must_cite: "policies/refunds.md",
    must_not: ["I don't know", "as an AI"] },
  { q: "Cancel my account",
    expect_tool: "create_approval",
    expect_risk: "high" },
];

for (const c of cases) {
  const trace = await runAgent(c.q);
  assert(trace.citations.includes(c.must_cite));
  for (const phrase of c.must_not ?? [])
    assert(!trace.response.includes(phrase));
}`,
    },
    realLife: [
      "Catch your tutor when it goes off-topic",
      "Track which prompts burn the most credits",
    ],
    enterprise: [
      "SLA monitoring on agent latency",
      "Cost attribution per team / customer",
      "Audit trails for SOC2 / HIPAA / GDPR",
    ],
    pitfalls: [
      "'Vibes-based' evals → silent regressions",
      "Logging without redaction → PII leak",
      "Tracking accuracy but ignoring cost & latency",
    ],
  },
];

const learningPaths = [
  {
    title: "Total Beginner — 'I've used ChatGPT, that's it'",
    weeks: "Weekend 1",
    icon: Sparkles,
    steps: [
      "Read concept 01 (Prompts) — try changing the system prompt of a template",
      "Read concept 02 (RAG) — upload a PDF, ask 5 questions",
      "Skim concept 03 (Tools) — run the demo Research agent",
      "Stop. You now know more than 90% of people talking about agents.",
    ],
  },
  {
    title: "Builder — 'I've shipped a chatbot, want to go deeper'",
    weeks: "Week 1-2",
    icon: Wrench,
    steps: [
      "All 6 concepts, in order, do every example",
      "Fork a template, swap models, compare traces",
      "Build your own swarm with 3 agents",
      "Add guardrails + an HITL approval gate",
      "Write your first 10-case eval suite",
    ],
  },
  {
    title: "Advanced — 'I'm taking agents to production'",
    weeks: "Ongoing",
    icon: Target,
    steps: [
      "Compare 3 providers on the same eval set — pick by cost+latency, not vibes",
      "Build a multi-tenant RAG with namespaced vector stores",
      "Wire OpenTelemetry from your traces into your APM",
      "Design a HITL approval flow with <2-min p95 latency",
      "Run shadow-mode evals on every prompt change",
    ],
  },
];

const glossary = [
  [
    "Agent",
    "An LLM with a system prompt, optional tools, and memory — capable of multi-step reasoning toward a goal.",
  ],
  [
    "RAG",
    "Retrieval-Augmented Generation. Inject relevant chunks from your docs into the prompt so the model can cite real sources.",
  ],
  [
    "Tool / Function call",
    "A typed action the model can invoke (search_web, send_email, query_db). The agent decides when to call it.",
  ],
  [
    "Guardrail",
    "Rules that filter input or output — PII redaction, profanity blocks, schema validation, cost caps.",
  ],
  ["HITL", "Human-in-the-Loop. Agent pauses for human approval before doing something risky."],
  [
    "MCP",
    "Model Context Protocol. A standard way to expose tools and data to any compatible agent.",
  ],
  ["Swarm", "Multiple specialized agents that hand off work to each other."],
  [
    "Eval",
    "A test suite for agents. Score outputs on accuracy, format, safety, cost — not just vibes.",
  ],
  ["Embedding", "A numeric vector representation of text. Similar meanings → similar vectors."],
  [
    "Vector store",
    "A database that indexes embeddings for fast similarity search (Pinecone, Weaviate, pgvector).",
  ],
  ["Token", "A chunk of text the model reads/writes. ~4 chars in English. You pay per token."],
  ["Temperature", "0 = deterministic, 1 = creative. Lower for facts, higher for brainstorming."],
  ["Few-shot", "Including examples of input→output pairs in the prompt to shape behavior."],
  [
    "Chain-of-thought",
    "Asking the model to reason step-by-step before answering. Improves hard tasks, costs more tokens.",
  ],
  [
    "Prompt injection",
    "User input that tries to override the system prompt. Treat as inevitable; design tools defensively.",
  ],
  ["LLM-as-judge", "Using one LLM to grade another's output. Cheap eval, but bias-prone."],
  [
    "SQL agent (text-to-SQL)",
    "An agent equipped with a sql_query tool that turns natural-language questions into validated SELECT statements, executes them, and answers in plain English. In AgentSwarms: SELECT-only, AST-parsed, 50-row capped, RLS-isolated.",
  ],
  [
    "Table allow-list",
    "Per-agent restriction (toolConfigs.sql_table_names) that limits which tables a SQL agent can read. Defense in depth on top of RLS.",
  ],
  ...foundationGlossary,
  ...scalingGlossary,
];

/* ─────────────── OPEN-SOURCE FRAMEWORK COMPARISON ─────────────── */

type Framework = {
  name: string;
  tagline: string;
  language: string;
  bestFor: string;
  strengths: string[];
  weaknesses: string[];
  whoUses: string;
  github: string;
};

const frameworks: Framework[] = [
  {
    name: "LangChain / LangGraph",
    tagline: "The Swiss army knife. Chains, agents, and a graph runtime.",
    language: "Python · JS/TS",
    bestFor: "Rapid prototyping, RAG pipelines, multi-step graphs with explicit state.",
    strengths: [
      "Huge ecosystem of integrations (200+ vector stores, models, tools)",
      "LangGraph adds a real state machine with checkpoints + HITL",
      "First-class observability via LangSmith",
    ],
    weaknesses: [
      "Heavy abstractions can hide what the LLM actually sees",
      "Frequent breaking changes — pin versions",
      "Easy to over-engineer simple chatbots",
    ],
    whoUses: "Teams shipping production RAG + multi-agent workflows.",
    github: "https://github.com/langchain-ai/langchain",
  },
  {
    name: "LlamaIndex",
    tagline: "RAG-first framework. Data → index → query, batteries included.",
    language: "Python · TS",
    bestFor: "Anything where retrieval quality is the #1 metric.",
    strengths: [
      "Best-in-class document loaders, parsers, and indexing strategies",
      "Advanced retrieval: hybrid, recursive, sub-question, agentic",
      "Workflows API for event-driven multi-agent flows",
    ],
    weaknesses: ["Less batteries for non-RAG agent patterns", "API surface is large and evolving"],
    whoUses: "Doc-QA, knowledge assistants, research copilots.",
    github: "https://github.com/run-llama/llama_index",
  },
  {
    name: "CrewAI",
    tagline: "Role-based crews. 'A team of agents with jobs and a boss.'",
    language: "Python",
    bestFor: "Multi-agent collaboration with clear roles and tasks.",
    strengths: [
      "Intuitive: Agent + Task + Crew is easy to teach",
      "Sequential and hierarchical processes out of the box",
      "Plays nicely with LangChain tools",
    ],
    weaknesses: [
      "Less control than building the orchestration yourself",
      "Fewer production-grade observability hooks",
    ],
    whoUses: "Content ops, research swarms, marketing automations.",
    github: "https://github.com/crewAIInc/crewAI",
  },
  {
    name: "AutoGen (Microsoft)",
    tagline: "Conversational multi-agent framework with code-execution.",
    language: "Python · .NET",
    bestFor: "Agents that talk to each other and write/run code.",
    strengths: [
      "Strong multi-agent chat patterns (group chat, nested chat)",
      "Built-in code executor and human proxy agent for HITL",
      "Backed by Microsoft Research",
    ],
    weaknesses: [
      "Free-form chat handoffs can be hard to debug at scale",
      "Steeper learning curve than CrewAI",
    ],
    whoUses: "R&D, code-generation pipelines, complex task decomposition.",
    github: "https://github.com/microsoft/autogen",
  },
  {
    name: "OpenAI Agents SDK",
    tagline: "Lightweight, opinionated. Built around handoffs + guardrails.",
    language: "Python · JS",
    bestFor: "Production agents on OpenAI/compatible models with minimal magic.",
    strengths: [
      "Tiny API surface — handoffs, guardrails, tracing",
      "Native streaming + structured outputs",
      "Excellent default tracing UI",
    ],
    weaknesses: ["Tighter coupling to OpenAI Responses API", "Smaller ecosystem than LangChain"],
    whoUses: "Teams that already standardised on OpenAI/Azure OpenAI.",
    github: "https://github.com/openai/openai-agents-python",
  },
  {
    name: "Pydantic AI",
    tagline: "Type-safe agents for the FastAPI generation.",
    language: "Python",
    bestFor: "Backend devs who want validated I/O and dependency injection.",
    strengths: [
      "Pydantic everywhere — inputs, outputs, tool schemas",
      "Model-agnostic (OpenAI, Anthropic, Gemini, local)",
      "Great DX for testing and mocking",
    ],
    weaknesses: ["Younger ecosystem; fewer pre-built integrations", "Python-only today"],
    whoUses: "Production backends that already use FastAPI/Pydantic.",
    github: "https://github.com/pydantic/pydantic-ai",
  },
  {
    name: "Haystack (deepset)",
    tagline: "Production search + RAG pipelines, pipeline-graph first.",
    language: "Python",
    bestFor: "Enterprise search, hybrid retrieval, document Q&A at scale.",
    strengths: [
      "Pipeline graphs are explicit and serializable (YAML)",
      "Strong on hybrid search, evals, and deployment",
      "Mature, used in regulated industries",
    ],
    weaknesses: [
      "Less focus on free-form 'agentic' loops",
      "Heavier than CrewAI for small projects",
    ],
    whoUses: "Enterprises building internal search & QA systems.",
    github: "https://github.com/deepset-ai/haystack",
  },
  {
    name: "Semantic Kernel (Microsoft)",
    tagline: "Agent framework for .NET / Java / Python with planners.",
    language: "C# · Python · Java",
    bestFor: "Enterprise .NET/Java shops integrating LLMs into existing apps.",
    strengths: [
      "First-class .NET and Java support — rare in this space",
      "Plugins, planners, and memory abstractions",
      "Tight Azure integration",
    ],
    weaknesses: [
      "Smaller community vs Python-first frameworks",
      "Concepts (planners, plugins) take time to click",
    ],
    whoUses: "Microsoft-stack enterprises adopting AI features.",
    github: "https://github.com/microsoft/semantic-kernel",
  },
];

/* ───────────── AGENT PROTOCOLS & VENDOR SDKs ───────────── */

type Protocol = {
  name: string;
  fullName: string;
  vendor: string;
  kind: "Protocol" | "SDK" | "Framework" | "Runtime";
  tagline: string;
  beginner: string;
  advanced: string;
  bestFor: string;
  language: string;
  link: string;
};

const protocols: Protocol[] = [
  {
    name: "MCP",
    fullName: "Model Context Protocol",
    vendor: "Anthropic (open standard)",
    kind: "Protocol",
    tagline: "USB-C for tools and data. One server → any compatible agent client.",
    beginner:
      "MCP is a standard wire-format. You write a tiny server that exposes 'tools' and 'resources' (e.g. read_jira_ticket, list_s3_files). Any MCP-aware client — Claude Desktop, Cursor, AgentSwarms — can call it. You write the integration once and it works everywhere.",
    advanced:
      "Transport-agnostic (stdio, HTTP, SSE). Capability-negotiated handshake. Resources are addressable URIs the model can subscribe to (live data feeds, not just one-shot calls). Adoption is the moat: OpenAI, Google, and most agent frameworks now ship MCP clients. Pair MCP with OAuth 2.1 + per-tenant scopes for multi-tenant SaaS exposure.",
    bestFor:
      "Exposing your internal tools/data to many agent clients without N×M integration glue.",
    language: "Python · TS · Rust · others",
    link: "https://modelcontextprotocol.io",
  },
  {
    name: "A2A",
    fullName: "Agent-to-Agent Protocol",
    vendor: "Google + 50+ partners",
    kind: "Protocol",
    tagline: "How agents from different vendors talk to each other.",
    beginner:
      "If MCP is how an agent talks to TOOLS, A2A is how an agent talks to OTHER AGENTS — even ones built by a different company on a different framework. Each agent publishes an 'agent card' (what it can do, how to reach it). Other agents discover it and send tasks over a standard JSON-RPC channel.",
    advanced:
      "Modeled around long-running tasks (not request/response): tasks have states (submitted, working, input-required, completed), streaming updates via SSE, and signed artifacts. Designed for cross-org trust boundaries — auth, billing, capability discovery are first-class. Complements MCP: an A2A agent can itself be an MCP client. Watch for Google ADK + A2A reference implementations as the de-facto starter kit.",
    bestFor: "Multi-vendor agent ecosystems, agent marketplaces, cross-org workflows.",
    language: "Any (HTTP/JSON-RPC)",
    link: "https://a2a-protocol.org",
  },
  {
    name: "Google ADK",
    fullName: "Agent Development Kit",
    vendor: "Google",
    kind: "SDK",
    tagline: "Google's open-source SDK for building, evaluating, and deploying agents.",
    beginner:
      "ADK is to Google what the OpenAI Agents SDK is to OpenAI: an opinionated kit for building production agents. You define agents in Python, give them tools, compose them into workflows (sequential, parallel, loop), and ship to Cloud Run or Vertex AI Agent Engine.",
    advanced:
      "Model-agnostic despite Google branding (works with Gemini, Claude, GPT, OSS via LiteLLM). First-class A2A support — agents you build are A2A-callable out of the box. Built-in eval harness, declarative workflows, callback hooks at every lifecycle step. Sweet spot: GCP shops standardising on Vertex but wanting open code, not a black box.",
    bestFor: "GCP-native teams shipping production agents with eval + deploy story.",
    language: "Python · Java",
    link: "https://github.com/google/adk-python",
  },
  {
    name: "AWS Strands",
    fullName: "Strands Agents SDK",
    vendor: "AWS (open-source)",
    kind: "SDK",
    tagline: "Model-driven agents in a few lines. 'The model IS the agent loop.'",
    beginner:
      "Strands flips the script: instead of you writing a giant orchestration graph, you give the model tools and let IT decide the loop. Define an agent in ~10 lines: pick a model, list tools, hit run. The SDK handles the think→act→observe cycle.",
    advanced:
      "Production-tested inside AWS (powering Q Developer, parts of Bedrock). Provider-agnostic (Bedrock, Anthropic, OpenAI, Ollama, LiteLLM). Native MCP client, OpenTelemetry tracing, multi-agent primitives (swarm, graph, agents-as-tools). Pairs naturally with Bedrock AgentCore for memory, identity, gateway, and code-interpreter as managed services. Best when you trust the model to plan and you don't want LangGraph-level ceremony.",
    bestFor: "AWS shops, fast iteration, model-driven (vs graph-driven) agent design.",
    language: "Python",
    link: "https://strandsagents.com",
  },
  {
    name: "Bedrock AgentCore",
    fullName: "Amazon Bedrock AgentCore",
    vendor: "AWS",
    kind: "Runtime",
    tagline: "Managed runtime services (memory, identity, gateway, browser, code-interpreter).",
    beginner:
      "AgentCore isn't a framework — it's the BORING infra under your agents: long-term memory store, OAuth identity broker, MCP gateway, sandboxed browser & Python interpreter, and an observability dashboard. Use it with Strands, LangGraph, or your own code.",
    advanced:
      "Framework-agnostic by design. AgentCore Runtime gives serverless, session-isolated, long-running agent execution. Gateway turns Lambda/OpenAPI/Smithy into MCP tools automatically. Memory has both short-term (session) and long-term (semantic, summary, user-preference) tiers. Identity handles OAuth flows so agents can act on behalf of users without you re-implementing token refresh. Pricing is consumption-based — watch it on long-running agents.",
    bestFor: "Production AWS agents that need managed memory, auth, and tool gateways.",
    language: "Any (service APIs)",
    link: "https://aws.amazon.com/bedrock/agentcore/",
  },
  {
    name: "OpenAI Agents SDK",
    fullName: "OpenAI Agents SDK (formerly Swarm)",
    vendor: "OpenAI",
    kind: "SDK",
    tagline: "Tiny, opinionated. Handoffs + guardrails + tracing. That's it.",
    beginner:
      "If you're already on OpenAI and want the smallest possible API to ship a multi-agent system, this is it. Three primitives: Agent (a model + instructions + tools), Handoff (transfer control to another agent), Guardrail (input/output validation).",
    advanced:
      "Built on the Responses API — get streaming, structured outputs, and the OpenAI tracing UI for free. Provider-extensible via LiteLLM, but the magic is OpenAI-tight. Sessions, voice agents, and realtime agents are first-class. Compare to Strands philosophically: both are minimal and model-driven.",
    bestFor: "Teams standardised on OpenAI/Azure OpenAI who want zero-magic orchestration.",
    language: "Python · JS",
    link: "https://github.com/openai/openai-agents-python",
  },
  {
    name: "Letta (MemGPT)",
    fullName: "Letta",
    vendor: "Letta Labs (open-source)",
    kind: "Framework",
    tagline: "Stateful agents with operating-system-style memory management.",
    beginner:
      "Most agents forget you the moment the chat ends. Letta agents have a real memory hierarchy — core memory (always in context), recall memory (searchable history), archival memory (long-term store) — and they manage it themselves with memory-edit tools.",
    advanced:
      "Born from the MemGPT paper. Server-first architecture: agents are persistent server-side objects you call via REST/SDK, not in-process Python objects. Excellent fit for personal-assistant and customer-success agents that need to remember users across weeks. Pairs well with A2A for multi-agent personal AI.",
    bestFor: "Long-lived personal/customer agents that must remember context indefinitely.",
    language: "Python · TS",
    link: "https://github.com/letta-ai/letta",
  },
];

/* ───────────── MODERN RAG VARIANTS ───────────── */

type RagVariant = {
  name: string;
  oneLiner: string;
  beginner: string;
  advanced: string;
  whenToUse: string;
  link?: { label: string; href: string };
};

const ragVariants: RagVariant[] = [
  {
    name: "Naive RAG",
    oneLiner: "Chunk → embed → top-k → stuff into prompt. The starting point.",
    beginner:
      "Split docs into ~500-token chunks, embed them, find the closest k chunks to the question, paste into the prompt. This is the RAG everyone shows in tutorials. It works for ~60% of cases.",
    advanced:
      "Failure modes: query/document vocabulary mismatch, lost-in-the-middle on large k, near-duplicate chunks crowding out diverse context, no awareness of doc structure. Useful as a baseline to beat with the variants below.",
    whenToUse: "Prototypes, narrow corpora, when you're proving the concept.",
  },
  {
    name: "Hybrid search (dense + sparse)",
    oneLiner: "Combine semantic embeddings with BM25 keyword search.",
    beginner:
      "Vectors are great at meaning ('sad' ≈ 'unhappy') but bad at exact tokens (product codes, names, error IDs). Hybrid runs both BM25 and vector search, then merges the results — best of both worlds.",
    advanced:
      "Use Reciprocal Rank Fusion (RRF) or weighted score-sum; tune α per corpus. pgvector + tsvector, or Weaviate / Qdrant / Elasticsearch all support hybrid natively. On heterogeneous corpora hybrid lifts recall@10 by 10–25% with almost no engineering cost.",
    whenToUse: "Anything with codes, IDs, names, jargon, or short queries.",
  },
  {
    name: "Re-ranking (cross-encoder)",
    oneLiner: "Retrieve 50–100 cheap, then re-score with a precise model.",
    beginner:
      "Embeddings retrieve fast but coarsely. A cross-encoder (e.g. Cohere Rerank, BGE-reranker) reads the question + each candidate together and scores relevance — slower per-item but dramatically more accurate. Keep top 5–10 after re-rank.",
    advanced:
      "The single highest-ROI upgrade after naive RAG. Latency cost ~50–200ms for 50 docs. ColBERT (late-interaction) is a middle ground when you can't afford a full cross-encoder. Always re-rank before stuffing — it cuts hallucinations more than any prompt tweak.",
    whenToUse: "Always, in production. Skip only if latency budget is sub-100ms.",
    link: { label: "Cohere Rerank", href: "https://cohere.com/rerank" },
  },
  {
    name: "HyDE (Hypothetical Document Embeddings)",
    oneLiner: "Ask the LLM to draft a fake answer first, then embed THAT.",
    beginner:
      "Sometimes the user's question doesn't sound like the document that answers it. HyDE has the LLM imagine a plausible answer, then searches for chunks similar to the imagined answer. Closes the query↔doc vocabulary gap.",
    advanced:
      "Cheap query expansion with measurable wins on out-of-domain queries. Combine with multi-query (generate 3–5 paraphrases, retrieve for each, dedupe). Tradeoff: an extra LLM call per question. Skip when queries already mirror doc style (e.g. internal Q&A logs).",
    whenToUse: "Domain-specific corpora where users ask in plain English.",
  },
  {
    name: "Contextual Retrieval",
    oneLiner: "Prepend an LLM-generated context paragraph to each chunk before embedding.",
    beginner:
      "A chunk like 'Revenue grew 12%' is meaningless without knowing 'this is from Apple's Q3 2024 10-Q'. Contextual Retrieval uses an LLM at index time to add a one-line context to every chunk, then embeds the enriched chunk. Retrieval becomes much sharper.",
    advanced:
      "Anthropic's 2024 technique. Combined with hybrid search + re-ranking, they report a ~67% reduction in retrieval failures. Index-time cost only — query path stays cheap. Pair with prompt caching to keep the index step affordable on large corpora.",
    whenToUse: "Long, structured docs (filings, manuals, contracts) where chunk context matters.",
    link: { label: "Anthropic post", href: "https://www.anthropic.com/news/contextual-retrieval" },
  },
  {
    name: "Graph RAG",
    oneLiner: "Build a knowledge graph from your docs; retrieve entities and their relationships.",
    beginner:
      "Vector RAG finds passages. Graph RAG finds CONNECTIONS. An LLM extracts entities (people, products, events) and relations from your docs into a graph. At query time, you traverse the graph to gather connected facts — perfect for 'how is X related to Y?' questions vector search fundamentally can't answer.",
    advanced:
      "Microsoft's GraphRAG popularized two retrieval modes: local (one entity + neighborhood) and global (community summaries via Leiden clustering). Indexing is expensive (LLM calls per chunk for entity/relation extraction); querying is fast. Hybrid graph+vector setups (LightRAG, GraphRAG-style) outperform either alone on multi-hop QA. Tools: Neo4j, Kuzu, Memgraph, NebulaGraph.",
    whenToUse:
      "Multi-hop reasoning, investigative QA, sense-making over large heterogeneous corpora.",
    link: { label: "Microsoft GraphRAG", href: "https://microsoft.github.io/graphrag/" },
  },
  {
    name: "Agentic RAG",
    oneLiner:
      "An agent decides what to retrieve, when, from which index — possibly multiple times.",
    beginner:
      "Naive RAG retrieves once, blindly. Agentic RAG gives the LLM a 'search' tool (or several — one per index) and lets it issue queries, read results, then issue MORE queries until it has enough. Closer to how a human researches.",
    advanced:
      "Patterns: query-routing across multiple indexes, sub-question decomposition (LlamaIndex), self-RAG (retrieve only when uncertain), corrective RAG (CRAG — grade retrievals, fall back to web search if weak). Cost goes up; quality on complex queries goes way up. Always cap iteration count + total tokens.",
    whenToUse: "Complex questions spanning multiple sources or requiring iterative drill-down.",
  },
  {
    name: "Multi-modal RAG",
    oneLiner: "Embed and retrieve images, tables, charts — not just text.",
    beginner:
      "Documents aren't just words — financial reports have charts, manuals have diagrams, slides have screenshots. Multi-modal RAG uses vision-language models (CLIP, SigLIP, or full VLMs like Gemini / GPT-4o) to embed images directly so a question can retrieve the right chart, not just text near it.",
    advanced:
      "Two architectures: (1) caption-then-embed (cheap, lossy), (2) native vision embeddings (ColPali — page-as-image with late interaction, dramatically simpler than OCR pipelines). For tables, structured extraction (Unstructured, Reducto, Azure DI) often beats embedding raw text. Evaluate retrieval on visual queries separately from text.",
    whenToUse:
      "PDFs heavy with charts/tables, scanned docs, slide decks, product catalogs with images.",
  },
  {
    name: "Long-context vs RAG",
    oneLiner: "Models with 1M+ token windows change — but don't kill — RAG.",
    beginner:
      "Gemini and Claude can now read entire books in a single prompt. So why bother with RAG? Because cost scales linearly with context, latency too, and accuracy degrades for facts buried in the middle. RAG is still the right answer at scale.",
    advanced:
      "Practical rule: if your corpus fits in <50k tokens AND queries are infrequent, skip RAG. Otherwise hybrid wins — use RAG to shortlist 20–50 candidate chunks, then dump them into a long-context model for synthesis. Prompt caching (Claude, Gemini) further changes the math: cached static context can make 'medium-context RAG' nearly free.",
    whenToUse: "Always evaluate both — the right answer is corpus-, query-, and budget-dependent.",
  },
];

const buildPathways = [
  {
    title: "Hand-rolled (no framework)",
    when: "You want to truly understand what's happening, or you have one simple use case.",
    pros: ["Zero dependencies", "Full control of every prompt + token", "Easy to debug"],
    cons: [
      "You re-invent retries, tool routing, tracing, memory",
      "Hard to scale beyond 1–2 agents",
    ],
  },
  {
    title: "Code-first framework (LangChain, LlamaIndex, AutoGen, Pydantic AI)",
    when: "You're a developer shipping production agents with custom logic.",
    pros: [
      "Reusable abstractions",
      "Big ecosystem of tools + integrations",
      "Version-controlled in git",
    ],
    cons: ["Learning curve", "Abstractions can hide the prompt", "Frequent breaking changes"],
  },
  {
    title: "Visual / no-code (n8n, Flowise, Langflow, Dify)",
    when: "You want non-engineers to compose flows, or you need fast internal automations.",
    pros: ["Drag-and-drop graphs", "Great for ops, marketing, support teams", "Visual debugging"],
    cons: [
      "Hits a ceiling on complex logic",
      "Harder to test / version-control",
      "Vendor lock-in for hosted ones",
    ],
  },
  {
    title: "AgentSwarms (this platform)",
    when: "You want the visual benefits + a real backend + open-source export — without giving up code.",
    pros: [
      "Visual swarm builder backed by a typed runtime",
      "BYO model: OpenAI, Gemini, Claude, Grok, Qwen, Bedrock, Vertex, OCI, Azure",
      "Full traces, costs, evals, and HITL approvals",
      "Export any swarm to a portable .swarm.json — no lock-in",
    ],
    cons: ["Hosted lab (you're not running the runtime yourself, yet)"],
  },
];

/* ─────────────────────── TOOLS DEEP-DIVE ─────────────────────── */

type ToolCategory = {
  name: string;
  what: string;
  examples: string[];
  whyItMatters: string;
};

const toolCategories: ToolCategory[] = [
  {
    name: "Information / Retrieval tools",
    what: "Read-only tools that fetch facts the model doesn't have.",
    examples: ["search_web", "fetch_url", "query_knowledge_base", "get_weather", "lookup_user"],
    whyItMatters: "Cuts hallucinations. The model stops guessing and starts citing.",
  },
  {
    name: "Action tools (write / mutate)",
    what: "Tools that change state in another system.",
    examples: [
      "send_email",
      "create_ticket",
      "update_crm_record",
      "issue_refund",
      "deploy_service",
    ],
    whyItMatters:
      "Turn the agent from advisor into operator. Always gate dangerous ones with HITL.",
  },
  {
    name: "Computation tools",
    what: "Deterministic helpers that LLMs are bad at on their own.",
    examples: ["calculator", "run_sql", "execute_python", "convert_units", "parse_pdf"],
    whyItMatters:
      "Math, code, and parsing are deterministic — never trust an LLM to do them in its head.",
  },
  {
    name: "Memory tools",
    what: "Read/write the agent's long-term store.",
    examples: ["save_fact", "recall_fact", "update_user_preference", "list_recent_conversations"],
    whyItMatters: "Lets agents learn across sessions instead of starting from zero each time.",
  },
  {
    name: "Handoff / orchestration tools",
    what: "Tools that route work to another agent.",
    examples: ["transfer_to_specialist", "ask_reviewer_agent", "spawn_sub_swarm"],
    whyItMatters:
      "The wiring of multi-agent swarms — a handoff is just a tool call under the hood.",
  },
  {
    name: "Human-in-the-loop tools",
    what: "Tools that pause the agent and wait for a human decision.",
    examples: ["request_approval", "ask_user_confirmation", "escalate_to_oncall"],
    whyItMatters: "Your safety net for irreversible or high-cost actions.",
  },
];

const toolLifecycle = [
  {
    step: "1",
    title: "Describe",
    body: "You define the tool's name, params, and a one-sentence description. The model only sees this — make it crisp.",
  },
  {
    step: "2",
    title: "Expose",
    body: "The runtime sends the tool list with every model call. Keep the list small (<15) per turn for best accuracy.",
  },
  {
    step: "3",
    title: "Decide",
    body: "The model emits a tool_call with structured arguments — no execution yet, just intent.",
  },
  {
    step: "4",
    title: "Validate",
    body: "Your runtime validates args (schema, policy, budget, HITL gate) before doing anything.",
  },
  {
    step: "5",
    title: "Execute",
    body: "Run the tool. Apply timeouts, retries, and observability. Capture cost + latency.",
  },
  {
    step: "6",
    title: "Return",
    body: "Send a structured tool_result back to the model. It plans the next step or replies to the user.",
  },
];

/* ─────────────────────────── PAGE ─────────────────────────── */

function LearnPage() {
  const [activeChapter, setActiveChapter] = useState(0);
  const [mobileTocOpen, setMobileTocOpen] = useState(false);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  // Top-level view tab: curriculum chapters · presentations gallery · build-along labs.
  const [view, setView] = useState<"lessons" | "presentations" | "labs">("lessons");
  const presentMode = view !== "lessons"; // an overlay (presentations or labs) is showing
  // Allow deep links from the home page to open a specific tab, e.g. /learn#presentations.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = window.location.hash.replace("#", "");
    if (h === "presentations") setView("presentations");
    else if (h === "build-along" || h === "labs") setView("labs");
  }, []);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const isFirstRender = useRef(true);
  // When true, the next activeChapter change should NOT auto-scroll to top
  // or jump to a saved anchor — used when a deep link or in-page anchor click
  // already controls the scroll position.
  const skipAutoScrollRef = useRef(false);

  // Restore last-read chapter from localStorage on mount, but let direct hash
  // links like /learn#quiz-track-sql win so quiz links from Welcome work.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const scrollToHash = () => {
      const anchorId = window.location.hash.replace("#", "");
      if (!anchorId) return false;
      const targetChapter = ANCHOR_TO_CHAPTER[anchorId];
      if (targetChapter === undefined) return false;
      skipAutoScrollRef.current = true;
      setActiveChapter(targetChapter);
      window.setTimeout(() => {
        document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 350);
      return true;
    };

    if (!scrollToHash()) {
      try {
        const saved = window.localStorage.getItem(LEARN_LAST_CHAPTER_KEY);
        if (saved) {
          const idx = parseInt(saved, 10);
          if (!Number.isNaN(idx) && idx >= 0 && idx < TOTAL_CHAPTERS) {
            // Don't auto-scroll-to-top on initial mount restore — we want to
            // resume at the saved anchor inside that chapter (handled below).
            skipAutoScrollRef.current = true;
            setActiveChapter(idx);
          }
        }
      } catch {
        /* ignore — localStorage might be blocked */
      }
    }

    window.addEventListener("hashchange", scrollToHash);
    return () => window.removeEventListener("hashchange", scrollToHash);
  }, []);

  // Persist active chapter; on switch, either jump to top OR resume at the
  // last in-chapter anchor the user was reading.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
    } else {
      try {
        window.localStorage.setItem(LEARN_LAST_CHAPTER_KEY, String(activeChapter));
      } catch {
        /* ignore */
      }
    }
    setMobileTocOpen(false);

    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      // Still seed activeAnchorId from saved progress so the section bar
      // highlights correctly even when we don't auto-scroll.
      try {
        const savedAnchor = window.localStorage.getItem(LEARN_LAST_ANCHOR_PREFIX + activeChapter);
        if (savedAnchor && ANCHOR_TO_CHAPTER[savedAnchor] === activeChapter) {
          setActiveAnchorId(savedAnchor);
        } else {
          setActiveAnchorId(chapters[activeChapter]?.anchors[0]?.id ?? null);
        }
      } catch {
        /* ignore */
      }
      return;
    }

    // No deep-link override: try to resume at saved anchor, else top.
    let resumed = false;
    try {
      const savedAnchor = window.localStorage.getItem(LEARN_LAST_ANCHOR_PREFIX + activeChapter);
      if (savedAnchor && ANCHOR_TO_CHAPTER[savedAnchor] === activeChapter) {
        setActiveAnchorId(savedAnchor);
        // Defer until the new chapter content renders.
        window.setTimeout(() => {
          const el = document.getElementById(savedAnchor);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
            resumed = true;
          }
        }, 80);
      }
    } catch {
      /* ignore */
    }
    if (!resumed) {
      setActiveAnchorId(chapters[activeChapter]?.anchors[0]?.id ?? null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [activeChapter]);

  // Observe anchor sections inside the active chapter and track the topmost
  // visible one as the "currently reading" section. Persist to localStorage
  // so the next visit resumes here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const anchors = chapters[activeChapter]?.anchors ?? [];
    if (anchors.length === 0) return;

    const elements = anchors
      .map((a) => document.getElementById(a.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const visible = new Map<string, number>(); // id -> intersectionRatio

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            visible.set(entry.target.id, entry.intersectionRatio);
          } else {
            visible.delete(entry.target.id);
          }
        });
        // Choose the section that appears first in chapter order among visible.
        let chosen: string | null = null;
        for (const a of anchors) {
          if (visible.has(a.id)) {
            chosen = a.id;
            break;
          }
        }
        if (chosen) {
          setActiveAnchorId(chosen);
          try {
            window.localStorage.setItem(LEARN_LAST_ANCHOR_PREFIX + activeChapter, chosen);
          } catch {
            /* ignore */
          }
        }
      },
      {
        // Trigger when section is in the upper portion of the viewport.
        rootMargin: "-96px 0px -55% 0px",
        threshold: [0, 0.1, 0.5, 1],
      },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [activeChapter]);

  const goToChapter = (idx: number) => {
    if (idx < 0 || idx >= TOTAL_CHAPTERS) return;
    setActiveChapter(idx);
  };

  const jumpToAnchor = (anchorId: string) => {
    const targetChapter = ANCHOR_TO_CHAPTER[anchorId];
    if (targetChapter === undefined) return;
    const scrollToEl = () => {
      const el = document.getElementById(anchorId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        // Update URL hash without triggering another navigation.
        history.replaceState(null, "", `#${anchorId}`);
      }
    };
    if (targetChapter !== activeChapter) {
      skipAutoScrollRef.current = true;
      setActiveChapter(targetChapter);
      // Wait for the chapter switch + scroll-to-top to settle, then scroll
      // to the anchor inside the now-visible chapter.
      window.setTimeout(scrollToEl, 350);
    } else {
      scrollToEl();
    }
    setActiveAnchorId(anchorId);
    setMobileTocOpen(false);
  };

  const chapter = chapters[activeChapter];
  const ChapterIcon = chapter.icon;
  const progressPct = ((activeChapter + 1) / TOTAL_CHAPTERS) * 100;
  const chapterAnchors = chapter.anchors;
  const activeAnchorIdx = activeAnchorId
    ? Math.max(
        0,
        chapterAnchors.findIndex((a) => a.id === activeAnchorId),
      )
    : 0;
  const sectionProgressPct =
    chapterAnchors.length > 0 ? ((activeAnchorIdx + 1) / chapterAnchors.length) * 100 : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          {/* Row 1: brand + actions */}
          <div className="flex h-14 items-center justify-between gap-2 lg:h-16">
            <Link to="/" className="flex min-w-0 items-center gap-2">
              <img
                src={agentSwarmsLogo}
                alt="AgentSwarms School of Agentic AI logo"
                className="h-7 w-7 shrink-0 rounded-lg object-cover sm:h-8 sm:w-8"
              />
              <span className="truncate text-base font-bold tracking-tight sm:text-lg">
                AgentSwarms
              </span>
              <span className="ml-2 hidden rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:inline">
                Curriculum
              </span>
            </Link>
            {/* View tabs (desktop) — kept inline on lg+ for power users */}
            <div className="hidden lg:flex items-center gap-1 rounded-xl border border-primary/40 bg-primary/5 p-1 shadow-sm shadow-primary/10">
              <button
                type="button"
                onClick={() => setView("lessons")}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-sm font-semibold transition-all",
                  view === "lessons"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                Detailed Lessons
              </button>
              <button
                type="button"
                onClick={() => setView("presentations")}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-sm font-semibold transition-all",
                  view === "presentations"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                Presentations
              </button>
              <button
                type="button"
                onClick={() => setView("labs")}
                className={cn(
                  "relative inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-semibold transition-all",
                  view === "labs"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                Build-Along Labs
                <span className="ml-0.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow">
                  New
                </span>
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!presentMode && (
                <button
                  type="button"
                  onClick={() => setMobileTocOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground lg:hidden"
                  aria-label="Toggle chapter list"
                >
                  {mobileTocOpen ? <X className="h-3.5 w-3.5" /> : <Menu className="h-3.5 w-3.5" />}
                  Ch {activeChapter + 1}/{TOTAL_CHAPTERS}
                </button>
              )}
              <Link
                to="/"
                className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
              >
                Home
              </Link>
              <Link to="/dashboard">
                <Button size="sm" className="gap-1.5">
                  <span className="hidden sm:inline">Open the lab</span>
                  <span className="sm:hidden">Lab</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>
          {/* Row 2 (mobile/tablet only): view tabs on their own row so they're always visible */}
          <div className="lg:hidden -mx-1 overflow-x-auto pb-2 pt-1">
            <div className="inline-flex w-full min-w-max items-center gap-1 rounded-xl border border-primary/40 bg-primary/5 p-1 shadow-sm shadow-primary/10">
              <button
                type="button"
                onClick={() => setView("lessons")}
                className={cn(
                  "flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all sm:text-sm",
                  view === "lessons"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                Detailed Lessons
              </button>
              <button
                type="button"
                onClick={() => setView("presentations")}
                className={cn(
                  "flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all sm:text-sm",
                  view === "presentations"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                Presentations
              </button>
              <button
                type="button"
                onClick={() => setView("labs")}
                className={cn(
                  "relative inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all sm:text-sm",
                  view === "labs"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                Build-Along Labs
                <span className="rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow">
                  New
                </span>
              </button>
            </div>
          </div>
        </div>
        {/* Top progress bar — always visible so learners see how far they've come */}
        <div className="h-1 w-full bg-border/40">
          <div
            className="h-full bg-gradient-to-r from-primary to-nexus-glow transition-all duration-500"
            style={{ width: `${progressPct}%` }}
            aria-hidden
          />
        </div>
      </nav>

      {/* Presentations / Build-Along overlays — full-page below the nav. Keeps the
          curriculum mounted underneath; the overlay simply covers it. */}
      {presentMode && (
        <div className="fixed inset-0 top-[112px] z-30 overflow-y-auto bg-background lg:top-16">
          <div className="mx-auto max-w-7xl px-6 py-10">
            {view === "presentations" ? <PresentationsSection /> : <BuildAlongSection />}
          </div>
        </div>
      )}

      {/* In-chapter section progress — sticky under the nav. Shows where you
          are inside the current chapter and lets you jump between sections. */}
      {!presentMode && chapterAnchors.length > 1 && (
        <div className="fixed top-[112px] z-40 w-full border-b border-border/40 bg-background/85 backdrop-blur-md lg:top-16">
          <div className="mx-auto max-w-7xl px-6 py-2">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="hidden min-w-0 truncate font-semibold text-muted-foreground sm:inline">
                Section {activeAnchorIdx + 1} / {chapterAnchors.length}:{" "}
                <span className="text-foreground">
                  {chapterAnchors[activeAnchorIdx]?.label.replace(/^📝\s*/, "")}
                </span>
              </span>
              <span className="font-mono text-muted-foreground">
                {Math.round(sectionProgressPct)}%
              </span>
            </div>
            <div className="mt-1.5 flex w-full gap-1">
              {chapterAnchors.map((a, i) => {
                const reached = i <= activeAnchorIdx;
                const isCurrent = i === activeAnchorIdx;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => jumpToAnchor(a.id)}
                    title={a.label}
                    aria-label={`Jump to section: ${a.label}`}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-all hover:h-2",
                      reached
                        ? "bg-gradient-to-r from-primary to-nexus-glow"
                        : "bg-border/60 hover:bg-border",
                      isCurrent && "ring-2 ring-primary/40 ring-offset-1 ring-offset-background",
                    )}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div
        className={cn(
          "mx-auto flex max-w-7xl gap-10 px-6 pb-24 lg:gap-12",
          chapterAnchors.length > 1 ? "pt-[180px] lg:pt-32" : "pt-[140px] lg:pt-24",
        )}
      >
        {/* Sticky chapter TOC */}
        <aside
          className={cn(
            "lg:sticky lg:top-28 lg:h-[calc(100vh-8rem)] lg:w-64 lg:shrink-0 lg:overflow-y-auto lg:block",
            mobileTocOpen
              ? "fixed inset-x-0 top-20 z-40 mx-4 max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl lg:static lg:m-0 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none"
              : "hidden",
          )}
        >
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <ListTree className="h-3 w-3" /> Curriculum
          </div>
          <p className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {TOTAL_CHAPTERS} chapters · ~{chapters.reduce((sum, c) => sum + c.minutes, 0)} min total
          </p>
          <nav className="space-y-1">
            {chapters.map((c, idx) => {
              const Icon = c.icon;
              const isActive = idx === activeChapter;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => goToChapter(idx)}
                  className={cn(
                    "group flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
                    isActive
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-card/50 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-semibold">
                      <Icon className="h-3 w-3 shrink-0 text-primary" />
                      <span className="truncate">{c.title}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/80">
                      <Clock className="h-2.5 w-2.5" /> {c.minutes} min
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>
          {chapter.anchors.length > 1 && (
            <div className="mt-5 border-t border-border/50 pt-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                In this chapter
              </p>
              <nav className="space-y-1 text-xs">
                {chapter.anchors.map((a) => (
                  <a
                    key={a.id}
                    href={`#${a.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      jumpToAnchor(a.id);
                    }}
                    className="block rounded px-2 py-1 text-muted-foreground hover:bg-card/50 hover:text-foreground"
                  >
                    · {a.label}
                  </a>
                ))}
              </nav>
            </div>
          )}
        </aside>

        {/* Main column */}
        <main ref={mainRef} className="min-w-0 flex-1">
          {/* Chapter header — orient the learner before they read */}
          <div className="mb-8 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 font-semibold text-primary">
                <ChapterIcon className="h-3 w-3" /> Chapter {activeChapter + 1} of {TOTAL_CHAPTERS}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" /> ~{chapter.minutes} min read
              </span>
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{chapter.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground sm:text-base">{chapter.blurb}</p>
            {(() => {
              const quizAnchors = chapter.anchors.filter((a) => a.id.startsWith("quiz-track-"));
              if (quizAnchors.length === 0) return null;
              return (
                <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/5 p-3">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    <GraduationCap className="h-3.5 w-3.5" /> Quizzes in this chapter
                  </span>
                  {quizAnchors.map((q) => (
                    <a
                      key={q.id}
                      href={`#${q.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        jumpToAnchor(q.id);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-400/50 bg-background/60 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:border-amber-500 hover:bg-amber-500/10"
                    >
                      {q.label.replace(/^📝\s*/, "")}
                    </a>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* ═══════════ CHAPTER 1 — Welcome & Choose Your Path ═══════════ */}
          <div className={cn(activeChapter !== 0 && "hidden")}>
            {/* Intro */}
            {/* Intro — human, problem-led, with one immediate interactive action.
              IDs and CurriculumProgress are preserved so deep links and progress
              tracking still work. */}
            <section id="intro" className="scroll-mt-24">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <BookOpen className="h-3.5 w-3.5" /> Start here
              </div>
              <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
                Build your <span className="text-primary">first agent</span> in about 10 minutes.
              </h2>
              <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
                You don't need to read this page top to bottom. Open the Playground in another tab,
                follow the three steps below, and come back here when something doesn't make sense.
                The vocabulary is easier to absorb after you've broken something with it.
              </p>

              {/* Important note — what AgentSwarms is and production readiness */}
              <div className="mt-8 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" /> Important — read this first
                </div>
                <h4 className="mt-3 text-sm font-bold text-foreground">What is AgentSwarms?</h4>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  AgentSwarms is a <strong>hands-on learning platform</strong> for Agentic AI. It
                  teaches you how AI agents work — prompts, tools, RAG, memory, guardrails,
                  multi-agent orchestration — by letting you{" "}
                  <strong>build and test them live in your browser</strong>. No local setup, no API
                  keys to start.
                </p>
                <h4 className="mt-4 text-sm font-bold text-foreground">What it can do</h4>
                <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    Teach you the <strong>core concepts</strong> behind every major agent framework
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    Let you <strong>prototype agents and swarms</strong> with real models in a safe
                    sandbox
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    Give you <strong>pattern literacy</strong> — routers, loops, tool-use, evals,
                    cost control — so you recognise them in any SDK
                  </li>
                </ul>
                <h4 className="mt-4 text-sm font-bold text-foreground">What it is not</h4>
                <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    It is <strong>not a production deployment platform</strong> — you won't ship
                    customer-facing agents from here
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    It does <strong>not replace</strong> cloud-specific SDKs, IAM policies, or
                    enterprise compliance tooling
                  </li>
                </ul>
                <h4 className="mt-4 text-sm font-bold text-foreground">
                  How it prepares you for production
                </h4>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  Every concept you learn here maps directly to production agent platforms. Once
                  you're comfortable building agents in AgentSwarms, the next step is deploying them
                  on services like <strong>AWS Bedrock Agents</strong>,{" "}
                  <strong>Google Cloud Vertex AI Agents</strong>,{" "}
                  <strong>Azure AI Agent Service</strong>, <strong>OCI Generative AI Agents</strong>
                  , or open-source frameworks like <strong>LangGraph</strong> and{" "}
                  <strong>CrewAI</strong>. The patterns are the same — system prompts, tool schemas,
                  retrieval, orchestration, guardrails — only the deployment target changes.
                  AgentSwarms gives you the <em>transferable mental model</em> so you're not
                  starting from scratch on any of them.
                </p>
              </div>
              {/* Interactive 3-step kickoff — the "promised interactive part". */}
              <div className="mt-8 rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5 sm:p-6">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-primary">
                  <Rocket className="h-3.5 w-3.5" /> Your first 10 minutes
                </div>
                <ol className="mt-4 space-y-4">
                  <li className="flex gap-3">
                    <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                      1
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        Talk to a model. See what raw output looks like.
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Open the Playground and ask:{" "}
                        <em>
                          "Plan a 3-day Lisbon trip for two people who love food and walking."
                        </em>{" "}
                        That's it. No tools, no memory, no swarm — just you and a model. Notice the
                        response is confident, well-formatted, and has no idea what's actually open
                        this weekend.
                      </p>
                      <Link
                        to="/playground"
                        search={{ agentId: undefined }}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                      >
                        Open the Playground <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                      2
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        Give it a job and a personality.
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Now create an Agent: same model, but with a system prompt like{" "}
                        <em>
                          "You're a skeptical travel planner. Always ask one clarifying question
                          before suggesting anything."
                        </em>{" "}
                        Send the same trip request. The reply changes shape — and that's the entire
                        idea behind agents in one move.
                      </p>
                      <Link
                        to="/agents"
                        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-background/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-primary/10"
                      >
                        Create an agent <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                      3
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        Come back and read whichever section confused you.
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Wondered why the agent forgot what you said two turns ago? That's{" "}
                        <em>memory</em>. Wondered why it can't actually check restaurant hours?
                        That's <em>tools</em>. The chapters below answer those questions in roughly
                        the order they come up.
                      </p>
                    </div>
                  </li>
                </ol>
              </div>

              {/* What this site actually is — sets honest expectations. */}
              <div className="mt-10 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
                    What you're looking at
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    AgentSwarms is two things in one place: a <strong>playground</strong> where you
                    actually build agents (left sidebar) and a <strong>reference book</strong> that
                    explains what you're building (this page). Most chapters end with a
                    <em> "Try it in the lab"</em> button that drops you into the matching tool with
                    a sensible default loaded.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
                    What it isn't
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    It isn't a video course you watch beginning-to-end. It also isn't a list of
                    vocabulary you have to memorise — if a term appears once in passing and you
                    don't reach for it again, <strong>you don't need it</strong>. Skim, build, look
                    things up. That's the whole loop.
                  </p>
                </div>
              </div>

              <div className="mt-10">
                <CurriculumProgress />
              </div>
            </section>

            {/* Paths */}
            <section id="paths" className="mt-20 scroll-mt-24">
              <SectionHeader
                icon={Compass}
                chip="Pick your path"
                title="Three ways through this curriculum"
              />

              {/* Field manuals callout — surfaces the senior-depth chapters that
                live at the end of Foundations, Engineering, SQL & BI, Production
                & Business, and Deep Dives. These are what separate a working
                practitioner from someone who can debug agents in production. */}
              <div className="mt-6 rounded-2xl border border-primary/40 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5 sm:p-6">
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-primary">
                  <BrainCircuit className="h-3 w-3" /> Field manuals · Read these if you want senior
                  depth
                </div>
                <h3 className="mt-2 text-lg font-bold tracking-tight">
                  Five field manuals sit at the end of Chapters 3, 4, 5, 6, and 7.
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  The body of each chapter teaches you the vocabulary and the happy path. The{" "}
                  <strong className="text-foreground">field manuals</strong> — Foundations,
                  Engineering Rigor, SQL &amp; BI, Production &amp; Business, and RAG &amp;
                  Frameworks — go one level deeper into the internals that surface in real
                  incidents, real interviews, and real architecture reviews: tokenization economics,
                  KV-cache math, schema-linking failure modes, EU AI Act obligations, Reciprocal
                  Rank Fusion, embedding lifecycle, framework lock-in. Each section is long-form
                  prose with worked numerical examples and primary-source citations. If you only
                  have time for one pass through this curriculum, the manuals are the difference
                  between knowing the words and knowing the system.
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <a
                    href="#foundations-depth"
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1 hover:border-primary/50 hover:text-foreground"
                  >
                    Foundations
                  </a>
                  <a
                    href="#production-depth"
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1 hover:border-primary/50 hover:text-foreground"
                  >
                    Engineering Rigor
                  </a>
                  <a
                    href="#specialized-depth"
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1 hover:border-primary/50 hover:text-foreground"
                  >
                    SQL &amp; BI
                  </a>
                  <a
                    href="#business-depth"
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1 hover:border-primary/50 hover:text-foreground"
                  >
                    Production &amp; Business
                  </a>
                  <a
                    href="#deep-dives-depth"
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1 hover:border-primary/50 hover:text-foreground"
                  >
                    RAG &amp; Frameworks
                  </a>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                {learningPaths.map((p) => (
                  <div key={p.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-2 flex items-center justify-between">
                      <p.icon className="h-5 w-5 text-primary" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {p.weeks}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold">{p.title}</h3>
                    <ol className="mt-3 space-y-2">
                      {p.steps.map((s, i) => (
                        <li
                          key={s}
                          className="flex items-start gap-2 text-xs text-muted-foreground"
                        >
                          <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                            {i + 1}
                          </span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
          </div>
          {/* ═══════════ CHAPTER 2 — Use the Platform ═══════════ */}
          <div className={cn(activeChapter !== 1 && "hidden")}>
            {/* Using AgentSwarms — practical handbook */}
            <section id="using-agentswarms" className="mt-24 scroll-mt-24">
              <SectionHeader icon={MapPin} chip="Practical handbook" title={userGuideIntro.title} />
              <p className="mt-4 max-w-3xl text-base italic leading-relaxed text-foreground/80">
                {userGuideIntro.tagline}
              </p>
              <p className="mt-3 max-w-3xl text-base leading-relaxed text-muted-foreground">
                {userGuideIntro.body}
              </p>

              {/* Suggested journey */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The 9-step journey we recommend
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                You can absolutely start anywhere, but if you've never built an agent before,
                walking these nine steps in order is the fastest way to internalize how the pieces
                fit together.
              </p>
              <ol className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {userJourney.map((j) => (
                  <li
                    key={j.step}
                    className="rounded-xl border border-border/50 bg-card/40 p-4 transition-colors hover:border-primary/40 hover:bg-card/60"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-extrabold text-primary/30">
                        {String(j.step).padStart(2, "0")}
                      </span>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
                        {j.route}
                      </span>
                    </div>
                    <h4 className="mt-1 text-sm font-semibold text-foreground">{j.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{j.goal}</p>
                  </li>
                ))}
              </ol>

              {/* Section-by-section guide */}
              <h3 className="mt-16 text-xl font-bold tracking-tight">
                Every section of the app, explained
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Each card below is a mini-lesson on one screen of AgentSwarms — what it does, why it
                exists, and the workflow for getting value out of it the first time you open it.
              </p>
              <div className="mt-8 space-y-6">
                {sectionGuides.map((g) => (
                  <article
                    key={g.id}
                    id={g.id}
                    className="scroll-mt-24 rounded-2xl border border-border/50 bg-card/40 p-6"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                          <ListChecks className="h-3 w-3" /> {g.chip}
                        </div>
                        <h4 className="text-lg font-bold tracking-tight text-foreground">
                          {g.title}
                        </h4>
                        <p className="mt-1 text-sm text-muted-foreground">{g.summary}</p>
                      </div>
                      <code className="rounded-md border border-border/50 bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground">
                        {g.route}
                      </code>
                    </div>

                    <div className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-4">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-primary">
                        Why it exists
                      </div>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {g.whyItExists}
                      </p>
                    </div>

                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                      <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <RouteIcon className="h-3 w-3 text-primary" /> First-time steps
                        </div>
                        <ol className="space-y-1.5 text-xs text-muted-foreground">
                          {g.firstTimeSteps.map((s, i) => (
                            <li key={s} className="flex items-start gap-2">
                              <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                                {i + 1}
                              </span>
                              <span>{s}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <Lightbulb className="h-3 w-3 text-primary" /> Expert tips
                        </div>
                        <ul className="space-y-1.5 text-xs text-muted-foreground">
                          {g.expertTips.map((t) => (
                            <li key={t} className="flex items-start gap-1.5">
                              <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                              <span>{t}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                          <AlertTriangle className="h-3 w-3" /> Common pitfalls
                        </div>
                        <ul className="space-y-1.5 text-xs text-muted-foreground">
                          {g.pitfalls.map((p) => (
                            <li key={p} className="flex items-start gap-1.5">
                              <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-destructive" />
                              <span>{p}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <Lightbulb className="h-3 w-3 text-primary" /> Concepts unlocked
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {g.conceptsUnlocked.map((c) => (
                            <span
                              key={c}
                              className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              {/* Cross-cutting workflows */}
              <h3 className="mt-16 text-xl font-bold tracking-tight">
                End-to-end workflows (recipes)
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                The most common questions we get all start with "how do I…?". These recipes span
                multiple sections — they're the moves that turn the feature list above into a real,
                shippable agent or swarm.
              </p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {workflows.map((w) => (
                  <div key={w.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <h4 className="text-base font-semibold tracking-tight text-foreground">
                      {w.title}
                    </h4>
                    <p className="mt-1 text-xs italic text-muted-foreground">Goal: {w.goal}</p>
                    <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                      {w.steps.map((s, i) => (
                        <li key={s} className="flex items-start gap-2">
                          <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                            {i + 1}
                          </span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
          </div>
          {/* ═══════════ CHAPTER 3 — Foundations & Core Concepts ═══════════ */}
          <div className={cn(activeChapter !== 2 && "hidden")}>
            {/* Foundations — for total beginners up to senior engineers */}
            <section id="foundations" className="mt-20 scroll-mt-24">
              <SectionHeader
                icon={Cpu}
                chip="Foundations · Start here"
                title="The foundations — what's actually inside an agent"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Ten building blocks underpin everything in agentic AI — from{" "}
                <strong>what a model is</strong> to{" "}
                <strong>how agents think, remember, and use tools</strong>, to{" "}
                <strong>the economics of tokens and context windows</strong>. Each block has a "like
                you're 10" version and a "for the engineer" version — read the one you need today.
              </p>
              <div className="mt-10 space-y-16">
                {foundations.map((f, i) => (
                  <Fragment key={f.id}>
                    <FoundationBlock f={f} />
                    {i === 0 && <WhatIsAnAgentSection />}
                  </Fragment>
                ))}
              </div>

              {/* Visual aids that reinforce the foundational ideas */}
              <div className="mt-12">
                <EmbeddingsVisual />
                <AttentionVisual />
                <DiffusionVisual />
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Open the Playground, pick any model, and try a system prompt + few-shot pattern from this section — see tokens, cost, and latency live."
                to="/playground"
              />

              <InterviewReminder
                topic="LLM fundamentals, embeddings & attention"
                body="Recruiters and senior engineers love to start with the basics — 'explain attention to me like I'm a junior'. The 'standout' answer always ties the math back to a concrete behaviour you've seen in production. Browse 40+ real questions with average vs offer-winning answers."
              />
            </section>

            {/* Foundations track quiz */}
            <div id="quiz-track-foundations" className="mt-12 scroll-mt-24">
              <QuizModule
                trackId="track-foundations"
                trackTitle="Foundations of Generative & Agentic AI"
              />
            </div>

            {/* ═══════════ Foundations Field Manual — internals depth ═══════════ */}
            <section id="foundations-depth" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={BrainCircuit}
                chip="Foundations field manual · Senior depth"
                title={foundationsDepthIntro.headline}
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                {foundationsDepthIntro.body}
              </p>

              <div className="mt-10 space-y-12">
                {foundationsDepthSections.map((s) => (
                  <article
                    key={s.id}
                    id={s.id}
                    className="scroll-mt-24 rounded-2xl border border-border/50 bg-card/30 p-6 lg:p-8"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
                        Section {s.number}
                      </span>
                    </div>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">{s.title}</h3>
                    <p className="mt-3 max-w-3xl text-base font-medium italic text-foreground/80">
                      {s.oneLiner}
                    </p>

                    <div className="prose prose-sm prose-invert mt-6 max-w-3xl text-[15px] leading-[1.75] text-muted-foreground [&_strong]:text-foreground">
                      {s.body.split(/\n\n+/).map((para, i) => (
                        <p key={i} className="mb-4">
                          {para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, j) => {
                            if (seg.startsWith("**") && seg.endsWith("**"))
                              return <strong key={j}>{seg.slice(2, -2)}</strong>;
                            if (seg.startsWith("`") && seg.endsWith("`"))
                              return (
                                <code
                                  key={j}
                                  className="rounded bg-muted/40 px-1 py-0.5 text-[13px]"
                                >
                                  {seg.slice(1, -1)}
                                </code>
                              );
                            return <span key={j}>{seg}</span>;
                          })}
                        </p>
                      ))}
                    </div>

                    {s.workedExample && (
                      <div className="mt-6 rounded-xl border border-border/50 bg-background/60 p-5">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <Code2 className="h-3 w-3 text-primary" /> Worked example —{" "}
                          {s.workedExample.title}
                        </div>
                        <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[12px] leading-relaxed text-foreground/90">
                          <code>{s.workedExample.code}</code>
                        </pre>
                      </div>
                    )}

                    {s.sources && s.sources.length > 0 && (
                      <div className="mt-6 rounded-lg border border-border/40 bg-background/40 p-4">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <BookOpen className="h-3 w-3 text-primary" /> Primary sources &amp; papers
                        </div>
                        <div className="space-y-2">
                          {s.sources.map((src) => (
                            <a
                              key={src.href}
                              href={src.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block rounded-md px-2 py-1 hover:bg-primary/5"
                            >
                              <div className="text-sm font-semibold text-foreground hover:text-primary">
                                {src.label} ↗
                              </div>
                              {src.note && (
                                <div className="mt-0.5 text-xs italic text-muted-foreground">
                                  {src.note}
                                </div>
                              )}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                ))}
              </div>

              <div className="mt-12 rounded-xl border border-primary/30 bg-primary/5 p-6">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <Compass className="h-3 w-3" /> {foundationsDepthClosing.title}
                </div>
                <p className="text-[15px] leading-[1.75] text-muted-foreground">
                  {foundationsDepthClosing.body}
                </p>
              </div>
            </section>

            {/* Concepts — framed so it doesn't feel like a vocabulary list.
              These are tools you reach for when a specific thing breaks; they
              are not flashcards to memorise. */}
            <section id="concepts" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Puzzle}
                chip="Patterns · Read once, look up later"
                title="Six patterns you'll actually reach for"
              />
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
                These are the moves working agent builders make — prompting, RAG, tools, guardrails,
                swarms, and observability. Each one solves a specific failure mode you'll recognise
                the moment you hit it.{" "}
                <strong className="text-foreground">Don't try to memorise them.</strong> Skim once
                so you know they exist, then come back when an agent you're building does something
                dumb and you need the right tool to fix it.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
                <span className="font-semibold text-primary">Best way to read this section:</span>
                <span className="text-muted-foreground">
                  pick one pattern, open the Playground, try it on a prompt of your own — then move
                  on. Two patterns a sitting is plenty.
                </span>
                <Link
                  to="/playground"
                  search={{ agentId: undefined }}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-background/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-primary/10"
                >
                  Open Playground <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>

              <div className="mt-12 space-y-20">
                {concepts.map((c) => (
                  <ConceptBlock key={c.id} c={c} />
                ))}
              </div>
            </section>

            {/* Visual aids for the agentic patterns + memory concepts above */}
            <div className="mt-12">
              <RAGVisual />
              <ToolCallVisual />
              <ReActVisual />
              <PlanExecuteVisual />
              <SwarmVisual />
              <MemoryVisual />
            </div>

            <InterviewReminder
              topic="agents, tools, memory & multi-agent design"
              body="This is where most interviews actually decide the offer — 'design a customer-support agent', 'when would you pick ReAct over plan-and-execute?', 'how do you keep an agent honest over a 50-turn conversation?'. The library has scripted answers from Anthropic, OpenAI and real production case studies."
            />

            {/* Patterns + Memory track quiz (covers concepts above) */}
            <div className="mt-12 grid gap-6 lg:grid-cols-2">
              <div id="quiz-track-patterns" className="scroll-mt-24">
                <QuizModule trackId="track-patterns" trackTitle="Patterns, Tools & Guardrails" />
              </div>
              <div id="quiz-track-memory" className="scroll-mt-24">
                <QuizModule trackId="track-memory" trackTitle="Agent Memory: STM & LTM" />
              </div>
            </div>
          </div>
          {/* ═══════════ CHAPTER 4 — Engineering Rigor ═══════════ */}
          <div className={cn(activeChapter !== 3 && "hidden")}>
            {/* ════════════════════ Engineering Rigor & Mental Models ════════════════════ */}
            <section id="engineering" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Cpu}
                chip="Engineering rigor · Senior-level mental models"
                title="Beyond &lsquo;LLM + prompt + tools&rsquo; — how to think about agents like a systems engineer"
              />
              <p className="mt-4 max-w-3xl text-lg font-semibold text-foreground">
                {engineeringIntro.headline}
              </p>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <ExplainerCard
                  tone="beginner"
                  title="Why this matters"
                  body={engineeringIntro.beginner}
                />
                <ExplainerCard
                  tone="advanced"
                  title="The systems view"
                  body={engineeringIntro.engineer}
                />
              </div>

              {/* 1. Four axes of the agent mental model */}
              <div id="engineering-mental-model" className="mt-12 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  1 · The four axes every serious agent design must answer
                </h3>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  Most beginner content stops at &ldquo;an agent is an LLM with tools.&rdquo; That
                  sentence is true and almost completely useless for design. Every production agent
                  makes a decision on each of these four axes — explicitly or by accident. Make them
                  explicit.
                </p>
                <div className="mt-6 space-y-6">
                  {agentAxes.map((a) => (
                    <article
                      key={a.id}
                      id={a.id}
                      className="scroll-mt-24 rounded-xl border border-border/50 bg-card/40 p-6"
                    >
                      <div className="flex items-start gap-3">
                        <div className="inline-flex rounded-lg bg-primary/10 p-2">
                          <a.icon className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1">
                          <h4 className="text-lg font-bold">{a.title}</h4>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 lg:grid-cols-2">
                        <ExplainerCard tone="beginner" title="In plain English" body={a.beginner} />
                        <ExplainerCard tone="advanced" title="For engineers" body={a.engineer} />
                      </div>
                      <div className="mt-3 rounded-lg border border-border/50 bg-background/40 p-4">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Concrete examples
                        </div>
                        <ul className="space-y-1.5">
                          {a.examples.map((ex) => (
                            <li
                              key={ex}
                              className="flex items-start gap-2 text-sm text-muted-foreground"
                            >
                              <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary/60" />
                              <span>{ex}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="mt-6 rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Network className="h-3 w-3 text-primary" /> Diagram — control topologies side
                    by side
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[11px] leading-relaxed text-muted-foreground">
                    <code>{diagramTopologies}</code>
                  </pre>
                </div>
              </div>

              {/* 2. Deterministic vs Emergent */}
              <div id="engineering-determinism" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  2 · Deterministic orchestration vs emergent agentic behaviour
                </h3>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <ExplainerCard
                    tone="beginner"
                    title="The trade-off in one paragraph"
                    body={determinismIntro.beginner}
                  />
                  <ExplainerCard
                    tone="advanced"
                    title="Anthropic&rsquo;s &lsquo;workflows vs agents&rsquo; line"
                    body={determinismIntro.engineer}
                  />
                </div>
                <div className="mt-5 overflow-x-auto rounded-xl border border-border/50 bg-card/40">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-3">Dimension</th>
                        <th className="px-4 py-3">Deterministic / Workflow</th>
                        <th className="px-4 py-3">Emergent / Agentic</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detEmergentTable.map((row) => (
                        <tr key={row.dimension} className="border-b border-border/30 last:border-0">
                          <td className="px-4 py-3 font-semibold text-foreground">
                            {row.dimension}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{row.deterministic}</td>
                          <td className="px-4 py-3 text-muted-foreground">{row.emergent}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm text-muted-foreground">
                  <strong className="text-foreground">Decision rule:</strong> If you can draw the
                  task graph on a whiteboard, build a workflow. If genuinely no two runs share the
                  same graph (open-ended research, novel computer-use, simulation), promote to
                  agentic — and bring the full failure-handling stack with you.
                </div>
              </div>

              {/* 3. Failure handling & retries */}
              <div id="engineering-failure" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  3 · Failure handling &amp; retries — the boring stuff that decides if you ship
                </h3>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <ExplainerCard
                    tone="beginner"
                    title="Why agents fail differently"
                    body={failureIntro.beginner}
                  />
                  <ExplainerCard
                    tone="advanced"
                    title="The distributed-systems view"
                    body={failureIntro.engineer}
                  />
                </div>

                <div className="mt-5 rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <ShieldAlert className="h-3 w-3 text-primary" /> Diagram — the failure-handling
                    stack per call
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[11px] leading-relaxed text-muted-foreground">
                    <code>{diagramFailure}</code>
                  </pre>
                </div>

                <div className="mt-6 space-y-5">
                  {failureModes.map((fm) => (
                    <article
                      key={fm.id}
                      className="rounded-xl border border-border/50 bg-card/40 p-5"
                    >
                      <div className="flex items-start gap-3">
                        <div className="inline-flex rounded-lg bg-destructive/10 p-2">
                          <fm.icon className="h-4 w-4 text-destructive" />
                        </div>
                        <div className="flex-1">
                          <h4 className="text-base font-bold">{fm.title}</h4>
                          <p className="mt-1 text-sm text-muted-foreground">
                            <strong className="text-foreground">What goes wrong:</strong> {fm.what}
                          </p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            <strong className="text-foreground">How to fix:</strong> {fm.fix}
                          </p>
                        </div>
                      </div>
                      {fm.code && (
                        <pre className="mt-3 overflow-x-auto rounded-lg bg-background/80 p-4 text-xs leading-relaxed">
                          <code>{fm.code}</code>
                        </pre>
                      )}
                    </article>
                  ))}
                </div>
              </div>

              {/* 4. Evaluation at scale */}
              <div id="engineering-evals" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  4 · Evaluation at scale — the four-layer eval pyramid
                </h3>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <ExplainerCard
                    tone="beginner"
                    title="Why you need this"
                    body={evalIntro.beginner}
                  />
                  <ExplainerCard
                    tone="advanced"
                    title="The four layers"
                    body={evalIntro.engineer}
                  />
                </div>

                <div className="mt-5 rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Activity className="h-3 w-3 text-primary" /> Diagram — the eval flywheel
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[11px] leading-relaxed text-muted-foreground">
                    <code>{diagramEvalLoop}</code>
                  </pre>
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {evalLayers.map((l) => (
                    <article
                      key={l.id}
                      className="rounded-xl border border-border/50 bg-card/40 p-5"
                    >
                      <div className="flex items-center justify-between">
                        <div className="inline-flex items-center gap-2">
                          <div className="inline-flex rounded-lg bg-primary/10 p-2">
                            <l.icon className="h-4 w-4 text-primary" />
                          </div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                            {l.number}
                          </span>
                        </div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {l.cadence}
                        </span>
                      </div>
                      <h4 className="mt-3 text-base font-bold">{l.title}</h4>
                      <p className="mt-2 text-sm text-muted-foreground">{l.what}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {l.tools.map((t) => (
                          <span
                            key={t}
                            className="rounded-md border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] text-foreground"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>

                <EvalPyramidVisual />

                <InterviewReminder
                  topic="agent evaluation, LLM-as-judge & regression suites"
                  body="'How do you know your agent got better?' is the question that separates juniors from seniors. The standout answer references golden datasets, LLM-as-judge calibration, and the eval pyramid you just saw — not vibes."
                />
              </div>

              {/* 5. System design under constraints */}
              <div id="engineering-system-design" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  5 · System design under constraints — latency, cost, throughput
                </h3>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <ExplainerCard
                    tone="beginner"
                    title="The three masters"
                    body={systemDesignIntro.beginner}
                  />
                  <ExplainerCard
                    tone="advanced"
                    title="The seven levers"
                    body={systemDesignIntro.engineer}
                  />
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {designLevers.map((d) => (
                    <article
                      key={d.id}
                      className="rounded-xl border border-border/50 bg-card/40 p-5"
                    >
                      <div className="flex items-start gap-3">
                        <div className="inline-flex rounded-lg bg-primary/10 p-2">
                          <d.icon className="h-4 w-4 text-primary" />
                        </div>
                        <h4 className="text-base font-bold">{d.title}</h4>
                      </div>
                      <p className="mt-3 text-sm text-muted-foreground">
                        <strong className="text-foreground">Problem:</strong> {d.problem}
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        <strong className="text-foreground">Technique:</strong> {d.technique}
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        <strong className="text-foreground">Trade-off:</strong> {d.trade}
                      </p>
                    </article>
                  ))}
                </div>
              </div>

              {/* Pitfalls + further reading */}
              <div className="mt-12 grid gap-5 lg:grid-cols-2">
                <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                    <Lightbulb className="h-3 w-3" /> Engineering pitfalls
                  </div>
                  <ul className="space-y-1.5">
                    {engineeringPitfalls.map((p) => (
                      <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <BookOpen className="h-3 w-3 text-primary" /> Papers, specs &amp; deep reads
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {engineeringFurtherReading.map((r) => (
                      <a
                        key={r.href}
                        href={r.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs text-foreground hover:border-primary/50 hover:text-primary"
                      >
                        {r.label} ↗
                      </a>
                    ))}
                  </div>
                </div>
              </div>

              <TryItCTA
                title="See it live in the platform"
                body="Open the Swarms canvas to see a centralised topology in action, then check Traces for the failure-handling and budget-cap signals discussed above."
                to="/swarms"
                ctaLabel="Open Swarms"
              />
            </section>

            {/* ═══════════ Evaluations — measuring agent quality ═══════════ */}
            <section id="evaluations" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Gauge}
                chip="Engineering rigor · Evaluations"
                title="Evaluations — turn vibes into numbers"
              />
              <p className="mt-4 max-w-3xl text-lg font-semibold text-foreground">
                Evals are the difference between a demo and a deployment. Without them you can't
                detect regressions, compare prompts objectively, or give stakeholders a number
                instead of an opinion.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {evalsIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {evalsIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <Lightbulb className="h-3 w-3" /> Why evals matter
                </div>
                <ul className="space-y-1">
                  {evalsIntro.whyItMatters.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The four canonical eval patterns
              </h3>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {evalPatterns.map((p) => (
                  <div key={p.id} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Scale className="h-3 w-3" /> {p.name}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-foreground">{p.oneLiner}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground/80">When to use:</span>{" "}
                      {p.whenToUse}
                    </p>
                    <a
                      href={p.realWorld.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-xs text-primary hover:underline"
                    >
                      {p.realWorld.org} → {p.realWorld.label}
                    </a>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Metrics you'll actually use
              </h3>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {evalMetrics.map((m) => (
                  <div key={m.name} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Activity className="h-3 w-3" /> {m.name}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{m.what}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground/80">Formula:</span>{" "}
                      <code className="rounded bg-background/80 px-1 py-0.5 text-[12px]">
                        {m.formula}
                      </code>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground/80">Passing bar:</span>{" "}
                      {m.passingBar}
                    </p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">When to run each kind</h3>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {evalWhenToRun.map((w) => (
                  <div key={w.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <h4 className="text-sm font-semibold text-foreground">{w.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{w.body}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">Common pitfalls</h3>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {evalPitfalls.map((p) => (
                  <div
                    key={p.title}
                    className="rounded-xl border border-destructive/20 bg-destructive/5 p-5"
                  >
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                      <AlertTriangle className="h-3 w-3" /> {p.title}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Try it in AgentSwarms — RAG Evaluation Harness
              </h3>
              <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-5">
                <p className="text-sm leading-relaxed text-foreground">
                  {evalsInAgentSwarms.template.summary}
                </p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Telescope className="h-3 w-3" /> What you'll see
                    </div>
                    <ul className="space-y-1">
                      {evalsInAgentSwarms.template.youWillSee.map((s) => (
                        <li
                          key={s}
                          className="flex items-start gap-2 text-xs text-muted-foreground"
                        >
                          <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <ArrowRight className="h-3 w-3" /> Try this next
                    </div>
                    <ul className="space-y-1">
                      {evalsInAgentSwarms.template.tryThisNext.map((s) => (
                        <li
                          key={s}
                          className="flex items-start gap-2 text-xs text-muted-foreground"
                        >
                          <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              <TryItCTA
                title="Run the RAG Evaluation Harness"
                body="Two RAG candidates answer the same question, GPT-5 judges both on faithfulness, answer-relevancy, and completeness, and you get a structured scorecard. No setup — uses the bundled How-To knowledge base."
                to="/swarms"
                ctaLabel="Open the eval template"
              />

              <h3 className="mt-12 text-xl font-bold tracking-tight">Further reading</h3>
              <div className="mt-4 space-y-2">
                {evalsInAgentSwarms.furtherReading.map((r) => (
                  <a
                    key={r.href}
                    href={r.href}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-lg border border-border/50 bg-card/40 p-3 hover:border-primary/40"
                  >
                    <div className="text-sm font-semibold text-foreground">{r.label}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{r.note}</div>
                  </a>
                ))}
              </div>
            </section>

            {/* ═══════════ Production Field Manual — depth on the 8 gaps ═══════════ */}
            <section id="production-depth" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Building2}
                chip="Production field manual · Senior depth"
                title={productionDepthIntro.headline}
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                {productionDepthIntro.body}
              </p>

              <div className="mt-10 space-y-12">
                {depthSections.map((s) => (
                  <article
                    key={s.id}
                    id={s.id}
                    className="scroll-mt-24 rounded-2xl border border-border/50 bg-card/30 p-6 lg:p-8"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
                        Section {s.number}
                      </span>
                    </div>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">{s.title}</h3>
                    <p className="mt-3 max-w-3xl text-base font-medium italic text-foreground/80">
                      {s.oneLiner}
                    </p>

                    <div className="prose prose-sm prose-invert mt-6 max-w-3xl text-[15px] leading-[1.75] text-muted-foreground [&_strong]:text-foreground">
                      {s.body.split(/\n\n+/).map((para, i) => (
                        <p key={i} className="mb-4">
                          {para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, j) => {
                            if (seg.startsWith("**") && seg.endsWith("**"))
                              return <strong key={j}>{seg.slice(2, -2)}</strong>;
                            if (seg.startsWith("`") && seg.endsWith("`"))
                              return (
                                <code
                                  key={j}
                                  className="rounded bg-muted/40 px-1 py-0.5 text-[13px]"
                                >
                                  {seg.slice(1, -1)}
                                </code>
                              );
                            return <span key={j}>{seg}</span>;
                          })}
                        </p>
                      ))}
                    </div>

                    {s.workedExample && (
                      <div className="mt-6 rounded-xl border border-border/50 bg-background/60 p-5">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <Code2 className="h-3 w-3 text-primary" /> Worked example —{" "}
                          {s.workedExample.title}
                        </div>
                        <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[12px] leading-relaxed text-foreground/90">
                          <code>{s.workedExample.code}</code>
                        </pre>
                      </div>
                    )}

                    {s.sources && s.sources.length > 0 && (
                      <div className="mt-6 rounded-lg border border-border/40 bg-background/40 p-4">
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <BookOpen className="h-3 w-3 text-primary" /> Primary sources &amp;
                          incidents
                        </div>
                        <div className="space-y-2">
                          {s.sources.map((src) => (
                            <a
                              key={src.href}
                              href={src.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block rounded-md px-2 py-1 hover:bg-primary/5"
                            >
                              <div className="text-sm font-semibold text-foreground hover:text-primary">
                                {src.label} ↗
                              </div>
                              {src.note && (
                                <div className="mt-0.5 text-xs italic text-muted-foreground">
                                  {src.note}
                                </div>
                              )}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                ))}
              </div>

              <div className="mt-12 rounded-xl border border-primary/30 bg-primary/5 p-6">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <Compass className="h-3 w-3" /> {productionDepthClosing.title}
                </div>
                <p className="text-[15px] leading-[1.75] text-muted-foreground">
                  {productionDepthClosing.body}
                </p>
              </div>
            </section>
          </div>
          {/* ═══════════ CHAPTER 5 — Specialized Agents (SQL & BI) ═══════════ */}
          <div className={cn(activeChapter !== 4 && "hidden")}>
            {/* SQL & data-grounded agents — specialty topic */}
            <section id="sql-agents" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Database}
                chip="Specialized agents · Data"
                title="SQL & data-grounded agents — turn English into answers from your data"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Most real business questions — "which region performed best?", "what's our churn
                last quarter?", "top 5 customers by revenue?" — are SQL questions wearing a costume.
                A SQL agent is the specialty pattern that lets non-technical users ask in English
                and get a real answer drawn from real rows. This is the hands-on companion to the
                bundled{" "}
                <code className="rounded bg-background/80 px-1 py-0.5 text-[12px]">
                  SaaS RevOps
                </code>{" "}
                swarm template — read this section to understand what's actually happening when you
                press Run.
              </p>

              {/* Beginner / engineer dual explainer */}
              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {sqlAgentIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {sqlAgentIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <Lightbulb className="h-3 w-3" /> Why this pattern matters
                </div>
                <ul className="space-y-1">
                  {sqlAgentIntro.whyItMatters.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* The 6-step pipeline */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                How it works — the 6-step pipeline
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Every SQL-agent run in AgentSwarms follows the same six-step round-trip. Walk
                through it once and you'll be able to read any trace.
              </p>
              <ol className="mt-6 grid gap-3 md:grid-cols-3">
                {sqlPipeline.map((s) => (
                  <li key={s.step} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-extrabold text-primary/30">{s.step}</span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Step {s.step}
                      </span>
                    </div>
                    <h4 className="mt-1 text-sm font-semibold text-foreground">{s.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </li>
                ))}
              </ol>

              <SqlAgentVisual />

              {/* Safety guarantees */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Safety — why we let an LLM write SQL against your data
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Letting an LLM generate and run database queries sounds terrifying. In AgentSwarms
                it's safe because we layer six guardrails — the model never gets to do anything it
                could regret.
              </p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {sqlSafety.map((s) => (
                  <div key={s.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <ShieldCheck className="h-3 w-3" /> {s.title}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                ))}
              </div>

              {/* How to use — single agent vs swarm */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                How to use it in AgentSwarms
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Two on-ramps depending on the complexity of your question. Start with a single agent
                for lookups; graduate to a swarm when the question is strategic.
              </p>
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Bot className="h-3 w-3" /> {sqlInAgentSwarms.singleAgent.title}
                  </div>
                  <ol className="mt-2 space-y-2">
                    {sqlInAgentSwarms.singleAgent.steps.map((s, i) => (
                      <li key={s} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                          {i + 1}
                        </span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-3 rounded-md bg-background/60 px-3 py-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                      When to use
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {sqlInAgentSwarms.singleAgent.whenToUse}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <GitBranch className="h-3 w-3" /> {sqlInAgentSwarms.insideSwarm.title}
                  </div>
                  <ol className="mt-2 space-y-2">
                    {sqlInAgentSwarms.insideSwarm.steps.map((s, i) => (
                      <li key={s} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                          {i + 1}
                        </span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-3 rounded-md bg-background/60 px-3 py-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                      When to use
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {sqlInAgentSwarms.insideSwarm.whenToUse}
                    </p>
                  </div>
                </div>
              </div>

              {/* Example queries */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Example queries against the bundled{" "}
                <code className="rounded bg-background/80 px-1 py-0.5 text-[14px]">saas_sales</code>{" "}
                dataset
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                You ask in English. The agent writes SQL like this. You see the answer, not the SQL
                — but the trace shows the exact query for auditability.
              </p>
              <div className="mt-6 space-y-3">
                {sqlExampleQueries.map((q) => (
                  <div
                    key={q.question}
                    className="rounded-xl border border-border/50 bg-card/40 p-4"
                  >
                    <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <MessageSquare className="h-3 w-3" /> You ask
                    </div>
                    <p className="text-sm text-foreground">{q.question}</p>
                    <div className="mt-3 mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <Code2 className="h-3 w-3 text-primary" /> Agent generates &amp; runs
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-background/80 p-3 text-xs leading-relaxed">
                      <code>{q.sql}</code>
                    </pre>
                  </div>
                ))}
              </div>

              {/* Pitfalls */}
              <div className="mt-8 rounded-xl border border-destructive/20 bg-destructive/5 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                  <AlertTriangle className="h-3 w-3" /> Common pitfalls
                </div>
                <ul className="space-y-1.5">
                  {sqlPitfalls.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Real-world */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The same pattern, in production at scale
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Text-to-SQL is one of the most-deployed agentic patterns in 2024–2025. These are the
                public write-ups worth studying.
              </p>
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {sqlRealWorld.map((r) => (
                  <article
                    key={r.org}
                    className="rounded-xl border border-border/50 bg-card/40 p-5"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-primary" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                        {r.org}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.quote}</p>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] text-foreground hover:border-primary/50 hover:text-primary"
                    >
                      Read the case study ↗
                    </a>
                  </article>
                ))}
              </div>

              {/* CTA to template */}
              <div className="mt-10 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-6">
                <div className="flex items-start gap-3">
                  <Rocket className="mt-0.5 h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <h4 className="text-base font-semibold text-foreground">Try it in 2 minutes</h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The bundled <strong>SaaS RevOps — Multi-Agent SQL Analyst</strong> swarm
                      template wires this whole pipeline up against the sample dataset. Open Swarms,
                      load the template, and press Run.
                    </p>
                    <Link to="/dashboard" className="mt-3 inline-flex">
                      <Button size="sm" className="gap-1.5">
                        Open the lab <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </section>

            <InterviewReminder
              topic="text-to-SQL agents, schema retrieval & safety"
              body="Every data team is building one of these now, so it's a hot interview topic. Expect 'design a chat-with-your-warehouse system' or 'how do you stop the agent from running DROP TABLE?'. The library has the standout answers."
            />

            {/* SQL track quiz */}
            <div id="quiz-track-sql" className="mt-12 scroll-mt-24">
              <QuizModule trackId="track-sql" trackTitle="Text-to-SQL & Data Agents" />
            </div>

            {/* BI Agent — Wren-style GenBI */}
            <section id="bi-agent" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={BarChart3}
                chip="Specialized agents · GenBI"
                title="BI Agent — chat with your data, get charts back"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                The BI Agent is the natural next step after the SQL agent. Instead of just returning
                rows, it auto-picks a chart, writes a short executive summary, and lets you save
                successful queries as reusable metrics. It's a Wren-AI-style{" "}
                <strong>GenBI pipeline</strong> — Plan → SQL → Execute → Chart → Narrative — running
                entirely inside AgentSwarms with zero extra infrastructure. Try it in the{" "}
                <strong>BI Agent</strong> tab of{" "}
                <code className="rounded bg-background/80 px-1 py-0.5 text-[12px]">
                  Data &amp; SQL Agents
                </code>
                .
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {biAgentIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {biAgentIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <Lightbulb className="h-3 w-3" /> Why this pattern matters
                </div>
                <ul className="space-y-1">
                  {biAgentIntro.whyItMatters.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">The 5-stage pipeline</h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Each stage is a small, focused LLM call in JSON-mode. Splitting the work this way is
                what makes the answers reliable.
              </p>
              <ol className="mt-6 grid gap-3 md:grid-cols-5">
                {biPipeline.map((s) => (
                  <li key={s.step} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-extrabold text-primary/30">{s.step}</span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Stage {s.step}
                      </span>
                    </div>
                    <h4 className="mt-1 text-sm font-semibold text-foreground">{s.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </li>
                ))}
              </ol>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The semantic layer — the secret to good answers
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                You can edit table descriptions, column aliases and saved metrics from the{" "}
                <strong>Semantics</strong> button in the datasets list. This metadata is the single
                biggest accuracy lever in the whole pipeline.
              </p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {biSemanticLayer.map((s) => (
                  <div key={s.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Database className="h-3 w-3" /> {s.title}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                How AgentSwarms runs the BI Agent — explained for everyone
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{biUnderTheHood.intro}</p>
              <ol className="mt-6 space-y-3">
                {biUnderTheHood.steps.map((s, i) => (
                  <li
                    key={s.who}
                    className="flex items-start gap-3 rounded-xl border border-border/50 bg-card/40 p-4"
                  >
                    <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                      {i + 1}
                    </span>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                        {s.who}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{s.does}</p>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-6 rounded-xl border border-chart-2/30 bg-chart-2/5 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-chart-2">
                  <ShieldCheck className="h-3 w-3" /> Why this is safe
                </div>
                <ul className="space-y-1">
                  {biUnderTheHood.whySafe.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Build a BI Agent in your own product — the recipe
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{biBuildYourOwn.intro}</p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {biBuildYourOwn.ingredients.map((s) => (
                  <div key={s.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Code2 className="h-3 w-3" /> {s.title}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Where to plug a BI Agent into your stack
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                The same pipeline ships in five very different shapes depending on where your users
                already live.
              </p>
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {biIntegrationPatterns.map((p) => (
                  <div
                    key={p.title}
                    className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 via-card/40 to-card/0 p-5"
                  >
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Rocket className="h-3 w-3" /> {p.title}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-xl border border-destructive/20 bg-destructive/5 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                  <AlertTriangle className="h-3 w-3" /> Common pitfalls
                </div>
                <ul className="space-y-1.5">
                  {biPitfalls.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The same pattern, in production at scale
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                GenBI is one of the fastest-growing agent patterns of 2024–2025. Every major data
                platform now ships a flavor of it.
              </p>
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {biRealWorld.map((r) => (
                  <article
                    key={r.org}
                    className="rounded-xl border border-border/50 bg-card/40 p-5"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-primary" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                        {r.org}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.quote}</p>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] text-foreground hover:border-primary/50 hover:text-primary"
                    >
                      Read more ↗
                    </a>
                  </article>
                ))}
              </div>

              <div className="mt-10 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-6">
                <div className="flex items-start gap-3">
                  <Rocket className="mt-0.5 h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <h4 className="text-base font-semibold text-foreground">
                      Try the BI Agent in 60 seconds
                    </h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Open <strong>Data &amp; SQL Agents</strong>, pick the bundled{" "}
                      <code className="rounded bg-background/80 px-1 py-0.5 text-[12px]">
                        saas_sales
                      </code>{" "}
                      dataset, switch to the <strong>BI Agent</strong> tab, and click any suggested
                      question. You'll get a chart, a narrative, and the SQL — in one shot.
                    </p>
                    <Link to="/data-sql" className="mt-3 inline-flex">
                      <Button size="sm" className="gap-1.5">
                        Open the BI Agent <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </section>

            <FieldManualSection
              anchorId="specialized-depth"
              chip="SQL & BI field manual · Senior depth"
              intro={specializedDepthIntro}
              sections={specializedDepthSections}
              closing={specializedDepthClosing}
            />
          </div>
          <div className={cn(activeChapter !== 5 && "hidden")}>
            {/* ── Guardrails Deep Dive ── */}
            <section id="guardrails-deep" className="mt-10 scroll-mt-24">
              <SectionHeader
                icon={Shield}
                chip="Deep dive · Safety & compliance"
                title="Guardrails — keeping agents safe, compliant, and under control"
              />
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border bg-card/60 p-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-primary mb-2">
                    Like you're 10
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {guardrailsIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card/60 p-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-primary mb-2">
                    For the engineer
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {guardrailsIntro.engineer}
                  </p>
                </div>
              </div>
              <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="font-semibold text-sm text-destructive mb-2">Why guardrails matter</p>
                <ul className="space-y-1">
                  {guardrailsIntro.whyItMatters.map((w, i) => (
                    <li key={i} className="text-sm text-muted-foreground flex gap-2">
                      <span className="text-destructive shrink-0">•</span>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>

              {/* 5 layers */}
              <h3 className="mt-12 text-lg font-bold">The 5 guardrail layers</h3>
              <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                Production agents layer guardrails at every stage — input, processing, output,
                policy, and human review. Each layer catches what the previous one misses.
              </p>
              <div className="mt-6 space-y-8">
                {guardrailLayers.map((layer) => (
                  <div
                    key={layer.id}
                    id={layer.id}
                    className="scroll-mt-24 rounded-xl border border-border bg-card/40 p-5"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xl">{layer.emoji}</span>
                      <h4 className="font-bold text-base">{layer.name}</h4>
                    </div>
                    <p className="text-sm text-muted-foreground italic mb-3">{layer.oneLiner}</p>
                    <div className="grid gap-3 md:grid-cols-2 mb-4">
                      <div className="rounded-lg bg-muted/30 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-primary mb-1">
                          Like you're 10
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {layer.child}
                        </p>
                      </div>
                      <div className="rounded-lg bg-muted/30 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-primary mb-1">
                          For the engineer
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {layer.engineer}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs font-semibold mb-2">Techniques</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {layer.techniques.map((t) => (
                        <div key={t.name} className="rounded-lg border border-border p-3">
                          <p className="text-xs font-semibold text-foreground">{t.name}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{t.what}</p>
                          <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono">
                            {t.example}
                          </p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      <strong>When to skip:</strong> {layer.whenToSkip}
                    </p>
                  </div>
                ))}
              </div>

              {/* Prompt injection — the #1 threat */}
              <h3 className="mt-12 text-lg font-bold">Prompt injection — the #1 threat</h3>
              <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                Prompt injection is the SQL injection of LLMs. It exploits the fact that
                instructions and data share the same text channel. Here are the four attack types
                you need to know.
              </p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {injectionTypes.map((inj) => (
                  <div key={inj.id} className="rounded-xl border border-border bg-card/40 p-4">
                    <h4 className="font-bold text-sm">{inj.name}</h4>
                    <p className="text-xs text-muted-foreground mt-1">{inj.what}</p>
                    <p className="text-[10px] mt-2 font-mono text-muted-foreground/70 bg-muted/30 rounded p-2">
                      {inj.example}
                    </p>
                    <p className="text-[11px] mt-2 text-muted-foreground">
                      <strong className="text-foreground">Defense:</strong> {inj.defense}
                    </p>
                  </div>
                ))}
              </div>

              {/* In AgentSwarms */}
              <h3 className="mt-12 text-lg font-bold">Guardrails in AgentSwarms</h3>
              <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                {guardrailsInAgentSwarms.intro}
              </p>
              <div className="mt-6 space-y-3">
                {guardrailsInAgentSwarms.features.map((f) => (
                  <div
                    key={f.name}
                    className="rounded-lg border border-border bg-card/40 p-4 flex flex-col sm:flex-row sm:items-start gap-3"
                  >
                    <div className="shrink-0">
                      <span className="inline-block rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold text-primary">
                        {f.layer}
                      </span>
                    </div>
                    <div>
                      <p className="font-semibold text-sm">{f.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{f.what}</p>
                      <p className="text-[10px] text-muted-foreground/70 mt-1">Where: {f.where}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Real-world architectures */}
              <h3 className="mt-12 text-lg font-bold">Real-world guardrail architectures</h3>
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                {realWorldArchitectures.map((arch) => (
                  <div
                    key={arch.industry}
                    className="rounded-xl border border-border bg-card/40 p-4"
                  >
                    <h4 className="font-bold text-sm mb-2">{arch.industry}</h4>
                    <ol className="space-y-1.5">
                      {arch.pipeline.map((step, i) => (
                        <li key={i} className="text-[11px] text-muted-foreground flex gap-1.5">
                          <span className="font-mono text-primary shrink-0">{i + 1}.</span>
                          {step}
                        </li>
                      ))}
                    </ol>
                    <p className="mt-3 text-[10px] text-primary/80 italic">💡 {arch.keyInsight}</p>
                  </div>
                ))}
              </div>

              {/* Pitfalls */}
              <h3 className="mt-12 text-lg font-bold">Common pitfalls</h3>
              <div className="mt-4 space-y-3">
                {guardrailPitfalls.map((p, i) => (
                  <div key={i} className="rounded-lg border border-border bg-card/40 p-4">
                    <p className="font-semibold text-sm text-destructive">❌ {p.mistake}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      <strong>Why it hurts:</strong> {p.why}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      <strong className="text-green-500">Fix:</strong> {p.fix}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-8">
                <QuizModule trackId="track-guardrails" trackTitle="Guardrails & Agent Safety" />
              </div>
            </section>

            {/* Scaling Agentic AI in the Enterprise */}
            <section id="scaling" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Building2}
                chip="Deep dive · Production"
                title="Scaling agentic AI in the enterprise"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Building one agent that works on a happy path is a weekend project. Running
                thousands of agent conversations a day, across many customers, without losing money,
                leaking data, or making embarrassing mistakes — that's a different sport. This
                section maps the pillars where scale shows up, the resiliency patterns that keep the
                lights on, real case studies you can study, and the best practices we bake into
                AgentSwarms by default.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {scalingIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {scalingIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <AlertTriangle className="h-3 w-3" /> Why scaling matters from day one
                </div>
                <ul className="space-y-1">
                  {scalingIntro.whyEveryoneShouldCare.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-10">
                <h3 className="text-xl font-bold tracking-tight">The maturity ladder</h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  Most teams climb these four rungs. Each rung introduces a whole new class of
                  problem — and a new class of investment. Find your stage, then look one above to
                  see what to build next.
                </p>
                <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  {maturityStages.map((s) => (
                    <div
                      key={s.stage}
                      className={`rounded-xl border border-border/50 bg-gradient-to-br ${s.color} p-4`}
                    >
                      <div className="text-xs font-bold uppercase tracking-wider text-foreground">
                        {s.stage}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{s.audience}</div>
                      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                        <div>
                          <span className="font-semibold text-foreground">Looks like: </span>
                          {s.looksLike}
                        </div>
                        <div>
                          <span className="font-semibold text-foreground">Risks: </span>
                          {s.risks}
                        </div>
                        <div className="rounded-md bg-background/60 px-2 py-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                            Next step
                          </span>
                          <p className="mt-0.5 text-[11px] leading-snug">{s.nextStep}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-12">
                <h3 className="text-xl font-bold tracking-tight">
                  The 10 pillars where scale shows up
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  When something breaks in production, it's almost always one of these. Each pillar
                  has a beginner-friendly intuition, an engineer-grade explanation, what to actually
                  do, and the signals you should be watching.
                </p>
                <div className="mt-6 grid gap-4 lg:grid-cols-2">
                  {scalingPillars.map((p) => (
                    <PillarCard key={p.id} p={p} />
                  ))}
                </div>
              </div>

              <div className="mt-12">
                <h3 className="text-xl font-bold tracking-tight">
                  Real case studies — read what actually shipped
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  Theory is easy. These are companies running agentic systems at serious scale
                  today, with public write-ups you can learn from.
                </p>
                <div className="mt-6 grid gap-4 lg:grid-cols-2">
                  {caseStudies.map((cs) => (
                    <article
                      key={cs.org}
                      className="rounded-xl border border-border/50 bg-card/40 p-5"
                    >
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                          {cs.org}
                        </span>
                      </div>
                      <h4 className="mt-2 text-base font-semibold text-foreground">{cs.title}</h4>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {cs.what}
                      </p>
                      <div className="mt-3 rounded-md border border-border/40 bg-background/60 p-3">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Scaling takeaways
                        </div>
                        <ul className="space-y-1">
                          {cs.takeaways.map((t) => (
                            <li
                              key={t}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-primary" />
                              <span>{t}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {cs.links.map((l) => (
                          <a
                            key={l.href}
                            href={l.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs text-foreground hover:border-primary/50 hover:text-primary"
                          >
                            {l.label} ↗
                          </a>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </div>

              <div className="mt-12">
                <h3 className="text-xl font-bold tracking-tight">
                  The production-readiness checklist
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  If you can tick these boxes, you're already ahead of most teams shipping agents
                  today. Use it as a pre-launch review or a quarterly health check.
                </p>
                <div className="mt-6 overflow-x-auto rounded-xl border border-border/50 bg-card/40">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-background/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Area</th>
                        <th className="px-4 py-3 font-semibold">Rule</th>
                        <th className="px-4 py-3 font-semibold">Why it matters</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bestPractices.map((b) => (
                        <tr key={b.area + b.rule} className="border-t border-border/40 align-top">
                          <td className="px-4 py-3">
                            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                              {b.area}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-foreground">{b.rule}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{b.why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Open the Traces page to inspect every step of a real agent run — tokens, cost, latency, tool calls, errors. The same observability the case studies above rely on."
                to="/traces"
              />
            </section>

            {/* Scaling + Swarms track quizzes */}
            <div className="mt-12 grid gap-6 lg:grid-cols-2">
              <div id="quiz-track-scaling" className="scroll-mt-24">
                <QuizModule
                  trackId="track-scaling"
                  trackTitle="Scaling, Observability & Responsible AI"
                />
              </div>
              <div id="quiz-track-swarms" className="scroll-mt-24">
                <QuizModule trackId="track-swarms" trackTitle="Multi-Agent Swarms" />
              </div>
            </div>

            {/* OpenAI-compatible API */}
            <section id="openai-compat" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Plug}
                chip="Standards · Interoperability"
                title="OpenAI-compatible API — the universal plug for LLMs"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                The single most important standardization in the LLM world isn't a new protocol —
                it's the fact that almost every provider speaks the same HTTP shape OpenAI shipped
                in 2023. That one decision is why you can swap models in AgentSwarms without
                rewriting a line of agent code.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {openAICompatIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {openAICompatIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-8 grid gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Why everyone adopted it
                  </h3>
                  <ul className="mt-3 space-y-2">
                    {openAICompatBenefits.map((b) => (
                      <li key={b} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    The shape — one request fits all
                  </h3>
                  <pre className="mt-3 overflow-x-auto rounded-xl border border-border/50 bg-background/80 p-4 text-[11px] leading-relaxed text-foreground">
                    <code>{openAICompatRequest}</code>
                  </pre>
                </div>
              </div>

              <div className="mt-10 rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <Network className="h-3 w-3" /> How AgentSwarms uses it
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {agentSwarmsCompat.whatWeDo}
                </p>
                <ul className="mt-4 space-y-2">
                  {agentSwarmsCompat.howItHelpsYou.map((b) => (
                    <li key={b} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs italic text-muted-foreground">
                  {agentSwarmsCompat.fileHint}
                </p>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Add an OpenAI-compatible provider on the Integrations page — paste your base URL + key once and every agent can use it."
                to="/integrations"
              />
            </section>

            {/* AI Security */}
            <section id="security" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={ShieldAlert}
                chip="Critical · Production"
                title="AI security — the new attack surface and how to defend it"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Agents read untrusted text and click real buttons. That combination breaks a lot of
                assumptions traditional appsec was built on. This section maps the threats you
                should know about, why they matter to your business, and the defenses we recommend
                baking in from day one.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {aiSecurityIntro.child}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {aiSecurityIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                  <AlertTriangle className="h-3 w-3" /> Why this matters from day one
                </div>
                <ul className="space-y-1">
                  {aiSecurityWhyItMatters.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <SecurityThreatVisual />

              <div className="mt-12">
                <h3 className="text-xl font-bold tracking-tight">
                  The six threats every agent team should rehearse
                </h3>
                <div className="mt-6 grid gap-4 lg:grid-cols-2">
                  {aiSecurityThreats.map((t) => (
                    <article
                      key={t.id}
                      className="rounded-xl border border-border/50 bg-card/40 p-5"
                    >
                      <div className="flex items-center gap-2">
                        <t.icon className="h-4 w-4 text-primary" />
                        <h4 className="text-base font-semibold text-foreground">{t.name}</h4>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.what}</p>
                      <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                          Real-world example
                        </div>
                        <p className="text-xs italic text-muted-foreground">{t.example}</p>
                      </div>
                      <div className="mt-3">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                          Defenses
                        </div>
                        <ul className="space-y-1">
                          {t.defenses.map((d) => (
                            <li
                              key={d}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-chart-2" />
                              <span>{d}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </article>
                  ))}
                </div>
              </div>

              <div className="mt-10 rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                  <ShieldCheck className="h-3 w-3" /> How to actually achieve it
                </div>
                <ul className="space-y-2">
                  {aiSecurityHowToAchieve.map((h) => (
                    <li key={h} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href="https://genai.owasp.org/llm-top-10/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs text-foreground hover:border-primary/50 hover:text-primary"
                  >
                    OWASP LLM Top 10 ↗
                  </a>
                  <a
                    href="https://www.nist.gov/itl/ai-risk-management-framework"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs text-foreground hover:border-primary/50 hover:text-primary"
                  >
                    NIST AI RMF ↗
                  </a>
                  <a
                    href="https://www.iso.org/standard/81230.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs text-foreground hover:border-primary/50 hover:text-primary"
                  >
                    ISO/IEC 42001 ↗
                  </a>
                </div>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Set per-agent spend caps and monthly budget alerts so a runaway loop or prompt-injection attack can't quietly drain your provider account."
                to="/budgets"
              />

              <InterviewReminder
                topic="prompt injection, agent security & responsible AI"
                body="Security questions are the fastest way for an interviewer to tell if you've actually shipped agents or just demoed them. 'How would you defend against indirect prompt injection in a tool-using agent?' has a textbook answer that most candidates fumble — the library has the one that lands."
              />
            </section>

            {/* ROI & Economics */}
            <section id="roi" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={TrendingUp}
                chip="Business · Economics"
                title="ROI on agentic AI — what to measure, what it costs, where it pays off"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                An agent that wows in a demo can still lose money in production. This section gives
                you the formulas to measure return, realistic monthly cost ranges across enterprise
                scenarios, and a frank fit matrix so you don't fund the wrong use case.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> Like you're 10
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">{roiIntro.child}</p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Telescope className="h-3 w-3" /> For the engineer
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {roiIntro.engineer}
                  </p>
                </div>
              </div>

              <div className="mt-10">
                <h3 className="text-xl font-bold tracking-tight flex items-center gap-2">
                  <Calculator className="h-5 w-5 text-primary" /> Four formulas that matter
                </h3>
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {roiFormulas.map((f) => (
                    <div key={f.name} className="rounded-xl border border-border/50 bg-card/40 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
                        {f.name}
                      </div>
                      <pre className="mt-2 overflow-x-auto rounded-md bg-background/80 p-2 text-[11px] leading-relaxed text-foreground">
                        <code>{f.formula}</code>
                      </pre>
                      <p className="mt-2 text-xs text-muted-foreground">{f.note}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-12">
                <h3 className="text-xl font-bold tracking-tight flex items-center gap-2">
                  <Coins className="h-5 w-5 text-primary" /> What it actually costs at scale
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  Order-of-magnitude monthly ranges from public benchmarks and our own deployments.
                  Token spend ≠ total spend — operations (vector store, observability, eval,
                  security, on-call) are typically 30–60% of the bill once you're past pilot.
                </p>
                <div className="mt-6 overflow-x-auto rounded-xl border border-border/50 bg-card/40">
                  <table className="w-full min-w-[820px] text-left text-sm">
                    <thead className="bg-background/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Scenario</th>
                        <th className="px-4 py-3 font-semibold">Volume</th>
                        <th className="px-4 py-3 font-semibold">Model mix</th>
                        <th className="px-4 py-3 font-semibold">Tokens/mo</th>
                        <th className="px-4 py-3 font-semibold">Ops/mo</th>
                        <th className="px-4 py-3 font-semibold">Total/mo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enterpriseCostScenarios.map((s) => (
                        <tr key={s.scenario} className="border-t border-border/40 align-top">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-foreground">{s.scenario}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{s.notes}</div>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{s.volume}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{s.modelMix}</td>
                          <td className="px-4 py-3 text-xs text-foreground">
                            {s.monthlyTokenSpend}
                          </td>
                          <td className="px-4 py-3 text-xs text-foreground">{s.monthlyOpsSpend}</td>
                          <td className="px-4 py-3 text-xs font-semibold text-primary">
                            {s.totalMonthly}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-12">
                <h3 className="text-xl font-bold tracking-tight">
                  Use-case fit — where agentic AI shines and where it doesn't
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  Most failed agent projects didn't pick the wrong framework — they picked the wrong
                  workflow. Use this matrix as a pre-investment gut check.
                </p>
                <div className="mt-6 overflow-x-auto rounded-xl border border-border/50 bg-card/40">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="bg-background/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Use case</th>
                        <th className="px-4 py-3 font-semibold">Fit</th>
                        <th className="px-4 py-3 font-semibold">Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {useCaseFitness.map((u) => (
                        <tr key={u.useCase} className="border-t border-border/40 align-top">
                          <td className="px-4 py-3 text-foreground">{u.useCase}</td>
                          <td className="px-4 py-3">
                            <span
                              className={
                                u.fit === "high"
                                  ? "rounded-md bg-chart-2/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-chart-2"
                                  : u.fit === "medium"
                                    ? "rounded-md bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary"
                                    : "rounded-md bg-destructive/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-destructive"
                              }
                            >
                              {u.fit}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{u.why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-10 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-chart-2/30 bg-chart-2/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-chart-2">
                    <ThumbsUp className="h-3 w-3" /> Green flags — invest with confidence
                  </div>
                  <ul className="space-y-1.5">
                    {greenFlags.map((g) => (
                      <li key={g} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-chart-2" />
                        <span>{g}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                    <ThumbsDown className="h-3 w-3" /> Red flags — pick a different tool
                  </div>
                  <ul className="space-y-1.5">
                    {redFlags.map((r) => (
                      <li key={r} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Open the Analytics dashboard to see live token, latency, and cost numbers from your own runs — the raw data behind every ROI calculation above."
                to="/analytics"
              />
            </section>

            <FieldManualSection
              anchorId="business-depth"
              chip="Production & Business field manual · Senior depth"
              intro={businessDepthIntro}
              sections={businessDepthSections}
              closing={businessDepthClosing}
            />
          </div>
          {/* ═══════════ CHAPTER 7 — Deep Dives (RAG & Frameworks) ═══════════ */}
          <div className={cn(activeChapter !== 6 && "hidden")}>
            {/* Modern RAG variants */}
            <section id="rag-variants" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Database}
                chip="Deep dive · Retrieval"
                title="Modern RAG — beyond chunk-and-stuff"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Concept 02 covered the basics. The retrieval landscape has moved fast since the
                original 2020 RAG paper — hybrid search, re-ranking, HyDE, contextual retrieval,{" "}
                <strong>Graph RAG</strong>, agentic RAG, and multi-modal retrieval are all
                production patterns now. Here's what each one is, when to reach for it, and how they
                stack.
              </p>

              <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="flex items-start gap-3">
                  <Lightbulb className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      A practical stacking order
                    </h4>
                    <p className="mt-2 text-sm text-muted-foreground">
                      For most production systems, the highest-ROI stack is:{" "}
                      <strong>
                        Hybrid search → Contextual Retrieval → Cross-encoder re-rank → Agentic loop
                        on hard queries.
                      </strong>{" "}
                      Add <strong>Graph RAG</strong> only when your questions are genuinely
                      multi-hop (relationships across documents). Add{" "}
                      <strong>Multi-modal RAG</strong> only when your corpus has meaningful non-text
                      content.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                {ragVariants.map((v) => (
                  <div key={v.name} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="text-base font-semibold text-foreground">{v.name}</h4>
                      {v.link && (
                        <a
                          href={v.link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 rounded-md border border-border/60 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:border-primary/50 hover:text-primary"
                        >
                          {v.link.label} ↗
                        </a>
                      )}
                    </div>
                    <p className="mt-1 text-sm italic text-muted-foreground">{v.oneLiner}</p>
                    <div className="mt-4 grid gap-3">
                      <div>
                        <div className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                          <Sparkles className="h-3 w-3" /> Beginner
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {v.beginner}
                        </p>
                      </div>
                      <div>
                        <div className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                          <Telescope className="h-3 w-3" /> Advanced
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {v.advanced}
                        </p>
                      </div>
                      <div className="rounded-md bg-background/60 px-3 py-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                          When to use
                        </span>
                        <p className="mt-0.5 text-xs text-muted-foreground">{v.whenToUse}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Upload a PDF, DOCX, or Markdown file to a Knowledge Base, attach it to an agent, and ask a question — citations included."
                to="/knowledge"
              />
            </section>

            {/* Graph RAG — dedicated deep dive */}
            <section id="graph-rag" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Network}
                chip="Deep dive · Graph RAG"
                title="Graph RAG — when relationships matter more than passages"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Vector RAG is brilliant at <em>"find me the paragraph that talks about X."</em> It
                falls over the moment you ask{" "}
                <em>"how is X connected to Y, and what changed between them last quarter?"</em>{" "}
                That's a multi-hop question — the answer lives in the{" "}
                <strong>relationships between facts</strong>, not in any single chunk. Graph RAG is
                built for exactly that.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <ExplainerCard
                  tone="beginner"
                  title="Like you're 10"
                  body="Vector RAG is like Google: it finds the page that mentions your question. Graph RAG is like a detective's pinboard with red string between photos — it finds the *connections* between things. If you ask 'who works for the team that owns the database that broke last Tuesday?', Graph RAG can hop from incident → service → team → person. Vector RAG can't, because no single document says all of that in one paragraph."
                />
                <ExplainerCard
                  tone="advanced"
                  title="For the engineer"
                  body="At index time, an LLM does (entity, relation, entity) extraction over chunks and stores triples in a graph. At query time you (1) match seed entities from the query (lexical or embedding), (2) expand 1–2 hops to gather neighbours, (3) materialize the subgraph + supporting snippets and feed both to the answering LLM. Microsoft GraphRAG adds Leiden community detection for 'global' queries; LightRAG fuses graph + vector in a single retriever. Indexing cost is high (LLM calls per chunk); query cost is cheap."
                />
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">The pipeline at a glance</h3>
              <div className="mt-4 grid gap-3 md:grid-cols-5">
                {[
                  { n: "1", t: "Chunk", b: "Split documents into ~3k-char passages." },
                  {
                    n: "2",
                    t: "Extract",
                    b: "LLM returns (subject, predicate, object) triples per chunk.",
                  },
                  {
                    n: "3",
                    t: "Normalize",
                    b: "Lower-case + dedupe entity names; merge variants.",
                  },
                  { n: "4", t: "Store", b: "Persist entities, relations, mentions in your DB." },
                  {
                    n: "5",
                    t: "Traverse",
                    b: "At query time, seed → 1–2 hop neighbours → answer.",
                  },
                ].map((s) => (
                  <div key={s.n} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                      {s.n}
                    </div>
                    <div className="text-sm font-semibold">{s.t}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{s.b}</p>
                  </div>
                ))}
              </div>

              <GraphRagVisual />

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                See it in action in AgentSwarms
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                We shipped a working Graph RAG implementation so you can poke at every step instead
                of reading another blog post about it.
              </p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">1. The sample knowledge base</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Open <strong>Knowledge → "Graph RAG Demo — Acme Corp"</strong>. It's a fictional
                    company with deliberately interconnected docs (services, owners, incidents,
                    vendors). Pre-seeded triples let you query the graph immediately — no build step
                    needed.
                  </p>
                  <Link to="/knowledge" className="mt-3 inline-flex">
                    <Button size="sm" variant="outline" className="gap-1.5">
                      Open Knowledge <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">2. The Graph tab</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Inside any KB, switch to the <strong>Graph</strong> tab to see the extracted
                    entities and relations as a live, zoomable network. Hit{" "}
                    <strong>Build Graph</strong> on your own KBs to run the extractor (hardcoded to{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                      google/gemini-2.5-flash
                    </code>{" "}
                    for now — model picker coming).
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">3. The agent tool</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Any agent with a KB attached can be granted the{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                      kb_graph_search
                    </code>{" "}
                    tool. The agent calls it whenever it needs multi-hop facts — the response
                    includes the matched subgraph, supporting snippets, and citations.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">4. The "Graph RAG Researcher" swarm</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    A 3-node template that compares retrieval modes side by side: one node uses
                    graph search, one uses vector search, a Synthesizer fuses both. Best way to feel
                    the difference.
                  </p>
                  <Link to="/swarms" className="mt-3 inline-flex">
                    <Button size="sm" variant="outline" className="gap-1.5">
                      Open Swarms <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                When Graph RAG actually helps
              </h3>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-chart-2/30 bg-chart-2/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-chart-2">
                    <CheckCircle2 className="h-3 w-3" /> Reach for it when…
                  </div>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      "Questions are multi-hop (X → relates to → Y → caused → Z).",
                      "Corpus is heterogeneous and entities recur across docs.",
                      "You need 'global' sense-making (themes, communities, summaries).",
                      "Investigative / discovery work — fraud, security, journalism, science.",
                      "Org-knowledge: who owns what, what depends on what.",
                    ].map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                    <AlertTriangle className="h-3 w-3" /> Skip it when…
                  </div>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      "Your queries are single-passage lookups ('what's the warranty period?').",
                      "Indexing budget matters — Graph RAG can be 10–100× more expensive at index time.",
                      "Documents are short, uniform, and self-contained (FAQs, support macros).",
                      "Your team can't debug LLM-generated triples (garbage extraction = garbage graph).",
                      "Hybrid search + cross-encoder re-rank already gets you to the quality bar.",
                    ].map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                In production & the enterprise
              </h3>
              <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[
                  {
                    title: "Knowledge management",
                    body: "Connect Confluence, SharePoint, Notion, Google Drive. Graph RAG surfaces 'who knows what,' duplicate ownership, and stale documentation. Common at consulting firms (Deloitte, Accenture) and large engineering orgs.",
                  },
                  {
                    title: "Investigative & compliance",
                    body: "AML/KYC, journalism, anti-fraud. Graph RAG over transactions, filings, and articles finds chains of relationships humans miss. Used by financial-crime teams and outlets like ICIJ for the Panama / Pandora Papers.",
                  },
                  {
                    title: "Healthcare & life sciences",
                    body: "Drug-disease-protein networks (BioBERT + KGs), patient-cohort discovery from EHRs, literature synthesis. AstraZeneca & GSK have publicly discussed GraphRAG-style retrieval over scientific corpora.",
                  },
                  {
                    title: "Customer 360 & CRM",
                    body: "Stitch accounts, contacts, tickets, deals, calls into one graph. Sales/CS agents answer 'what's at risk in this account and why?' with traceable hops. Salesforce Data Cloud + Agentforce moves in this direction.",
                  },
                  {
                    title: "DevOps / SRE",
                    body: "Service-owner-incident graphs let on-call agents trace 'what depends on the broken thing' and page the right humans. Microsoft has published on internal copilots that fuse graph + vector retrieval over runbooks.",
                  },
                  {
                    title: "Legal & contract intelligence",
                    body: "Parties, clauses, obligations, dates. Graph queries answer 'every contract where Acme owes us a renewal notice in Q4' — impossible with chunk-and-stuff RAG.",
                  },
                ].map((c) => (
                  <div key={c.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="text-sm font-semibold">{c.title}</div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{c.body}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Real-world case studies & primary sources
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                These are first-party publications from the teams that actually built Graph RAG
                systems in production — not blog rewrites.
              </p>
              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {[
                  {
                    org: "Microsoft Research",
                    title: "GraphRAG: From local to global with LLM-generated knowledge graphs",
                    body: "The paper + open-source toolkit that defined the modern Graph RAG pattern. Introduces Leiden community detection for 'global' queries and the local/global retrieval split.",
                    href: "https://www.microsoft.com/en-us/research/blog/graphrag-unlocking-llm-discovery-on-narrative-private-data/",
                  },
                  {
                    org: "Microsoft GraphRAG (open source)",
                    title: "microsoft/graphrag — reference implementation",
                    body: "The repo, prompts, evaluation suite, and accelerator templates. Best place to read production-grade extraction prompts and indexing pipelines.",
                    href: "https://github.com/microsoft/graphrag",
                  },
                  {
                    org: "Neo4j × LangChain",
                    title: "Implementing 'From Local to Global' GraphRAG with Neo4j",
                    body: "Engineering deep-dive on running Microsoft's GraphRAG architecture against a Neo4j store, with cost & latency numbers from real datasets.",
                    href: "https://neo4j.com/developer-blog/global-graphrag-neo4j-langchain/",
                  },
                  {
                    org: "LinkedIn Engineering",
                    title: "Retrieval-augmented generation for customer-service question answering",
                    body: "LinkedIn's customer-support copilot. Builds a knowledge graph from historical tickets and uses graph traversal for retrieval — published median resolution time dropped 28.6%.",
                    href: "https://arxiv.org/abs/2404.17723",
                  },
                  {
                    org: "LightRAG (HKU)",
                    title: "LightRAG: Simple and Fast Retrieval-Augmented Generation",
                    body: "Open-source graph + vector hybrid retriever. Strong empirical results on multi-hop QA at a fraction of GraphRAG's indexing cost — popular drop-in for prototypes.",
                    href: "https://github.com/HKUDS/LightRAG",
                  },
                  {
                    org: "AWS Neptune + Bedrock",
                    title: "Build a Graph-Powered Generative AI Application on AWS",
                    body: "Reference architecture for combining Amazon Neptune knowledge graphs with Bedrock LLMs. Useful as a blueprint for regulated-industry deployments.",
                    href: "https://aws.amazon.com/blogs/database/build-a-graph-rag-application-using-amazon-neptune-and-amazon-bedrock/",
                  },
                  {
                    org: "Writer.com",
                    title: "Why we built our own Graph-based RAG",
                    body: "Engineering write-up on shipping a graph-augmented retrieval pipeline to enterprise customers. Pragmatic notes on extraction quality and eval.",
                    href: "https://writer.com/engineering/graph-based-rag/",
                  },
                  {
                    org: "Anthropic",
                    title: "Contextual Retrieval (companion technique)",
                    body: "Not Graph RAG itself, but the canonical pre-step: chunk-context enrichment cuts retrieval failures ~67%. Stack it before any graph or vector retriever.",
                    href: "https://www.anthropic.com/news/contextual-retrieval",
                  },
                ].map((s) => (
                  <a
                    key={s.title}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group rounded-xl border border-border/50 bg-card/40 p-5 transition-colors hover:border-primary/50"
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                      {s.org}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-foreground group-hover:text-primary">
                      {s.title} ↗
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </a>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Pitfalls we've actually hit
              </h3>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {[
                  {
                    t: "Garbage triples in, garbage answers out",
                    b: "Extraction quality dominates everything. Always inspect a sample of (s, p, o) by hand before trusting the graph; re-run extraction with a stronger model on disagreements.",
                  },
                  {
                    t: "Entity normalization is the silent killer",
                    b: "'Acme Corp', 'Acme', 'ACME, Inc.' must collapse to one node — otherwise your hops dead-end. Lower-case + strip punctuation is the floor; embedding-based merge is the ceiling.",
                  },
                  {
                    t: "Indexing cost surprises",
                    b: "An LLM call per chunk × thousands of chunks = real money. Use a cheap fast model (we hardcode gemini-2.5-flash) and prompt-cache the system prompt.",
                  },
                  {
                    t: "Don't replace vector RAG — augment it",
                    b: "Best production systems run BOTH. Vector RAG for passages, Graph RAG for relationships, then fuse. Our 'Graph RAG Researcher' swarm models this exact pattern.",
                  },
                ].map((p) => (
                  <div key={p.t} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="text-sm font-semibold">{p.t}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{p.b}</p>
                  </div>
                ))}
              </div>

              <TryItCTA
                title="Try Graph RAG end-to-end in 3 minutes"
                body="Open the 'Graph RAG Demo — Acme Corp' KB → Graph tab to see the network. Then run the 'Graph RAG Researcher' swarm to compare graph vs vector retrieval on the same question."
                to="/knowledge"
              />
            </section>

            {/* Agentic RAG — dedicated deep dive */}
            <section id="agentic-rag" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Bot}
                chip="Deep dive · Agentic RAG"
                title="Agentic RAG — when the agent decides what to retrieve"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Classic RAG is a one-shot pipeline: <em>question → embed → top-k → answer</em>. The
                retriever runs once, the model gets one shot at the chunks, and if the chunks miss
                the mark, the answer misses with them. <strong>Agentic RAG</strong> flips this: the
                LLM is no longer the passive consumer of a fixed retrieval result — it becomes the{" "}
                <strong>orchestrator of its own evidence-gathering loop</strong>. It chooses which
                sources to query (vector KB? graph KB? SQL? web? a specific tool?), inspects what
                came back, decides if it has enough, and re-queries with a better plan when it
                doesn&rsquo;t.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <ExplainerCard
                  tone="beginner"
                  title="Like you're 10"
                  body="Normal RAG is like asking one librarian one question and writing your essay from whatever books they hand you back. Agentic RAG is like a researcher: you ask one librarian, then the science one, then check the database in the basement, and if you're still missing something, you go ask again with a better question. The agent keeps going until it has enough evidence to actually answer — and tells you which sources it used."
                />
                <ExplainerCard
                  tone="advanced"
                  title="For the engineer"
                  body="Agentic RAG promotes the retriever from a fixed component to a tool the LLM calls. The control loop typically combines (1) query planning / decomposition, (2) source routing across heterogeneous indices (dense, sparse, graph, SQL, API, web), (3) per-source retrieval with the right adapter, (4) self-evaluation of the gathered evidence (sufficiency, contradictions, gaps), and (5) iterative re-querying — bounded by a max-iteration budget. It is the natural marriage of ReAct-style reasoning + tool use with the retrieval stack."
                />
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Naive RAG vs Agentic RAG — the loop in pseudo-diagram form
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                The shift is from a straight pipe to a controlled loop with a critic. Read both
                diagrams left-to-right.
              </p>
              <div className="mt-4 rounded-xl border border-border/50 bg-card/40 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <GitBranch className="h-3 w-3 text-primary" /> Diagram — naive RAG vs Agentic RAG
                  control flow
                </div>
                <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[11px] leading-relaxed text-muted-foreground">
                  <code>{diagramAgenticRag}</code>
                </pre>
              </div>

              <AgenticRagVisual />

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The five moves an Agentic RAG system makes
              </h3>
              <div className="mt-4 grid gap-3 md:grid-cols-5">
                {[
                  {
                    n: "1",
                    t: "Plan",
                    b: "LLM decomposes the user question into sub-queries and picks which sources each one should hit.",
                  },
                  {
                    n: "2",
                    t: "Route",
                    b: "Each sub-query is dispatched to the right retriever — vector KB, graph KB, SQL, web, MCP tool, or a specialized API.",
                  },
                  {
                    n: "3",
                    t: "Retrieve",
                    b: "Each adapter returns evidence in its native shape: passages, triples + subgraphs, rows, JSON.",
                  },
                  {
                    n: "4",
                    t: "Critique",
                    b: "The LLM (or a dedicated critic agent) scores sufficiency: do we have enough? are there contradictions? what's missing?",
                  },
                  {
                    n: "5",
                    t: "Loop or Synthesize",
                    b: "If gaps remain and budget allows, re-plan and retrieve again. Otherwise, synthesize a cited answer.",
                  },
                ].map((s) => (
                  <div key={s.n} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                      {s.n}
                    </div>
                    <div className="text-sm font-semibold">{s.t}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{s.b}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Where it goes beyond plain RAG
              </h3>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-chart-2/30 bg-chart-2/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-chart-2">
                    <CheckCircle2 className="h-3 w-3" /> What you gain
                  </div>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      "Multi-source reasoning — fuses unstructured text, graph relations, and structured tables in one answer.",
                      "Self-correction — the critic loop catches retrieval failures before the user sees a hallucinated answer.",
                      "Better recall on hard queries via decomposition (a multi-part question becomes several focused sub-queries).",
                      "Graceful degradation — if one source is empty, the agent re-routes instead of giving up.",
                      "Auditable — every iteration emits its plan, the sources hit, and the critique, which is gold for evals.",
                    ].map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                    <AlertTriangle className="h-3 w-3" /> What it costs
                  </div>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      "Higher latency — multiple LLM calls per question instead of one.",
                      "Higher cost — every iteration is more tokens. Always cap max-iterations.",
                      "More moving parts to debug — plan/route/retrieve/critique each have failure modes.",
                      "Risk of loops — without a strict iteration budget and stop conditions, agents keep 'just one more search'.",
                      "Eval becomes multi-step — you need to score retrieval AND reasoning AND the loop's stop decision.",
                    ].map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                See it in action — the Pharmacovigilance swarm
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                We shipped a working Agentic RAG implementation as a swarm template so you can poke
                at every step instead of reading another theory post about it.
              </p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">1. The Router agent</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Receives the user&rsquo;s safety question and emits three typed sub-queries: a{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">DOC_QUERY</code> for
                    the documents KB, a{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">GRAPH_QUERY</code>{" "}
                    for mechanistic relations, and a{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">SQL_QUERY</code> for
                    adverse-event counts.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">2. Three parallel specialists</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    A document retriever uses{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">kb_search</code>, a
                    graph retriever uses{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                      kb_graph_search
                    </code>
                    , and a SQL agent uses{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">sql_query</code>{" "}
                    against the seeded adverse-event dataset. They run in parallel — not
                    sequentially.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">3. The Critic loop</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    A dedicated critic node scores the gathered evidence on four dimensions
                    (Quantitative, Mechanistic, Regulatory, Confounders) and either appends{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">DONE</code> or lists{" "}
                    <strong>GAPS</strong> for another retrieval pass — capped at 3 iterations.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="text-sm font-semibold">4. HITL approval + Synthesizer</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Before the final memo is filed, a <strong>human-in-the-loop approval</strong>{" "}
                    node pauses for safety-officer sign-off (drug-safety questions are high-risk by
                    definition). On approve, the Synthesizer writes the cited memo from all three
                    evidence streams.
                  </p>
                  <Link to="/swarms" className="mt-3 inline-flex">
                    <Button size="sm" variant="outline" className="gap-1.5">
                      Open Swarms <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                When Agentic RAG actually helps
              </h3>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-chart-2/30 bg-chart-2/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-chart-2">
                    <CheckCircle2 className="h-3 w-3" /> Reach for it when…
                  </div>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      "Answers require evidence from multiple, heterogeneous sources (docs + graph + SQL + web).",
                      "The user's question is multi-part or under-specified and benefits from decomposition.",
                      "Retrieval failures are expensive — a wrong answer would mislead a clinician, lawyer, analyst, or auditor.",
                      "You can spend extra tokens and seconds in exchange for higher recall and self-correction.",
                      "You need an explicit, inspectable trail of which sources were consulted and why.",
                    ].map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
                    <AlertTriangle className="h-3 w-3" /> Skip it when…
                  </div>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      "Latency budget is sub-second (chat suggestions, autocomplete) — the loop is too slow.",
                      "You only have one source and naive RAG already hits the quality bar.",
                      "Cost per query is a hard constraint — multi-iteration agents can be 5–10× more expensive.",
                      "You can't enforce a strict iteration cap or a robust stop condition — runaway loops are real.",
                      "Your evals can't yet distinguish 'the answer is correct' from 'the agent loved its own loop'.",
                    ].map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">Real-world case studies</h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Public, first-party writeups from teams that have shipped agentic / iterative
                retrieval at scale. These are the references worth reading directly — not summaries.
              </p>
              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {[
                  {
                    org: "Anthropic",
                    title: "Building effective agents",
                    body: "Anthropic's canonical post on agent design distinguishes 'workflows' (predefined paths) from 'agents' (LLMs dynamically choosing tools). The retrieval-plus-tool-use loop they describe is the backbone of every agentic RAG system in production.",
                    href: "https://www.anthropic.com/research/building-effective-agents",
                  },
                  {
                    org: "OpenAI",
                    title: "A practical guide to building agents",
                    body: "OpenAI's guide on iterative agent loops, tool selection, and stop conditions. The same primitives map cleanly to retrieval-as-a-tool — the LLM picks which retriever to call and decides when it has enough.",
                    href: "https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf",
                  },
                  {
                    org: "Self-RAG (Asai et al.)",
                    title: "Self-RAG: Learning to retrieve, generate, and critique",
                    body: "The academic foundation of the critic loop in agentic RAG. Introduces reflection tokens that let the model decide when to retrieve and whether retrieved passages are useful — read this before designing your own critic.",
                    href: "https://arxiv.org/abs/2310.11511",
                  },
                  {
                    org: "LangChain / LangGraph",
                    title: "Agentic RAG cookbook",
                    body: "LangChain's reference implementations of agentic RAG with tool-using retrievers and self-correction (CRAG, Self-RAG, adaptive RAG). Useful for seeing the prompts and the loop control logic spelled out in working code.",
                    href: "https://github.com/langchain-ai/langgraph",
                  },
                  {
                    org: "Databricks (Mosaic AI)",
                    title: "Mosaic AI Agent Framework & evaluation",
                    body: "Databricks' field-tested guidance on agentic retrieval over enterprise lakehouse data — combining unstructured docs, vector search, and SQL into a single agent with self-evaluation. Strong on the eval side.",
                    href: "https://www.databricks.com/blog/announcing-mosaic-ai-agent-framework-and-mosaic-ai-agent-evaluation",
                  },
                  {
                    org: "FDA Sentinel + pharmacovigilance literature",
                    title: "Multi-source signal detection for drug safety",
                    body: "Pharmacovigilance teams have for years combined adverse-event databases (FAERS, VAERS), literature, and mechanistic knowledge graphs to evaluate signals. The Drug Safety swarm template in /swarms encodes this exact pattern as an agentic RAG workflow you can run.",
                    href: "https://www.fda.gov/safety/fdas-sentinel-initiative",
                  },
                ].map((c) => (
                  <a
                    key={c.title}
                    href={c.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-xl border border-border/50 bg-card/40 p-5 transition-colors hover:border-primary/40 hover:bg-card/60"
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                      {c.org}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-foreground">{c.title} ↗</div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{c.body}</p>
                  </a>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Production pitfalls (and how to dodge them)
              </h3>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {[
                  {
                    t: "Set a strict iteration budget",
                    b: "Always cap max-iterations (3–5 is a good default). Without it, an over-eager critic will keep finding 'one more gap' until you blow your token budget.",
                  },
                  {
                    t: "Make the critic cheap",
                    b: "Use a small, fast model for the critic (e.g. gemini-2.5-flash) and a stronger model only for planning + final synthesis. Critics are called every iteration — cost adds up fast.",
                  },
                  {
                    t: "Type your sub-queries",
                    b: "Have the router emit explicit DOC_QUERY / GRAPH_QUERY / SQL_QUERY tokens (not free-form text). It makes routing deterministic and the trace readable.",
                  },
                  {
                    t: "Always carry citations through the loop",
                    b: "Every retrieved passage, triple, or row should have a stable id. The synthesizer must cite them — that's how you get an auditable answer instead of 'trust me'.",
                  },
                  {
                    t: "Add a HITL gate for high-risk domains",
                    b: "In healthcare, finance, legal, or anything regulated, pause for human approval before the final action. The Pharmacovigilance template ships this by default.",
                  },
                  {
                    t: "Track loop telemetry as a first-class metric",
                    b: "Log average iterations per query, % of queries that hit the cap, and which sources were consulted. These reveal bad routers and weak retrievers faster than any eval suite.",
                  },
                ].map((p) => (
                  <div key={p.t} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="text-sm font-semibold">{p.t}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{p.b}</p>
                  </div>
                ))}
              </div>

              <TryItCTA
                title="Run an Agentic RAG swarm in 3 minutes"
                body="Open Swarms → 'Agentic RAG — Drug Safety Investigation'. Take the guided tour to see the Router, three parallel retrievers, the Critic loop, and the HITL approval gate firing live. Inspect every iteration in Traces."
                to="/swarms"
              />

              <InterviewReminder
                topic="Agentic RAG, multi-source routing & self-critique loops"
                body="This is the 2026 darling topic — every senior interview now has at least one Agentic RAG question. 'When would you go from naive RAG to Agentic RAG?', 'how does the critic decide it has enough evidence?', 'how do you bound the loop?'. The library has the answers that win offers."
              />
            </section>

            {/* Open-source frameworks comparison */}
            <section id="frameworks" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Layers}
                chip="Deep dive · Build pathways"
                title="Different ways to build agents — open-source frameworks compared"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Once you understand the building blocks (prompt → RAG → tools → guardrails →
                swarms), the next question is <em>"what do I actually use to build this?"</em> There
                are four broad pathways. Pick by your team's skills and how much control you need —
                not by hype.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                {buildPathways.map((p) => (
                  <div key={p.title} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <h3 className="text-base font-semibold text-foreground">{p.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground italic">{p.when}</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                          Pros
                        </div>
                        <ul className="space-y-1">
                          {p.pros.map((x) => (
                            <li
                              key={x}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                              <span>{x}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                          Cons
                        </div>
                        <ul className="space-y-1">
                          {p.cons.map((x) => (
                            <li
                              key={x}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                              <span>{x}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Side-by-side: the major open-source frameworks
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                All of these are free and open-source. Most are Python-first, a few have strong
                JS/TS or .NET stories. None of them are "best" — they're optimized for different
                jobs.
              </p>

              <div className="mt-6 overflow-x-auto rounded-xl border border-border/50 bg-card/40">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-background/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Framework</th>
                      <th className="px-4 py-3 font-semibold">Language</th>
                      <th className="px-4 py-3 font-semibold">Best for</th>
                      <th className="px-4 py-3 font-semibold">Who typically uses it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {frameworks.map((f) => (
                      <tr key={f.name} className="border-t border-border/40 align-top">
                        <td className="px-4 py-3">
                          <a
                            href={f.github}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-foreground hover:text-primary"
                          >
                            {f.name} ↗
                          </a>
                          <div className="mt-1 text-xs text-muted-foreground">{f.tagline}</div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{f.language}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{f.bestFor}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{f.whoUses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                {frameworks.map((f) => (
                  <div key={f.name} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="flex items-center justify-between">
                      <h4 className="text-base font-semibold text-foreground">{f.name}</h4>
                      <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        {f.language}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground italic">{f.tagline}</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                          Strengths
                        </div>
                        <ul className="space-y-1">
                          {f.strengths.map((x) => (
                            <li
                              key={x}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                              <span>{x}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                          Trade-offs
                        </div>
                        <ul className="space-y-1">
                          {f.weaknesses.map((x) => (
                            <li
                              key={x}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
                              <span>{x}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Skip the framework setup — pick a runnable template (RAG bot, code reviewer, planner-executor, multi-agent swarm) and fork it into your own workspace."
                to="/templates"
              />
            </section>

            {/* Frameworks DEEP dive — beginner + pro per framework, real stack, decision guide */}
            <section id="frameworks-deep" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Layers}
                chip="Deep dive · Each framework, dissected"
                title="LangChain, LangGraph, CrewAI, AutoGen, LlamaIndex, Semantic Kernel, PydanticAI"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                The seven names everyone in agent-land debates. Below is the same story told twice
                for each — once for someone meeting it for the first time, once for someone shipping
                production. Then a real-world stack picture, an honest "do you really need them
                all?" guide, and how AgentSwarms borrows the good ideas.
              </p>

              <FrameworkStackVisual />

              <div className="mt-10 space-y-6">
                {frameworksDeep.map((f) => (
                  <article
                    key={f.id}
                    id={`fw-${f.id}`}
                    className="scroll-mt-24 rounded-2xl border border-border/50 bg-card/40 p-6 sm:p-7"
                  >
                    <div className="flex flex-wrap items-baseline gap-3">
                      <h3 className="text-xl font-bold tracking-tight">{f.name}</h3>
                      <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        {f.language}
                      </span>
                      <span className="text-xs text-muted-foreground">by {f.vendor}</span>
                    </div>
                    <p className="mt-1 text-sm italic text-muted-foreground">{f.oneLiner}</p>

                    <div className="mt-5 grid gap-4 lg:grid-cols-2">
                      <div className="rounded-lg border border-chart-2/30 bg-chart-2/5 p-4">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                          For a beginner
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {f.beginner}
                        </p>
                      </div>
                      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                          For a senior engineer
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {f.advanced}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-foreground">
                          Reach for it when
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {f.whenToReachFor}
                        </p>
                      </div>
                      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                          Watch out for
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {f.watchOut}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-chart-3/30 bg-chart-3/5 p-3">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-chart-3">
                        Real-world case study
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">{f.caseStudy}</p>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Vocab:
                      </span>
                      {f.keyConcepts.map((k) => (
                        <span
                          key={k}
                          className="rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] font-medium text-foreground"
                        >
                          {k}
                        </span>
                      ))}
                    </div>

                    <div className="mt-4 rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-3">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        How AgentSwarms relates
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {f.agentSwarmsLink}
                      </p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                      <a
                        href={f.github}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        GitHub ↗
                      </a>
                      <a
                        href={f.docs}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        Docs ↗
                      </a>
                    </div>
                  </article>
                ))}
              </div>

              <h3 className="mt-16 text-xl font-bold tracking-tight">
                What a real stack looks like — four scenarios
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Nobody adopts all seven. Real teams pick one orchestrator + one or two libraries
                that solve a specific sub-problem (retrieval, validation, observability). Here are
                four representative stacks from production teams we've spoken to.
              </p>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {stackExamples.map((s) => (
                  <div
                    key={s.scenario}
                    className="rounded-xl border border-border/50 bg-card/40 p-5"
                  >
                    <h4 className="text-base font-semibold text-foreground">{s.scenario}</h4>
                    <p className="mt-1 text-xs italic text-muted-foreground">{s.team}</p>
                    <div className="mt-4 space-y-2">
                      {s.layers.map((l) => (
                        <div key={l.layer} className="grid grid-cols-[110px_1fr] gap-2 text-xs">
                          <div className="font-semibold text-foreground">{l.layer}</div>
                          <div>
                            <span className="font-medium text-primary">{l.choice}</span>
                            <span className="text-muted-foreground"> — {l.why}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-md border border-chart-2/30 bg-chart-2/5 p-3 text-xs text-muted-foreground">
                      <span className="font-semibold text-chart-2">Takeaway · </span>
                      {s.takeaway}
                    </div>
                  </div>
                ))}
              </div>

              <h3 className="mt-16 text-xl font-bold tracking-tight">
                Do you really need all of them? — a short, honest guide
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Short answer: no. Most production agent stacks use one orchestrator and pull a
                focused library or two for the parts that orchestrator isn't great at. The decision
                tree below settles 80% of arguments.
              </p>

              <FrameworkDecisionVisual />

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {doYouNeedItAll.map((d) => (
                  <div
                    key={d.question}
                    className="rounded-lg border border-border/50 bg-card/40 p-4"
                  >
                    <div className="text-sm font-semibold text-foreground">{d.question}</div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{d.answer}</p>
                  </div>
                ))}
              </div>

              <div className="mt-10 rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-6">
                <h3 className="text-lg font-bold tracking-tight">
                  Where AgentSwarms fits in this picture
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  AgentSwarms is not trying to replace LangGraph or CrewAI — it
                  <em> stands on the same shoulders</em>. The visual canvas is a LangGraph-style
                  typed state machine; the role/handoff edges echo CrewAI; the typed I/O on every
                  node is the PydanticAI ethos; the Knowledge tab borrows LlamaIndex's "many
                  indices, one router" pattern; the tool registry uses MCP-compatible schemas; and
                  the reviewer-pattern template is the AutoGen GroupChat in two clicks. The
                  difference is that you can <em>see</em> all of it, run it with one model click,
                  and export to a portable
                  <code className="mx-1 rounded bg-background/60 px-1.5 py-0.5 text-[11px]">
                    .swarm.json
                  </code>
                  so you keep your work even if you walk away.
                </p>
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {[
                    "Visual canvas → same primitives as a LangGraph state graph",
                    "Role + tools + handoff → CrewAI's mental model, no Python",
                    "Typed I/O on every node → PydanticAI discipline, enforced",
                    "Multi-source retrieval (KB · Graph · SQL) → LlamaIndex routing",
                    "MCP-compatible tools → no N×M integration glue",
                    "Reviewer / supervisor templates → AutoGen GroupChat patterns",
                  ].map((x) => (
                    <li
                      key={x}
                      className="flex items-start gap-2 rounded-md border border-border/40 bg-background/40 p-2 text-xs text-muted-foreground"
                    >
                      <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                      <span>{x}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <InterviewReminder
                topic="agent frameworks"
                body="Hiring managers will ask why you picked LangGraph over CrewAI, or how MCP changes a stack. Read the standout answers before your next loop."
              />

              <TryItCTA
                title="Pick one and ship in 5 minutes"
                body="Open a template that mirrors any of these frameworks (planner-executor, reviewer, RAG bot, supervisor) — fork, swap the model, and you have a working agent in your workspace."
                to="/templates"
              />
            </section>

            {/* Protocols & vendor SDKs */}
            <section id="protocols" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Workflow}
                chip="Deep dive · Standards"
                title="Protocols & vendor SDKs — A2A, ADK, Strands, MCP and friends"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Frameworks (LangChain, CrewAI, …) are how YOU write agent code. Protocols and vendor
                SDKs are how agents <em>talk to tools and to each other</em>, and how the big
                platforms package "agents" as first-class products. This is where the ecosystem is
                moving fastest right now — worth knowing the names even if you don't adopt them
                today.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Puzzle className="h-3 w-3" /> Protocol
                  </div>
                  <h4 className="text-sm font-semibold text-foreground">A wire format. No code.</h4>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Examples: <strong>MCP</strong> (agent ↔ tools/data), <strong>A2A</strong> (agent
                    ↔ agent). They define the JSON shape and rules — anyone can implement client or
                    server.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Bot className="h-3 w-3" /> SDK / Framework
                  </div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Code you write agents in.
                  </h4>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Examples: <strong>Google ADK</strong>, <strong>AWS Strands</strong>,{" "}
                    <strong>OpenAI Agents SDK</strong>, <strong>Letta</strong>. Each is opinionated
                    about how agents should be defined and run.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Layers className="h-3 w-3" /> Runtime / Platform
                  </div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Managed infra under your agents.
                  </h4>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Example: <strong>Bedrock AgentCore</strong>. Memory, identity, tool gateway,
                    sandboxed code interpreter — all as services you call from any framework.
                  </p>
                </div>
              </div>

              <div className="mt-8 overflow-x-auto rounded-xl border border-border/50 bg-card/40">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-background/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Kind</th>
                      <th className="px-4 py-3 font-semibold">Vendor</th>
                      <th className="px-4 py-3 font-semibold">Best for</th>
                      <th className="px-4 py-3 font-semibold">Language</th>
                    </tr>
                  </thead>
                  <tbody>
                    {protocols.map((p) => (
                      <tr key={p.name} className="border-t border-border/40 align-top">
                        <td className="px-4 py-3">
                          <a
                            href={p.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-foreground hover:text-primary"
                          >
                            {p.name} ↗
                          </a>
                          <div className="mt-1 text-xs text-muted-foreground">{p.fullName}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                            {p.kind}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{p.vendor}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{p.bestFor}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{p.language}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                {protocols.map((p) => (
                  <div key={p.name} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-foreground">{p.name}</h4>
                        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                          {p.fullName}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        {p.kind}
                      </span>
                    </div>
                    <p className="mt-2 text-xs italic text-muted-foreground">{p.tagline}</p>
                    <div className="mt-4 grid gap-3">
                      <div>
                        <div className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                          <Sparkles className="h-3 w-3" /> Beginner
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {p.beginner}
                        </p>
                      </div>
                      <div>
                        <div className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                          <Telescope className="h-3 w-3" /> Advanced
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {p.advanced}
                        </p>
                      </div>
                    </div>
                    <a
                      href={p.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] text-foreground hover:border-primary/50 hover:text-primary"
                    >
                      Docs ↗
                    </a>
                  </div>
                ))}
              </div>

              <div className="mt-10 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-6">
                <div className="flex items-start gap-3">
                  <Lightbulb className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <h4 className="text-base font-semibold text-foreground">
                      How they fit together
                    </h4>
                    <p className="mt-2 text-sm text-muted-foreground">
                      A typical 2025 stack: build agents in <strong>ADK</strong> or{" "}
                      <strong>Strands</strong> (or LangGraph, or AgentSwarms). Expose your internal
                      tools over <strong>MCP</strong>. Let your agents discover and call other
                      vendors' agents over <strong>A2A</strong>. Run the whole thing on a managed
                      runtime like <strong>Bedrock AgentCore</strong> or your own cloud. Each layer
                      is swappable — that's the whole point of open standards.
                    </p>
                  </div>
                </div>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Connect a real Model Context Protocol (MCP) server — every tool it advertises shows up in your agent's tool palette automatically."
                to="/mcp"
              />
            </section>

            {/* ─────────── Levels of Autonomy mapping ─────────── */}
            <section id="autonomy-levels" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Telescope}
                chip="Where AgentSwarms sits"
                title="Levels of autonomy — L1 to L5"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                The industry has converged on a 5-level taxonomy for agentic autonomy. Tracks 01–07
                take you from L1 to a confident L3. The Deep Dives below are how you reach L4. L5 is
                currently theoretical.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {autonomyLevels.map((l) => {
                  const tone =
                    l.curriculumFit === "covered"
                      ? "border-primary/40 bg-primary/5"
                      : l.curriculumFit === "touched"
                        ? "border-primary/30 bg-primary/5"
                        : l.curriculumFit === "deep-dive"
                          ? "border-amber-500/40 bg-amber-500/5"
                          : "border-border/50 bg-background/40";
                  const label =
                    l.curriculumFit === "covered"
                      ? "Covered"
                      : l.curriculumFit === "touched"
                        ? "Touched"
                        : l.curriculumFit === "deep-dive"
                          ? "Deep Dive"
                          : "Out of scope";
                  return (
                    <div key={l.level} className={`rounded-lg border p-3 ${tone}`}>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {l.level} · {label}
                      </p>
                      <p className="mt-1 text-sm font-semibold">{l.name}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {l.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ─────────── Production Deep Dives — full lessons ─────────── */}
            {deepDives.map((d) => (
              <section key={d.id} id={d.id} className="mt-24 scroll-mt-24">
                <SectionHeader
                  icon={d.icon}
                  chip={`${d.number} · ${d.level} · ${d.estTime}`}
                  title={d.title}
                />
                <p className="mt-4 rounded-md border-l-2 border-primary/40 bg-primary/5 px-4 py-3 text-base italic leading-relaxed text-muted-foreground">
                  {d.hook}
                </p>
                <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                  {d.whyItMatters}
                </p>

                {/* The actual lesson body — prose that teaches the topic. */}
                <div className="mt-8 max-w-3xl space-y-6">
                  {d.explainer.map((sec) => (
                    <div key={sec.heading}>
                      <h3 className="text-lg font-semibold tracking-tight text-foreground">
                        {sec.heading}
                      </h3>
                      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                        {sec.body}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-6 grid gap-5 lg:grid-cols-2">
                  <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      What you'll learn
                    </p>
                    <ul className="mt-3 space-y-2">
                      {d.whatYouLearn.map((w) => (
                        <li
                          key={w}
                          className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground"
                        >
                          <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      Patterns introduced
                    </p>
                    <ul className="mt-3 space-y-2.5">
                      {d.patterns.map((p) => (
                        <li
                          key={p.name}
                          className="rounded-md border border-border/40 bg-background/40 p-3 text-xs"
                        >
                          <p className="font-semibold text-foreground">{p.name}</p>
                          <p className="mt-1 leading-relaxed text-muted-foreground">
                            {p.one_liner}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-5 rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                    On AgentSwarms today
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {d.agentSwarmsHook}
                  </p>
                </div>
              </section>
            ))}

            <FieldManualSection
              anchorId="deep-dives-depth"
              chip="RAG & Frameworks field manual · Senior depth"
              intro={deepDivesDepthIntro}
              sections={deepDivesDepthSections}
              closing={deepDivesDepthClosing}
            />
          </div>
          {/* ═══════════ CHAPTER 8 — Build with AgentSwarms ═══════════ */}
          <div className={cn(activeChapter !== 7 && "hidden")}>
            {/* How we build agents in AgentSwarms */}
            <section id="how-we-build" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Bot}
                chip="In this platform"
                title="How AgentSwarms builds agents"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                AgentSwarms is the visual + code-friendly middle ground. Under the hood, every agent
                is a row in a database with a system prompt, a model, optional tools, and an
                optional knowledge base. Every swarm is a typed graph of those agents with routed
                handoffs. Nothing proprietary — you can export and run it elsewhere.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <Bot className="h-3 w-3" /> A single agent
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Go to <strong>Agents → New Agent</strong>. Pick a provider (AgentSwarms AI,
                    OpenAI, Gemini, Anthropic, Grok, Bedrock, Vertex, OCI, Qwen, Azure), choose a
                    model, write a system prompt, attach a knowledge base, enable tools, set spend
                    caps. That's it — your agent is callable from the Playground.
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <GitBranch className="h-3 w-3" /> A multi-agent swarm
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Go to <strong>Swarms → New Swarm</strong>. Drag agent nodes, router nodes,
                    guardrail nodes, and tool nodes onto the canvas. Wire them with edges (the typed
                    handoffs). Hit Run to stream traces live, or Export to get a portable
                    <code className="mx-1 rounded bg-background/80 px-1 py-0.5 text-[11px]">
                      .swarm.json
                    </code>
                    you can import into another instance.
                  </p>
                </div>
              </div>

              {/* Anatomy of an agent */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Anatomy of an agent — the data model
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Under the hood, every agent is a single database row pointing to a handful of
                related objects. Understanding this shape helps you reason about what "building an
                agent" actually means.
              </p>
              <div className="mt-6 grid gap-3 md:grid-cols-3">
                {[
                  {
                    label: "Core",
                    items: [
                      "System prompt (the instructions)",
                      "Provider + model (e.g. OpenAI / gpt-5)",
                      "Temperature, max tokens, top-p",
                      "Spend cap (monthly $ limit)",
                    ],
                  },
                  {
                    label: "Attachments",
                    items: [
                      "Knowledge base references (one or many)",
                      "Tool / MCP / webhook bindings",
                      "Skill references (reusable playbooks)",
                      "Memory config (STM window, LTM on/off)",
                    ],
                  },
                  {
                    label: "Identity",
                    items: [
                      "Display name & description",
                      "Avatar / icon",
                      "Tags (for search)",
                      "Export metadata (schema version, portable JSON)",
                    ],
                  },
                ].map((col) => (
                  <div
                    key={col.label}
                    className="rounded-xl border border-border/50 bg-card/40 p-5"
                  >
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      {col.label}
                    </div>
                    <ul className="space-y-1.5 text-xs text-muted-foreground">
                      {col.items.map((it) => (
                        <li key={it} className="flex items-start gap-1.5">
                          <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                          <span>{it}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {/* Request lifecycle */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The request lifecycle — what happens when you send a message
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Every chat message triggers a 7-step pipeline. The runtime does all of this before
                the first token streams back.
              </p>
              <ol className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    step: 1,
                    title: "Resolve provider",
                    body: "Look up the agent's model in the registry. Resolve API keys (user-owned or built-in gateway). Select the right adapter (OpenAI, Gemini, Anthropic, Bedrock, etc.).",
                  },
                  {
                    step: 2,
                    title: "Assemble system prompt",
                    body: "Start with the agent's base prompt. Append the LTM recall block (relevant long-term memories). Append the STM summary (compressed earlier conversation). Inject skill playbooks.",
                  },
                  {
                    step: 3,
                    title: "Inject tools",
                    body: "Gather all attached tools: knowledge-base search, MCP server tools, webhook tools, memory tools. Serialize their JSON schemas for the model's function-calling interface.",
                  },
                  {
                    step: 4,
                    title: "Build message window",
                    body: "Take the most recent N messages from STM (default 20). Older messages are covered by the summary from step 2, so context stays bounded.",
                  },
                  {
                    step: 5,
                    title: "Stream response",
                    body: "Call the provider's chat-completion endpoint with streaming on. Tokens flow back to the UI in real time. If the model returns a tool call, execute it and loop back.",
                  },
                  {
                    step: 6,
                    title: "Log trace",
                    body: "Record the full exchange: input tokens, output tokens, latency, tool calls, model used, cost estimate. Every run is inspectable in Traces.",
                  },
                  {
                    step: 7,
                    title: "Extract memories",
                    body: "If LTM auto-extract is on, scan the assistant's response for durable facts, preferences, or instructions worth remembering. Store them for future recall.",
                  },
                ].map((s) => (
                  <li key={s.step} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-extrabold text-primary/30">{s.step}</span>
                    </div>
                    <h4 className="mt-1 text-sm font-semibold text-foreground">{s.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </li>
                ))}
              </ol>

              {/* Model registry */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                Model registry & provider abstraction
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                AgentSwarms normalizes 10+ providers behind a single adapter interface. Each
                provider adapter translates the unified request format into the vendor's native API
                and back. This means switching an agent from GPT-5 to Gemini 2.5 Pro is a one-click
                operation — the system prompt, tools, and memory all carry over unchanged.
              </p>
              <div className="mt-4 rounded-xl border border-border/50 bg-card/40 p-5">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Supported providers
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    "AgentSwarms AI (no key needed)",
                    "OpenAI",
                    "Google Gemini",
                    "Anthropic",
                    "Grok (xAI)",
                    "AWS Bedrock",
                    "Google Vertex AI",
                    "Oracle OCI",
                    "Alibaba Qwen",
                    "Azure OpenAI",
                    "vLLM (self-hosted)",
                  ].map((p) => (
                    <span
                      key={p}
                      className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary"
                    >
                      {p}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  The <strong>AgentSwarms AI</strong> gateway gives every user 15 free requests with
                  no API key. Bring your own keys to unlock unlimited usage on any provider.
                </p>
              </div>

              {/* Portable schema (kept from original) */}
              <div className="mt-6 rounded-xl border border-border/50 bg-card/40 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Code2 className="h-3 w-3 text-primary" /> Worked example — the AgentSwarms
                  portable schema
                </div>
                <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-xs leading-relaxed">
                  <code>{`{
  "schemaVersion": "1.0.0",
  "name": "Research Swarm",
  "nodes": [
    {
      "id": "researcher",
      "type": "agent",
      "agent": {
        "provider": "openai",
        "model": "gpt-5",
        "systemPrompt": "You find sources and return JSON.",
        "tools": ["search_web", "fetch_url"]
      }
    },
    {
      "id": "writer",
      "type": "agent",
      "agent": { "provider": "anthropic", "model": "claude-3.7", ... }
    },
    { "id": "reviewer", "type": "agent", "agent": { ... } }
  ],
  "edges": [
    { "from": "researcher", "to": "writer" },
    { "from": "writer",     "to": "reviewer" }
  ]
}`}</code>
                </pre>
                <p className="mt-3 text-xs text-muted-foreground">
                  Because every swarm exports to this schema, anything you build here can be
                  re-implemented in LangGraph, CrewAI, or hand-rolled code in an afternoon.{" "}
                  <strong>No lock-in.</strong>
                </p>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Build your first agent: pick a provider, write a system prompt, attach a knowledge base or tool, set spend caps, then run it from the Playground."
                to="/agents"
              />
            </section>

            {/* ── Knowledge bases ── */}
            <section id="kb-internals" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Database}
                chip="Under the hood"
                title="Knowledge bases — how RAG works here"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                A knowledge base turns your documents into a searchable tool the agent can query
                mid-conversation. Here's what happens at each stage.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    1 · Ingestion
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>Upload PDFs, DOCX, Markdown, plain text, or paste a URL</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>Documents are split into overlapping chunks (~500 tokens each)</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Each chunk is embedded (vector representation) and stored alongside the raw
                        text
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        GitHub repo ingestion clones the repo, parses code files, and chunks them by
                        function/class boundaries
                      </span>
                    </li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    2 · Runtime retrieval
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        The agent calls{" "}
                        <code className="rounded bg-background/80 px-1 text-[11px]">
                          query_knowledge_base
                        </code>{" "}
                        with the user's question
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>Semantic search finds the top-k most similar chunks (default 5)</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Chunks are returned as structured tool results with source citations
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        The model weaves them into its answer — this is RAG (Retrieval-Augmented
                        Generation)
                      </span>
                    </li>
                  </ul>
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    3 · Graph RAG (optional)
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Enable "Build Knowledge Graph" on any KB to extract entities and
                        relationships
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Creates a structured graph (nodes = concepts, edges = relationships)
                        alongside the vector index
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        At query time, the agent can traverse relationships ("what connects X to
                        Y?") not just find similar chunks
                      </span>
                    </li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    When to use a KB vs. system prompt
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>System prompt:</strong> Small, stable instructions (&lt;2K tokens).
                        Always in context.
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Knowledge base:</strong> Large or changing corpora. Retrieved
                        on-demand — only relevant chunks enter context.
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Rule of thumb: if it fits in 1 page, use the prompt. If it's a library, use
                        a KB.
                      </span>
                    </li>
                  </ul>
                </div>
              </div>

              <TryItCTA
                title="Try it now"
                body="Upload a PDF to a knowledge base, attach it to an agent, and ask a question — watch the citations flow back."
                to="/knowledge"
              />
            </section>

            {/* ── Agent memory ── */}
            <section id="memory-internals" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Brain}
                chip="Under the hood"
                title="Agent memory — STM and LTM"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Memory is what turns a stateless LLM into a persistent assistant that remembers
                context within a conversation and learns across sessions. AgentSwarms implements two
                complementary systems.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    Short-term memory (STM)
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Sliding window:</strong> The last N messages (default 20) are sent
                        with each request
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Summarization:</strong> When messages age out of the window, they're
                        compressed into a running summary
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        The summary is prepended to the system prompt so the agent "remembers"
                        earlier discussion without using all the tokens
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Stored in{" "}
                        <code className="rounded bg-background/80 px-1 text-[11px]">
                          conversation_memory
                        </code>{" "}
                        — one row per conversation
                      </span>
                    </li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    Long-term memory (LTM)
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Persistent items:</strong> Facts, preferences, episodic memories,
                        and instructions stored per-agent, per-user
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Auto-extract:</strong> After each response, the runtime scans for
                        durable knowledge worth saving
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Recall:</strong> Before each turn, relevant LTM items are retrieved
                        via semantic search and injected into the system prompt
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Up to 200 items per agent (configurable). Scored by recency + relevance
                      </span>
                    </li>
                  </ul>
                </div>
              </div>

              <h3 className="mt-10 text-lg font-bold tracking-tight">
                Memory tools the agent can call
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Beyond automatic extraction, agents can explicitly manage their own memory
                mid-conversation using five built-in tools.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-5">
                {[
                  {
                    name: "memory_remember",
                    desc: "Save a durable note to LTM (fact, preference, instruction)",
                  },
                  { name: "memory_recall", desc: "Search LTM for items matching a query (top-k)" },
                  { name: "memory_forget", desc: "Delete an LTM item when it's no longer true" },
                  { name: "memory_set", desc: "Write a key/value to the conversation scratchpad" },
                  { name: "memory_get", desc: "Read from the scratchpad (or dump all keys)" },
                ].map((t) => (
                  <div key={t.name} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <code className="text-[11px] font-semibold text-primary">{t.name}</code>
                    <p className="mt-1 text-xs text-muted-foreground">{t.desc}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="flex items-start gap-3">
                  <Lightbulb className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">Scratchpad in swarms</h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      In a multi-agent swarm,{" "}
                      <code className="rounded bg-background/80 px-1 text-[11px]">memory_set</code>{" "}
                      and{" "}
                      <code className="rounded bg-background/80 px-1 text-[11px]">memory_get</code>{" "}
                      use the swarm run ID as the conversation ID. This means different agent nodes
                      within the same run can share state through the scratchpad — a lightweight
                      alternative to passing everything through the message chain.
                    </p>
                  </div>
                </div>
              </div>

              <TryItCTA
                title="Try it now"
                body="Enable LTM on an agent (Agent → Edit → Memory tab), chat for a few turns, then start a new conversation and watch the agent recall what it learned."
                to="/agents"
              />
            </section>

            {/* ── Skills ── */}
            <section id="skills-internals" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Sparkles}
                chip="Under the hood"
                title="Skills — reusable agent capabilities"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                A skill is a structured playbook you attach to an agent. Unlike tools (which execute
                code), skills are injected as extra instructions into the system prompt — they teach
                the agent
                <em> how</em> to behave in specific situations.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    What a skill contains
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Name:</strong> A short identifier (e.g. "Refund Triage")
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Body:</strong> Markdown instructions with "When to use" and "How to
                        apply" sections
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Tags:</strong> For search and organization
                      </span>
                    </li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    How they attach
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>Pick skills from the library when creating/editing an agent</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        At runtime, all attached skill bodies are compiled into a "Skills available
                        to you" block
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Multiple skills compose — the agent is told to apply all matching skills per
                        turn
                      </span>
                    </li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/40 p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    Built-in vs. custom
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Sample skills</strong> ship with the platform (e.g. "Chain of
                        Thought", "Structured Output")
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        <strong>Custom skills</strong> you write yourself — or generate with AI
                        assistance in the Skill Builder
                      </span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span>
                        Both types are reusable across any agent — write once, attach many
                      </span>
                    </li>
                  </ul>
                </div>
              </div>

              <TryItCTA
                title="Try it now"
                body="Open Skills → browse built-in skills, then attach one to an existing agent. Compare the agent's behavior with and without the skill."
                to="/agents"
              />
            </section>

            {/* ── Swarm execution ── */}
            <section id="swarm-runtime" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Network}
                chip="Under the hood"
                title="Swarm execution — what happens when you hit Run"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                A swarm is a directed graph of nodes and edges. The runtime walks the graph from
                START to END, executing each node and routing based on edges and conditions.
              </p>

              <h3 className="mt-10 text-lg font-bold tracking-tight">Node types</h3>
              <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {[
                  {
                    name: "Input",
                    desc: "The entry point. Takes the user's message and seeds the swarm's shared context.",
                  },
                  {
                    name: "Agent",
                    desc: "Calls an LLM via /api/chat. The system prompt, tools, and model come from the agent config. Output is stored in the node's variable.",
                  },
                  {
                    name: "Condition",
                    desc: "An LLM-judged router. Evaluates the upstream output against labeled edges and picks the best path. Think of it as an if/else decided by the model.",
                  },
                  {
                    name: "Loop",
                    desc: "Re-runs an agent body until a check passes or max iterations is hit. Useful for iterative refinement (write → review → rewrite).",
                  },
                  {
                    name: "Approval (HITL)",
                    desc: "Pauses execution and creates an approval request. The run waits until a human approves or rejects in the Approvals inbox.",
                  },
                  {
                    name: "Evaluate",
                    desc: "LLM-as-a-judge node. Scores upstream output on configurable metrics (faithfulness, relevancy, completeness) and returns a structured scorecard.",
                  },
                  {
                    name: "Output",
                    desc: "The terminal node. Its value becomes the swarm's final response.",
                  },
                ].map((n) => (
                  <div key={n.name} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <h4 className="text-sm font-semibold text-primary">{n.name}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{n.desc}</p>
                  </div>
                ))}
              </div>

              <h3 className="mt-10 text-lg font-bold tracking-tight">Execution flow</h3>
              <ol className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    step: 1,
                    title: "Topological sort",
                    body: "The graph is sorted so dependencies run before dependents. Cycles (loops) are handled specially.",
                  },
                  {
                    step: 2,
                    title: "Node execution",
                    body: "Each node runs in order. Agent nodes stream their output; condition nodes evaluate and pick an edge; approval nodes pause.",
                  },
                  {
                    step: 3,
                    title: "Variable passing",
                    body: "Every node writes its output to a shared context map keyed by the node's outputVar. Downstream nodes can read any upstream variable.",
                  },
                  {
                    step: 4,
                    title: "Edge routing",
                    body: "After a node completes, the runtime follows its outgoing edges. Condition nodes choose one edge by label; regular nodes follow all outgoing edges.",
                  },
                  {
                    step: 5,
                    title: "Tracing",
                    body: "Every node execution is logged: input/output text, token count, latency, tool calls, model, cost. The full run is viewable as a timeline in the Run Panel.",
                  },
                  {
                    step: 6,
                    title: "Completion",
                    body: "When the output node is reached, the swarm returns the final value. If any node errors, the run stops with a traceable failure.",
                  },
                ].map((s) => (
                  <li key={s.step} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <span className="text-2xl font-extrabold text-primary/30">{s.step}</span>
                    <h4 className="mt-1 text-sm font-semibold text-foreground">{s.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </li>
                ))}
              </ol>

              <TryItCTA
                title="Try it now"
                body="Open a template swarm (Templates → any example), hit Run, and watch the node-by-node execution in the Run Panel. Each step is traceable."
                to="/templates"
              />
            </section>

            {/* ── Export formats ── */}
            <section id="export-formats" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Code2}
                chip="Portability"
                title="Export formats — take your work anywhere"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Everything you build in AgentSwarms is exportable. No lock-in. Here's what each
                format gives you.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {[
                  {
                    format: "Portable JSON",
                    desc: "The native AgentSwarms schema. Contains the full graph definition — nodes, edges, agent configs, tool references. Import back into any AgentSwarms instance or use as a blueprint.",
                    ext: ".swarm.json",
                  },
                  {
                    format: "LangChain (Python & TypeScript)",
                    desc: "Generates a single-file LCEL chain for individual agents. Maps provider → ChatOpenAI / ChatGoogleGenerativeAI / etc. Includes tool stubs with the @tool decorator. pip install langchain and run.",
                    ext: ".py / .ts",
                  },
                  {
                    format: "LangGraph (Python & TypeScript)",
                    desc: "Generates a full StateGraph for swarms. Each agent node becomes a model-invoking function. Condition nodes map to add_conditional_edges. Approval nodes use the interrupt() HITL pattern. Typed state with message history and swarm variables.",
                    ext: ".py / .ts",
                  },
                  {
                    format: "Hand-rolled migration",
                    desc: "The portable JSON schema is simple enough to reimplement in CrewAI, AutoGen, or plain code. Nodes → agent definitions, edges → orchestration logic. The schema docs show exactly what each field means.",
                    ext: "any",
                  },
                ].map((f) => (
                  <div key={f.format} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-foreground">{f.format}</h4>
                      <code className="rounded-md border border-border/50 bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground">
                        {f.ext}
                      </code>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.desc}</p>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
                <div className="flex items-start gap-3">
                  <Lightbulb className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      Export is a learning tool
                    </h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Even if you never leave AgentSwarms, exporting to LangGraph Python or
                      TypeScript is an excellent way to understand what's happening. The generated
                      code is fully commented and maps 1:1 to the visual canvas — every node, edge,
                      and condition is visible as real code.
                    </p>
                  </div>
                </div>
              </div>

              <TryItCTA
                title="Try it now"
                body="Open any swarm, click the Export button, and choose LangGraph Python. Read the generated code — it's a map of the visual canvas."
                to="/swarms"
              />
            </section>

            {/* Tools deep-dive */}
            <section id="tools-deep" className="mt-24 scroll-mt-24">
              <SectionHeader icon={Wrench} chip="Deep dive · Tools" title="Tools — the deep dive" />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                Concept 03 introduced tools. This section goes one level deeper: the categories of
                tools you'll actually build, the lifecycle of a single tool call, and how to design
                tools that don't blow up in production.
              </p>

              <h3 className="mt-10 text-xl font-bold tracking-tight">
                The 6 categories of agent tools
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Every tool you'll ever build falls into one of these buckets. Knowing the bucket
                tells you how to design it (idempotent? gated? cached?) and how risky it is.
              </p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {toolCategories.map((t) => (
                  <div key={t.name} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                      <Puzzle className="h-3 w-3" /> {t.name}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{t.what}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {t.examples.map((e) => (
                        <code
                          key={e}
                          className="rounded-md bg-background/80 px-2 py-0.5 text-[11px] text-foreground"
                        >
                          {e}
                        </code>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground italic">
                      Why it matters: {t.whyItMatters}
                    </p>
                  </div>
                ))}
              </div>

              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The lifecycle of a single tool call
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                A "tool call" is not just <code>function(args)</code>. It's a six-step round-trip
                between the model and your runtime. Skip a step and you'll ship bugs that look like
                LLM hallucinations but are actually plumbing.
              </p>
              <ol className="mt-6 grid gap-3 md:grid-cols-3">
                {toolLifecycle.map((s) => (
                  <li key={s.step} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-extrabold text-primary/30">{s.step}</span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Step {s.step}
                      </span>
                    </div>
                    <h4 className="mt-1 text-sm font-semibold text-foreground">{s.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </li>
                ))}
              </ol>

              <div className="mt-8 rounded-xl border border-border/50 bg-card/40 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Code2 className="h-3 w-3 text-primary" /> Worked example — a well-described tool
                </div>
                <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-xs leading-relaxed">
                  <code>{`{
  "name": "issue_refund",
  "description": "Refund a customer order. Use ONLY when the user explicitly asks for a refund and you have an order_id. Refunds over $100 require human approval.",
  "parameters": {
    "type": "object",
    "properties": {
      "order_id":  { "type": "string", "description": "The internal order id, e.g. 'ord_123'" },
      "amount":    { "type": "number", "description": "Refund amount in USD" },
      "reason":    { "type": "string", "enum": ["damaged", "wrong_item", "late", "other"] }
    },
    "required": ["order_id", "amount", "reason"]
  }
}`}</code>
                </pre>
                <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    <span>
                      <strong>Tip:</strong> Encode policy in the description ("over $100 requires
                      approval") — the model will route correctly.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    <span>
                      <strong>Tip:</strong> Use <code>enum</code> on free-form fields (like reason)
                      so the model returns a clean value you can switch on.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                    <span>
                      <strong>Tip:</strong> Make tool results <em>structured</em>, not freeform —
                      downstream agents can parse them.
                    </span>
                  </li>
                </ul>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Open Agents → New Agent, attach a tool (knowledge base, MCP, or webhook), and watch the 6-step tool lifecycle play out live in the Playground."
                to="/agents"
              />
            </section>

            {/* Tools in this project */}
            <section id="tools-here" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Puzzle}
                chip="In this platform"
                title="How AgentSwarms uses tools"
              />
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                In AgentSwarms, tools are first-class objects. You attach them to an agent, the
                runtime validates calls, executes them with tracing, and routes the structured
                result back to the model — exactly the lifecycle described above.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[
                  {
                    name: "Knowledge bases",
                    body: "Attach any KB you upload (PDF, DOCX, Markdown, raw text). The runtime exposes it as a query_knowledge_base tool with citations.",
                  },
                  {
                    name: "MCP servers",
                    body: "Connect any Model Context Protocol server (HTTP or stdio). Every tool the MCP server advertises shows up in your agent's tool palette automatically.",
                  },
                  {
                    name: "n8n / webhook tools",
                    body: "Point the agent at any n8n workflow or HTTPS webhook. Great for connecting to Slack, Notion, Stripe, Salesforce — anything with an API.",
                  },
                  {
                    name: "Provider integrations",
                    body: "OpenAI, Gemini, Anthropic, Grok, Bedrock, Vertex, OCI, Qwen, Azure — bring your own keys, or use the built-in AgentSwarms AI gateway with no key required (15 free requests / user).",
                  },
                  {
                    name: "Handoff edges (in swarms)",
                    body: "Wiring two nodes in the swarm canvas IS a handoff tool. The router agent calls transfer_to_<node> under the hood.",
                  },
                  {
                    name: "HITL approvals",
                    body: "Mark any action as requiring approval. The agent calls request_approval, the run pauses, and the request shows up in the Approvals inbox.",
                  },
                ].map((x) => (
                  <div key={x.name} className="rounded-xl border border-border/50 bg-card/40 p-5">
                    <h4 className="text-sm font-semibold text-foreground">{x.name}</h4>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{x.body}</p>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-6">
                <div className="flex items-start gap-3">
                  <Lightbulb className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <h4 className="text-base font-semibold text-foreground">The mental model</h4>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Every tool in AgentSwarms — whether it's a KB lookup, an MCP call, an n8n
                      webhook, a swarm handoff, or an approval request — flows through the{" "}
                      <strong>same 6-step lifecycle</strong>. Same tracing. Same cost accounting.
                      Same guardrails. That uniformity is what lets you debug a 50-step swarm run as
                      easily as a single tool call.
                    </p>
                  </div>
                </div>
              </div>

              <TryItCTA
                title="Try it in 2 minutes"
                body="Connect your own provider keys (OpenAI, Anthropic, Gemini, Bedrock, Azure, OCI, Qwen, Grok) or wire up an MCP / n8n tool — every tool flows through the same lifecycle described above."
                to="/integrations"
              />
            </section>
          </div>
          {/* ═══════════ CHAPTER 9 — Roadmap, Glossary & What's Next ═══════════ */}
          <div className={cn(activeChapter !== 8 && "hidden")}>
            {/* Glossary */}
            <section id="glossary" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={BookOpen}
                chip="Reference"
                title="Glossary — the agentic AI vocabulary"
              />
              <dl className="mt-6 grid gap-3 sm:grid-cols-2">
                {glossary.map(([term, def]) => (
                  <div
                    key={term}
                    className="rounded-lg border border-border/50 bg-background/60 p-4"
                  >
                    <dt className="text-sm font-semibold text-primary">{term}</dt>
                    <dd className="mt-1 text-sm text-muted-foreground">{def}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* ════════════════════ Production Roadmap ════════════════════ */}
            <section id="roadmap" className="mt-24 scroll-mt-24">
              <SectionHeader
                icon={Rocket}
                chip="After the curriculum · Your next 12 months"
                title="From curriculum graduate to shipping in production"
              />
              <p className="mt-4 max-w-3xl text-lg font-semibold text-foreground">
                {roadmapIntro.headline}
              </p>
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <ExplainerCard
                  tone="beginner"
                  title="The plain-English version"
                  body={roadmapIntro.child}
                />
                <ExplainerCard
                  tone="advanced"
                  title="The engineer's version"
                  body={roadmapIntro.engineer}
                />
              </div>

              {/* 7 phases */}
              <h3 className="mt-12 text-xl font-bold tracking-tight">
                The 7 phases — what to do, in order
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Don't skip ahead. Each phase un-blocks the next. Phases marked for both audiences
                need a builder AND a leader to do them well.
              </p>

              <div className="mt-6 grid gap-4">
                {roadmapPhases.map((p) => (
                  <div
                    key={p.id}
                    id={p.id}
                    className="scroll-mt-24 rounded-xl border border-border/50 bg-card/40 p-6"
                  >
                    <div className="flex flex-wrap items-start gap-4">
                      <span className="text-4xl font-extrabold text-primary/30">{p.number}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                            <p.icon className="h-3 w-3" /> Phase {p.number}
                          </div>
                          <span className="rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {p.duration}
                          </span>
                          {p.forWhom.map((w) => (
                            <span
                              key={w}
                              className="rounded-full border border-chart-2/40 bg-chart-2/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-chart-2"
                            >
                              {w === "builder" ? "Builders" : "Leaders"}
                            </span>
                          ))}
                        </div>
                        <h4 className="mt-2 text-lg font-bold">{p.title}</h4>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <ExplainerCard tone="beginner" title="Plain-English" body={p.child} />
                      <ExplainerCard tone="advanced" title="Engineer's view" body={p.engineer} />
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                          Outcomes you should have
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {p.outcomes.map((o) => (
                            <li
                              key={o}
                              className="flex items-start gap-2 text-sm text-muted-foreground"
                            >
                              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-chart-2" />
                              <span>{o}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                          Hand-picked resources
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {p.resources.map((r) => (
                            <li key={r.label}>
                              <a
                                href={r.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-start gap-2 text-sm text-foreground hover:text-primary"
                              >
                                <BookOpen className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                                <span>
                                  {r.label}{" "}
                                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                    · {r.kind}
                                  </span>{" "}
                                  ↗
                                </span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Where to deploy */}
              <div id="roadmap-platforms" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  Where to deploy — the platform landscape (2025/2026)
                </h3>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  There is no single "best" — pick by where your data already lives, your team's
                  skills, and the regulatory regime you sell into. Most serious deployments end up{" "}
                  <em>multi-vendor</em> behind a model gateway.
                </p>

                <div className="mt-6 grid gap-3 lg:grid-cols-2">
                  {deployPlatforms.map((p) => (
                    <a
                      key={p.name}
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group rounded-xl border border-border/50 bg-card/40 p-5 transition-colors hover:border-primary/50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-foreground group-hover:text-primary">
                          {p.name} ↗
                        </div>
                        <span className="rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          {p.category}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-semibold text-chart-2">Best for:</span> {p.bestFor}
                      </p>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-semibold text-destructive/80">Watch out:</span>{" "}
                        {p.watchOut}
                      </p>
                    </a>
                  ))}
                </div>
              </div>

              {/* ═══════ Running AI Agents on Cloud Platforms ═══════ */}
              <div id="cloud-deployment-guide" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  Running AI agents on AWS, Azure, GCP &amp; OCI
                </h3>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  Everything you learned in AgentSwarms — agents, tools, knowledge bases,
                  guardrails, memory, swarms — maps directly to the managed agent services on every
                  major cloud. Below is a practical, simplified guide for each platform. For a
                  detailed side-by-side comparison of cloud AI/ML capabilities and pricing, visit{" "}
                  <a
                    href="https://cloudcompare.online/ai-ml"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline font-medium"
                  >
                    CloudCompare.online/ai-ml ↗
                  </a>
                  .
                </p>

                {/* ── Capabilities comparison table ── */}
                <h4 className="mt-10 text-lg font-bold">Capabilities comparison</h4>
                <p className="mt-1 text-xs text-muted-foreground max-w-2xl">
                  How the four hyperscalers stack up across the capabilities you already know from
                  the AgentSwarms curriculum.
                </p>
                <div className="mt-4 overflow-x-auto rounded-xl border border-border/50">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 bg-card/60">
                        <th className="px-3 py-2.5 text-left font-semibold text-foreground">
                          Feature
                        </th>
                        <th className="px-3 py-2.5 text-left font-semibold text-foreground">
                          🟧 AWS
                        </th>
                        <th className="px-3 py-2.5 text-left font-semibold text-foreground">
                          🔵 Azure
                        </th>
                        <th className="px-3 py-2.5 text-left font-semibold text-foreground">
                          🔴 GCP
                        </th>
                        <th className="px-3 py-2.5 text-left font-semibold text-foreground">
                          🟤 OCI
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {cloudCapabilities.map((row, i) => (
                        <tr
                          key={row.feature}
                          className={cn(
                            "border-b border-border/30",
                            i % 2 === 0 ? "bg-background/40" : "bg-card/30",
                          )}
                        >
                          <td className="px-3 py-2 font-medium text-foreground">{row.feature}</td>
                          <td className="px-3 py-2 text-muted-foreground">{row.aws}</td>
                          <td className="px-3 py-2 text-muted-foreground">{row.azure}</td>
                          <td className="px-3 py-2 text-muted-foreground">{row.gcp}</td>
                          <td className="px-3 py-2 text-muted-foreground">{row.oci}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  For live pricing comparisons and more feature breakdowns →{" "}
                  <a
                    href="https://cloudcompare.online/ai-ml"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    cloudcompare.online/ai-ml ↗
                  </a>
                </p>

                {/* ── Per-provider guides ── */}
                <h4 className="mt-12 text-lg font-bold">Platform-by-platform guide</h4>
                <p className="mt-1 text-xs text-muted-foreground max-w-2xl">
                  Each guide shows how to take the skills you built in AgentSwarms and apply them on
                  the cloud platform. Expand any provider to see getting-started steps, the skill
                  mapping, best practices, supported models, and official documentation links.
                </p>

                <div className="mt-6 space-y-4">
                  {cloudProviderGuides.map((provider) => (
                    <details
                      key={provider.id}
                      className="group rounded-xl border border-border/50 bg-card/40 overflow-hidden"
                    >
                      <summary className="flex cursor-pointer items-center gap-3 px-5 py-4 text-sm font-semibold text-foreground hover:bg-card/60 transition-colors [&::-webkit-details-marker]:hidden list-none">
                        <span className="text-xl">{provider.icon}</span>
                        <span className="flex-1">{provider.name}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
                      </summary>

                      <div className="border-t border-border/40 px-5 py-5 space-y-6">
                        <p className="text-sm text-muted-foreground italic">{provider.tagline}</p>

                        {/* Getting started */}
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-primary mb-2">
                            Getting started — step by step
                          </div>
                          <ol className="space-y-2">
                            {provider.gettingStarted.map((step, i) => (
                              <li
                                key={i}
                                className="flex items-start gap-2 text-xs text-muted-foreground"
                              >
                                <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                                  {i + 1}
                                </span>
                                <span>{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>

                        {/* Skill mapping */}
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-primary mb-2">
                            AgentSwarms skill → {provider.name.split(" (")[0]} equivalent
                          </div>
                          <div className="overflow-x-auto rounded-lg border border-border/40">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-border/40 bg-card/60">
                                  <th className="px-3 py-2 text-left font-semibold">
                                    What you learned
                                  </th>
                                  <th className="px-3 py-2 text-left font-semibold">
                                    Where it lives on {provider.name.split(" (")[0]}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {provider.agentSwarmSkillsMap.map((row, i) => (
                                  <tr
                                    key={row.skill}
                                    className={i % 2 === 0 ? "bg-background/40" : ""}
                                  >
                                    <td className="px-3 py-1.5 font-medium text-foreground">
                                      {row.skill}
                                    </td>
                                    <td className="px-3 py-1.5 text-muted-foreground">
                                      {row.maps}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Best practices */}
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-primary mb-2">
                            Best practices
                          </div>
                          <ul className="space-y-1.5">
                            {provider.bestPractices.map((bp) => (
                              <li
                                key={bp}
                                className="flex items-start gap-2 text-xs text-muted-foreground"
                              >
                                <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-chart-2" />
                                <span>{bp}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Supported models */}
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-primary mb-2">
                            Supported models
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {provider.supportedModels.map((m) => (
                              <span
                                key={m}
                                className="rounded-full border border-border/50 bg-background/60 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Documentation links */}
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-primary mb-2">
                            Official documentation
                          </div>
                          <ul className="space-y-1.5">
                            {provider.docs.map((doc) => (
                              <li key={doc.label}>
                                <a
                                  href={doc.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-start gap-2 text-xs text-foreground hover:text-primary"
                                >
                                  <BookOpen className="mt-0.5 h-3 w-3 flex-shrink-0 text-primary" />
                                  <span>{doc.label} ↗</span>
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </details>
                  ))}
                </div>

                {/* Tip box */}
                <div className="mt-8 rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <p className="text-sm font-semibold text-foreground mb-2">💡 How to choose</p>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="text-primary shrink-0">•</span>
                      <span>
                        <strong className="text-foreground">Already on AWS?</strong> Start with
                        Bedrock Agents — widest model catalogue, deepest IAM integration.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary shrink-0">•</span>
                      <span>
                        <strong className="text-foreground">Microsoft 365 shop?</strong> Azure AI
                        Foundry gives you Copilot-level integration and EU data boundary.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary shrink-0">•</span>
                      <span>
                        <strong className="text-foreground">Multimodal + BigQuery?</strong> GCP's
                        Gemini models + Agent Builder are the natural fit.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary shrink-0">•</span>
                      <span>
                        <strong className="text-foreground">Sovereign cloud / Oracle DB?</strong>{" "}
                        OCI offers competitive GPU pricing and dedicated AI clusters.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-primary shrink-0">•</span>
                      <span>
                        <strong className="text-foreground">Multi-cloud?</strong> Export from
                        AgentSwarms as LangChain/LangGraph code and deploy anywhere. Use a model
                        gateway (LiteLLM, Portkey) to route across providers.
                      </span>
                    </li>
                  </ul>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Compare all four in detail →{" "}
                    <a
                      href="https://cloudcompare.online/ai-ml"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline font-medium"
                    >
                      CloudCompare.online/ai-ml ↗
                    </a>
                  </p>
                </div>
              </div>

              {/* Persona checklists */}
              <div id="roadmap-personas" className="mt-16 scroll-mt-24">
                <h3 className="text-xl font-bold tracking-tight">
                  Your 30 / 90 / 365-day plan — pick your persona
                </h3>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  Two paths through the same roadmap. Builders go deep on the tooling. Leaders go
                  deep on scope, risk, and ROI. Both should read both — production agents only ship
                  when these two roles actually talk to each other.
                </p>

                <div className="mt-6 grid gap-5 lg:grid-cols-2">
                  {personaTracks.map((t) => (
                    <div
                      key={t.persona}
                      className="rounded-xl border border-primary/30 bg-card/60 p-6"
                    >
                      <div className="flex items-center gap-2">
                        <div className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 p-2 text-primary">
                          <t.icon className="h-4 w-4" />
                        </div>
                        <h4 className="text-base font-bold">{t.title}</h4>
                      </div>
                      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                        {t.intro}
                      </p>

                      {[
                        { label: "First 30 days", items: t.thirtyDay, color: "chart-2" },
                        { label: "First 90 days", items: t.ninetyDay, color: "primary" },
                        { label: "Year 1", items: t.oneYear, color: "chart-4" },
                      ].map((blk) => (
                        <div key={blk.label} className="mt-5">
                          <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
                            {blk.label}
                          </div>
                          <ul className="mt-2 space-y-1.5">
                            {blk.items.map((it) => (
                              <li
                                key={it}
                                className="flex items-start gap-2 text-xs text-muted-foreground"
                              >
                                <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-chart-2" />
                                <span>{it}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}

                      <div className="mt-5 border-t border-border/50 pt-4">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
                          Recommended next reads
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {t.recommended.map((r) => (
                            <li key={r.label}>
                              <a
                                href={r.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-foreground hover:text-primary"
                              >
                                {r.label} ↗
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Common mistakes */}
              <h3 className="mt-16 text-xl font-bold tracking-tight">
                Mistakes we've seen real teams make
              </h3>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {commonMistakes.map((m) => (
                  <div key={m.t} className="rounded-xl border border-border/50 bg-card/40 p-4">
                    <div className="text-sm font-semibold">{m.t}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{m.b}</p>
                  </div>
                ))}
              </div>

              {/* Farewell */}
              <div className="mt-12 rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 via-card/60 to-card/0 p-8 text-center">
                <GraduationCap className="mx-auto h-8 w-8 text-primary" />
                <h3 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
                  {farewell.headline}
                </h3>
                <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  {farewell.body}
                </p>
                <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-primary">
                  {farewell.signature}
                </p>
                <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Link to="/dashboard">
                    <Button size="lg" className="gap-2 px-8">
                      Open the lab <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                  <Link to="/certification">
                    <Button variant="outline" size="lg" className="gap-2 px-8">
                      Take the certification exam
                    </Button>
                  </Link>
                </div>
              </div>
            </section>

            {/* CTA */}
            <section
              id="next"
              className="mt-24 scroll-mt-24 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-8 text-center"
            >
              <Zap className="mx-auto h-8 w-8 text-primary" />
              <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
                Reading is good. Building is better.
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
                Open the lab, pick a template, and apply what you just read. Every in-app page has a
                side-rail explaining the concept you're touching — so you keep learning as you
                build.
              </p>
              <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                <Link to="/dashboard">
                  <Button size="lg" className="gap-2 px-8">
                    Open the lab <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link to="/">
                  <Button variant="outline" size="lg" className="px-8">
                    Back to home
                  </Button>
                </Link>
              </div>
            </section>
          </div>
          {/* ═══════════ End of chapters — prev/next nav ═══════════ */}
          <div className="mt-12 flex flex-col gap-3 border-t border-border/50 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <Button
              variant="outline"
              onClick={() => goToChapter(activeChapter - 1)}
              disabled={activeChapter === 0}
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              {activeChapter > 0 ? (
                <span className="text-left">
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                    Previous
                  </span>
                  <span className="block truncate text-sm font-semibold">
                    {chapters[activeChapter - 1]?.title}
                  </span>
                </span>
              ) : (
                <span>You're at the start</span>
              )}
            </Button>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Chapter {activeChapter + 1} of {TOTAL_CHAPTERS}
            </span>
            {activeChapter < TOTAL_CHAPTERS - 1 ? (
              <Button onClick={() => goToChapter(activeChapter + 1)} className="gap-2">
                <span className="text-right">
                  <span className="block text-[10px] uppercase tracking-wider text-primary-foreground/80">
                    Next chapter
                  </span>
                  <span className="block truncate text-sm font-semibold">
                    {chapters[activeChapter + 1]?.title}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Link to="/dashboard">
                <Button className="gap-2">
                  Open the lab <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/* ─────────────────────────── PIECES ─────────────────────────── */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center sm:text-left">
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  chip,
  title,
}: {
  icon: typeof Compass;
  chip: string;
  title: string;
}) {
  return (
    <div>
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        <Icon className="h-3 w-3" /> {chip}
      </div>
      <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
    </div>
  );
}

function ConceptBlock({ c }: { c: Concept }) {
  return (
    <article id={c.id} className="scroll-mt-24">
      <div className="flex items-start gap-4">
        <span className="mt-1 text-4xl font-extrabold text-primary/30">{c.number}</span>
        <div className="flex-1">
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <c.icon className="h-3 w-3" /> Concept {c.number}
          </div>
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{c.title}</h2>
          <p className="mt-2 text-base leading-relaxed text-muted-foreground">{c.oneLiner}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <ExplainerCard tone="beginner" title="Beginner — the intuition" body={c.beginner} />
        <ExplainerCard tone="advanced" title="Advanced — the gotchas" body={c.advanced} />
      </div>

      <div className="mt-4 rounded-xl border border-border/50 bg-card/40 p-5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Code2 className="h-3 w-3 text-primary" /> Worked example — {c.example.title}
        </div>
        <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-xs leading-relaxed">
          <code>{c.example.code}</code>
        </pre>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <UseCaseCard title="In real life" items={c.realLife} tone="real" />
        <UseCaseCard title="In the enterprise" items={c.enterprise} tone="enterprise" />
      </div>

      <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-4">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
          <Lightbulb className="h-3 w-3" /> Common pitfalls
        </div>
        <ul className="space-y-1">
          {c.pitfalls.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
              <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>

      {c.furtherReading && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="text-muted-foreground">Further reading:</span>
          {c.furtherReading.map((r) => (
            <a
              key={r.href}
              href={r.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-foreground hover:border-primary/50 hover:text-primary"
            >
              {r.label} ↗
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function ExplainerCard({
  tone,
  title,
  body,
}: {
  tone: "beginner" | "advanced";
  title: string;
  body: string;
}) {
  return (
    <div
      className={
        tone === "beginner"
          ? "rounded-xl border border-primary/30 bg-primary/5 p-5"
          : "rounded-xl border border-border/50 bg-card/40 p-5"
      }
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
        {tone === "beginner" ? <Sparkles className="h-3 w-3" /> : <Telescope className="h-3 w-3" />}
        {title}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function UseCaseCard({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "real" | "enterprise";
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <CheckCircle2 className={`h-3 w-3 ${tone === "real" ? "text-chart-2" : "text-chart-1"}`} />
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it} className="flex items-start gap-2 text-sm text-muted-foreground">
            <span
              className={`mt-1.5 h-1 w-1 flex-shrink-0 rounded-full ${
                tone === "real" ? "bg-chart-2" : "bg-chart-1"
              }`}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────── WHAT IS AN AGENT (used inside Foundations) ─────────────────────── */

function WhatIsAnAgentSection() {
  return (
    <section id="what-is-an-agent" className="scroll-mt-24">
      <SectionHeader icon={Sparkles} chip="Definition" title="So… what is an agent, really?" />
      <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
        The word "agent" gets thrown around loosely. Two of the labs that ship the most production
        agentic systems — OpenAI and Anthropic — have written down crisp, surprisingly humble
        definitions. Read them side-by-side; the overlap is the part that actually matters.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border/50 bg-card/40 p-5">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-primary">
            <BookOpen className="h-3.5 w-3.5" /> OpenAI's definition
          </div>
          <p className="mt-3 text-sm leading-relaxed text-foreground">
            "Agents are systems that <strong>independently accomplish tasks on your behalf</strong>
            ."
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            In OpenAI's framing (see their <em>"A practical guide to building agents"</em>), an
            agent uses an LLM to <strong>manage workflow execution</strong>: it decides when a task
            is complete, can correct its own mistakes, and calls <strong>tools</strong> to interact
            with the outside world — all within guardrails you define.
          </p>
        </div>

        <div className="rounded-xl border border-border/50 bg-card/40 p-5">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-primary">
            <BookOpen className="h-3.5 w-3.5" /> Anthropic's definition
          </div>
          <p className="mt-3 text-sm leading-relaxed text-foreground">
            Agents are systems where "LLMs{" "}
            <strong>dynamically direct their own processes and tool usage</strong>, maintaining
            control over how they accomplish tasks."
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Anthropic (in <em>"Building effective agents"</em>) draws a sharp line between{" "}
            <strong>workflows</strong> — LLMs on predefined code paths — and <strong>agents</strong>
            , where the LLM is in the driver's seat: choosing the next step, picking the tool, and
            deciding when to stop.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-5">
        <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
          The shared core (what everyone agrees on)
        </p>
        <p className="mt-2 text-sm leading-relaxed text-foreground">
          An agent = <strong>an LLM in a loop</strong>, with <strong>tools</strong> it can call,{" "}
          <strong>memory</strong> of what just happened, and the{" "}
          <strong>autonomy to decide the next step</strong> until the task is done — bounded by
          guardrails.
        </p>
      </div>

      <div className="mt-8 rounded-2xl border border-border/50 bg-card/40 p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
              Reference architecture
            </p>
            <h3 className="mt-1 text-lg font-semibold text-foreground">
              Anatomy of an agent runtime
            </h3>
          </div>
          <p className="hidden max-w-xs text-xs text-muted-foreground sm:block">
            Inspired by AWS Bedrock AgentCore &amp; Google Vertex AI Agent Engine. The same six
            pieces show up in every serious agent runtime.
          </p>
        </div>

        <div className="overflow-x-auto">
          <svg
            viewBox="0 0 880 460"
            className="mx-auto h-auto w-full max-w-[880px]"
            role="img"
            aria-label="Agent runtime architecture diagram"
          >
            <defs>
              <marker
                id="agent-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
              <marker
                id="agent-arrow-primary"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
              </marker>
            </defs>

            <rect
              x="20"
              y="200"
              width="120"
              height="60"
              rx="10"
              className="fill-muted stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="80"
              y="226"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="13"
              fontWeight="600"
            >
              User
            </text>
            <text
              x="80"
              y="244"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              goal / prompt
            </text>

            <rect
              x="180"
              y="40"
              width="500"
              height="380"
              rx="16"
              className="fill-primary/5 stroke-primary/40"
              strokeWidth="1.5"
              strokeDasharray="6 4"
            />
            <text
              x="430"
              y="62"
              textAnchor="middle"
              className="fill-primary"
              fontSize="11"
              fontWeight="700"
              letterSpacing="1.5"
            >
              AGENT RUNTIME
            </text>

            <rect
              x="350"
              y="200"
              width="160"
              height="80"
              rx="12"
              className="fill-primary/15 stroke-primary"
              strokeWidth="2"
            />
            <text
              x="430"
              y="228"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="14"
              fontWeight="700"
            >
              Orchestrator
            </text>
            <text x="430" y="246" textAnchor="middle" className="fill-foreground" fontSize="11">
              LLM (reason → act)
            </text>
            <text
              x="430"
              y="264"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              plans · decides · loops
            </text>

            <rect
              x="220"
              y="90"
              width="160"
              height="70"
              rx="10"
              className="fill-card stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="300"
              y="115"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="12"
              fontWeight="600"
            >
              Memory
            </text>
            <text
              x="300"
              y="132"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              short-term (context)
            </text>
            <text
              x="300"
              y="148"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              long-term (vectors / KV)
            </text>

            <rect
              x="480"
              y="90"
              width="160"
              height="70"
              rx="10"
              className="fill-card stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="560"
              y="115"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="12"
              fontWeight="600"
            >
              Knowledge
            </text>
            <text
              x="560"
              y="132"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              RAG · vector store
            </text>
            <text
              x="560"
              y="148"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              graph · documents
            </text>

            <rect
              x="220"
              y="320"
              width="160"
              height="70"
              rx="10"
              className="fill-card stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="300"
              y="345"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="12"
              fontWeight="600"
            >
              Tools
            </text>
            <text
              x="300"
              y="362"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              APIs · functions
            </text>
            <text
              x="300"
              y="378"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              MCP · code interpreter
            </text>

            <rect
              x="480"
              y="320"
              width="160"
              height="70"
              rx="10"
              className="fill-card stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="560"
              y="345"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="12"
              fontWeight="600"
            >
              Guardrails
            </text>
            <text
              x="560"
              y="362"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              policies · auth · PII
            </text>
            <text
              x="560"
              y="378"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              budgets · approvals
            </text>

            <rect
              x="730"
              y="120"
              width="130"
              height="60"
              rx="10"
              className="fill-muted stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="795"
              y="146"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="12"
              fontWeight="600"
            >
              APIs / SaaS
            </text>
            <text
              x="795"
              y="162"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              Slack · CRM · DB
            </text>

            <rect
              x="730"
              y="280"
              width="130"
              height="60"
              rx="10"
              className="fill-muted stroke-border"
              strokeWidth="1.5"
            />
            <text
              x="795"
              y="306"
              textAnchor="middle"
              className="fill-foreground"
              fontSize="12"
              fontWeight="600"
            >
              Observability
            </text>
            <text
              x="795"
              y="322"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              traces · evals · cost
            </text>

            <line
              x1="140"
              y1="225"
              x2="350"
              y2="230"
              className="stroke-primary"
              strokeWidth="2"
              markerEnd="url(#agent-arrow-primary)"
            />
            <line
              x1="350"
              y1="250"
              x2="140"
              y2="250"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="395"
              y1="200"
              x2="320"
              y2="160"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="335"
              y1="160"
              x2="410"
              y2="200"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="465"
              y1="200"
              x2="540"
              y2="160"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="555"
              y1="160"
              x2="480"
              y2="200"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="395"
              y1="280"
              x2="320"
              y2="320"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="335"
              y1="320"
              x2="410"
              y2="280"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="465"
              y1="280"
              x2="540"
              y2="320"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="380"
              y1="345"
              x2="730"
              y2="155"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              markerEnd="url(#agent-arrow)"
            />
            <line
              x1="640"
              y1="350"
              x2="730"
              y2="310"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              markerEnd="url(#agent-arrow)"
            />
          </svg>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Read it as a loop, not a pipeline: the <strong>Orchestrator (LLM)</strong> reads the user
          goal, pulls relevant facts from <strong>Memory</strong> and <strong>Knowledge</strong>,
          picks a <strong>Tool</strong> to act on the world, observes the result, and decides
          whether to loop again or finish — every step gated by <strong>Guardrails</strong> and
          recorded for <strong>Observability</strong>. AWS Bedrock AgentCore and Google Vertex AI
          Agent Engine package these same six boxes as a managed runtime.
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────── FOUNDATION BLOCK ─────────────────────── */

function FoundationBlock({ f }: { f: Foundation }) {
  return (
    <article id={f.id} className="scroll-mt-24">
      <div className="flex items-start gap-4">
        <span className="mt-1 text-3xl font-extrabold text-primary/30">{f.number}</span>
        <div className="flex-1">
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <f.icon className="h-3 w-3" /> Foundation {f.number}
          </div>
          <h3 className="text-2xl font-bold tracking-tight sm:text-3xl">{f.title}</h3>
          <p className="mt-2 text-base leading-relaxed text-muted-foreground">{f.oneLiner}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
            <Sparkles className="h-3 w-3" /> Like you're 10
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{f.child}</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-card/40 p-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
            <Telescope className="h-3 w-3" /> For the engineer
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{f.engineer}</p>
        </div>
      </div>

      {f.subCards && f.subCards.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Puzzle className="h-3 w-3 text-primary" /> The varieties you'll meet
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {f.subCards.map((s) => (
              <div key={s.name} className="rounded-xl border border-border/50 bg-card/40 p-4">
                <h4 className="text-sm font-semibold text-foreground">{s.name}</h4>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.what}</p>
                {s.example && (
                  <div className="mt-2 rounded-md bg-background/70 px-2 py-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                      Examples
                    </span>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {s.example}
                    </p>
                  </div>
                )}
                {s.whenToUse && (
                  <div className="mt-2 rounded-md bg-background/70 px-2 py-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                      When to use
                    </span>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {s.whenToUse}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {f.example && (
        <div className="mt-6 rounded-xl border border-border/50 bg-card/40 p-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Code2 className="h-3 w-3 text-primary" /> Worked example — {f.example.title}
          </div>
          <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-xs leading-relaxed">
            <code>{f.example.code}</code>
          </pre>
        </div>
      )}

      <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
          <Bot className="h-3 w-3" /> Why it matters for agents
        </div>
        <ul className="space-y-1">
          {f.whyForAgents.map((w) => (
            <li key={w} className="flex items-start gap-2 text-sm text-muted-foreground">
              <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <UseCaseCard title="In real life" items={f.realLife} tone="real" />
        <UseCaseCard title="In the enterprise" items={f.enterprise} tone="enterprise" />
      </div>

      <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-4">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
          <Lightbulb className="h-3 w-3" /> Common pitfalls
        </div>
        <ul className="space-y-1">
          {f.pitfalls.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
              <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-destructive/60" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>

      {f.furtherReading && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="text-muted-foreground">Further reading:</span>
          {f.furtherReading.map((r) => (
            <a
              key={r.href}
              href={r.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-foreground hover:border-primary/50 hover:text-primary"
            >
              {r.label} ↗
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

/* ─────────────────────── PILLAR CARD (scaling) ─────────────────────── */

function PillarCard({ p }: { p: ScalingPillar }) {
  return (
    <article id={p.id} className="scroll-mt-24 rounded-xl border border-border/50 bg-card/40 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <p.icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
            Pillar {p.number}
          </div>
          <h4 className="text-base font-semibold text-foreground">{p.title}</h4>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <Sparkles className="h-3 w-3" /> Like you're 10
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{p.child}</p>
        </div>
        <div className="rounded-lg border border-border/40 bg-background/50 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <Telescope className="h-3 w-3" /> For the engineer
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{p.engineer}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border/40 bg-background/50 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <CheckCircle2 className="h-3 w-3 text-primary" /> What to do
          </div>
          <ul className="space-y-1">
            {p.whatToDo.map((w) => (
              <li key={w} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-border/40 bg-background/50 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Activity className="h-3 w-3 text-primary" /> Signals to watch
          </div>
          <ul className="space-y-1">
            {p.signals.map((s) => (
              <li key={s} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-chart-2" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

// Reusable "Try it in 2 minutes" CTA — links each /learn section to its
// matching authenticated lab so the lesson and the live tool stay one click
// apart. Same visual language as the original SQL-section CTA.
type TryItCTAProps = {
  title: string;
  body: string;
  to:
    | "/playground"
    | "/agents"
    | "/swarms"
    | "/templates"
    | "/knowledge"
    | "/integrations"
    | "/mcp"
    | "/traces"
    | "/analytics"
    | "/budgets"
    | "/dashboard";
  ctaLabel?: string;
};

function TryItCTA({ title, body, to, ctaLabel = "Open the lab" }: TryItCTAProps) {
  return (
    <div className="mt-10 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/40 to-card/0 p-6">
      <div className="flex items-start gap-3">
        <Rocket className="mt-0.5 h-5 w-5 text-primary" />
        <div className="flex-1">
          <h4 className="text-base font-semibold text-foreground">{title}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          <Link to={to} className="mt-3 inline-flex">
            <Button size="sm" className="gap-1.5">
              {ctaLabel} <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function InterviewReminder({ topic, body }: { topic: string; body: string }) {
  return (
    <div className="mt-8 rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-card/40 to-card/0 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <Briefcase className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            <MessageCircle className="h-3 w-3" /> In the interview
          </div>
          <h4 className="text-base font-semibold text-foreground">
            They will ask you about{" "}
            <span className="text-amber-700 dark:text-amber-400">{topic}</span>
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
          <Link
            to="/interview-questions"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
          >
            See standout answers <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Reusable Field Manual renderer (used by Specialized / Business / Deep Dives depth sections) ─────────── */
type DepthSectionShape = {
  id: string;
  number: string;
  title: string;
  oneLiner: string;
  body: string;
  workedExample?: { title: string; language: string; code: string };
  sources?: { label: string; href: string; note?: string }[];
};

function FieldManualSection({
  anchorId,
  chip,
  intro,
  sections,
  closing,
}: {
  anchorId: string;
  chip: string;
  intro: { headline: string; body: string };
  sections: DepthSectionShape[];
  closing: { title: string; body: string };
}) {
  return (
    <section id={anchorId} className="mt-24 scroll-mt-24">
      <SectionHeader icon={BrainCircuit} chip={chip} title={intro.headline} />
      <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">{intro.body}</p>

      <div className="mt-10 space-y-12">
        {sections.map((s) => (
          <article
            key={s.id}
            id={s.id}
            className="scroll-mt-24 rounded-2xl border border-border/50 bg-card/30 p-6 lg:p-8"
          >
            <div className="flex items-baseline gap-3">
              <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
                Section {s.number}
              </span>
            </div>
            <h3 className="mt-2 text-2xl font-bold tracking-tight">{s.title}</h3>
            <p className="mt-3 max-w-3xl text-base font-medium italic text-foreground/80">
              {s.oneLiner}
            </p>

            <div className="prose prose-sm prose-invert mt-6 max-w-3xl text-[15px] leading-[1.75] text-muted-foreground [&_strong]:text-foreground">
              {s.body.split(/\n\n+/).map((para, i) => (
                <p key={i} className="mb-4">
                  {para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, j) => {
                    if (seg.startsWith("**") && seg.endsWith("**"))
                      return <strong key={j}>{seg.slice(2, -2)}</strong>;
                    if (seg.startsWith("`") && seg.endsWith("`"))
                      return (
                        <code key={j} className="rounded bg-muted/40 px-1 py-0.5 text-[13px]">
                          {seg.slice(1, -1)}
                        </code>
                      );
                    return <span key={j}>{seg}</span>;
                  })}
                </p>
              ))}
            </div>

            {s.workedExample && (
              <div className="mt-6 rounded-xl border border-border/50 bg-background/60 p-5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Code2 className="h-3 w-3 text-primary" /> Worked example —{" "}
                  {s.workedExample.title}
                </div>
                <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-[12px] leading-relaxed text-foreground/90">
                  <code>{s.workedExample.code}</code>
                </pre>
              </div>
            )}

            {s.sources && s.sources.length > 0 && (
              <div className="mt-6 rounded-lg border border-border/40 bg-background/40 p-4">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <BookOpen className="h-3 w-3 text-primary" /> Primary sources &amp; papers
                </div>
                <div className="space-y-2">
                  {s.sources.map((src) => (
                    <a
                      key={src.href}
                      href={src.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-md px-2 py-1 hover:bg-primary/5"
                    >
                      <div className="text-sm font-semibold text-foreground hover:text-primary">
                        {src.label} ↗
                      </div>
                      {src.note && (
                        <div className="mt-0.5 text-xs italic text-muted-foreground">
                          {src.note}
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="mt-12 rounded-xl border border-primary/30 bg-primary/5 p-6">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
          <Compass className="h-3 w-3" /> {closing.title}
        </div>
        <p className="text-[15px] leading-[1.75] text-muted-foreground">{closing.body}</p>
      </div>
    </section>
  );
}
