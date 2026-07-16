// Static catalog of Agentic AI design patterns rendered as read-only ReactFlow
// graphs in /patterns. Each pattern ships with: nodes, edges, an educational
// "notes" panel (use-when / watch-out / real-world), and a guided tour that
// highlights specific nodes/edges step-by-step.
import {
  User, Brain, Wrench, Eye, CheckCircle2, ListChecks, ClipboardList,
  Workflow, Users, Bot, FileText, GitCompare, RefreshCw, Search,
  Calculator, Database, ShieldCheck, UserCheck, ArrowRight, Network,
  Sparkles, Layers,
  GitBranch, BookMarked, Boxes, Compass, Route as RouteIcon,
  Archive, Repeat, Crown, Share2, TreePine,
  Download, Shield, AlertTriangle,
  type LucideIcon,
} from "lucide-react";

export type PatternNodeKind =
  | "input" | "llm" | "tool" | "observation" | "output"
  | "planner" | "task" | "worker" | "synthesizer"
  | "critique" | "reviser" | "router" | "agent"
  | "checkpoint" | "step";

export type PatternNode = {
  id: string;
  label: string;
  sublabel?: string;
  kind: PatternNodeKind;
  icon: LucideIcon;
  position: { x: number; y: number };
  /** Optional per-node accent override (e.g. branching paths in one pattern) */
  accent?: AgenticPattern["accent"];
};

export type PatternEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Render with a dashed line (e.g. loop-back, conditional, human gate) */
  dashed?: boolean;
  /** Optional visual variant — paints the edge in a path-specific color
   *  regardless of the parent pattern accent. Used for branching graphs
   *  where the "danger" path should look red/dashed and the "safe" path
   *  should look green/solid even before the tour starts. */
  variant?: "danger" | "success";
};

export type PatternTourStep = {
  /** Nodes to highlight in this step */
  nodeIds: string[];
  /** Edges to highlight in this step (optional) */
  edgeIds?: string[];
  title: string;
  /** What is happening at this step in the flow */
  what: string;
  /** Why this step exists / what it teaches */
  why: string;
  /** Concrete production example */
  realWorld?: string;
};

export type AgenticPattern = {
  id: string;
  name: string;
  tagline: string;
  /** One-liner color name from the accent map below */
  accent: "indigo" | "teal" | "violet" | "amber" | "rose" | "emerald" | "sky";
  /** Long-form intro shown above the canvas */
  summary: string;
  useWhen: string[];
  watchOutFor: string[];
  realWorld: string[];
  combinesWellWith: string[];
  nodes: PatternNode[];
  edges: PatternEdge[];
  tour: PatternTourStep[];
};

// Accent color tokens. Map to Tailwind classes for borders / glows / edge stroke.
export const ACCENT_CLASSES: Record<
  AgenticPattern["accent"],
  { border: string; ring: string; text: string; bg: string; stroke: string }
> = {
  indigo:  { border: "border-indigo-400/70",  ring: "ring-indigo-400/60",  text: "text-indigo-300",  bg: "bg-indigo-500/10",  stroke: "#818cf8" },
  teal:    { border: "border-teal-400/70",    ring: "ring-teal-400/60",    text: "text-teal-300",    bg: "bg-teal-500/10",    stroke: "#2dd4bf" },
  violet:  { border: "border-violet-400/70",  ring: "ring-violet-400/60",  text: "text-violet-300",  bg: "bg-violet-500/10",  stroke: "#a78bfa" },
  amber:   { border: "border-amber-400/70",   ring: "ring-amber-400/60",   text: "text-amber-300",   bg: "bg-amber-500/10",   stroke: "#fbbf24" },
  rose:    { border: "border-rose-400/70",    ring: "ring-rose-400/60",    text: "text-rose-300",    bg: "bg-rose-500/10",    stroke: "#fb7185" },
  emerald: { border: "border-emerald-400/70", ring: "ring-emerald-400/60", text: "text-emerald-300", bg: "bg-emerald-500/10", stroke: "#34d399" },
  sky:     { border: "border-sky-400/70",     ring: "ring-sky-400/60",     text: "text-sky-300",     bg: "bg-sky-500/10",     stroke: "#38bdf8" },
};

// ── Pattern definitions ───────────────────────────────────────────────────

const X = { col1: 40, col2: 280, col3: 520, col4: 760, col5: 1000 };
const Y = { row1: 40, row2: 160, row3: 280, row4: 400 };

export const AGENTIC_PATTERNS: AgenticPattern[] = [
  // 1. ReAct ───────────────────────────────────────────────────────────────
  {
    id: "react",
    name: "ReAct (Reason + Act)",
    tagline: "Alternates Thought → Action → Observation in a loop until it has the answer.",
    accent: "indigo",
    summary:
      "ReAct is the foundational agentic loop. The LLM first writes a 'Thought' explaining what it wants to do next, calls a tool ('Action'), reads the tool's result ('Observation'), and decides whether to loop again or finalize. It's how most modern agents — including ChatGPT's tool-using mode and most LangChain agents — actually work under the hood.",
    useWhen: [
      "The problem is open-ended or investigative",
      "The agent must adapt step-by-step (search, debugging, research)",
      "You can't pre-plan every step in advance",
    ],
    watchOutFor: [
      "High token consumption — every loop replays the full transcript",
      "Latency grows with every tool call",
      "Hard to trace if the agent loops too long",
    ],
    realWorld: [
      "Anthropic's tool-use API (Claude Sonnet / Opus) follows a ReAct-style loop",
      "OpenAI Assistants run tools in a ReAct-style step loop",
      "Perplexity's answer engine is a constrained ReAct loop over web search",
    ],
    combinesWellWith: ["Tool Use", "Reflection", "Human-in-the-Loop"],
    nodes: [
      { id: "prompt",      label: "User Prompt",  sublabel: "Question / task",        kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "thought",     label: "Thought",      sublabel: "LLM reasoning",          kind: "llm",         icon: Brain,        position: { x: X.col2, y: Y.row2 } },
      { id: "action",      label: "Action",       sublabel: "Tool call",              kind: "tool",        icon: Wrench,       position: { x: X.col3, y: Y.row2 } },
      { id: "observation", label: "Observation",  sublabel: "Tool result",            kind: "observation", icon: Eye,          position: { x: X.col4, y: Y.row2 } },
      { id: "final",       label: "Final Answer", sublabel: "Returned to user",       kind: "output",      icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "prompt",      target: "thought" },
      { id: "e2", source: "thought",     target: "action" },
      { id: "e3", source: "action",      target: "observation" },
      { id: "e4", source: "observation", target: "thought", label: "loop until done", dashed: true },
      { id: "e5", source: "observation", target: "final",   label: "answer ready" },
    ],
    tour: [
      {
        nodeIds: ["prompt"], edgeIds: ["e1"],
        title: "1 · The user prompt arrives",
        what: "A user asks an open-ended question — for example, 'What's the weather in the city where Anthropic is headquartered?'",
        why: "Open-ended questions can't be answered from the prompt alone. The agent will have to reason and use tools, which is exactly why we need ReAct instead of a single LLM call.",
        realWorld: "Perplexity, ChatGPT browsing, Claude with tools all start exactly here.",
      },
      {
        nodeIds: ["thought"], edgeIds: ["e2"],
        title: "2 · The LLM writes a Thought",
        what: "The model produces internal reasoning text like: 'I need to first find Anthropic's HQ, then look up its weather. Let me search.'",
        why: "Externalising reasoning in plain text is the key insight of ReAct (Yao et al., 2022). It makes the agent's decisions auditable and dramatically reduces hallucination compared to forcing one giant answer.",
        realWorld: "Claude's <thinking> blocks and OpenAI's reasoning summaries are direct descendants of this idea.",
      },
      {
        nodeIds: ["action"], edgeIds: ["e3"],
        title: "3 · The LLM picks an Action",
        what: "Based on its Thought, the model emits a structured tool call — e.g. `search('Anthropic headquarters')`.",
        why: "The LLM doesn't actually do anything itself. It just decides which tool to call and with which arguments. The runtime executes it. This separation is what makes the pattern safe and observable.",
        realWorld: "Function calling in OpenAI, tool_use in Anthropic, and Gemini's function-calling all expose this exact step.",
      },
      {
        nodeIds: ["observation"], edgeIds: ["e4"],
        title: "4 · An Observation comes back",
        what: "The runtime calls the tool and feeds the result back to the model: 'Anthropic is HQ'd in San Francisco, CA.'",
        why: "Now the LLM has new information it didn't have before. It will either loop (still missing data — e.g. needs the weather next) or finalize. This loop is the heart of ReAct.",
        realWorld: "Every agentic browser, code assistant, and research agent loops here, often 3–8 times for a single user question.",
      },
      {
        nodeIds: ["final"], edgeIds: ["e5"],
        title: "5 · Final Answer",
        what: "Once the LLM decides it has enough information, it stops looping and produces a final natural-language answer.",
        why: "The agent must know when to stop. Without a clear stop condition, ReAct loops can run forever and burn tokens. Production systems usually cap loops (e.g. max 10 iterations).",
        realWorld: "LangChain's AgentExecutor has `max_iterations`. OpenAI Assistants enforce step limits. Always set one.",
      },
    ],
  },

  // 2. Reflection ──────────────────────────────────────────────────────────
  {
    id: "reflection",
    name: "Reflection (Self-Critique)",
    tagline: "The agent writes an answer, then becomes its own reviewer and rewrites it.",
    accent: "violet",
    summary:
      "Reflection adds a second pass: after producing a draft, the same (or another) model is prompted to critique the draft and then revise it. This dramatically improves quality on writing, code, and analytical tasks at the cost of extra latency and tokens.",
    useWhen: [
      "Quality matters more than speed",
      "Output is factual, analytical, or code",
      "Hallucinations are expensive (legal, medical, financial copy)",
    ],
    watchOutFor: [
      "2–3× latency and cost per request",
      "Without strong critique criteria, the model just rephrases",
      "Can become overly conservative and hedge everything",
    ],
    realWorld: [
      "Cursor and GitHub Copilot Workspace use reflection-style passes for code review",
      "Anthropic's 'Constitutional AI' is a reflection loop over policy",
      "Most production writing tools do at least one critique pass before delivery",
    ],
    combinesWellWith: ["Sequential Workflow", "Multi-Agent (different model as critic)"],
    nodes: [
      { id: "prompt",   label: "User Prompt",   sublabel: "Task brief",               kind: "input",    icon: User,        position: { x: X.col1, y: Y.row2 } },
      { id: "draft",    label: "Draft",         sublabel: "First-pass answer",        kind: "llm",      icon: FileText,    position: { x: X.col2, y: Y.row2 } },
      { id: "critique", label: "Critique",      sublabel: "Self-review",              kind: "critique", icon: GitCompare,  position: { x: X.col3, y: Y.row2 } },
      { id: "revise",   label: "Revise",        sublabel: "Rewrite with feedback",    kind: "reviser",  icon: RefreshCw,   position: { x: X.col4, y: Y.row2 } },
      { id: "final",    label: "Final Answer",  sublabel: "Polished output",          kind: "output",   icon: CheckCircle2,position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "prompt",   target: "draft" },
      { id: "e2", source: "draft",    target: "critique" },
      { id: "e3", source: "critique", target: "revise" },
      { id: "e4", source: "revise",   target: "critique", label: "another pass?", dashed: true },
      { id: "e5", source: "revise",   target: "final" },
    ],
    tour: [
      {
        nodeIds: ["prompt", "draft"], edgeIds: ["e1"],
        title: "1 · Draft a fast first answer",
        what: "The model produces a first-pass response without worrying about polish — speed matters here.",
        why: "Drafts are cheap. They give the critic something concrete to react to, which is much easier than asking a model to produce a perfect answer in one shot.",
        realWorld: "This is exactly how Cursor's 'fast apply' and Notion AI generate drafts before refinement.",
      },
      {
        nodeIds: ["critique"], edgeIds: ["e2"],
        title: "2 · Self-critique with explicit criteria",
        what: "The same model (or a different one) is prompted: 'Review this draft for factual errors, missing citations, and unclear claims.'",
        why: "The critique prompt is the secret sauce. Vague critics produce vague revisions. Production reflection systems give the critic a checklist (style guide, rubric, policy doc).",
        realWorld: "Anthropic's Constitutional AI critiques against an explicit list of principles. Same idea here.",
      },
      {
        nodeIds: ["revise"], edgeIds: ["e3"],
        title: "3 · Revise using the critique",
        what: "The model rewrites the draft applying the critique's feedback verbatim.",
        why: "Studies (Madaan et al., 2023 — 'Self-Refine') show this loop improves quality on 7 of 7 tasks tested, with the biggest gains on code and constrained generation.",
      },
      {
        nodeIds: ["critique", "revise"], edgeIds: ["e4"],
        title: "4 · Loop until quality plateaus",
        what: "Optionally critique-then-revise again. Most systems cap at 1–2 loops because gains diminish quickly.",
        why: "Diminishing returns are real. The first reflection pass gets ~80% of the quality lift. Beyond 2 passes you're often paying tokens for marginal improvement.",
        realWorld: "GitHub Copilot Workspace uses exactly one reflection pass for most workflows.",
      },
      {
        nodeIds: ["final"], edgeIds: ["e5"],
        title: "5 · Deliver the polished answer",
        what: "The final, revised answer is returned to the user.",
        why: "The user never sees the draft or the critique — only the final output. This keeps the UX clean while still benefiting from the quality boost.",
      },
    ],
  },

  // 3. Planning ────────────────────────────────────────────────────────────
  {
    id: "planning",
    name: "Plan and Execute",
    tagline: "First decompose the task into a plan, then execute each step.",
    accent: "teal",
    summary:
      "Planning decouples 'what to do' from 'how to do it'. A planner LLM produces a structured plan (an ordered list of subtasks). A separate executor — often the same model in a different role — works through each subtask. This handles long-horizon tasks much better than a single ReAct loop, which loses focus over many steps.",
    useWhen: [
      "Tasks span many steps with dependencies",
      "You need repeatability and structured output",
      "Long-horizon work where ReAct would lose track",
    ],
    watchOutFor: [
      "Overkill for one-shot questions",
      "Static plans drift from reality — you may need replanning",
      "Plans can be wrong; bad plans propagate to every step",
    ],
    realWorld: [
      "Devin (Cognition) uses a planner + executor architecture",
      "LangGraph's Plan-and-Execute template is widely deployed",
      "Microsoft AutoGen's GroupChatManager schedules planned subtasks",
    ],
    combinesWellWith: ["ReAct (per subtask)", "Multi-Agent", "HITL on the plan"],
    nodes: [
      { id: "prompt",  label: "User Prompt",     sublabel: "High-level goal",          kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "planner", label: "Planner Agent",   sublabel: "Breaks goal into steps",   kind: "planner",     icon: ClipboardList,position: { x: X.col2, y: Y.row2 } },
      { id: "tasks",   label: "Task Queue",      sublabel: "Ordered subtasks",         kind: "task",        icon: ListChecks,   position: { x: X.col3, y: Y.row2 } },
      { id: "exec1",   label: "Executor · Task 1", sublabel: "Runs first subtask",     kind: "worker",      icon: Bot,          position: { x: X.col4, y: Y.row1 } },
      { id: "exec2",   label: "Executor · Task 2", sublabel: "Runs next subtask",      kind: "worker",      icon: Bot,          position: { x: X.col4, y: Y.row3 } },
      { id: "synth",   label: "Synthesizer",     sublabel: "Combines results",         kind: "synthesizer", icon: Layers,       position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "prompt",  target: "planner" },
      { id: "e2", source: "planner", target: "tasks" },
      { id: "e3", source: "tasks",   target: "exec1" },
      { id: "e4", source: "tasks",   target: "exec2" },
      { id: "e5", source: "exec1",   target: "synth" },
      { id: "e6", source: "exec2",   target: "synth" },
      { id: "e7", source: "synth",   target: "planner", label: "replan?", dashed: true },
    ],
    tour: [
      {
        nodeIds: ["prompt", "planner"], edgeIds: ["e1"],
        title: "1 · The planner reads the goal",
        what: "The user asks something complex like 'Write a competitive analysis of three cloud providers and email it to me.' The planner LLM is asked, in isolation, to think only about *what to do*.",
        why: "Planning works best when the planner doesn't also have to execute. A focused planner prompt produces sharper, more decomposable plans.",
        realWorld: "Devin's planner is a separate model call from its execution agents — by design.",
      },
      {
        nodeIds: ["planner", "tasks"], edgeIds: ["e2"],
        title: "2 · Output a structured plan",
        what: "The planner emits a JSON-shaped task list: [{id:1, 'gather AWS pricing'}, {id:2, 'gather GCP pricing'}, ...]",
        why: "Structured output (vs a paragraph) makes the plan executable by downstream agents. Use schemas / JSON mode here — it's the difference between a working pipeline and a fragile one.",
      },
      {
        nodeIds: ["tasks", "exec1", "exec2"], edgeIds: ["e3", "e4"],
        title: "3 · Execute subtasks (often in parallel)",
        what: "Each task is dispatched to an executor. Independent tasks can run concurrently for big latency wins.",
        why: "Most real plans have parallelizable branches. Running them in parallel can cut wall-clock time 3–5×, which matters a lot for user-facing agents.",
        realWorld: "Manus (the autonomous browsing agent) parallelizes independent research subtasks aggressively.",
      },
      {
        nodeIds: ["exec1", "exec2", "synth"], edgeIds: ["e5", "e6"],
        title: "4 · Synthesize partial results",
        what: "A synthesizer LLM merges all subtask outputs into one coherent final deliverable.",
        why: "Without a synthesis step, the user gets a stack of disconnected fragments. The synthesizer is what makes the final output feel like one thoughtful answer.",
      },
      {
        nodeIds: ["synth", "planner"], edgeIds: ["e7"],
        title: "5 · Optional replanning loop",
        what: "If a subtask reveals the original plan was wrong (e.g. a tool returned 'no data'), the synthesizer can hand control back to the planner to revise the plan.",
        why: "Static plans drift. The best production planning systems are 'plan → execute → reflect → replan' loops, not one-shot plans.",
        realWorld: "LangGraph's plan-and-execute template ships with replanning built in.",
      },
    ],
  },

  // 4. Tool Use ────────────────────────────────────────────────────────────
  {
    id: "tool-use",
    name: "Tool Use",
    tagline: "The LLM picks from a registry of tools (APIs, DBs, code) and the runtime executes them.",
    accent: "sky",
    summary:
      "Tool Use is what gives LLMs hands. The model is given a list of available tools (with names, descriptions, and JSON schemas), it picks one, the runtime executes it, and the result is fed back. This is the foundation of every useful agent — without tools, agents can only generate text.",
    useWhen: [
      "Real-time data is required (weather, prices, web)",
      "The agent must take action (send email, write to DB)",
      "Math, code execution, or structured lookups are involved",
    ],
    watchOutFor: [
      "Tool routing logic is now an engineering surface — schemas matter",
      "Rate limits and timeouts can break the loop",
      "Misaligned tool descriptions cause the model to pick the wrong tool",
    ],
    realWorld: [
      "Anthropic's Model Context Protocol (MCP) standardizes this exact pattern",
      "OpenAI function calling and Gemini function calling expose it natively",
      "Slack's AI assistant routes between dozens of internal tools using this shape",
    ],
    combinesWellWith: ["ReAct", "Planning", "Multi-Agent"],
    nodes: [
      { id: "prompt", label: "User Prompt", sublabel: "Question / task",       kind: "input",  icon: User,        position: { x: X.col1, y: Y.row2 } },
      { id: "llm",    label: "LLM",         sublabel: "Decides which tool",    kind: "llm",    icon: Brain,       position: { x: X.col2, y: Y.row2 } },
      { id: "router", label: "Tool Router", sublabel: "Validates & dispatches",kind: "router", icon: Network,     position: { x: X.col3, y: Y.row2 } },
      { id: "search", label: "Web Search",  sublabel: "Tool: search()",        kind: "tool",   icon: Search,      position: { x: X.col4, y: Y.row1 } },
      { id: "calc",   label: "Calculator",  sublabel: "Tool: math()",          kind: "tool",   icon: Calculator,  position: { x: X.col4, y: Y.row2 } },
      { id: "db",     label: "Database",    sublabel: "Tool: query()",         kind: "tool",   icon: Database,    position: { x: X.col4, y: Y.row3 } },
      { id: "llm2",   label: "LLM (synth)", sublabel: "Reads tool result",     kind: "llm",    icon: Brain,       position: { x: X.col5, y: Y.row2 } },
      { id: "final",  label: "Final Answer",sublabel: "Returned to user",      kind: "output", icon: CheckCircle2,position: { x: X.col5 + 220, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "prompt", target: "llm" },
      { id: "e2", source: "llm",    target: "router" },
      { id: "e3", source: "router", target: "search", label: "if web data" },
      { id: "e4", source: "router", target: "calc",   label: "if math" },
      { id: "e5", source: "router", target: "db",     label: "if internal data" },
      { id: "e6", source: "search", target: "llm2" },
      { id: "e7", source: "calc",   target: "llm2" },
      { id: "e8", source: "db",     target: "llm2" },
      { id: "e9", source: "llm2",   target: "final" },
    ],
    tour: [
      {
        nodeIds: ["prompt", "llm"], edgeIds: ["e1"],
        title: "1 · The LLM sees the prompt + a tool catalog",
        what: "Along with the user's question, the model is given a list like [search, calculator, query_db] with JSON schemas describing each tool's arguments.",
        why: "The model can only call tools it knows about. The tool catalog is the agent's API. Good tool descriptions are the single biggest lever on agent reliability.",
        realWorld: "MCP (Model Context Protocol) is essentially a standard for sharing tool catalogs between agents and external systems.",
      },
      {
        nodeIds: ["llm", "router"], edgeIds: ["e2"],
        title: "2 · The model emits a structured tool call",
        what: "Instead of free text, the LLM responds with `{ tool: 'search', args: { query: 'Anthropic HQ' } }`.",
        why: "Structured output (function calling / tool_use) is enforced by the provider's API. This is what makes tool use safe — the runtime can validate args before executing.",
      },
      {
        nodeIds: ["router", "search", "calc", "db"], edgeIds: ["e3", "e4", "e5"],
        title: "3 · The router dispatches to the chosen tool",
        what: "The runtime validates the args against the tool's schema, then executes only that tool. Other tools are skipped.",
        why: "The router is your security layer. It enforces auth, rate limits, allow-lists, and arg validation. Never let a tool call bypass the router in production.",
        realWorld: "This is exactly where guardrails like Cloudflare AI Gateway and Portkey sit in real deployments.",
      },
      {
        nodeIds: ["llm2"], edgeIds: ["e6", "e7", "e8"],
        title: "4 · A second LLM call reads the tool result",
        what: "The tool's output is stuffed back into the conversation, and a second LLM call turns the raw result into a natural-language answer.",
        why: "Tools return raw data (JSON, numbers, search hits). The LLM's job is to translate that into something a human wants to read.",
      },
      {
        nodeIds: ["final"], edgeIds: ["e9"],
        title: "5 · The user gets the synthesized answer",
        what: "The final, human-readable answer is delivered. The user never sees the tool call, the JSON, or the routing.",
        why: "Hide the plumbing. Users care about the answer, not the agent's internals — but log every tool call for debugging and audit.",
      },
    ],
  },

  // 5. Multi-Agent Collaboration ───────────────────────────────────────────
  {
    id: "multi-agent",
    name: "Multi-Agent Collaboration",
    tagline: "An orchestrator coordinates specialized agents — each is great at one thing.",
    accent: "rose",
    summary:
      "Instead of one general-purpose agent, you build a team: a researcher, an analyst, a writer, a reviewer, and an orchestrator that routes work between them. Each agent has a focused system prompt, possibly its own model and toolset. This is how production agentic systems handle complex, cross-domain workflows.",
    useWhen: [
      "Tasks need genuine specialization (legal + financial + technical)",
      "You want modular, reusable agent roles",
      "Workflows are too complex for one agent's context window",
    ],
    watchOutFor: [
      "More moving parts = more failure modes",
      "Latency adds up across agent hand-offs",
      "Costs multiply — each agent is a separate LLM call",
    ],
    realWorld: [
      "Microsoft AutoGen popularized the conversational multi-agent pattern",
      "crewAI is built entirely around this pattern",
      "OpenAI Swarm + Agents SDK use 'handoffs' between specialized agents",
    ],
    combinesWellWith: ["Planning (orchestrator plans)", "HITL (between hand-offs)"],
    nodes: [
      { id: "prompt",     label: "User Prompt",   sublabel: "Cross-domain task",  kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "orch",       label: "Orchestrator",  sublabel: "Routes & schedules", kind: "agent",       icon: Users,        position: { x: X.col2, y: Y.row2 } },
      { id: "researcher", label: "Researcher",    sublabel: "Gathers facts",      kind: "agent",       icon: Search,       position: { x: X.col3, y: Y.row1 } },
      { id: "analyst",    label: "Analyst",       sublabel: "Crunches numbers",   kind: "agent",       icon: Calculator,   position: { x: X.col3, y: Y.row3 } },
      { id: "writer",     label: "Writer",        sublabel: "Drafts the output",  kind: "agent",       icon: FileText,     position: { x: X.col4, y: Y.row1 } },
      { id: "reviewer",   label: "Reviewer",      sublabel: "QA pass",            kind: "agent",       icon: ShieldCheck,  position: { x: X.col4, y: Y.row3 } },
      { id: "final",      label: "Final Answer",  sublabel: "Delivered",          kind: "output",      icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "prompt",     target: "orch" },
      { id: "e2", source: "orch",       target: "researcher" },
      { id: "e3", source: "orch",       target: "analyst" },
      { id: "e4", source: "researcher", target: "writer" },
      { id: "e5", source: "analyst",    target: "writer" },
      { id: "e6", source: "writer",     target: "reviewer" },
      { id: "e7", source: "reviewer",   target: "final" },
      { id: "e8", source: "reviewer",   target: "writer", label: "send back", dashed: true },
    ],
    tour: [
      {
        nodeIds: ["prompt", "orch"], edgeIds: ["e1"],
        title: "1 · Orchestrator receives the goal",
        what: "The user's request lands at a single 'manager' agent whose only job is to decide which specialist should do what, in which order.",
        why: "Centralizing routing keeps the system debuggable. A flat 'all agents talk to all agents' design becomes chaos at 4+ agents.",
        realWorld: "AutoGen's GroupChatManager and crewAI's Crew both use a central orchestrator.",
      },
      {
        nodeIds: ["orch", "researcher", "analyst"], edgeIds: ["e2", "e3"],
        title: "2 · Specialists run in parallel",
        what: "The Researcher gathers raw facts (e.g. via web search) while the Analyst pulls numbers from internal tools. They have different system prompts and may use different models.",
        why: "Specialization means each agent has a tighter prompt and a smaller tool surface — both improve reliability. Parallelism means faster wall-clock time.",
        realWorld: "Bloomberg's GPT (BloombergGPT) deployments use specialist agents per asset class.",
      },
      {
        nodeIds: ["researcher", "analyst", "writer"], edgeIds: ["e4", "e5"],
        title: "3 · Writer composes a draft from inputs",
        what: "The Writer agent receives both the research and the analysis and produces a coherent first draft.",
        why: "Synthesis is its own skill. A dedicated writer agent (often with a 'house style' system prompt) produces much more consistent output than asking specialists to also write.",
      },
      {
        nodeIds: ["writer", "reviewer"], edgeIds: ["e6"],
        title: "4 · Reviewer does a QA pass",
        what: "A separate reviewer agent reads the draft against a checklist (accuracy, tone, completeness) and either approves or sends it back.",
        why: "Splitting writing from review is the multi-agent version of the Reflection pattern — and a different model often catches what the original writer missed.",
      },
      {
        nodeIds: ["reviewer", "writer", "final"], edgeIds: ["e7", "e8"],
        title: "5 · Approve or loop",
        what: "If the reviewer approves, the answer goes to the user. If not, it's sent back to the writer with feedback.",
        why: "This loop is bounded in production (e.g. max 2 review cycles) to prevent endless ping-pong between agents.",
        realWorld: "OpenAI's Agents SDK calls these 'handoffs' and provides built-in loop limits.",
      },
    ],
  },

  // 6. Sequential Workflow ─────────────────────────────────────────────────
  {
    id: "sequential",
    name: "Sequential Workflow",
    tagline: "A fixed pipeline where each step's output is the next step's input.",
    accent: "emerald",
    summary:
      "Sometimes you don't need autonomy — you just need a reliable pipeline. Sequential workflows hard-code the order of steps. Each step might be an LLM call, a tool call, or a deterministic transform. Predictable, debuggable, cheap.",
    useWhen: [
      "The workflow is stable and well-understood",
      "Document pipelines, ETL, form processing, classification",
      "You need predictable cost and latency",
    ],
    watchOutFor: [
      "Rigid — can't adapt if the input is unexpected",
      "Not for ambiguous problems where the right next step depends on context",
    ],
    realWorld: [
      "n8n, Zapier, and Make's AI nodes are sequential workflows",
      "LangChain's LCEL pipelines (input | step1 | step2 | step3)",
      "Most production 'AI features' inside SaaS apps are sequential, not agentic",
    ],
    combinesWellWith: ["Reflection (as a step)", "Tool Use (as a step)"],
    nodes: [
      { id: "input",  label: "Input",         sublabel: "Raw document",     kind: "input",  icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "s1",     label: "Step 1",        sublabel: "Extract text",     kind: "step",   icon: FileText,     position: { x: X.col2, y: Y.row2 } },
      { id: "s2",     label: "Step 2",        sublabel: "Classify",         kind: "step",   icon: Sparkles,     position: { x: X.col3, y: Y.row2 } },
      { id: "s3",     label: "Step 3",        sublabel: "Summarize",        kind: "step",   icon: Brain,        position: { x: X.col4, y: Y.row2 } },
      { id: "output", label: "Output",        sublabel: "Structured result",kind: "output", icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "input", target: "s1" },
      { id: "e2", source: "s1",    target: "s2" },
      { id: "e3", source: "s2",    target: "s3" },
      { id: "e4", source: "s3",    target: "output" },
    ],
    tour: [
      {
        nodeIds: ["input", "s1"], edgeIds: ["e1"],
        title: "1 · A fixed entry point",
        what: "An input — a PDF, email, form submission — enters the pipeline. The shape is known in advance.",
        why: "Knowing the input shape is what unlocks sequential design. If you can't predict the input, you probably need an agent, not a workflow.",
      },
      {
        nodeIds: ["s1", "s2"], edgeIds: ["e2"],
        title: "2 · Each step is a pure function",
        what: "Step 1 extracts text from the PDF. Step 2 classifies that text into a category. Each step takes one input and produces one output.",
        why: "Pure-function steps are easy to test, cache, and replace. This is why most production 'AI features' inside boring SaaS apps look like this — not like ReAct.",
        realWorld: "Stripe Radar, Notion's AI summary, and Linear's auto-triage are sequential workflows under the hood.",
      },
      {
        nodeIds: ["s2", "s3"], edgeIds: ["e3"],
        title: "3 · LLM steps sit alongside deterministic ones",
        what: "Some steps call an LLM (classify, summarize), others are plain code (parse, validate). Mix freely.",
        why: "LLMs are tools, not protagonists. Use them for the parts of the pipeline that genuinely need reasoning; use deterministic code for everything else.",
      },
      {
        nodeIds: ["s3", "output"], edgeIds: ["e4"],
        title: "4 · A predictable output",
        what: "The pipeline produces a known-shaped result (a JSON object, a row in a table, a notification).",
        why: "Predictable outputs are what let downstream systems trust the pipeline. This is what makes sequential workflows production-friendly even when one of the steps is an LLM.",
      },
    ],
  },

  // 7. Human-in-the-Loop ───────────────────────────────────────────────────
  {
    id: "hitl",
    name: "Human-in-the-Loop",
    tagline: "The agent pauses at a checkpoint and waits for a human to approve, edit, or reject.",
    accent: "amber",
    summary:
      "HITL is the safety valve of agentic systems. The agent runs autonomously up to a defined checkpoint (e.g. 'before sending the email', 'before charging the card'), then pauses for a human decision. Essential for high-stakes domains and the standard pattern for any agent that takes irreversible action.",
    useWhen: [
      "Actions are irreversible (payments, sends, deletions)",
      "Domain is high-stakes (medical, legal, financial)",
      "You need a paper-trail of human approval for compliance",
    ],
    watchOutFor: [
      "Adds human latency — usually minutes to hours",
      "Needs a real UX (inbox, notifications, mobile)",
      "If approvers are slow, the agent piles up pending tasks",
    ],
    realWorld: [
      "Most enterprise email-sending agents pause for human approval",
      "Devin asks for approval before running risky shell commands",
      "Anthropic's research agents pause before publishing externally",
    ],
    combinesWellWith: ["Planning (approve plan first)", "Multi-Agent (human as one agent)"],
    nodes: [
      { id: "prompt",     label: "User Prompt",   sublabel: "Task brief",                  kind: "input",      icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "agent",      label: "Agent",         sublabel: "Drafts the action",           kind: "agent",      icon: Bot,          position: { x: X.col2, y: Y.row2 } },
      { id: "checkpoint", label: "Checkpoint",    sublabel: "Pause for human",             kind: "checkpoint", icon: ShieldCheck,  position: { x: X.col3, y: Y.row2 } },
      { id: "human",      label: "Human Reviewer",sublabel: "Approve / edit / reject",     kind: "checkpoint", icon: UserCheck,    position: { x: X.col4, y: Y.row1 } },
      { id: "execute",    label: "Execute",       sublabel: "Send / pay / commit",         kind: "tool",       icon: Wrench,       position: { x: X.col4, y: Y.row3 } },
      { id: "final",      label: "Final Result",  sublabel: "Receipt / confirmation",      kind: "output",     icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "prompt",     target: "agent" },
      { id: "e2", source: "agent",      target: "checkpoint" },
      { id: "e3", source: "checkpoint", target: "human", label: "wait for review", dashed: true },
      { id: "e4", source: "human",      target: "execute", label: "approved" },
      { id: "e5", source: "human",      target: "agent",   label: "edit / retry", dashed: true },
      { id: "e6", source: "execute",    target: "final" },
    ],
    tour: [
      {
        nodeIds: ["prompt", "agent"], edgeIds: ["e1"],
        title: "1 · The agent does the easy 90%",
        what: "The agent autonomously researches, drafts, and prepares an action — for example, drafting a refund email with a specific dollar amount.",
        why: "HITL is most valuable when the agent does most of the work and the human only reviews. If a human has to do everything, you've built a worse spreadsheet.",
      },
      {
        nodeIds: ["agent", "checkpoint"], edgeIds: ["e2"],
        title: "2 · Pause at a checkpoint",
        what: "Right before the irreversible step (sending the email, charging the card), the agent halts and creates a pending approval record.",
        why: "Choosing *where* to pause is the key design decision. Pause too early and you annoy the human with trivia; pause too late and a mistake is already in production.",
        realWorld: "AgentSwarms' built-in Approval Inbox is exactly this checkpoint pattern.",
      },
      {
        nodeIds: ["checkpoint", "human"], edgeIds: ["e3"],
        title: "3 · A human reviews and decides",
        what: "The reviewer sees the proposed action with full context (what, why, risk level) and chooses approve, edit, or reject.",
        why: "The reviewer needs context, not just a yes/no button. Show them the agent's reasoning, the tool inputs, and the expected effect — that's what makes review fast and high-quality.",
      },
      {
        nodeIds: ["human", "execute"], edgeIds: ["e4"],
        title: "4 · Approved → execute the action",
        what: "Once approved, the runtime executes the action exactly as the agent proposed (or with the human's edits applied).",
        why: "The execute step itself is deterministic — no more LLM calls. This makes the action auditable and reproducible.",
      },
      {
        nodeIds: ["human", "agent"], edgeIds: ["e5"],
        title: "5 · Rejected → loop back with feedback",
        what: "If the reviewer rejects or edits, the agent gets the feedback and tries again.",
        why: "Rejections are training data. Logging *why* a human rejected a proposal lets you continually improve the agent's prompts and tool descriptions.",
      },
      {
        nodeIds: ["execute", "final"], edgeIds: ["e6"],
        title: "6 · Confirmed result is returned",
        what: "After execution, the user receives confirmation (the email was sent, the refund processed, the deploy completed).",
        why: "Always close the loop with a confirmation — both the requesting user and the approving human want to know what actually happened.",
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // ADVANCED PATTERNS — production-grade architectures used by LangGraph,
  // OpenAI Swarm/Agents SDK, Anthropic, AutoGen, and CrewAI deployments.
  // ────────────────────────────────────────────────────────────────────────

  // 8. Agentic RAG (Self-Correcting Retrieval) ─────────────────────────────
  {
    id: "agentic-rag",
    name: "Agentic RAG (Self-Correcting Retrieval)",
    tagline: "RAG with a feedback loop: grade retrieved docs, rewrite the query, retry until grounded.",
    accent: "indigo",
    summary:
      "Classic RAG is a one-shot pipeline: retrieve top-k chunks → generate. It fails silently when the retriever surfaces irrelevant chunks. Agentic RAG adds a control loop: an LLM grades each retrieved chunk for relevance, decides whether to use them, rewrite the query, search the web as a fallback, or escalate. This is the basis of Corrective-RAG (CRAG) and Self-RAG.",
    useWhen: [
      "Hallucinations from off-topic retrievals are unacceptable",
      "Knowledge base is large and retrieval quality is uneven",
      "Users ask questions outside what your KB actually covers",
      "You need citations grounded in retrieved evidence",
    ],
    watchOutFor: [
      "2–4× latency vs vanilla RAG (multiple LLM grade + retry steps)",
      "Grader prompt is the highest-leverage piece — bad grader = bad agent",
      "Can loop forever without a max-iteration cap",
    ],
    realWorld: [
      "Perplexity's answer engine grades sources before citing",
      "LangGraph's CRAG and Self-RAG templates are deployed widely in enterprise search",
      "Notion AI uses a graded-retrieval loop over workspace docs",
    ],
    combinesWellWith: ["ReAct", "Reflection", "Tool Use (web search fallback)"],
    nodes: [
      { id: "query",   label: "User Query",      sublabel: "Question",                kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "retrieve",label: "Vector Retrieve", sublabel: "Top-k chunks from KB",    kind: "tool",        icon: Database,     position: { x: X.col2, y: Y.row2 } },
      { id: "grader",  label: "Relevance Grader",sublabel: "LLM scores each chunk",   kind: "critique",    icon: GitCompare,   position: { x: X.col3, y: Y.row2 } },
      { id: "rewrite", label: "Query Rewriter",  sublabel: "Reformulate & retry",     kind: "llm",         icon: RefreshCw,    position: { x: X.col2, y: Y.row4 } },
      { id: "websearch",label:"Web Fallback",    sublabel: "If KB has no good docs",  kind: "tool",        icon: Search,       position: { x: X.col3, y: Y.row4 } },
      { id: "generate",label: "Generate Answer", sublabel: "Grounded in good chunks", kind: "synthesizer", icon: Brain,        position: { x: X.col4, y: Y.row2 } },
      { id: "final",   label: "Cited Answer",    sublabel: "With sources",            kind: "output",      icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "query",    target: "retrieve" },
      { id: "e2", source: "retrieve", target: "grader" },
      { id: "e3", source: "grader",   target: "generate", label: "relevant" },
      { id: "e4", source: "grader",   target: "rewrite",  label: "irrelevant", dashed: true },
      { id: "e5", source: "rewrite",  target: "retrieve", label: "retry",      dashed: true },
      { id: "e6", source: "grader",   target: "websearch",label: "KB has nothing", dashed: true },
      { id: "e7", source: "websearch",target: "generate" },
      { id: "e8", source: "generate", target: "final" },
    ],
    tour: [
      {
        nodeIds: ["query", "retrieve"], edgeIds: ["e1"],
        title: "1 · Vector retrieval kicks things off",
        what: "The user's question is embedded and the top-k most similar chunks are pulled from a vector store (Pinecone, Weaviate, pgvector, etc.).",
        why: "This is identical to vanilla RAG. The difference comes next — instead of trusting the retrieval, we audit it.",
        realWorld: "Perplexity, Notion AI, and most enterprise 'chat with your docs' products all start at this exact step.",
      },
      {
        nodeIds: ["retrieve", "grader"], edgeIds: ["e2"],
        title: "2 · An LLM grader scores each chunk",
        what: "A small/cheap LLM is asked, per chunk: 'Does this chunk contain information that helps answer the question? Score 0–1.'",
        why: "This is the core insight of Corrective-RAG (Yan et al., 2024). Vector similarity is not relevance — semantically close text can still be useless. A grader catches that gap.",
        realWorld: "LangGraph's CRAG template uses GPT-4o-mini as the grader to keep cost low.",
      },
      {
        nodeIds: ["grader", "generate"], edgeIds: ["e3"],
        title: "3 · Good chunks → generate grounded answer",
        what: "If the grader approves enough chunks, they're passed to the answer-generation LLM along with explicit instructions to cite sources.",
        why: "Forcing the generator to use only graded-good chunks is what reduces hallucination. Without grading, irrelevant chunks pollute the prompt and cause the model to make things up.",
      },
      {
        nodeIds: ["grader", "rewrite", "retrieve"], edgeIds: ["e4", "e5"],
        title: "4 · Bad chunks → rewrite the query and retry",
        what: "If chunks are off-topic, an LLM rewrites the user's question (e.g. expanding acronyms, adding synonyms, reformulating) and the retrieval runs again.",
        why: "Most retrieval failures are query-formulation failures. A rewrite step recovers a huge fraction of cases for free, before falling back to slower options.",
      },
      {
        nodeIds: ["grader", "websearch", "generate"], edgeIds: ["e6", "e7"],
        title: "5 · No good chunks anywhere → web fallback",
        what: "If even the rewritten query can't surface good chunks from the KB, the agent falls back to web search (Tavily, Brave, SerpAPI).",
        why: "Knowing your KB doesn't have the answer is more valuable than guessing. The web fallback turns 'I don't know' into a real answer for out-of-scope questions.",
        realWorld: "Self-RAG (Asai et al., 2023) introduced this 'reflect on retrieval, then optionally search externally' loop.",
      },
      {
        nodeIds: ["generate", "final"], edgeIds: ["e8"],
        title: "6 · Cited answer goes back to the user",
        what: "The final answer cites the specific chunks (or web pages) it used, so the user can verify.",
        why: "Citations are non-negotiable in enterprise RAG. They turn the agent from a black box into something auditable, which is what makes Agentic RAG production-deployable in regulated industries.",
      },
    ],
  },

  // 9. Supervisor (Hierarchical Multi-Agent) ───────────────────────────────
  {
    id: "supervisor",
    name: "Supervisor (Hierarchical Multi-Agent)",
    tagline: "A supervisor LLM routes each turn to the best worker agent until the task is done.",
    accent: "violet",
    summary:
      "The supervisor pattern (popularized by LangGraph's `langgraph-supervisor`) puts a single 'manager' LLM in charge of routing. After every worker turn, the supervisor re-reads the conversation and decides: which worker should go next, or are we done? This gives you flexible coordination without the chaos of a fully decentralized swarm.",
    useWhen: [
      "You have 3+ specialized worker agents",
      "Routing decisions depend on conversation state, not a fixed plan",
      "You need a single, debuggable place where coordination happens",
    ],
    watchOutFor: [
      "Supervisor becomes the bottleneck — every turn passes through it",
      "Long conversations bloat the supervisor's context window",
      "Without good worker descriptions, the supervisor routes badly",
    ],
    realWorld: [
      "LangGraph's `langgraph-supervisor-py` (1.5k+ stars) is the reference implementation",
      "OpenAI's customer-support reference uses a supervisor over Triage/Refunds/Tech agents",
      "Klarna's AI assistant is reported to use a supervisor over ~10 specialist agents",
    ],
    combinesWellWith: ["Tool Use (per worker)", "HITL (supervisor escalates)", "Memory"],
    nodes: [
      { id: "user",       label: "User",            sublabel: "Sends a request",     kind: "input",  icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "supervisor", label: "Supervisor",      sublabel: "Decides who acts",    kind: "agent",  icon: Crown,        position: { x: X.col3, y: Y.row2 } },
      { id: "research",   label: "Research Agent",  sublabel: "Web + KB lookups",    kind: "agent",  icon: Search,       position: { x: X.col5, y: Y.row1 } },
      { id: "code",       label: "Code Agent",      sublabel: "Writes & runs code",  kind: "agent",  icon: Wrench,       position: { x: X.col5, y: Y.row2 } },
      { id: "math",       label: "Math Agent",      sublabel: "Numerical work",      kind: "agent",  icon: Calculator,   position: { x: X.col5, y: Y.row3 } },
      { id: "final",      label: "Final Answer",    sublabel: "Supervisor responds", kind: "output", icon: CheckCircle2, position: { x: X.col1, y: Y.row4 } },
    ],
    edges: [
      { id: "e1", source: "user",       target: "supervisor" },
      { id: "e2", source: "supervisor", target: "research", label: "if research" },
      { id: "e3", source: "supervisor", target: "code",     label: "if code" },
      { id: "e4", source: "supervisor", target: "math",     label: "if math" },
      { id: "e5", source: "research",   target: "supervisor", dashed: true },
      { id: "e6", source: "code",       target: "supervisor", dashed: true },
      { id: "e7", source: "math",       target: "supervisor", dashed: true },
      { id: "e8", source: "supervisor", target: "final",    label: "task done" },
    ],
    tour: [
      {
        nodeIds: ["user", "supervisor"], edgeIds: ["e1"],
        title: "1 · Everything enters through the supervisor",
        what: "The user's request goes only to the supervisor — workers never receive raw user messages directly.",
        why: "Centralizing the entry point means every routing decision is made by one model with one prompt, which makes the system enormously easier to debug and improve.",
      },
      {
        nodeIds: ["supervisor", "research", "code", "math"], edgeIds: ["e2", "e3", "e4"],
        title: "2 · Supervisor picks the next worker",
        what: "The supervisor inspects the conversation so far and emits a routing decision: 'next: research_agent'. Workers are described to the supervisor by name + 1-line job description.",
        why: "The supervisor is just an LLM doing classification. Good worker descriptions in the supervisor prompt are the single biggest factor in routing accuracy.",
        realWorld: "LangGraph's supervisor uses structured output (Pydantic schema) so the routing decision is type-safe.",
      },
      {
        nodeIds: ["research", "code", "math", "supervisor"], edgeIds: ["e5", "e6", "e7"],
        title: "3 · Worker runs, then hands control back",
        what: "The chosen worker does its turn (calls tools, writes a draft, computes a result) and returns. Control goes back to the supervisor, not directly to another worker.",
        why: "This 'hub and spoke' shape is what distinguishes Supervisor from Swarm. Workers don't talk to each other; everything funnels through the manager.",
      },
      {
        nodeIds: ["supervisor", "final"], edgeIds: ["e8"],
        title: "4 · Supervisor decides we're done and replies",
        what: "When the supervisor judges the task complete, it stops routing and produces the final user-facing answer itself.",
        why: "The supervisor doubles as the 'voice' of the system. This keeps the user-facing tone consistent even though many specialists worked behind the scenes.",
        realWorld: "OpenAI's Agents SDK calls this 'final response from the orchestrator' and recommends a max-step cap to prevent runaway routing loops.",
      },
    ],
  },

  // 10. Swarm / Handoff (Decentralized Multi-Agent) ────────────────────────
  {
    id: "swarm",
    name: "Swarm (Peer Handoffs)",
    tagline: "Agents transfer the conversation directly to a peer when their job is done — no central manager.",
    accent: "rose",
    summary:
      "Popularized by OpenAI's Swarm library and now part of the Agents SDK, the Swarm pattern lets each agent emit a 'handoff' to another agent instead of routing through a supervisor. The active agent owns the conversation until it explicitly hands off. Lighter weight than Supervisor, but trickier to debug.",
    useWhen: [
      "Workflow is sequential by domain (sales → onboarding → support)",
      "You want minimal latency overhead — no supervisor turn between workers",
      "Each agent has a clear, narrow handoff condition",
    ],
    watchOutFor: [
      "Cycles can form if handoff rules are sloppy",
      "No single place to inspect routing — debugging is harder than Supervisor",
      "Agents need explicit handoff tools or they can't pass control",
    ],
    realWorld: [
      "OpenAI Swarm (now superseded by the Agents SDK) introduced this pattern",
      "Stripe's customer support agent uses handoffs between Triage → Billing → Refund agents",
      "LangGraph's `swarm` template implements peer-to-peer handoff",
    ],
    combinesWellWith: ["Memory (carried across handoffs)", "HITL (any agent can escalate)"],
    nodes: [
      { id: "user",      label: "User",             sublabel: "Talks to one agent at a time", kind: "input",  icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "triage",    label: "Triage Agent",     sublabel: "Greets & classifies",          kind: "agent",  icon: Compass,      position: { x: X.col2, y: Y.row2 } },
      { id: "sales",     label: "Sales Agent",      sublabel: "Pricing & plans",              kind: "agent",  icon: Sparkles,     position: { x: X.col4, y: Y.row1 } },
      { id: "support",   label: "Support Agent",    sublabel: "Bug & how-to questions",       kind: "agent",  icon: ShieldCheck,  position: { x: X.col4, y: Y.row3 } },
      { id: "billing",   label: "Billing Agent",    sublabel: "Refunds & invoices",           kind: "agent",  icon: Calculator,   position: { x: X.col5, y: Y.row2 } },
      { id: "final",     label: "Resolution",       sublabel: "Returned to user",             kind: "output", icon: CheckCircle2, position: { x: X.col5, y: Y.row4 } },
    ],
    edges: [
      { id: "e1", source: "user",    target: "triage" },
      { id: "e2", source: "triage",  target: "sales",   label: "handoff" },
      { id: "e3", source: "triage",  target: "support", label: "handoff" },
      { id: "e4", source: "support", target: "billing", label: "handoff", dashed: true },
      { id: "e5", source: "sales",   target: "billing", label: "handoff", dashed: true },
      { id: "e6", source: "billing", target: "final" },
      { id: "e7", source: "sales",   target: "final" },
      { id: "e8", source: "support", target: "final" },
    ],
    tour: [
      {
        nodeIds: ["user", "triage"], edgeIds: ["e1"],
        title: "1 · One agent owns the conversation",
        what: "At any moment, exactly one agent is 'active' and talking to the user. Initially that's the Triage agent.",
        why: "Single ownership keeps the conversation coherent. The user never sees 'three agents arguing' — they just see one assistant whose personality changes when the topic shifts.",
      },
      {
        nodeIds: ["triage", "sales", "support"], edgeIds: ["e2", "e3"],
        title: "2 · Handoff is just another tool call",
        what: "Each agent has handoff tools like `transfer_to_sales()`. When the agent calls one, the runtime swaps the active agent.",
        why: "Modeling handoff as a tool means the LLM uses the same mechanism it already knows. No special routing language to learn.",
        realWorld: "OpenAI's Agents SDK literally models this as `agent.handoffs = [sales_agent, support_agent]`.",
      },
      {
        nodeIds: ["support", "billing", "sales"], edgeIds: ["e4", "e5"],
        title: "3 · Peers can chain handoffs",
        what: "A Support agent investigating an issue might discover it's a billing problem and hand off to the Billing agent — no detour through Triage.",
        why: "Direct peer-to-peer handoff cuts a turn out of the loop vs Supervisor. For a 5-agent system, that can be 30–40% latency savings.",
      },
      {
        nodeIds: ["billing", "final", "sales", "support"], edgeIds: ["e6", "e7", "e8"],
        title: "4 · Whichever agent finishes, replies to the user",
        what: "There's no central 'final voice'. Whichever agent solves the problem closes the conversation directly.",
        why: "This is the trade-off vs Supervisor. You get lower latency and simpler routing, but at the cost of a less consistent user-facing tone — agents need shared style guides to feel cohesive.",
      },
    ],
  },

  // 11. Tree of Thoughts (Deliberate Search) ────────────────────────────────
  {
    id: "tree-of-thoughts",
    name: "Tree of Thoughts",
    tagline: "Explore multiple reasoning branches in parallel, score them, and prune the weak ones.",
    accent: "teal",
    summary:
      "Introduced by Yao et al. (2023), Tree of Thoughts (ToT) generalizes Chain-of-Thought by exploring a tree of partial reasoning paths instead of committing to one. At each step the agent generates several candidate next-thoughts, an evaluator scores them, and a search algorithm (BFS, DFS, or beam) prunes the worst. Used for hard problems where the first guess is often wrong.",
    useWhen: [
      "Problems where the first reasoning path frequently fails (puzzles, math, planning)",
      "You can write a meaningful evaluator (rubric, test, simulator)",
      "Quality matters way more than latency or cost",
    ],
    watchOutFor: [
      "5–20× the cost of vanilla CoT — it's the most expensive pattern here",
      "Useless without a real evaluator; otherwise it's just CoT × N",
      "Exponential blow-up without aggressive pruning / beam width caps",
    ],
    realWorld: [
      "Game-of-24, crossword, and creative-writing benchmarks see large gains with ToT",
      "Anthropic and OpenAI use beam-search-style exploration in their reasoning models",
      "Production deployments cap branching factor at 3 and depth at 4 to bound cost",
    ],
    combinesWellWith: ["Reflection (as evaluator)", "Tool Use (per branch)"],
    nodes: [
      { id: "problem", label: "Hard Problem",   sublabel: "Multi-step reasoning",     kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "expand",  label: "Branch Expander",sublabel: "Generate N candidates",    kind: "llm",         icon: TreePine,     position: { x: X.col2, y: Y.row2 } },
      { id: "b1",      label: "Branch 1",       sublabel: "Reasoning path A",         kind: "llm",         icon: GitBranch,    position: { x: X.col3, y: Y.row1 } },
      { id: "b2",      label: "Branch 2",       sublabel: "Reasoning path B",         kind: "llm",         icon: GitBranch,    position: { x: X.col3, y: Y.row2 } },
      { id: "b3",      label: "Branch 3",       sublabel: "Reasoning path C",         kind: "llm",         icon: GitBranch,    position: { x: X.col3, y: Y.row3 } },
      { id: "evaluator",label:"Evaluator",      sublabel: "Score each branch 0-1",    kind: "critique",    icon: GitCompare,   position: { x: X.col4, y: Y.row2 } },
      { id: "best",    label: "Best Path",      sublabel: "Pruned tree winner",       kind: "synthesizer", icon: Crown,        position: { x: X.col5, y: Y.row2 } },
      { id: "final",   label: "Final Answer",   sublabel: "Returned to user",         kind: "output",      icon: CheckCircle2, position: { x: X.col5, y: Y.row4 } },
    ],
    edges: [
      { id: "e1", source: "problem",   target: "expand" },
      { id: "e2", source: "expand",    target: "b1" },
      { id: "e3", source: "expand",    target: "b2" },
      { id: "e4", source: "expand",    target: "b3" },
      { id: "e5", source: "b1",        target: "evaluator" },
      { id: "e6", source: "b2",        target: "evaluator" },
      { id: "e7", source: "b3",        target: "evaluator" },
      { id: "e8", source: "evaluator", target: "expand", label: "expand winner deeper", dashed: true },
      { id: "e9", source: "evaluator", target: "best",   label: "depth reached" },
      { id: "e10",source: "best",      target: "final" },
    ],
    tour: [
      {
        nodeIds: ["problem", "expand"], edgeIds: ["e1"],
        title: "1 · A hard problem arrives",
        what: "Something where greedily picking the first plausible answer fails — a math olympiad puzzle, a multi-step scheduling problem, a tricky code refactor.",
        why: "ToT is overkill for everyday questions. It earns its cost only when the first reasoning path is often wrong.",
      },
      {
        nodeIds: ["expand", "b1", "b2", "b3"], edgeIds: ["e2", "e3", "e4"],
        title: "2 · Generate N candidate next-thoughts",
        what: "Instead of one continuation, the LLM is sampled N times (typically 3–5) at temperature > 0 to produce diverse candidate next steps.",
        why: "Diversity is the whole point. If all branches are paraphrases of each other, you've paid 5× the cost for nothing. Use sampling temperature deliberately.",
        realWorld: "Yao et al. used branching factor 5 for Game-of-24 and beam width 1 — meaning explore 5, keep the best 1.",
      },
      {
        nodeIds: ["b1", "b2", "b3", "evaluator"], edgeIds: ["e5", "e6", "e7"],
        title: "3 · Evaluator scores each branch",
        what: "An LLM (or a deterministic checker like a unit test or simulator) rates how promising each partial reasoning path looks. Scores can be numeric or categorical (sure/maybe/impossible).",
        why: "The evaluator is the soul of ToT. Without it, this is just expensive parallel CoT. The smartest deployments use a programmatic evaluator (e.g. 'does this code compile?') rather than an LLM evaluator.",
      },
      {
        nodeIds: ["evaluator", "expand"], edgeIds: ["e8"],
        title: "4 · Prune losers, expand the winners deeper",
        what: "Drop low-scoring branches, then recursively expand the survivors one more level deep. This is BFS with beam pruning.",
        why: "Aggressive pruning is what bounds cost. Without it, depth-D × branching-B explodes to B^D — infeasible past depth 3.",
      },
      {
        nodeIds: ["evaluator", "best"], edgeIds: ["e9"],
        title: "5 · Best complete path wins",
        what: "Once a branch reaches a complete answer (or hits max depth), the highest-scored complete branch is selected.",
        why: "ToT trades cost for reliability. On Game-of-24, ToT with GPT-4 hit ~74% accuracy vs 4% for vanilla CoT — a >18× lift, at ~5–10× cost.",
      },
      {
        nodeIds: ["best", "final"], edgeIds: ["e10"],
        title: "6 · Surface the chosen answer",
        what: "Only the winning path is returned to the user. The other branches and evaluator scores are kept in logs for debugging.",
        why: "Hide the search internals; users want the answer. But log the tree — it's the most diagnostic artifact when an answer is wrong.",
      },
    ],
  },

  // 12. Memory-Augmented Agent ─────────────────────────────────────────────
  {
    id: "memory",
    name: "Memory-Augmented Agent",
    tagline: "Short-term, episodic, semantic, and procedural memory — agents that learn across sessions.",
    accent: "amber",
    summary:
      "Out-of-the-box LLMs are stateless. Memory-augmented agents add four memory types (popularized by LangMem and the cognitive-science literature): short-term (current conversation), episodic (past conversations), semantic (extracted facts about the user/domain), and procedural (learned behaviors and prompt updates). This is what lets an agent feel like it 'knows you'.",
    useWhen: [
      "Long-running assistants that span days, weeks, or months",
      "Personalization is core to the product (preferences, history, style)",
      "You want the agent to learn from corrections without retraining",
    ],
    watchOutFor: [
      "Stale or contradictory memories silently corrupt future answers",
      "Unbounded memory grows forever — needs pruning, summarization, or TTL",
      "Privacy: stored memories are personal data and must be deletable",
    ],
    realWorld: [
      "ChatGPT's 'Memory' feature stores semantic facts across conversations",
      "LangChain's LangMem SDK provides all four memory types as building blocks",
      "Mem0, Zep, and Letta are dedicated agent-memory infrastructure products",
    ],
    combinesWellWith: ["Any other pattern — memory is orthogonal", "Supervisor", "Swarm"],
    nodes: [
      { id: "user",      label: "User",            sublabel: "Conversation turn",                kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "agent",     label: "Agent",           sublabel: "Reads memory + reasons",           kind: "agent",       icon: Bot,          position: { x: X.col3, y: Y.row2 } },
      { id: "short",     label: "Short-Term",      sublabel: "Current chat (in context)",        kind: "step",        icon: Repeat,       position: { x: X.col2, y: Y.row1 } },
      { id: "episodic",  label: "Episodic Memory", sublabel: "Past conversations",               kind: "step",        icon: Archive,      position: { x: X.col2, y: Y.row3 } },
      { id: "semantic",  label: "Semantic Memory", sublabel: "Facts about user / domain",        kind: "step",        icon: BookMarked,   position: { x: X.col2, y: Y.row4 } },
      { id: "procedural",label: "Procedural Memory",sublabel: "Learned prompts / behaviors",     kind: "step",        icon: Workflow,     position: { x: X.col4, y: Y.row1 } },
      { id: "writer",    label: "Memory Writer",   sublabel: "Background extractor",             kind: "llm",         icon: RefreshCw,    position: { x: X.col4, y: Y.row3 } },
      { id: "answer",    label: "Personalized Answer", sublabel: "Grounded in memory",           kind: "output",      icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "user",      target: "agent" },
      { id: "e2", source: "short",     target: "agent" },
      { id: "e3", source: "episodic",  target: "agent" },
      { id: "e4", source: "semantic",  target: "agent" },
      { id: "e5", source: "procedural",target: "agent" },
      { id: "e6", source: "agent",     target: "answer" },
      { id: "e7", source: "agent",     target: "writer", label: "log turn", dashed: true },
      { id: "e8", source: "writer",    target: "episodic", label: "save", dashed: true },
      { id: "e9", source: "writer",    target: "semantic", label: "extract facts", dashed: true },
    ],
    tour: [
      {
        nodeIds: ["user", "short", "agent"], edgeIds: ["e1", "e2"],
        title: "1 · Short-term memory = the current conversation",
        what: "Every turn so far in this session is in the LLM's context window. This is the cheapest, most immediate memory.",
        why: "Short-term is what every chatbot has. The other three memory types are what turn a chatbot into an agent that 'remembers you'.",
      },
      {
        nodeIds: ["episodic", "agent"], edgeIds: ["e3"],
        title: "2 · Episodic memory = past conversations",
        what: "Past conversations are stored verbatim (or summarized) and retrieved by similarity when relevant — 'last time you asked about X, we decided Y'.",
        why: "Episodic memory is what lets an agent reference history without you having to repeat yourself. It's typically stored as embeddings in a vector store keyed by user_id + timestamp.",
        realWorld: "Mem0 and Zep both offer episodic memory as a managed service.",
      },
      {
        nodeIds: ["semantic", "agent"], edgeIds: ["e4"],
        title: "3 · Semantic memory = extracted facts",
        what: "Atomic facts about the user or domain: 'User prefers brevity', 'Their company is on Postgres 15', 'They speak French and English'. Stored as structured records, not raw chat.",
        why: "Semantic memory is far more reliable than episodic for personalization, because it's pre-distilled. The agent doesn't have to re-derive your preferences from raw history every turn.",
        realWorld: "ChatGPT's user-visible Memory feature is exactly this: surfaced semantic facts.",
      },
      {
        nodeIds: ["procedural", "agent"], edgeIds: ["e5"],
        title: "4 · Procedural memory = learned behaviors",
        what: "The agent's own system prompt and tool-use heuristics are versioned and updated as it learns from feedback ('always confirm before deleting', 'prefer Python over Bash for file work').",
        why: "Procedural memory is how agents improve without retraining. Every accepted/rejected suggestion can refine the system prompt for next time.",
        realWorld: "LangMem's prompt-optimizer is built specifically for this.",
      },
      {
        nodeIds: ["agent", "writer", "episodic", "semantic"], edgeIds: ["e7", "e8", "e9"],
        title: "5 · A background writer keeps memory fresh",
        what: "After (not during) each conversation, a separate LLM extracts new facts and saves new episodes — out of the user's hot path.",
        why: "Writing memory inline kills latency. Real systems do this asynchronously, often hours later, batched per user.",
      },
      {
        nodeIds: ["agent", "answer"], edgeIds: ["e6"],
        title: "6 · The reply feels personal because it is",
        what: "The answer naturally references prior context, user preferences, and learned conventions — not because the LLM is magic, but because all four memory types fed into its prompt.",
        why: "Memory is the difference between 'a chatbot' and 'my assistant'. It's the highest-leverage upgrade you can add to any of the other patterns on this page.",
      },
    ],
  },

  // 13. LLM Router (Cost / Capability Routing) ─────────────────────────────
  {
    id: "llm-router",
    name: "LLM Router",
    tagline: "Classify each request, then send it to the cheapest model that can handle it.",
    accent: "sky",
    summary:
      "Sending every request to your most expensive model is the #1 cost mistake in production AI. The Router pattern adds a tiny classifier in front: simple FAQs go to a nano model, code goes to a code-specialist, hard reasoning goes to a frontier model. Often pays for itself in the first hour of traffic.",
    useWhen: [
      "Your traffic mix is heterogeneous (FAQs + complex reasoning + code)",
      "You have a clear cost ceiling per request",
      "Latency matters and small models are 5–20× faster",
    ],
    watchOutFor: [
      "Bad classification = wrong model = bad answer (worse than no router)",
      "Adds one extra LLM call per request — keep the classifier tiny and fast",
      "Need a fallback path: if the cheap model fails, escalate, don't drop",
    ],
    realWorld: [
      "OpenRouter, Portkey, and Cloudflare AI Gateway all sit at this layer",
      "vLLM Semantic Router is an open-source classifier for self-hosted deployments",
      "Most production AI products quietly route 60–80% of traffic to small models",
    ],
    combinesWellWith: ["Any pattern — router fronts the model call", "Tool Use"],
    nodes: [
      { id: "request",   label: "Incoming Request", sublabel: "User question",          kind: "input",       icon: User,         position: { x: X.col1, y: Y.row2 } },
      { id: "classifier",label: "Classifier",       sublabel: "Tiny LLM / embedding",   kind: "router",      icon: RouteIcon,    position: { x: X.col2, y: Y.row2 } },
      { id: "nano",      label: "Nano Model",       sublabel: "Cheap, FAQs, classify",  kind: "llm",         icon: Sparkles,     position: { x: X.col4, y: Y.row1 } },
      { id: "code",      label: "Code Specialist",  sublabel: "Code + structured edits",kind: "llm",         icon: Wrench,       position: { x: X.col4, y: Y.row2 } },
      { id: "frontier",  label: "Frontier Model",   sublabel: "Hard reasoning, agentic",kind: "llm",         icon: Brain,        position: { x: X.col4, y: Y.row3 } },
      { id: "fallback",  label: "Escalation",       sublabel: "Retry on harder model",  kind: "checkpoint",  icon: ArrowRight,   position: { x: X.col3, y: Y.row4 } },
      { id: "answer",    label: "Answer",           sublabel: "Returned to user",       kind: "output",      icon: CheckCircle2, position: { x: X.col5, y: Y.row2 } },
    ],
    edges: [
      { id: "e1", source: "request",   target: "classifier" },
      { id: "e2", source: "classifier",target: "nano",     label: "simple" },
      { id: "e3", source: "classifier",target: "code",     label: "code-shaped" },
      { id: "e4", source: "classifier",target: "frontier", label: "hard" },
      { id: "e5", source: "nano",      target: "answer" },
      { id: "e6", source: "code",      target: "answer" },
      { id: "e7", source: "frontier",  target: "answer" },
      { id: "e8", source: "nano",      target: "fallback", label: "low confidence", dashed: true },
      { id: "e9", source: "fallback",  target: "frontier", label: "escalate",       dashed: true },
    ],
    tour: [
      {
        nodeIds: ["request", "classifier"], edgeIds: ["e1"],
        title: "1 · Every request hits the classifier first",
        what: "A small, fast model (or an embedding-based classifier) reads the request and tags it: simple/code/hard.",
        why: "The classifier must be cheaper than the savings it generates. Embedding-based classifiers (one vector lookup) cost ~$0.0001 per request — orders of magnitude less than the model call they're routing.",
        realWorld: "vLLM Semantic Router uses sentence embeddings + a learned classifier. Portkey and Cloudflare AI Gateway use rule-based + LLM classifiers.",
      },
      {
        nodeIds: ["classifier", "nano"], edgeIds: ["e2"],
        title: "2 · Easy stuff goes to a nano model",
        what: "FAQs, classification, short summaries — anything a small model handles well goes to GPT-4o-mini, Claude Haiku, or Gemini Flash.",
        why: "60–80% of typical production traffic is in this bucket. Routing it correctly cuts your bill by ~70% with no measurable quality drop.",
      },
      {
        nodeIds: ["classifier", "code"], edgeIds: ["e3"],
        title: "3 · Code requests go to a code specialist",
        what: "Code-shaped requests (write a function, fix a bug, refactor) go to a code-specialist model like Claude Sonnet or DeepSeek-Coder.",
        why: "Specialist models often beat frontier general-purpose models on their specialty, at lower cost. Routing by request shape captures that for free.",
      },
      {
        nodeIds: ["classifier", "frontier"], edgeIds: ["e4"],
        title: "4 · Hard reasoning goes to the frontier",
        what: "Multi-step reasoning, planning, ambiguous instructions — these go to your most capable model (GPT-5, Claude Opus 4, Gemini 3 Pro).",
        why: "The router protects the frontier model from cheap traffic and reserves it for queries where its capability premium is actually worth paying for.",
      },
      {
        nodeIds: ["nano", "fallback", "frontier"], edgeIds: ["e8", "e9"],
        title: "5 · Confidence-based fallback",
        what: "If the cheap model returns a low-confidence answer (or fails a sanity check), the system escalates to the frontier model and tries again.",
        why: "This is the safety net. Without it, mis-routing degrades quality. With it, mis-routing just adds a small latency penalty in rare cases — much better trade-off.",
        realWorld: "OpenRouter's auto-router uses confidence + provider availability to decide when to retry on a different model.",
      },
      {
        nodeIds: ["nano", "code", "frontier", "answer"], edgeIds: ["e5", "e6", "e7"],
        title: "6 · The user gets one answer — they never see the routing",
        what: "From the outside, the system feels like a single model. Internally, you've cut cost dramatically while preserving quality on the cases that need it.",
        why: "This is why router patterns are now standard infrastructure — the cost savings compound at scale and the architecture is invisible to the end user.",
      },
    ],
  },

  // 14. Responsible AI / Guardrails (Branching: Unsafe vs Safe) ─────────────
  {
    id: "rai-guardrails",
    name: "Responsible AI Guardrails",
    tagline: "Branching swarm: an unguarded autonomous agent vs. a Guardrail/Audit chain that intercepts, redacts, and explains.",
    accent: "emerald",
    summary:
      "Responsible AI (RAI) isn't a single model — it's an architecture. This pattern shows the same loan-application input flowing down two paths: an Unrestricted Evaluator (the danger path) that silently uses proxy variables like zip code, vs. a chain of specialized agents (PII Guardrail → Blind Evaluator → Audit) that strip sensitive features, decide on math alone, and emit a regulator-ready 'Reason for Decision'. Used in fintech, healthcare, hiring, and any regulated decision system.",
    useWhen: [
      "Decisions affect access to credit, housing, employment, or health",
      "You need an auditable, regulator-ready reason for every decision",
      "The model has access to data that could become a proxy for protected attributes",
    ],
    watchOutFor: [
      "Implicit bias from 'innocent' features (zip code → race, name → gender)",
      "Hallucinated rationales when no output schema is enforced",
      "'Guardrail theater' — a guardrail agent that logs but doesn't actually redact",
    ],
    realWorld: [
      "ECOA/Reg B requires US lenders to give a specific reason for adverse action — exactly what the Audit Agent emits",
      "EU AI Act classifies credit scoring as 'high-risk' and mandates this kind of bias mitigation",
      "Anthropic's 'Constitutional AI' and OpenAI's safety classifiers are guardrail agents that intercept before the main model acts",
    ],
    combinesWellWith: ["Sequential Workflow", "Multi-Agent", "Reflection (as Audit)"],
    nodes: [
      // Shared intake (slate)
      { id: "rai_input",   label: "Loan Application",  sublabel: "Jane Doe · $85k · 90210", kind: "input",  icon: FileText, position: { x: X.col1, y: 220 } },
      { id: "rai_intake",  label: "Data Intake Agent", sublabel: "Parses raw applicant data", kind: "agent", icon: Download, position: { x: X.col2, y: 220 } },

      // BRANCH A — Unsafe path (top, amber/red)
      { id: "rai_unrestricted", label: "Unrestricted Evaluator", sublabel: "Sees ZIP, name, demographics", kind: "agent",  icon: Bot,            position: { x: X.col3, y: 60 },  accent: "amber" },
      { id: "rai_biased",       label: "Biased Rejection",       sublabel: "Hallucinated reason",          kind: "output", icon: AlertTriangle,  position: { x: X.col4, y: 60 },  accent: "rose" },

      // BRANCH B — Safe RAI path (bottom, blue → teal → indigo → emerald)
      { id: "rai_guardrail", label: "PII & Bias Guardrail", sublabel: "Strips name, gender, ZIP",      kind: "agent",  icon: Shield,       position: { x: X.col3, y: 380 }, accent: "sky" },
      { id: "rai_blind",     label: "Blind Financial Eval", sublabel: "Decides on DTI + credit only",  kind: "agent",  icon: Calculator,   position: { x: X.col4, y: 380 }, accent: "teal" },
      { id: "rai_audit",     label: "Explainability & Audit", sublabel: "Generates Reason for Decision", kind: "agent",  icon: Search,       position: { x: X.col4 + 220, y: 380 }, accent: "indigo" },
      { id: "rai_fair",      label: "Fair Approval",        sublabel: "Auditable, regulator-ready",    kind: "output", icon: CheckCircle2, position: { x: X.col5 + 200, y: 380 }, accent: "emerald" },
    ],
    edges: [
      // Shared spine
      { id: "rai_e1", source: "rai_input",  target: "rai_intake" },

      // Unsafe branch (red, dashed)
      { id: "rai_eA1", source: "rai_intake",       target: "rai_unrestricted", label: "raw data (incl. ZIP)", variant: "danger", dashed: true },
      { id: "rai_eA2", source: "rai_unrestricted", target: "rai_biased",       label: "silent bias",          variant: "danger", dashed: true },

      // Safe branch (green, solid)
      { id: "rai_eB1", source: "rai_intake",   target: "rai_guardrail", label: "raw data",        variant: "success" },
      { id: "rai_eB2", source: "rai_guardrail",target: "rai_blind",     label: "redacted features", variant: "success" },
      { id: "rai_eB3", source: "rai_blind",    target: "rai_audit",     label: "decision",        variant: "success" },
      { id: "rai_eB4", source: "rai_audit",    target: "rai_fair",      label: "explainable approval", variant: "success" },
    ],
    tour: [
      {
        nodeIds: ["rai_input", "rai_intake"], edgeIds: ["rai_e1"],
        title: "1 · A loan application enters the system",
        what: "The Data Intake Agent receives Jane Doe's full application: $85k income, 720 credit score, 22% debt-to-income ratio — and also her name, gender, and ZIP code 90210.",
        why: "The intake stage is identical for both architectures. The choice that defines whether this system is responsible or not happens in the next step: who gets to look at the raw data?",
        realWorld: "Most production fintech onboarding APIs collect everything by default — the discipline is what you do with it next.",
      },
      {
        nodeIds: ["rai_unrestricted", "rai_biased"], edgeIds: ["rai_eA1", "rai_eA2"],
        title: "2 · The danger path — autonomy without guardrails",
        what: "An Unrestricted Evaluator agent sees every field. It learns from history that ZIP code 90210 has lower defaults than 90011 and silently uses neighborhood as a feature. With no output schema, it hallucinates a plausible-sounding rejection like 'insufficient profile strength'.",
        why: "This is algorithmic redlining. The model isn't 'racist' — it's an optimizer that found ZIP correlates with default and used the cheapest signal. Without architectural guardrails, the same loop happens for hiring, insurance, healthcare triage. The hallucinated reason makes it impossible to audit.",
        realWorld: "Apple Card (2019) and several US lenders have been investigated for exactly this pattern — models trained on historical lending data that encoded redlining.",
      },
      {
        nodeIds: ["rai_guardrail"], edgeIds: ["rai_eB1", "rai_eB2"],
        title: "3 · The RAI shield — a Guardrail Agent intercepts first",
        what: "On the safe path, a specialized PII & Bias Guardrail Agent runs before any decision-maker. It strips Jane's name, gender, and ZIP, and forwards only the financial features: credit score, DTI, employment length, requested amount.",
        why: "The downstream model can't be biased on a feature it never sees. This is 'fairness through unawareness' done architecturally — separate the redactor from the decider so the decider physically cannot use the redacted fields.",
        realWorld: "Anthropic's guardrails, OpenAI's moderation endpoint, and AWS Bedrock Guardrails are all this exact pattern: a small, focused model that runs before the big one.",
      },
      {
        nodeIds: ["rai_blind", "rai_audit"], edgeIds: ["rai_eB3"],
        title: "4 · Blind evaluation, then a forced explanation",
        what: "The Blind Financial Evaluator approves Jane based purely on math: 'DTI 22%, credit 720, income $85k, requested $25k → approve at 7.4% APR'. The Explainability & Audit Agent then generates a structured 'Reason for Decision' record citing only the features that were actually used.",
        why: "The blind evaluator doesn't even know Jane's name. The audit agent gives the regulator (and Jane) a verifiable, model-agnostic explanation. Together they make the decision both fair and defensible — the two things ECOA, GDPR Art. 22, and the EU AI Act actually require.",
        realWorld: "US Reg B requires a specific reason for adverse action within 30 days. EU AI Act Art. 14 requires human-interpretable output for high-risk systems. This pair satisfies both.",
      },
      {
        nodeIds: ["rai_biased", "rai_fair"], edgeIds: ["rai_eA2", "rai_eB4"],
        title: "5 · Compare the outputs",
        what: "Unsafe path output: 'Rejected: applicant profile does not meet our risk criteria.' Safe path output: 'Approved: DTI 22% within policy, credit 720 above threshold of 680, no derogatory items in 24 months.'",
        why: "Same applicant, same data, two architectures. The unsafe one is illegal in most jurisdictions and impossible to defend in court. The safe one creates trust, auditability, and a paper trail. Responsible AI is a software architecture choice, not a model choice.",
        realWorld: "This branching test — running the same input down both paths and diffing the outputs — is how regulated AI teams actually validate guardrails in production (e.g. Stripe's Radar, Plaid's risk models).",
      },
    ],
  },
];

export function getPattern(id: string): AgenticPattern | undefined {
  return AGENTIC_PATTERNS.find((p) => p.id === id);
}
