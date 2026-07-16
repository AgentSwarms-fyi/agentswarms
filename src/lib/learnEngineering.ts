// Engineering Rigor & Deep Mental Models of Agents.
// Purpose: close the gap between "I built an agent in the playground" and
// "I can reason about agents like a senior systems engineer."
//
// Sources synthesised: Anthropic — Building Effective Agents (Dec 2024) /
// "Workflows vs Agents"; OpenAI — A Practical Guide to Building Agents
// (2025) and AgentKit launch notes; Google — Agents whitepaper & ADK docs;
// LangGraph durable-execution docs; Berkeley AgentBench & τ-bench papers;
// Anthropic AgentArena (eval at scale); Meta CICERO / Park et al.
// "Generative Agents" (emergent behaviour); Kleppmann — Designing
// Data-Intensive Applications (retries, idempotency); Google SRE Workbook
// (latency budgets, error budgets, circuit breakers); Jay Alammar &
// Hugging Face on caching/cascading; Microsoft Magentic-One & AutoGen
// papers on control topology; Salesforce Agentforce architecture notes.
import type { LucideIcon } from "lucide-react";
import {
  Brain, Network, GitBranch, Workflow, Boxes, Repeat, ShieldAlert,
  Gauge, Activity, Layers, ServerCog, Scale, Compass, Sparkles, AlertTriangle,
} from "lucide-react";

/* ─────────────────────────── INTRO ─────────────────────────── */

export const engineeringIntro = {
  headline:
    "An agent is not just 'LLM + prompt + tools'. It's a small distributed system that thinks.",
  beginner:
    "If you're new, here's the honest version: building one agent that works once on your laptop is the easy part. The hard part is making it survive ten thousand real users, three model providers, two regions, one bad actor, and the day OpenAI deprecates the model you depend on. This section is the bridge between 'it works on my machine' and 'I trust it to run my business overnight'.",
  engineer:
    "Think of an agent as a stateful, partially-observable, non-deterministic distributed system whose dominant remote dependency happens to be a probabilistic function (the model). Every classic distributed-systems concern reappears — at-least-once delivery, idempotency, timeouts, circuit breakers, backpressure, hot caches, blast-radius — plus three new ones: prompt drift, model drift, and emergent multi-agent behaviour. The frameworks (LangGraph, AgentKit, ADK, Magentic-One) are conveniences. The engineering discipline below is what actually makes the system survive contact with production.",
};

/* ───────────────────── 1. The deeper mental model ───────────────────── */

export type AgentAxis = {
  id: string;
  icon: LucideIcon;
  title: string;
  beginner: string;
  engineer: string;
  examples: string[];
};

export const agentAxes: AgentAxis[] = [
  {
    id: "axis-state",
    icon: Layers,
    title: "State management — what the agent 'knows' between steps",
    beginner:
      "An LLM forgets everything the moment it stops talking. So 'state' is whatever you carry forward yourself: the chat history, a scratchpad of notes, a vector store of past facts, the current step in a plan. Without state, an agent is amnesiac.",
    engineer:
      "Five concrete state surfaces, each with its own consistency, durability and access pattern: (1) conversational state (message log, replayable), (2) working memory / scratchpad (per-run, often JSON), (3) episodic memory (long-term, user-scoped, indexed), (4) semantic memory (knowledge base / RAG, shared, immutable-ish), (5) execution state (current node in graph, retries left, in-flight tool calls — must be durable for restart). LangGraph's checkpointer, OpenAI Conversations API, Bedrock AgentCore Memory, and our own conversation_memory + agent_memory_items tables all map onto these five.",
    examples: [
      "Conversational state — last 20 messages + rolling summary (STM)",
      "Working memory — `memory_set/get` JSON scratchpad shared across swarm nodes",
      "Episodic — `agent_memory_items` rows of kind='preference' / 'episodic'",
      "Semantic — `knowledge_documents` + KB graph entities/relations",
      "Execution — durable graph state in LangGraph / Temporal / Inngest",
    ],
  },
  {
    id: "axis-planning",
    icon: GitBranch,
    title: "Planning strategy — how the agent decides what to do next",
    beginner:
      "Imagine sending an assistant on errands. They could: (a) just react to what's in front of them, (b) write a to-do list first then work through it, (c) think out loud and revise, (d) ask a senior coworker. Agents pick the same way — and the choice changes accuracy, latency and cost dramatically.",
    engineer:
      "Five mainstream planning strategies, ordered by sophistication: (1) ReAct (Yao et al. 2022) — Thought→Action→Observation loop, cheap, brittle on long horizons; (2) Plan-and-Execute / LLMCompiler — write the DAG up front, then execute, far cheaper at scale, weaker on novel tasks; (3) Reflexion / self-critique — generate, critique, regenerate, big quality wins on reasoning, +30–50% latency; (4) Tree-of-Thoughts / MCTS — explore branches, evaluate, prune (used in DeepMind FunSearch and Magentic-One's orchestrator); (5) Hierarchical task networks — a high-level planner emits subgoals, specialist workers execute (HuggingGPT, ChatDev, Anthropic's Claude Sonnet 4.5 'Computer Use'). Choose by task horizon, verifiability, and budget — not by hype.",
    examples: [
      "ReAct — best for ≤5-step tool-use tasks with cheap models",
      "Plan-and-Execute — best for repeatable multi-step pipelines (data ETL, document workflows)",
      "Reflexion — best where quality > latency (essays, code review, legal drafts)",
      "Tree-of-Thoughts — best for verifiable problems with branching (planning, theorem proving)",
      "Hierarchical — best for multi-agent swarms with specialised workers",
    ],
  },
  {
    id: "axis-comm",
    icon: Network,
    title: "Multi-agent communication protocols — how agents talk to each other",
    beginner:
      "When multiple agents work together, they need a shared language and rules: who speaks first, how do they hand off, what happens if two disagree, when do they stop? Without rules, they either talk forever or all do the same thing.",
    engineer:
      "Three protocol families dominate in 2025: (1) Message-passing with structured handoffs — OpenAI's Swarm/Agents SDK and our Swarm canvas use this; cheap, debuggable, no schema standard. (2) A2A (Agent-to-Agent) protocol — Google-led open standard for cross-vendor agent interop, JSON-RPC over HTTP, capability discovery via Agent Cards; we ship an A2A endpoint at /api/a2a. (3) MCP (Model Context Protocol) — Anthropic-led standard, primarily for agent↔tool but increasingly used agent↔agent. Beyond the wire format, three social protocols matter: contract-net (auctions, used in CrewAI), blackboard (shared scratchpad, used in Magentic-One), and debate (two agents argue, a third judges — Du et al. 2023 shows +10% accuracy on math/reasoning).",
    examples: [
      "Handoff — Router decides next worker, passes structured payload (our default)",
      "A2A — `agent.send_message` over HTTPS with JSON-RPC, capability cards",
      "MCP — `tools/list` + `tools/call`, increasingly used between agents too",
      "Blackboard — shared `swarm_scratchpad` JSON; any node reads/writes",
      "Debate — Critic agent grades Worker output; Judge agent picks winner",
    ],
  },
  {
    id: "axis-control",
    icon: Workflow,
    title: "Control topology — centralised vs decentralised",
    beginner:
      "Either one boss assigns work and reviews it (centralised), or the team self-organises and figures it out (decentralised). The first is predictable and cheap. The second is creative but can spiral. Most production systems are centralised; most research demos are decentralised.",
    engineer:
      "Four topologies, with concrete trade-offs:\n\n• Centralised orchestrator (a.k.a. supervisor) — one Router LLM picks the next worker. Predictable, easy to trace, easy to budget. Bottleneck on the orchestrator. This is what AgentSwarms, OpenAI Agents SDK, LangGraph supervisor, AutoGen GroupChatManager, and Salesforce Agentforce all default to.\n\n• Hierarchical — Orchestrator → sub-orchestrators → workers. Scales beyond one model's context window. Used in HuggingGPT, ChatDev, Magentic-One.\n\n• Peer-to-peer / decentralised — agents broadcast; whoever is best-suited replies. Emergent, hard to debug, can deadlock. Park et al.'s 'Generative Agents' (Smallville) and Meta's CICERO are the canonical research examples.\n\n• Market / contract-net — agents bid on tasks; winner executes. Self-balances load, but bidding overhead is real. Used in some CrewAI deployments and academic swarm robotics work.\n\nProduction rule of thumb: start centralised, add hierarchy at scale, only go peer-to-peer when the task is genuinely open-ended (creative simulation, research exploration).",
    examples: [
      "Centralised — Router → [Researcher, Writer, Reviewer], synchronous handoffs",
      "Hierarchical — Project Manager → 3 Team Leads → 9 Workers (ChatDev)",
      "Peer-to-peer — N town-NPC agents in Smallville observe and react",
      "Market — CrewAI 'kickoff' with autonomous task bidding",
    ],
  },
];

/* ───────────────────── 2. Deterministic vs Emergent ───────────────────── */

export type DetEmergentRow = {
  dimension: string;
  deterministic: string;
  emergent: string;
};

export const determinismIntro = {
  beginner:
    "Two ways to ship agents. The boring one — write down the steps in advance and let the LLM only fill in the blanks — almost always wins in production. The exciting one — let the LLM decide every step at runtime — is what people demo on Twitter. Anthropic's own engineering team published this distinction and recommends the boring one first.",
  engineer:
    "Anthropic's December 2024 'Building Effective Agents' essay drew the canonical line between Workflows (predefined control flow, LLM is a node) and Agents (LLM-driven control flow, dynamic). Workflows compose well, are cheaper to evaluate, and bound blast-radius. Agents are necessary only when the task graph genuinely cannot be enumerated in advance. The 2025 industry consensus (OpenAI's Practical Guide, Google's Agents whitepaper, Salesforce's Agentforce architecture) is: always start with the workflow; promote to agentic only on evidence the workflow underperforms.",
};

export const detEmergentTable: DetEmergentRow[] = [
  {
    dimension: "Control flow",
    deterministic: "Hard-coded DAG / state machine. LLM is a node, not the driver.",
    emergent: "LLM picks the next step at every iteration. Loop until done.",
  },
  {
    dimension: "Predictability",
    deterministic: "Same input → same path (modulo LLM stochasticity inside nodes).",
    emergent: "Same input → different paths. Hard to reason about cost & latency.",
  },
  {
    dimension: "Cost",
    deterministic: "Bounded. You can compute max tokens per request up front.",
    emergent: "Unbounded without a step / token / dollar cap. Runaway loops are the #1 outage.",
  },
  {
    dimension: "Evaluation",
    deterministic: "Test each node independently. Mock the others. Reproducible.",
    emergent: "Must test trajectories end-to-end. Flaky. Need LLM-as-judge.",
  },
  {
    dimension: "Debuggability",
    deterministic: "Trace looks like a flowchart. Failures localise to a node.",
    emergent: "Trace looks like a graph search. Failures cascade across iterations.",
  },
  {
    dimension: "When it wins",
    deterministic: "ETL, document processing, support triage, RevOps, code review — anything you can flowchart on a napkin.",
    emergent: "Open-ended research, simulation, creative agents, novel computer-use tasks.",
  },
  {
    dimension: "Real example",
    deterministic: "Klarna customer service: classifier → KB lookup → response template → optional refund (HITL).",
    emergent: "Anthropic's Claude Sonnet 4.5 'Computer Use' — agent decides what to click next based on screen.",
  },
];

/* ───────────────────── 3. Failure handling & retries ───────────────────── */

export type FailureMode = {
  id: string;
  icon: LucideIcon;
  title: string;
  what: string;
  fix: string;
  code?: string;
};

export const failureIntro = {
  beginner:
    "Agents fail in ways your old code didn't: the model times out, returns invalid JSON, calls a tool twice, hallucinates an API that doesn't exist, or quietly succeeds with the wrong answer. You can't prevent these — you have to plan for them.",
  engineer:
    "Treat every model and tool call as a remote, partially-flaky procedure call. The classical handbook applies (timeouts, retries, idempotency keys, circuit breakers, dead-letter queues, compensating transactions) plus three agent-specific patterns: structured-output validation with retry-on-parse-failure, tool-call de-duplication by content hash, and budget-bounded loops with a hard step ceiling.",
};

export const failureModes: FailureMode[] = [
  {
    id: "fm-timeout",
    icon: Repeat,
    title: "Timeouts & retries with exponential backoff + jitter",
    what:
      "Provider calls hang or 5xx all the time. A naive retry storm can DDoS the provider AND blow your budget in 30 seconds.",
    fix:
      "Per-call timeout (typically 30–60s for non-streaming, longer for reasoning models). Bounded retries (3 max). Exponential backoff with full jitter to avoid thundering herd. Different policies for 429 (respect Retry-After), 5xx (retry), 4xx (do NOT retry — it's your bug).",
    code: `// Bounded retry with full jitter
async function callModel(req, { maxRetries = 3, baseMs = 500 }) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await withTimeout(provider.chat(req), 45_000);
    } catch (e) {
      if (e.status === 429 && e.retryAfter) await sleep(e.retryAfter * 1000);
      else if (e.status >= 500 || e.code === "TIMEOUT") {
        if (i === maxRetries) throw e;
        const cap = baseMs * 2 ** i;
        await sleep(Math.random() * cap);  // full jitter
      } else throw e;  // 4xx — your bug, don't retry
    }
  }
}`,
  },
  {
    id: "fm-idempotency",
    icon: ShieldAlert,
    title: "Idempotency keys for tool calls with side effects",
    what:
      "Retries can cause the agent to send the same email twice, charge the card twice, create the same Jira ticket twice. Duplicates are the #1 user-visible failure mode of badly-built agents.",
    fix:
      "Every write tool gets an idempotency_key derived from a stable hash of (agent_run_id, tool_name, normalised_args). Server (yours or vendor's) de-duplicates within a TTL window. Stripe's pattern is the canonical reference; we apply the same idea to email, ticketing, and database writes.",
    code: `const idemKey = sha256(\`\${runId}:send_email:\${normalize(args)}\`);
await emailApi.send(args, { headers: { "Idempotency-Key": idemKey } });
// Server returns the same response for repeats within 24h.`,
  },
  {
    id: "fm-structured",
    icon: AlertTriangle,
    title: "Structured-output validation + repair loop",
    what:
      "The model returns 'Sure! Here's your JSON: {...' with prose around it, or a key with a typo, or hallucinates an enum value. Your downstream code crashes.",
    fix:
      "Always demand a strict JSON schema (Anthropic tools / OpenAI Structured Outputs / Gemini responseSchema). Validate with Zod or jsonschema. On parse failure, send the validator error back to the model (max 1 repair turn) and ask for a corrected response. Never accept free text where you need a typed value.",
    code: `const schema = z.object({ refund_amount: z.number().min(0).max(500) });
let raw = await model.complete(prompt, { responseFormat: { type: "json_schema", schema } });
const parsed = schema.safeParse(JSON.parse(raw));
if (!parsed.success) {
  raw = await model.complete([...prompt,
    { role: "user", content: \`Your JSON failed: \${parsed.error.message}. Reply with valid JSON only.\` }
  ]);
}`,
  },
  {
    id: "fm-loop",
    icon: AlertTriangle,
    title: "Loop detection & step / token / cost ceilings",
    what:
      "An agent calls the same tool with the same args three times, or oscillates between two tools forever. Your bill hits $400 in an hour. (Real story — happened to multiple teams in 2024.)",
    fix:
      "Hard ceilings on every loop: max_steps (typically 10–25), max_tokens_total, max_cost_usd. Detect repeated (tool, args) tuples within the last N steps and break with a structured error. Surface the ceiling hit in the trace so a human sees it.",
    code: `if (steps >= MAX_STEPS) throw new BudgetError("step ceiling");
if (totalCost > AGENT_BUDGET) throw new BudgetError("cost ceiling");
const sig = \`\${tool}:\${hash(args)}\`;
recent.push(sig); if (recent.slice(-3).every(s => s === sig)) {
  throw new LoopError("repeated tool call detected");
}`,
  },
  {
    id: "fm-circuit",
    icon: ShieldAlert,
    title: "Circuit breakers per provider & per tool",
    what:
      "Provider X goes down. Every request hangs for 60s before failing. Your latency p95 explodes from 2s to 60s and your queue backs up.",
    fix:
      "Per-dependency circuit breaker (open / half-open / closed) — after N consecutive failures, fail fast for cooldown_ms, then probe with one request. Pair with a model gateway (LiteLLM, Portkey) so failover to a backup provider is one config flip.",
    code: `// Pseudocode
if (breaker.state === "open" && now < breaker.openUntil) {
  return fallbackProvider.chat(req);  // skip the dead one
}`,
  },
  {
    id: "fm-compensate",
    icon: GitBranch,
    title: "Compensating actions (the saga pattern)",
    what:
      "A multi-step workflow succeeds at step 1 (charged the card), fails at step 2 (couldn't book the hotel). You can't 'rollback' across HTTP. The user sees money missing and no booking.",
    fix:
      "For every irreversible step, register a compensating action (refund the charge) and run it on downstream failure. This is the Saga pattern from microservices, applied to agent workflows. Temporal, Inngest, and LangGraph durable execution all support this natively.",
  },
];

/* ───────────────────── 4. Evaluation at scale ───────────────────── */

export const evalIntro = {
  beginner:
    "How do you know your agent is actually getting better when you change a prompt? You write down a list of test questions with the right answers, and re-grade after every change. Just like school tests — but automated, and run on every code change.",
  engineer:
    "Production-grade agent eval has four layers: (1) unit-style — assertions on individual nodes / tools / prompts, run on every PR; (2) golden set / regression — versioned dataset of (input, expected, rubric), LLM-as-judge for grading, blocks merges that drop pass-rate; (3) trajectory eval — score whole multi-step traces (did the planner pick a sane path? did it use the right tools?), τ-bench / AgentBench style; (4) online eval — sampled live traffic scored by humans + LLM judge, drift detection, A/B harness. Without all four you are flying blind.",
};

export type EvalLayer = {
  id: string;
  number: string;
  icon: LucideIcon;
  title: string;
  cadence: string;
  what: string;
  tools: string[];
};

export const evalLayers: EvalLayer[] = [
  {
    id: "eval-unit",
    number: "L1",
    icon: Boxes,
    title: "Node / tool / prompt unit tests",
    cadence: "Every commit (CI gate)",
    what:
      "Assertions on the smallest pieces: 'this prompt with this input produces a JSON object containing key X', 'this tool returns within 2s', 'this guardrail blocks PII'. Cheap, fast (<30s), high coverage.",
    tools: ["promptfoo", "Vitest + Zod", "OpenAI Evals", "Anthropic Evals"],
  },
  {
    id: "eval-golden",
    number: "L2",
    icon: Scale,
    title: "Golden set with LLM-as-judge",
    cadence: "Every PR + nightly",
    what:
      "50–500 hand-curated (input, ideal answer, rubric) cases. A judge model (typically a stronger one than the agent) scores each output 1–5 against the rubric. Pass-rate is your CI gate. Drop > 2% blocks merge.",
    tools: ["Ragas (RAG-specific)", "DeepEval", "LangSmith Evaluation", "Braintrust"],
  },
  {
    id: "eval-traj",
    number: "L3",
    icon: GitBranch,
    title: "Trajectory / behavioural evaluation",
    cadence: "Pre-release + weekly",
    what:
      "Whole-run evaluation of multi-step agents. Did the planner pick a sane path? Did it call the right tools in the right order? Did it stop at the right time? Bench suites like τ-bench (airline / retail), AgentBench, SWE-bench score realistic workflows. Berkeley's Agent Arena adds head-to-head comparison.",
    tools: ["τ-bench", "AgentBench", "AgentArena", "WebArena"],
  },
  {
    id: "eval-online",
    number: "L4",
    icon: Activity,
    title: "Online evaluation on live traffic",
    cadence: "Continuous (1–10% sample)",
    what:
      "Sample real production runs, score with both an LLM judge and weekly human review. Track pass-rate, refusal-rate, tool-error-rate, and cost-per-successful-task as time-series. Alert on > 3σ drift. This is how you catch model deprecations, prompt drift, and adversarial users.",
    tools: ["Langfuse", "Arize Phoenix", "Datadog LLM Observability", "Helicone"],
  },
];

/* ───────────────────── 5. System design under constraints ───────────────────── */

export const systemDesignIntro = {
  beginner:
    "Same agent, same prompt, but on a real product you have three masters: it must be fast enough that users don't leave, cheap enough that the business survives, and reliable enough that ops doesn't quit. You can't max all three. Engineering is the art of choosing where to spend.",
  engineer:
    "Every production agent lives inside three budgets — latency, cost, and reliability — and an explicit budget allocation across components. The 7 levers below are how senior engineers spend those budgets. They compose: model cascading + semantic caching + parallel tool calls can take a 12s, $0.18 agent down to 1.4s and $0.01 with no quality loss.",
};

export type DesignLever = {
  id: string;
  icon: LucideIcon;
  title: string;
  problem: string;
  technique: string;
  trade: string;
};

export const designLevers: DesignLever[] = [
  {
    id: "dl-budget",
    icon: Gauge,
    title: "Latency budgets per step",
    problem:
      "Users abandon at ~3s. Your agent makes 5 model calls and 3 tool calls. Each averages 2s. You're at 16s.",
    technique:
      "Allocate an explicit budget per step (e.g. 800ms retrieval + 1200ms planner + 1800ms writer + 200ms guardrail = 4000ms). Enforce with timeouts. Surface budget violations in traces.",
    trade:
      "Tighter budgets force smaller models or shorter prompts on hot paths. Quality must be measured, not assumed.",
  },
  {
    id: "dl-cascade",
    icon: Layers,
    title: "Model cascading (cheap-first, escalate on uncertainty)",
    problem:
      "Using GPT-5 for every request burns money. Using GPT-5-nano misses 12% of edge cases.",
    technique:
      "Try the cheap/fast model first. If its self-reported confidence is low, or a verifier disagrees, OR a structured-output check fails, escalate to the stronger model. Frugal-GPT (Stanford 2023) showed 50–98% cost cuts with equal accuracy.",
    trade:
      "Adds one verifier call. Net win as long as escalation rate < ~30%. Track escalation rate as a first-class metric.",
  },
  {
    id: "dl-cache",
    icon: ServerCog,
    title: "Caching: prompt-prefix, semantic, and tool-result",
    problem:
      "Your system prompt is 4000 tokens, sent on every request. Users ask the same 200 FAQs every day.",
    technique:
      "Three layers: (1) provider-side prompt-prefix cache (Anthropic, OpenAI, Gemini all support it — up to 90% off cached portion); (2) semantic cache for whole responses keyed by embedding similarity (Redis with vector module, GPTCache); (3) tool-result cache for read-only deterministic tools.",
    trade:
      "Semantic cache hit-rate must be measured carefully — false positives serve a wrong answer with high confidence. Always include a TTL and a cache-bust on prompt or KB change.",
  },
  {
    id: "dl-stream",
    icon: Activity,
    title: "Streaming + speculative responses",
    problem:
      "Even at 4s total, the user sees a blank screen until the end. Perceived latency is awful.",
    technique:
      "Stream tokens to the UI as they arrive. For multi-step agents, stream each step's status ('Searching docs… Drafting answer…'). For high-stakes flows, render a draft optimistically while a verifier runs in parallel.",
    trade:
      "Streaming hides cost surprises — users don't see the bill grow. Always cap max_tokens and surface running cost in traces.",
  },
  {
    id: "dl-batch",
    icon: Boxes,
    title: "Parallel tool calls & batched embeddings",
    problem:
      "The agent calls 5 tools sequentially: 5 × 800ms = 4s of nothing happening.",
    technique:
      "Modern function-calling APIs (OpenAI, Anthropic) emit multiple tool_calls in one response — execute them in parallel via Promise.all. Batch embedding requests (OpenAI accepts 2048 inputs per call). Use map-reduce patterns for large RAG corpora.",
    trade:
      "Parallel writes need extra de-duplication. Failures need partial-result handling. Always set per-tool timeouts.",
  },
  {
    id: "dl-context",
    icon: Compass,
    title: "Context-window management & compression",
    problem:
      "By turn 30, your prompt is 80k tokens. Cost scales linearly. Quality drops in the middle (the 'lost in the middle' effect, Liu et al. 2023).",
    technique:
      "Sliding-window + rolling summary for chat (we ship this). Contextual Retrieval (Anthropic 2024) for RAG — prepend a contextual summary to each chunk. Hierarchical summarisation for long documents. Aggressive trimming of tool results before re-injection.",
    trade:
      "Summarisation can silently lose detail. Always keep raw history retrievable; only the in-context view is summarised.",
  },
  {
    id: "dl-router",
    icon: Network,
    title: "Throughput: queues, concurrency caps, fair-share",
    problem:
      "A single tenant runs a batch job; everyone else's latency p95 doubles.",
    technique:
      "Per-tenant concurrency caps. Priority queues (interactive > batch). Token-bucket rate limiting at the gateway. For very high throughput, async with webhooks/polling instead of synchronous HTTP.",
    trade:
      "Adds operational complexity. Worth it past ~100 concurrent users; overkill below ~10.",
  },
];

/* ───────────────────── 6. Diagrams (ASCII so they print well) ───────────────────── */

// These render inside <pre> blocks. ASCII keeps them theme-agnostic and
// avoids SVG complexity. We complement with the SVG visuals in LearnVisuals.

export const diagramTopologies = `
                       CONTROL TOPOLOGIES

  CENTRALISED                       HIERARCHICAL
  (supervisor / router)             (manager → leads → workers)

         ┌───────────┐                      ┌─────────┐
         │  Router   │                      │ Manager │
         └─────┬─────┘                      └────┬────┘
       ┌──────┼──────┐                  ┌───────┼───────┐
       ▼      ▼      ▼                  ▼       ▼       ▼
    ┌────┐ ┌────┐ ┌────┐              ┌───┐  ┌───┐  ┌───┐
    │ W1 │ │ W2 │ │ W3 │              │L1 │  │L2 │  │L3 │
    └────┘ └────┘ └────┘              └─┬─┘  └─┬─┘  └─┬─┘
                                       ▼     ▼     ▼
                                     workers workers workers

  PEER-TO-PEER (emergent)           MARKET / CONTRACT-NET

       ┌────┐ ←──→ ┌────┐                ┌─────────┐
       │ A  │      │ B  │            ┌──→│ Auction │←──┐
       └─┬──┘      └─┬──┘            │   └────┬────┘   │
         ▲           ▲              bid      bid      bid
         │           │               │        │        │
       ┌─┴──┐ ←──→ ┌─┴──┐         ┌──┴─┐  ┌───┴┐  ┌────┴┐
       │ D  │      │ C  │         │ A  │  │ B  │  │ C   │
       └────┘      └────┘         └────┘  └────┘  └─────┘

  Production rule of thumb: start CENTRALISED, add HIERARCHY at scale,
  only go PEER-TO-PEER for genuinely open-ended tasks.
`;

export const diagramFailure = `
                  FAILURE-HANDLING STACK (per call)

  Request ─┐
           ▼
  ┌──────────────────┐   timeout (e.g. 45s)
  │ Timeout wrapper  │ ───────────────────────► fail fast
  └────────┬─────────┘
           ▼
  ┌──────────────────┐   open?  yes ─► fallback provider
  │ Circuit breaker  │
  └────────┬─────────┘   no
           ▼
  ┌──────────────────┐   429 ─► honour Retry-After
  │ Bounded retry    │   5xx ─► exp backoff + jitter (≤3)
  │ (per-status)     │   4xx ─► raise (your bug)
  └────────┬─────────┘
           ▼
  ┌──────────────────┐   reject if bad
  │ Schema validate  │   ─► one repair turn allowed
  └────────┬─────────┘
           ▼
  ┌──────────────────┐   step / token / $ cap?
  │ Budget guard     │   ─► raise BudgetError
  └────────┬─────────┘
           ▼
  ┌──────────────────┐   side-effect tools only:
  │ Idempotency key  │   sha256(run_id, tool, args)
  └────────┬─────────┘
           ▼
       Tool / model
`;

export const diagramEvalLoop = `
              EVALUATION LOOP (4 layers, different cadences)

   ┌────────────────────────────────────────────────────────┐
   │  L1  unit tests on prompts / tools / guardrails        │  every commit
   ├────────────────────────────────────────────────────────┤
   │  L2  golden set + LLM-as-judge   ◄── blocks merge      │  every PR + nightly
   ├────────────────────────────────────────────────────────┤
   │  L3  trajectory eval (τ-bench, AgentBench)             │  pre-release + weekly
   ├────────────────────────────────────────────────────────┤
   │  L4  online eval (sampled traffic, drift detection)    │  continuous
   └────────────────────────────────────────────────────────┘
                              │
                              ▼
        Findings → curated cases → back into L2 golden set
                              │
                              ▼
                    The flywheel that makes
                    your agent get better,
                    not worse, over time.
`;

/* ───────────────────── 7. Pitfalls & further reading ───────────────────── */

export const engineeringPitfalls: string[] = [
  "Treating an agent as a single-machine program. It is a distributed system the moment it talks to a remote model — apply distributed-systems hygiene from day one.",
  "Choosing a fully agentic loop when a workflow with one LLM node would have been 10× cheaper, 10× more reliable, and 10× easier to evaluate.",
  "No step / token / cost ceiling on the loop. The first runaway agent run will single-handedly justify rebuilding the whole guardrail layer.",
  "Confusing 'it returned valid JSON' with 'it was correct'. Schema validity is necessary, not sufficient — you still need an outcome-based eval.",
  "Sampling only the last week of traffic for evals. You will miss the 99th percentile cases that cause real incidents.",
  "Scaling concurrency without per-tenant fair-share. One batch job will starve every interactive user.",
  "Designing for one provider. Outages, rate limits and deprecations will eventually force a migration; build the gateway before you need it.",
  "Centralised orchestrator with no per-worker timeout. One slow worker stalls the whole swarm.",
];

export const engineeringFurtherReading: { label: string; href: string }[] = [
  { label: "Anthropic — Building effective agents (workflow vs agent)", href: "https://www.anthropic.com/research/building-effective-agents" },
  { label: "OpenAI — A practical guide to building agents (PDF)", href: "https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf" },
  { label: "Google — Agents whitepaper", href: "https://www.kaggle.com/whitepaper-agents" },
  { label: "Yao et al. — ReAct: Synergizing Reasoning and Acting in LMs", href: "https://arxiv.org/abs/2210.03629" },
  { label: "Shinn et al. — Reflexion: language agents with verbal reinforcement", href: "https://arxiv.org/abs/2303.11366" },
  { label: "Du et al. — Improving factuality via multi-agent debate", href: "https://arxiv.org/abs/2305.14325" },
  { label: "Park et al. — Generative Agents (Smallville)", href: "https://arxiv.org/abs/2304.03442" },
  { label: "Microsoft — Magentic-One: a generalist multi-agent system", href: "https://www.microsoft.com/en-us/research/publication/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/" },
  { label: "τ-bench — benchmarking tool-agent-user interaction", href: "https://arxiv.org/abs/2406.12045" },
  { label: "AgentBench — Liu et al.", href: "https://arxiv.org/abs/2308.03688" },
  { label: "Frugal-GPT — Chen et al. (model cascading)", href: "https://arxiv.org/abs/2305.05176" },
  { label: "Liu et al. — Lost in the Middle", href: "https://arxiv.org/abs/2307.03172" },
  { label: "Anthropic — Contextual Retrieval", href: "https://www.anthropic.com/news/contextual-retrieval" },
  { label: "Google SRE Workbook — circuit breakers, retries, budgets", href: "https://sre.google/workbook/table-of-contents/" },
  { label: "Stripe — Designing robust APIs (idempotency)", href: "https://stripe.com/blog/idempotency" },
  { label: "LangGraph — durable execution & checkpointing", href: "https://langchain-ai.github.io/langgraph/concepts/persistence/" },
  { label: "A2A — Agent-to-Agent protocol spec", href: "https://google.github.io/A2A/" },
  { label: "Model Context Protocol (MCP)", href: "https://modelcontextprotocol.io/" },
];

export const engineeringIcons = {
  Brain, Network, GitBranch, Workflow, Boxes, Repeat, ShieldAlert,
  Gauge, Activity, Layers, ServerCog, Scale, Compass, Sparkles, AlertTriangle,
};

export const diagramAgenticRag = `
                  NAIVE RAG  vs  AGENTIC RAG

  NAIVE RAG (one-shot pipeline)

     Question ──► Embed ──► Top-k ──► Prompt + chunks ──► Answer
                                          (one pass)

  ───────────────────────────────────────────────────────────────

  AGENTIC RAG (controlled loop with critic)

                 Question
                    │
                    ▼
              ┌───────────┐
              │  Planner  │  decompose into typed sub-queries
              └─────┬─────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
   ┌────────┐  ┌─────────┐  ┌────────┐
   │ Vector │  │  Graph  │  │  SQL   │   ... + Web / MCP / API
   │  KB    │  │   KB    │  │ tables │
   └────┬───┘  └────┬────┘  └───┬────┘
        └───────────┼───────────┘
                    ▼
              ┌───────────┐
              │  Critic   │  enough? gaps? contradictions?
              └─────┬─────┘
                    │
            DONE ◄──┴──► GAPS ──► re-Plan (max N iterations)
                    │
                    ▼
            ┌─────────────┐
            │ Synthesizer │  cited answer from all evidence
            └─────────────┘

  Production rule of thumb: cap iterations (3–5), use a cheap
  critic, type your sub-queries, and always carry citations.
`;
