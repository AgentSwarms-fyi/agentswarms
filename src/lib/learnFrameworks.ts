// Deep-dive content for the major agent frameworks.
// Used by the "Frameworks deep dive" section in /learn.
// Each entry tells the same story twice — once for a beginner,
// once for someone shipping in production — plus where it sits
// in a real stack and how AgentSwarms relates.

export type FrameworkDeep = {
  id: string;
  name: string;
  vendor: string;
  language: string;
  oneLiner: string;
  /** Plain-English explanation for someone new to agents. */
  beginner: string;
  /** What a senior engineer should actually know. */
  advanced: string;
  /** When does this framework genuinely earn its slot in your stack? */
  whenToReachFor: string;
  /** Where it falls down — be honest. */
  watchOut: string;
  /** A concrete real-world use case they're known for. */
  caseStudy: string;
  /** Three to five vocabulary tokens unique to this framework. */
  keyConcepts: string[];
  /** How AgentSwarms borrows from / overlaps with this framework. */
  agentSwarmsLink: string;
  github: string;
  docs: string;
};

export const frameworksDeep: FrameworkDeep[] = [
  {
    id: "langchain",
    name: "LangChain",
    vendor: "LangChain Inc.",
    language: "Python · JS/TS",
    oneLiner: "The general-purpose toolbox that started the modern LLM-app movement.",
    beginner:
      "LangChain is a library of pre-built building blocks for talking to LLMs: prompt templates, model wrappers, chains (run-this-then-that), retrievers, memory, and tool wrappers. If you want to call OpenAI then pass the answer into another model then look something up in a vector store — LangChain has a one-line helper for each of those steps and you glue them together.",
    advanced:
      "Two distinct codebases live under the LangChain name today: the original `langchain` (chains + agents + integrations) and `langchain-core` (the runnable/LCEL primitives that everything composes from). LCEL (LangChain Expression Language) is the modern way — pipeline operators (`prompt | model | parser`), batched/streamed/async transparently, and OpenTelemetry-friendly. Trade-off: 200+ integration packages mean the abstraction layer is thick; what the LLM actually sees can be three wrappers deep, which is why teams pair it with LangSmith for tracing.",
    whenToReachFor:
      "RAG prototypes, multi-step pipelines, and anywhere you need the widest selection of pre-built integrations (vector stores, model providers, document loaders).",
    watchOut:
      "Frequent breaking changes — pin versions in production. Easy to over-engineer simple flows; for a single chatbot you may not need it at all.",
    caseStudy:
      "Klarna's customer-service assistant (handling ~2/3 of chat tickets at peak) was built on LangChain + LangSmith. Their public engineering posts call out LCEL composition + LangSmith tracing as the unlock for shipping safely at scale.",
    keyConcepts: ["Runnable / LCEL", "Chain", "Retriever", "Output parser", "Tool"],
    agentSwarmsLink:
      "AgentSwarms borrows the 'tool wrapping' pattern (a typed JSON schema + handler) directly. Our agent definitions look like LangChain `Tool`s, but the orchestration is a visual graph instead of Python code.",
    github: "https://github.com/langchain-ai/langchain",
    docs: "https://python.langchain.com/docs/",
  },
  {
    id: "langgraph",
    name: "LangGraph",
    vendor: "LangChain Inc.",
    language: "Python · JS/TS",
    oneLiner: "A durable state machine for agents — the missing 'workflow engine' under chains.",
    beginner:
      "LangGraph treats your agent as a graph of nodes and edges. Each node is a function (often an LLM call), each edge says 'go to this node next, maybe based on what the model just said.' The big win is that the framework remembers where you are — if your machine crashes mid-workflow, it resumes from the last checkpoint, just like a serverless step function for LLM apps.",
    advanced:
      "Built on the actor model: a typed `State` object flows through the graph; every node is a pure function `state → partial state`. First-class support for cycles (true agentic loops, not just DAGs), interrupts (pause for human approval), checkpointers (Postgres, SQLite, Redis), and time-travel debugging (replay from any past state). The Platform offering adds horizontal scaling, scheduled cron, and managed thread storage. Increasingly the substrate other 'agent frameworks' compile down to.",
    whenToReachFor:
      "Long-running agents, anything with HITL approval, multi-agent supervisors, and workflows where 'resume after crash' is a hard requirement (refunds, claims, deployments).",
    watchOut:
      "More ceremony than Strands or OpenAI Agents SDK; the durable-state model is overkill for short single-turn tasks. Pythonic API leaks into your graph definitions.",
    caseStudy:
      "Replit's coding agent ('Replit Agent') uses LangGraph for the planner/executor loop with explicit checkpoints between research, plan, and code-write phases — so a long build can be paused, inspected, and resumed.",
    keyConcepts: ["State graph", "Checkpointer", "Interrupt", "Supervisor", "Time travel"],
    agentSwarmsLink:
      "AgentSwarms' Swarm canvas is conceptually the same idea: nodes + edges + typed handoffs. We persist runs to Postgres so you can re-open a partial trace, which is the same pattern as a LangGraph checkpoint.",
    github: "https://github.com/langchain-ai/langgraph",
    docs: "https://langchain-ai.github.io/langgraph/",
  },
  {
    id: "crewai",
    name: "CrewAI",
    vendor: "CrewAI Inc.",
    language: "Python",
    oneLiner: "Role-based 'crews' of agents — easiest mental model for non-engineers.",
    beginner:
      "CrewAI asks you to think like a manager: define a few agents (each with a role, goal, and backstory), give them tasks, and form them into a 'crew' that runs sequentially or hierarchically. It feels like writing a job-description doc and pressing play. Great for content workflows, research pipelines, and demos.",
    advanced:
      "Two execution modes — sequential (linear pipeline) and hierarchical (a manager LLM delegates). Tasks have explicit `expected_output` schemas, so the framework can validate handoffs. Compatible with LangChain tools, plus a growing native tool catalog. CrewAI Enterprise adds a hosted runtime + observability. The role/task abstraction can be surprisingly limiting once flows branch — many teams graduate to LangGraph when they need real conditionals.",
    whenToReachFor:
      "Prototyping a multi-agent workflow in an afternoon, content-ops automations (research → draft → edit), and demos where the audience needs to grok the team metaphor.",
    watchOut:
      "Less control than coding the orchestration yourself. Hierarchical mode burns tokens fast — the manager re-summarises every step. Observability hooks are thinner than LangGraph or AutoGen.",
    caseStudy:
      "Featured in dozens of marketing-automation case studies (e.g. content factories that combine an SEO researcher + writer + editor crew). CrewAI publishes case studies with companies like PwC and Oracle on their site.",
    keyConcepts: ["Agent (role + goal)", "Task", "Crew", "Process (sequential / hierarchical)", "Manager LLM"],
    agentSwarmsLink:
      "Our 'role-prompt + tool list + handoff edge' on the swarm canvas is the visual analogue of a CrewAI Agent + Task + Crew. If you can describe a CrewAI crew in words, you can drag it onto our canvas in five minutes.",
    github: "https://github.com/crewAIInc/crewAI",
    docs: "https://docs.crewai.com/",
  },
  {
    id: "autogen",
    name: "AutoGen",
    vendor: "Microsoft Research",
    language: "Python · .NET",
    oneLiner: "Conversational multi-agent system with first-class code execution.",
    beginner:
      "AutoGen treats agents as participants in a chat room. You define a few agents (assistant, user-proxy, code-executor), put them in a `GroupChat`, and let them talk to each other until the task is done. Out of the box one agent writes code, another runs it in a sandbox and reports back errors — so 'self-healing code' demos are basically free.",
    advanced:
      "AutoGen 0.4 is a significant rewrite: actor-model architecture, async event-driven runtime, cross-language messages (Python ↔ .NET), and modular extensions. Three layers: Core (runtime), AgentChat (high-level chat patterns), Extensions (LLM clients, tools, code executors). Magentic-One is Microsoft's reference 'general-purpose multi-agent team' built on AutoGen — orchestrator + WebSurfer + FileSurfer + Coder + ComputerTerminal. Free-form chat handoffs are powerful but harder to debug than LangGraph's explicit edges; many production users wrap AutoGen with their own router.",
    whenToReachFor:
      "Code-generation pipelines (write → run → debug loops), research agents that need to iterate on outputs, and any workflow where the safest design is 'two LLMs critiquing each other'.",
    watchOut:
      "Unbounded chats can drift and burn tokens. The .NET path is genuinely first-class but lags Python on examples. Steeper learning curve than CrewAI.",
    caseStudy:
      "Microsoft's own Magentic-One sets state-of-the-art results on GAIA (a generalist agent benchmark) by composing five AutoGen agents. Many internal Microsoft tools (parts of GitHub Copilot extensions, security copilots) use AutoGen patterns under the hood.",
    keyConcepts: ["GroupChat", "User proxy", "Code executor", "Agent runtime", "Magentic-One"],
    agentSwarmsLink:
      "Our 'reviewer pattern' template (writer agent + reviewer agent + accept/reject handoff) is the AgentSwarms-canvas version of the classic AutoGen two-agent chat. The visual edge IS the conversation channel.",
    github: "https://github.com/microsoft/autogen",
    docs: "https://microsoft.github.io/autogen/stable/",
  },
  {
    id: "llamaindex",
    name: "LlamaIndex",
    vendor: "LlamaIndex Inc.",
    language: "Python · TS",
    oneLiner: "RAG-first framework — start with your data, end with an agent.",
    beginner:
      "While LangChain started 'how do I chain LLMs', LlamaIndex started 'how do I get my documents into an LLM well'. It has the largest catalog of document loaders (PDF, Notion, Google Drive, SQL, Slack…), every chunking strategy you've heard of, and rich indices (vector, summary, tree, knowledge-graph) you can mix per query. The Workflows API extends this into event-driven multi-agent flows.",
    advanced:
      "Architecturally: Documents → Nodes → Indices → Query Engines → Agents. Their differentiator is retrieval depth: hybrid search, sub-question decomposition, recursive retrieval over node hierarchies, query routing across multiple indices, and agentic retrieval (a tool-using ReAct agent that picks which index to query). LlamaParse (their commercial parser) handles complex PDFs (tables, figures) better than most open-source parsers. LlamaCloud productionises ingestion + indexing as a managed service. Pairs nicely with any orchestrator — LangGraph, CrewAI, custom — because it doesn't force you into its agent loop.",
    whenToReachFor:
      "Anywhere retrieval quality is the #1 metric: doc QA, regulated knowledge bases, research copilots, contract analysis. Especially when you have heterogeneous source data.",
    watchOut:
      "The agent abstractions are less battle-tested than the retrieval primitives. API surface is large and evolves fast — pin versions.",
    caseStudy:
      "KPMG and Salesforce have both presented LlamaIndex-based RAG architectures. The 'RAG over a 10-K filing' case study (parsing tables in financial PDFs with LlamaParse, then sub-question decomposition for multi-section questions) is the canonical LlamaIndex demo.",
    keyConcepts: ["Document / Node", "Index", "Query engine", "Sub-question decomposition", "LlamaParse"],
    agentSwarmsLink:
      "Our Knowledge tab + Graph RAG view echo the LlamaIndex 'index hierarchy' idea: vector index for semantic, graph index for relations, and an agent that picks which to query. The Agentic RAG swarm template demonstrates exactly this routing.",
    github: "https://github.com/run-llama/llama_index",
    docs: "https://docs.llamaindex.ai/",
  },
  {
    id: "semantic-kernel",
    name: "Semantic Kernel",
    vendor: "Microsoft",
    language: "C# · Python · Java",
    oneLiner: "Enterprise SDK for embedding LLMs into existing .NET / Java / Python apps.",
    beginner:
      "Semantic Kernel (SK) is Microsoft's 'add AI to your existing app' SDK. The big idea is the Kernel — a container that holds your AI services + your plugins (regular functions or LLM-callable ones). You ask the Kernel to fulfil a goal; it picks plugins, possibly using a Planner. It's Microsoft's pragmatic answer to LangChain for enterprises with C#/Java/Python codebases.",
    advanced:
      "First-class .NET support is genuinely rare in this space — many regulated enterprises only ship C# in production, and SK is their only realistic open option. Plugins are just attributed methods (`[KernelFunction]`) so you can expose existing business logic with one decorator. Planners (Stepwise, Function-Calling) decompose goals into plugin sequences. The Process Framework adds long-running stateful workflows (their LangGraph analogue). Tight Azure integration: AI Search connectors, Azure OpenAI, Entra ID auth — but model-agnostic at the abstraction layer.",
    whenToReachFor:
      "Microsoft-stack enterprises adding AI to existing .NET or Java systems, regulated industries that need first-party Microsoft support, and teams that want native dependency-injection patterns.",
    watchOut:
      "Concepts (Kernel, Planner, Process) take time to click vs LangChain's lower-level chains. Smaller community + fewer ecosystem packages than the Python-first players.",
    caseStudy:
      "Microsoft's own Copilot Studio agents and many internal copilots are built on SK. Public examples include enterprise customers like Kepler Vision and several financial-services firms using SK to expose mainframe APIs as plugins to LLMs.",
    keyConcepts: ["Kernel", "Plugin / KernelFunction", "Planner", "Process Framework", "Filter"],
    agentSwarmsLink:
      "Our 'tool registry' is the same idea as a SK plugin catalog — typed function metadata the LLM can call. Our HITL approval flow mirrors SK's Filter pipeline (intercept, allow/deny, log).",
    github: "https://github.com/microsoft/semantic-kernel",
    docs: "https://learn.microsoft.com/semantic-kernel/",
  },
  {
    id: "pydantic-ai",
    name: "Pydantic AI",
    vendor: "Pydantic Services Inc.",
    language: "Python",
    oneLiner: "Type-safe agents for the FastAPI generation — Pydantic everywhere.",
    beginner:
      "If you already use FastAPI + Pydantic to build APIs, Pydantic AI feels like home. You declare an Agent with a typed input model, a typed output model, and typed tools — and the framework guarantees you'll never get back a half-parsed JSON blob. The same validators you trust for HTTP request bodies now police your LLM outputs.",
    advanced:
      "Built by the Pydantic team itself, so the validation story is unmatched: structured outputs are validated, retried, and self-corrected on schema failure (the model gets the validator error message and tries again). Model-agnostic via a clean adapter layer (OpenAI, Anthropic, Gemini, Groq, Cohere, local). Dependency-injection container for tools — easy to mock, easy to test. Logfire integration gives OpenTelemetry tracing out of the box. Newer ecosystem than LangChain, but the API has a refreshing 'one obvious way to do things' feel.",
    whenToReachFor:
      "Production Python backends that already lean on Pydantic / FastAPI, agent endpoints with strict response contracts, and teams that prize testability over breadth of integrations.",
    watchOut:
      "Younger ecosystem — fewer pre-built loaders, vector wrappers, or community recipes. Python-only today (no JS/TS).",
    caseStudy:
      "Pydantic itself uses Pydantic AI to power features inside Logfire (their observability product). Several fintech and healthtech startups have publicly migrated their LangChain agents to Pydantic AI for the type-safety and DI testability.",
    keyConcepts: ["Agent[Deps, Result]", "RunContext", "Tool", "ModelRetry", "Structured output"],
    agentSwarmsLink:
      "Our agents enforce typed inputs/outputs on every node — same philosophy. The 'self-correct on schema failure' loop in our SQL Agent template is exactly what Pydantic AI does at the model layer.",
    github: "https://github.com/pydantic/pydantic-ai",
    docs: "https://ai.pydantic.dev/",
  },
];

/* ─────────── Real-world stack examples ─────────── */

export type StackExample = {
  scenario: string;
  team: string;
  layers: { layer: string; choice: string; why: string }[];
  takeaway: string;
};

export const stackExamples: StackExample[] = [
  {
    scenario: "Customer-support assistant for a SaaS product",
    team: "8-person product team, Python backend",
    layers: [
      { layer: "Orchestration", choice: "LangGraph", why: "Need HITL approval on refunds + checkpoints for resumable threads." },
      { layer: "Retrieval", choice: "LlamaIndex + LlamaParse", why: "Help docs include PDFs with tables — LlamaParse handles them out of the box." },
      { layer: "Validation", choice: "Pydantic AI patterns", why: "Outputs must match a strict ticket-update schema before reaching Zendesk." },
      { layer: "Observability", choice: "LangSmith", why: "Per-conversation traces + dataset evals on real ticket replays." },
      { layer: "Tools", choice: "MCP servers", why: "Zendesk + Stripe + internal billing exposed as MCP — reusable across other internal agents." },
    ],
    takeaway:
      "Most production stacks pick ONE orchestrator and pull retrieval / validation libraries from elsewhere. You almost never use LangChain AND LlamaIndex AND CrewAI in the same flow.",
  },
  {
    scenario: "Internal research crew (analyst → writer → editor)",
    team: "Marketing ops, no engineers",
    layers: [
      { layer: "Orchestration", choice: "CrewAI", why: "Role/task abstraction maps directly to the existing job titles on the team." },
      { layer: "Retrieval", choice: "Built-in CrewAI tools + Tavily", why: "Web search is the only retrieval source needed." },
      { layer: "Validation", choice: "Pydantic models in CrewAI tasks", why: "Each task declares an `expected_output` schema." },
      { layer: "Observability", choice: "CrewAI dashboards", why: "Non-engineers need a UI, not OpenTelemetry traces." },
      { layer: "Tools", choice: "None custom", why: "Stock tool catalog covers search + scraping." },
    ],
    takeaway:
      "Small teams without engineering should pick the framework with the gentlest mental model. CrewAI wins here precisely because it has the LEAST flexibility — fewer wrong choices to make.",
  },
  {
    scenario: "Code-review + auto-fix bot for a monorepo",
    team: "Internal DevX team, polyglot codebase",
    layers: [
      { layer: "Orchestration", choice: "AutoGen", why: "Reviewer + Fixer + Test-runner is the canonical AutoGen GroupChat pattern." },
      { layer: "Retrieval", choice: "Custom (tree-sitter + Postgres)", why: "Code retrieval is structural, not semantic — no off-the-shelf framework helps." },
      { layer: "Validation", choice: "Compiler / test suite", why: "Real ground truth — ignore the model's self-evaluation." },
      { layer: "Observability", choice: "OpenTelemetry → Honeycomb", why: "Already the team's standard for service traces." },
      { layer: "Tools", choice: "MCP server wrapping git + CI", why: "Reusable across other DevX agents." },
    ],
    takeaway:
      "Domain-specific tasks (code, finance, science) often need custom retrieval — frameworks help with the orchestration shell, not the substance.",
  },
  {
    scenario: "Enterprise .NET shop adding AI to a claims app",
    team: "20-engineer .NET team, regulated industry",
    layers: [
      { layer: "Orchestration", choice: "Semantic Kernel", why: "Only mature framework with first-class C# + dependency injection." },
      { layer: "Retrieval", choice: "Azure AI Search", why: "Fully managed, integrates with Entra ID for per-user document filtering." },
      { layer: "Validation", choice: "Kernel Filters", why: "Centralised PII redaction + audit log before any plugin executes." },
      { layer: "Observability", choice: "Application Insights", why: "Already mandated by the platform team." },
      { layer: "Tools", choice: "Existing services as KernelFunctions", why: "Decorate one method, expose to LLM." },
    ],
    takeaway:
      "Language and ecosystem fit beats benchmark wins. A regulated .NET shop will not adopt a Python-first framework no matter how popular it is on Twitter.",
  },
];

/* ─────────── Decision guide: do you actually need them all? ─────────── */

export const doYouNeedItAll = [
  {
    question: "Are you shipping ONE agent for ONE workflow?",
    answer:
      "Pick ONE framework. Modern frameworks (LangGraph, Pydantic AI, OpenAI Agents SDK) include retrieval, tools, and tracing. Adding LlamaIndex on top of LangGraph for a single chatbot is over-engineering.",
  },
  {
    question: "Are you building a RAG system over messy enterprise docs?",
    answer:
      "LlamaIndex for ingestion + retrieval, anything (LangGraph / Pydantic AI / your own loop) for the agent loop. Different libraries solve different sub-problems — this is the one combination that's genuinely common.",
  },
  {
    question: "Do you need multi-agent collaboration?",
    answer:
      "ONE of CrewAI / AutoGen / LangGraph supervisor / OpenAI Agents SDK. They all solve the same problem differently — pick by team mental model, not feature checklist.",
  },
  {
    question: "Is your codebase .NET or Java?",
    answer:
      "Semantic Kernel. The Python-first frameworks have JS/TS bindings of varying quality but no real .NET / Java story. Don't fight your platform.",
  },
  {
    question: "Do you need durable, long-running, resumable agents?",
    answer:
      "LangGraph (with Postgres checkpointer) or Temporal/Inngest underneath any framework. Most other frameworks assume the process stays alive for a single request — fine for chat, fatal for week-long workflows.",
  },
  {
    question: "Are you a non-engineer or a small team prototyping?",
    answer:
      "CrewAI, OpenAI Agents SDK, or a visual builder like AgentSwarms. Optimise for time-to-first-demo, not theoretical flexibility.",
  },
];
