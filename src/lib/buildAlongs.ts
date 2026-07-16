// Build-Along Labs — step-by-step guides for building real agents and swarms
// inside AgentSwarms. Static, version-controlled content (mirrors the pattern of
// presentations.ts / failureLabs.ts). Each guide carries a data-driven diagram
// (an AgentBlueprint for standalone agents, or a SwarmGraph for multi-agent
// swarms) that the BuildAlongSection renders.
//
// The instructions deliberately reference the REAL AgentSwarms UI:
//   - Agent builder tabs: General · Model · Knowledge · Memory · Guardrails · Tools
//   - Built-in tools: web_search, web_browse, kb_search, kb_graph_search,
//     sql_query, calculator, datetime, weather, mcp_call_tool
//   - Swarm canvas palette: Input 📨 · Agent 🤖 · Condition 🔀 · Loop 🔁 ·
//     Approval 🛡️ · A2A Remote 🌐 · Function ⚙️ · Evaluate 📊 · Output ✅

export type BuildStep = {
  title: string;
  body: string;
  detail?: string[]; // exact field values / sub-actions
  tip?: string; // pro-tip callout
  concept?: string; // "why this matters" teaching note
};

// A standalone-agent blueprint — drawn as an annotated agent card.
export type AgentBlueprint = {
  type: "agent";
  name: string;
  model: string;
  temperature: number;
  tools?: string[];
  knowledge?: string;
  memory?: string;
  guardrails?: string;
  systemPromptPreview: string;
};

export type GraphKind =
  | "input"
  | "agent"
  | "condition"
  | "loop"
  | "approval"
  | "evaluate"
  | "function"
  | "output";

// A swarm node positioned in a 160×90 unit grid (16:9). Keep x in [12,150],
// y in [12,80] so node chips stay inside the diagram frame.
export type GraphNode = { id: string; kind: GraphKind; label: string; x: number; y: number };
export type GraphEdge = { from: string; to: string; label?: string };
export type SwarmGraph = { type: "swarm"; nodes: GraphNode[]; edges: GraphEdge[] };

export type BuildAlong = {
  id: string;
  kind: "agent" | "swarm";
  title: string;
  tagline: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  duration: string;
  summary: string;
  useCase: string;
  youWillBuild: string;
  prerequisites?: string[];
  concepts: string[]; // skills/ideas this lab teaches
  diagram: AgentBlueprint | SwarmGraph;
  steps: BuildStep[];
  done: string; // closing line
};

// ─────────────────────────────────────────────────────────────────────────────
// 5 STANDALONE AGENTS
// ─────────────────────────────────────────────────────────────────────────────

const AGENTS: BuildAlong[] = [
  {
    id: "research-assistant",
    kind: "agent",
    title: "Web Research Assistant",
    tagline: "An agent that searches the web and answers with cited sources.",
    difficulty: "Beginner",
    duration: "~8 min",
    summary:
      "Your first agent. It takes a question, searches the live web, reads the best pages, and replies with a short synthesis plus a list of sources — never inventing facts.",
    useCase: "Market scans, fact-checking, 'what's the latest on…' questions.",
    youWillBuild:
      "A single agent with Web Search + Web Browser enabled and a system prompt that forces citations.",
    concepts: ["The agent builder", "System prompts", "Built-in tools", "Grounding with citations"],
    diagram: {
      type: "agent",
      name: "Research Assistant",
      model: "google/gemini-3-flash-preview",
      temperature: 0.3,
      tools: ["Web Search", "Web Browser"],
      guardrails: "Cite or stay silent",
      systemPromptPreview:
        "You are a meticulous research assistant. Search the web, read the most relevant sources, then answer with a 3–4 sentence synthesis followed by a bulleted list of sources (title + URL). Never state a fact you didn't find in a source.",
    },
    steps: [
      {
        title: "Open the agent builder",
        body: "In the sidebar go to Agents, then click New Agent. You'll land on the builder with tabs across the top: General, Model, Knowledge, Memory, Guardrails, Tools.",
        concept:
          "An 'agent' in AgentSwarms is an LLM + a system prompt + a set of tools it's allowed to call. That's the whole idea.",
      },
      {
        title: "Name it and write the system prompt (General tab)",
        body: "Give the agent a name, then paste a system prompt that defines its job and its rules.",
        detail: [
          "Name: Research Assistant",
          'System prompt: "You are a meticulous research assistant. Search the web, read the most relevant sources, then answer with a 3–4 sentence synthesis followed by a bulleted list of sources (title + URL). If you cannot verify a claim in a source, say so. Never invent facts or URLs."',
        ],
        tip: "Stuck on wording? Open the Prompt Library (Prompts tab) for ready-made prompts, or use the System Prompt Generator free tool.",
      },
      {
        title: "Pick the model and temperature (Model tab)",
        body: "Choose a fast, capable model and turn the creativity down — research wants accuracy, not flair.",
        detail: ["Model: google/gemini-3-flash-preview (fast + cheap)", "Temperature: 0.3"],
        concept:
          "Low temperature = more deterministic, focused answers. Great for factual tasks; raise it only for creative work.",
      },
      {
        title: "Enable the web tools (Tools tab)",
        body: "Toggle on Web Search and Web Browser. Web Search finds pages; Web Browser fetches a URL as clean markdown the agent can actually read.",
        detail: [
          "Enable: Web Search",
          "Enable: Web Browser",
          "Both work out-of-the-box via built-in Firecrawl — or add your own key (Brave / SerpAPI / Tavily / ScrapingBee).",
        ],
        concept:
          "Without tools, an LLM only knows its training data. Tools are how an agent reaches the live world.",
      },
      {
        title: "Save and test",
        body: "Save the agent, then open it in the Playground and ask a real, current question.",
        detail: [
          'Try: "What were the biggest open-source LLM releases this month?"',
          "Watch the trace: you should see Web Search → Web Browser calls before the answer.",
        ],
      },
      {
        title: "Iterate on the prompt",
        body: "Read the answer critically. If it rambles, tighten the prompt; if sources are weak, tell it to prefer primary sources. Edit, save, re-test — that's the whole loop.",
        tip: "Add 'Prefer official docs and primary sources over blogs' to instantly raise answer quality.",
      },
    ],
    done: "You've shipped a grounded research agent — and learned the core builder loop you'll reuse for every agent below.",
  },
  {
    id: "support-triage",
    kind: "agent",
    title: "Customer-Support Triage Agent",
    tagline: "Classifies incoming tickets into clean, machine-readable JSON.",
    difficulty: "Beginner",
    duration: "~10 min",
    summary:
      "An agent that reads a support message and returns strict JSON — category, urgency, and a one-line summary — so the rest of your system can route it automatically.",
    useCase: "Auto-tagging a support inbox, routing tickets, building dashboards.",
    youWillBuild:
      "An agent using a Prompt Library template, tuned for structured JSON output, with guardrails on.",
    concepts: [
      "Prompt Library",
      "Structured output",
      "Guardrails",
      "Low-temperature classification",
    ],
    diagram: {
      type: "agent",
      name: "Support Triage",
      model: "google/gemini-3-flash-preview",
      temperature: 0.1,
      tools: ["(none — pure classification)"],
      guardrails: "Block PII echo · profanity filter",
      systemPromptPreview:
        "You are a support triage assistant. Classify each ticket. Reply with ONLY JSON: {category, urgency, summary}. Never add prose before or after the JSON.",
    },
    steps: [
      {
        title: "Start from a Prompt Library template",
        body: "Open the Prompts tab and find the 'Tier-1 Customer Support' built-in prompt. Preview it, copy it, and use it as your starting point in a New Agent's General tab.",
        concept:
          "AgentSwarms ships 20+ production-grade system prompts. Starting from one beats a blank box every time.",
      },
      {
        title: "Rewrite the prompt for classification",
        body: "Adapt it so the agent only classifies and only returns JSON.",
        detail: [
          'System prompt: "You are a support triage assistant. For each ticket, reply with ONLY this JSON and nothing else: {\\"category\\": one of [\\"billing\\",\\"bug\\",\\"how-to\\",\\"refund\\",\\"other\\"], \\"urgency\\": one of [\\"low\\",\\"medium\\",\\"high\\"], \\"summary\\": a one-sentence summary}. Do not add commentary."',
        ],
        concept:
          "Structured output (strict JSON) is the single most important habit before wiring an agent into other software — prose is for humans, JSON is for code.",
      },
      {
        title: "Set a near-zero temperature (Model tab)",
        body: "Classification should be repeatable: the same ticket should always get the same label.",
        detail: ["Model: google/gemini-3-flash-preview", "Temperature: 0.1"],
      },
      {
        title: "Turn on guardrails (Guardrails tab)",
        body: "Enable input/output guardrails so the agent won't echo sensitive data or pass through abuse.",
        detail: [
          "Enable PII handling so SSNs/cards aren't reflected back",
          "Enable a profanity/abuse filter on inputs",
        ],
        concept:
          "Guardrails are deterministic checks that wrap the model — they catch what a prompt alone can't guarantee.",
      },
      {
        title: "Test with messy, real tickets",
        body: "Save, open the Playground, and paste a few realistic messages — including a vague one and an angry one.",
        detail: [
          'Try: "Order #A-91 arrived cracked, I want my money back not a replacement."',
          "Expect: clean JSON, category 'refund', urgency 'high'.",
        ],
        tip: "If it ever wraps the JSON in ```code fences```, add 'Output raw JSON with no markdown' to the prompt.",
      },
    ],
    done: "You now have a deterministic triage agent that emits machine-readable JSON — the building block for any automated workflow.",
  },
  {
    id: "sql-data-analyst",
    kind: "agent",
    title: "SQL Data Analyst Agent",
    tagline: "Answers questions about your data by writing read-only SQL.",
    difficulty: "Intermediate",
    duration: "~12 min",
    summary:
      "Upload a CSV, and this agent translates plain-English questions into safe SELECT queries, runs them, and explains the result in human terms.",
    useCase: "Self-serve analytics, 'what's our top region?' questions over a spreadsheet.",
    youWillBuild: "An agent with the SQL Query and Calculator tools over your own dataset.",
    prerequisites: ["A CSV uploaded under Data & SQL Agents (becomes a queryable table)"],
    concepts: ["Tool configuration", "SQL Query tool", "Read-only safety", "Tool + reasoning"],
    diagram: {
      type: "agent",
      name: "Data Analyst",
      model: "google/gemini-3-flash-preview",
      temperature: 0.2,
      tools: ["SQL Query", "Calculator"],
      guardrails: "SELECT-only · table allow-list",
      systemPromptPreview:
        "You are a data analyst. Translate the user's question into a single read-only SELECT against the available tables, run it, then explain the result in one short paragraph. Never write INSERT/UPDATE/DELETE.",
    },
    steps: [
      {
        title: "Upload a dataset first",
        body: "Go to Data & SQL Agents and upload a CSV. AgentSwarms turns it into a local, queryable table the SQL tool can read.",
        detail: ["Note the table name(s) it creates — you'll allow-list them in the tool config."],
        concept:
          "The SQL tool runs read-only SELECTs against your CSV-derived tables — your data never leaves your control.",
      },
      {
        title: "Create the agent and write its prompt (General tab)",
        body: "Name it Data Analyst and give it a prompt that fences it to read-only analysis.",
        detail: [
          'System prompt: "You are a careful data analyst. Translate the question into ONE read-only SELECT against the available tables, run it via the SQL tool, then explain the result in plain English (1 short paragraph). If a question needs a write or is ambiguous, ask for clarification. Never write INSERT, UPDATE, or DELETE."',
        ],
      },
      {
        title: "Enable SQL Query + Calculator (Tools tab)",
        body: "Toggle on SQL Query, then open its config and allow-list the exact tables this agent may read. Add Calculator for accurate arithmetic on results.",
        detail: [
          "Enable: SQL Query → set the table allow-list to your uploaded table(s)",
          "Enable: Calculator (so it doesn't do mental math on totals)",
        ],
        concept:
          "Least privilege: only grant the tables this agent truly needs. A tight allow-list shrinks the blast radius if the prompt is ever manipulated.",
      },
      {
        title: "Keep temperature low (Model tab)",
        body: "Analytical work wants precision.",
        detail: ["Temperature: 0.2"],
      },
      {
        title: "Test with real questions",
        body: "Save and ask questions in the Playground. Inspect the trace to see the generated SQL.",
        detail: [
          'Try: "Which region had the highest total sales last quarter?"',
          "Confirm the SQL is a single SELECT and the explanation matches the numbers.",
        ],
        tip: "Ask it to 'show the SQL you ran' during testing so you can sanity-check the query logic.",
      },
    ],
    done: "You've built a text-to-SQL analyst that's safe by construction — read-only, table-scoped, and explainable.",
  },
  {
    id: "kb-rag-agent",
    kind: "agent",
    title: "Knowledge-Base Q&A Agent (RAG)",
    tagline: "Answers strictly from your documents, with citations.",
    difficulty: "Intermediate",
    duration: "~12 min",
    summary:
      "Connect a knowledge base and this agent will retrieve the relevant chunks and answer only from them — saying 'not in the docs' instead of hallucinating.",
    useCase: "Internal docs Q&A, policy assistants, product-manual chatbots.",
    youWillBuild:
      "A RAG agent with a linked knowledge base, kb_search enabled, and grounding rules.",
    prerequisites: ["A knowledge base created under Knowledge with at least one document uploaded"],
    concepts: [
      "Retrieval-Augmented Generation",
      "Knowledge bases",
      "kb_search",
      "Grounding & refusal",
    ],
    diagram: {
      type: "agent",
      name: "Docs Q&A",
      model: "google/gemini-3-flash-preview",
      temperature: 0.1,
      tools: ["Knowledge Base Search (kb_search)"],
      knowledge: "Company Docs KB",
      guardrails: "Answer only from retrieved context",
      systemPromptPreview:
        "Answer ONLY from the retrieved context. Quote and cite the source chunk. If the answer isn't in the context, say 'I couldn't find that in the documents.' Never use outside knowledge.",
    },
    steps: [
      {
        title: "Build the knowledge base first",
        body: "Under Knowledge, create a KB and upload your documents. AgentSwarms chunks and embeds them into a vector store automatically.",
        detail: ["Wait for documents to finish embedding (status shows when ready)."],
        concept:
          "RAG = retrieve relevant chunks, then answer from them. The retrieval quality is capped by how well your docs were chunked and embedded.",
      },
      {
        title: "Create the agent and link the KB (Knowledge tab)",
        body: "In a New Agent, open the Knowledge tab and link the KB you just created. This auto-enables the kb_search tool.",
        detail: [
          "Link: your Company Docs KB",
          "kb_search switches on automatically once a KB is linked.",
        ],
        tip: "For multi-hop, relationship questions, also build a graph (Knowledge → Graph) and enable kb_graph_search.",
      },
      {
        title: "Write a strict grounding prompt (General tab)",
        body: "The prompt is what stops hallucination — make refusal the default when the docs don't cover something.",
        detail: [
          'System prompt: "Answer the user\'s question ONLY using the retrieved context from the knowledge base. Cite the source for each claim. If the context does not contain the answer, reply: \\"I couldn\'t find that in the documents.\\" Do not use any outside knowledge or guess."',
        ],
        concept:
          "A RAG agent's job is to be boring and correct: grounded, cited, and willing to say 'I don't know.'",
      },
      {
        title: "Set a low temperature (Model tab)",
        body: "Factual retrieval answers shouldn't be creative.",
        detail: ["Temperature: 0.1"],
      },
      {
        title: "Test grounded vs. out-of-scope questions",
        body: "Save and test in the Playground. Ask one question the docs answer, and one they don't.",
        detail: [
          "In-scope question → expect a cited answer.",
          "Out-of-scope question → expect 'I couldn't find that in the documents.'",
        ],
        tip: "If it answers out-of-scope questions from memory, your grounding prompt isn't strict enough — tighten it and re-test.",
      },
    ],
    done: "You've built a trustworthy docs assistant that cites its sources and refuses to make things up — the gold standard for internal knowledge.",
  },
  {
    id: "memory-productivity",
    kind: "agent",
    title: "Personal Assistant with Memory",
    tagline: "Remembers your preferences across conversations.",
    difficulty: "Advanced",
    duration: "~14 min",
    summary:
      "A personal assistant that uses long-term memory to recall your name, timezone, and preferences — plus date/time, weather, and calculator tools to actually be useful.",
    useCase: "A daily helper that remembers context so you don't repeat yourself.",
    youWillBuild: "An agent with long-term memory enabled and three utility tools wired up.",
    concepts: ["Long-term memory", "Memory config", "Utility tools", "Stateful agents"],
    diagram: {
      type: "agent",
      name: "Personal Assistant",
      model: "google/gemini-3-flash-preview",
      temperature: 0.5,
      tools: ["Date & Time", "Weather", "Calculator"],
      memory: "Long-term memory ON",
      systemPromptPreview:
        "You are a warm, concise personal assistant. Use stored memory to recall the user's preferences and avoid re-asking. Use your tools for time, weather, and math instead of guessing.",
    },
    steps: [
      {
        title: "Create the agent and set its persona (General tab)",
        body: "Name it and write a friendly, concise persona prompt that tells it to lean on memory.",
        detail: [
          'System prompt: "You are a warm, concise personal assistant. Greet the user by name if you know it. Use your memory to recall their timezone, preferences, and ongoing tasks so you never re-ask. Use tools for facts (time, weather, math) rather than guessing."',
        ],
      },
      {
        title: "Enable long-term memory (Memory tab)",
        body: "Turn on memory so the agent persists facts about the user between sessions, and tune what it stores.",
        detail: [
          "Enable long-term memory",
          "Let it store stable facts (name, timezone, preferences) — not every passing message",
        ],
        concept:
          "Memory turns a stateless chatbot into an assistant. Without it, every conversation starts from zero.",
      },
      {
        title: "Add utility tools (Tools tab)",
        body: "Enable the three no-key utility tools so the assistant gives real answers, not guesses.",
        detail: [
          "Enable: Date & Time (timezone-aware)",
          "Enable: Weather (Open-Meteo, no key)",
          "Enable: Calculator",
        ],
        concept:
          "LLMs are bad at 'what time is it?' and arithmetic. Tools make those answers correct and current.",
      },
      {
        title: "Choose a balanced temperature (Model tab)",
        body: "A personal assistant can be a little warmer than a classifier.",
        detail: ["Temperature: 0.5"],
      },
      {
        title: "Teach it something, then come back",
        body: "Save and chat. Tell it a preference, end the session, then start a fresh one and check it remembers.",
        detail: [
          'Session 1: "I\'m in IST and I prefer metric units and short answers."',
          'Session 2: "What\'s the weather and time?" → it should use your timezone and units without asking.',
        ],
        tip: "Inspect stored memory items on the Memory tab — you can review and clear what the agent has remembered.",
      },
    ],
    done: "You've built a stateful assistant that learns about its user — the foundation of any genuinely personal AI product.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 5 MULTI-AGENT SWARMS
// ─────────────────────────────────────────────────────────────────────────────

const SWARMS: BuildAlong[] = [
  {
    id: "research-write-edit",
    kind: "swarm",
    title: "Research → Write → Edit Pipeline",
    tagline: "Three specialists in a line turn a topic into a polished draft.",
    difficulty: "Beginner",
    duration: "~12 min",
    summary:
      "Your first swarm. A linear pipeline where a Researcher gathers facts, a Writer drafts from them, and an Editor polishes — each agent doing one job well.",
    useCase: "Blog posts, briefs, reports — any 'gather → draft → refine' content task.",
    youWillBuild:
      "A 5-node sequential swarm on the canvas: Input → Researcher → Writer → Editor → Output.",
    concepts: [
      "The swarm canvas",
      "Sequential pipelines",
      "Specialist agents",
      "Passing context downstream",
    ],
    diagram: {
      type: "swarm",
      nodes: [
        { id: "in", kind: "input", label: "Topic", x: 16, y: 45 },
        { id: "research", kind: "agent", label: "Researcher", x: 50, y: 45 },
        { id: "write", kind: "agent", label: "Writer", x: 84, y: 45 },
        { id: "edit", kind: "agent", label: "Editor", x: 118, y: 45 },
        { id: "out", kind: "output", label: "Final draft", x: 150, y: 45 },
      ],
      edges: [
        { from: "in", to: "research" },
        { from: "research", to: "write" },
        { from: "write", to: "edit" },
        { from: "edit", to: "out" },
      ],
    },
    steps: [
      {
        title: "Open the canvas",
        body: "Go to Swarms and create a new swarm. You'll see the node palette on the left (Input, Agent, Condition, Loop, Approval, A2A, Function, Evaluate, Output) and an infinite canvas.",
        concept:
          "A swarm is a graph: nodes do work, edges pass each node's output to the next. The canvas is where you wire that graph.",
      },
      {
        title: "Drop the Input node",
        body: "Drag an Input node (📨) onto the canvas. This is where the run's starting value — your topic — enters the graph.",
        detail: ["The Input node's value is what you type into the Run box later."],
      },
      {
        title: "Add three Agent nodes",
        body: "Drag three Agent nodes (🤖) onto the canvas, left to right. Click each to open the Node Inspector on the right and give it a focused system prompt.",
        detail: [
          'Researcher: "Research the topic. Output 5–8 crisp, factual bullet points with any sources you can find. No prose."',
          'Writer: "Using ONLY the research bullets you receive, write a clear 250-word article. Do not add facts that aren\'t in the bullets."',
          'Editor: "Polish the draft for clarity, flow, and grammar. Keep the meaning. Return only the final text."',
        ],
        concept:
          "Specialisation beats one mega-prompt: three small, sharp agents are easier to debug and improve than one doing everything.",
      },
      {
        title: "Add the Output node",
        body: "Drag an Output node (✅) to the far right. Whatever reaches it becomes the swarm's final result.",
      },
      {
        title: "Wire them in a line",
        body: "Drag from each node's right-side handle to the next node's left handle: Input → Researcher → Writer → Editor → Output.",
        detail: [
          "Each connection passes the upstream node's output as the downstream node's input.",
        ],
        tip: "If a node shows a warning that it has no input, you missed an edge — connect it and the warning clears.",
      },
      {
        title: "Run it",
        body: "Type a topic into the Run box and hit Run. Watch each node light up in turn and stream its output.",
        detail: [
          'Try the topic: "The benefits of retrieval-augmented generation"',
          "Open the trace to see what each agent passed downstream.",
        ],
        concept:
          "This is the most common swarm shape — a sequential pipeline. Master it and the branching patterns below are easy.",
      },
    ],
    done: "You've built and run your first multi-agent pipeline. Save it — the next swarms add branching, loops, and quality gates on top of this skeleton.",
  },
  {
    id: "support-router",
    kind: "swarm",
    title: "Smart Support Router",
    tagline: "A Condition node sends each message to the right specialist.",
    difficulty: "Intermediate",
    duration: "~12 min",
    summary:
      "A swarm that reads an incoming message and routes it: refund requests go to a Refunds agent, everything else to a General-help agent. Your first branching graph.",
    useCase: "Triaging an inbox to the correct handler; any 'if X then A else B' flow.",
    youWillBuild:
      "Input → Condition (refund?) → two specialist agents on labelled YES/NO branches → Output.",
    concepts: ["Condition node", "Labelled edges (YES/NO)", "Routing logic", "Branch convergence"],
    diagram: {
      type: "swarm",
      nodes: [
        { id: "in", kind: "input", label: "Message", x: 16, y: 45 },
        { id: "cond", kind: "condition", label: "Refund request?", x: 52, y: 45 },
        { id: "refund", kind: "agent", label: "Refunds agent", x: 100, y: 20 },
        { id: "general", kind: "agent", label: "General help", x: 100, y: 70 },
        { id: "out", kind: "output", label: "Reply", x: 148, y: 45 },
      ],
      edges: [
        { from: "in", to: "cond" },
        { from: "cond", to: "refund", label: "YES" },
        { from: "cond", to: "general", label: "NO" },
        { from: "refund", to: "out" },
        { from: "general", to: "out" },
      ],
    },
    steps: [
      {
        title: "Lay down Input and a Condition node",
        body: "Drag an Input node (📨), then a Condition node (🔀). The Condition node is a YES/NO router driven by a question you write.",
        concept:
          "A Condition node asks a yes/no question about its input and sends the run down one of two branches — this is how swarms make decisions.",
      },
      {
        title: "Write the routing question",
        body: "Click the Condition node and set its condition prompt to a crisp yes/no test.",
        detail: [
          'Condition prompt: "Is this message a request for a refund or money back?"',
          "Keep it binary and unambiguous — vague questions route unpredictably.",
        ],
      },
      {
        title: "Add the two specialist agents",
        body: "Drag two Agent nodes (🤖): one for refunds, one for everything else. Give each a tailored prompt.",
        detail: [
          'Refunds agent: "You handle refunds. Empathise, confirm the order, and explain the refund policy and next steps."',
          'General agent: "You are general support. Answer the question helpfully, or collect the details needed to help."',
        ],
      },
      {
        title: "Add Output and connect everything",
        body: "Drag an Output node (✅). Connect Input → Condition, then Condition → Refunds and Condition → General, and finally both agents → Output.",
        detail: ["Both branches converge on the same Output node so either path produces a reply."],
      },
      {
        title: "Label the branches YES / NO",
        body: "Click the edge from Condition to the Refunds agent and label it YES; label the edge to the General agent NO.",
        detail: ["YES edge → Refunds agent", "NO edge → General agent"],
        concept:
          "The runtime decides the branch from these labels. Unlabelled condition edges are a dead path — AgentSwarms will warn you if you forget.",
        tip: "Forgot a label? The canvas surfaces a node_warning for unlabelled condition edges — fix it and re-run.",
      },
      {
        title: "Test both paths",
        body: "Run a clear refund message, then a how-to question, and confirm each lands on the right agent.",
        detail: [
          'Refund path: "I want my money back for order #12."',
          'General path: "How do I reset my password?"',
          "The trace shows which branch fired.",
        ],
      },
    ],
    done: "You've built a branching swarm with real routing logic — the pattern behind every triage and dispatch system.",
  },
  {
    id: "reflection-loop",
    kind: "swarm",
    title: "Self-Improving Writer (Reflection Loop)",
    tagline: "An agent critiques and rewrites its own work until it's good.",
    difficulty: "Intermediate",
    duration: "~12 min",
    summary:
      "A swarm that drafts an answer, then loops — critiquing and refining it — until it meets the bar, signalled by a DONE token. Your first iterative pattern.",
    useCase: "Higher-quality copy, code, or analysis where the first draft is rarely the best.",
    youWillBuild: "Input → Draft agent → Loop (critique & refine until DONE) → Output.",
    concepts: ["Loop node", "The DONE stop-token", "Reflection pattern", "Bounded iteration"],
    diagram: {
      type: "swarm",
      nodes: [
        { id: "in", kind: "input", label: "Brief", x: 18, y: 45 },
        { id: "draft", kind: "agent", label: "Draft writer", x: 58, y: 45 },
        { id: "loop", kind: "loop", label: "Critique & refine ↻", x: 102, y: 45 },
        { id: "out", kind: "output", label: "Best version", x: 146, y: 45 },
      ],
      edges: [
        { from: "in", to: "draft" },
        { from: "draft", to: "loop" },
        { from: "loop", to: "out" },
      ],
    },
    steps: [
      {
        title: "Place Input and a Draft agent",
        body: "Drag an Input node (📨) and an Agent node (🤖). The agent writes the first attempt.",
        detail: [
          'Draft agent: "Write a first draft answering the brief. Be concise and concrete."',
        ],
      },
      {
        title: "Add the Loop node",
        body: "Drag a Loop node (🔁). A loop re-runs its own body, feeding each pass's output back in, until it sees a DONE signal or hits its iteration cap.",
        concept:
          "The reflection pattern: generate, then repeatedly self-critique and improve. It's how you trade a little extra cost for noticeably better output.",
      },
      {
        title: "Write the critique-and-refine prompt",
        body: "Click the Loop node and give it a prompt that critiques the current draft, rewrites it, and appends DONE only when it's satisfied.",
        detail: [
          'Loop prompt: "Critique the current draft in one line, then output an improved version. When the draft is genuinely strong and needs no further change, end your message with the token DONE."',
          "This is the contract: the loop stops the moment it emits DONE.",
        ],
        tip: "If your loop never stops, the body isn't emitting DONE — make the stop condition explicit in the prompt.",
      },
      {
        title: "Bound the loop",
        body: "Set Max iterations so a stubborn critic can't spin forever. Three is a sensible default.",
        detail: ["Max iterations: 3"],
        concept:
          "Every loop iteration is another full round of LLM calls — and cost. Always cap it; an unbounded loop is a runaway bill.",
      },
      {
        title: "Wire and run",
        body: "Connect Input → Draft → Loop → Output, then run with a brief and watch the drafts improve across iterations.",
        detail: [
          'Try: "Explain why vector databases matter, for a non-technical exec."',
          "In the trace you'll see each refinement pass until DONE.",
        ],
      },
    ],
    done: "You've built a self-improving agent that knows when to stop — the reflection pattern, bounded and safe.",
  },
  {
    id: "parallel-perspectives",
    kind: "swarm",
    title: "Parallel Multi-Perspective Analysis",
    tagline: "Three agents analyse in parallel; a fourth synthesises.",
    difficulty: "Advanced",
    duration: "~14 min",
    summary:
      "A fan-out / fan-in swarm: an Optimist, a Skeptic, and a Pragmatist each analyse the same input simultaneously, then an Aggregator merges their views into one balanced answer.",
    useCase:
      "Decision support, risk reviews, debate-style analysis where one viewpoint isn't enough.",
    youWillBuild: "Input → 3 parallel agents → Aggregator agent → Output.",
    concepts: [
      "Parallel execution (fan-out)",
      "Aggregation (fan-in)",
      "Multiple inputs to one node",
      "Diverse personas",
    ],
    diagram: {
      type: "swarm",
      nodes: [
        { id: "in", kind: "input", label: "Proposal", x: 16, y: 45 },
        { id: "opt", kind: "agent", label: "Optimist", x: 60, y: 16 },
        { id: "skep", kind: "agent", label: "Skeptic", x: 60, y: 45 },
        { id: "prag", kind: "agent", label: "Pragmatist", x: 60, y: 74 },
        { id: "agg", kind: "agent", label: "Aggregator", x: 108, y: 45 },
        { id: "out", kind: "output", label: "Balanced verdict", x: 148, y: 45 },
      ],
      edges: [
        { from: "in", to: "opt" },
        { from: "in", to: "skep" },
        { from: "in", to: "prag" },
        { from: "opt", to: "agg" },
        { from: "skep", to: "agg" },
        { from: "prag", to: "agg" },
        { from: "agg", to: "out" },
      ],
    },
    steps: [
      {
        title: "Add the Input and three Agent nodes",
        body: "Drag an Input node (📨) and three Agent nodes (🤖) stacked vertically. Each will get a distinct persona.",
        detail: [
          'Optimist: "Argue the strongest case FOR this proposal. List the upside and opportunities."',
          'Skeptic: "Argue the strongest case AGAINST. List risks, flaws, and failure modes."',
          'Pragmatist: "Ignore hype and doom. List what it would actually take to do this and the key tradeoffs."',
        ],
        concept:
          "Diverse personas surface blind spots a single agent would miss — you're simulating a small panel.",
      },
      {
        title: "Fan out from the Input",
        body: "Connect the Input node to all three agents. Because they share one upstream node and don't depend on each other, the runtime runs them in parallel.",
        detail: ["Input → Optimist, Input → Skeptic, Input → Pragmatist."],
        concept:
          "Fan-out = parallelism. Independent branches off the same node execute concurrently, so three analyses cost roughly the time of one.",
      },
      {
        title: "Add the Aggregator agent (fan-in)",
        body: "Drag a fourth Agent node and connect all three analysts into it. A node with multiple inputs receives all of them.",
        detail: [
          'Aggregator: "You receive three analyses (optimistic, skeptical, pragmatic). Synthesise them into one balanced verdict: a recommendation, the top 2 risks, and the top 2 opportunities."',
          "Connect: Optimist → Aggregator, Skeptic → Aggregator, Pragmatist → Aggregator.",
        ],
        concept:
          "Fan-in is where parallel work converges. The aggregator's prompt decides how the views are weighed and merged.",
      },
      {
        title: "Add Output and run",
        body: "Connect Aggregator → Output, then run a real proposal and watch all three analysts fire at once before the aggregator speaks.",
        detail: [
          'Try: "We should rewrite our entire backend in Rust next quarter."',
          "The trace shows the three branches running concurrently, then merging.",
        ],
        tip: "Give each persona a slightly higher temperature (e.g. 0.7) for genuinely different takes, and keep the aggregator low (0.3) for a steady synthesis.",
      },
    ],
    done: "You've built a parallel analysis swarm — faster than sequential and far more balanced than a single opinion.",
  },
  {
    id: "rag-eval-approval",
    kind: "swarm",
    title: "Production RAG with Eval + Human Approval",
    tagline: "Retrieve, answer, auto-grade, and gate on a human before it ships.",
    difficulty: "Advanced",
    duration: "~18 min",
    summary:
      "The capstone. A RAG agent answers from your docs, an Evaluate node grades the answer with an LLM-as-judge, a Condition gates on the score, and high-stakes answers pause for human Approval before reaching Output.",
    useCase: "Any answer that must be both grounded AND quality-checked before a customer sees it.",
    youWillBuild:
      "Input → RAG agent → Evaluate (judge) → Condition (passed?) → Approval / Refine → Output.",
    prerequisites: ["A knowledge base with documents (see the RAG agent lab)"],
    concepts: [
      "Evaluate node (LLM-as-judge)",
      "Quality gating",
      "Human-in-the-loop Approval",
      "Composing patterns",
    ],
    diagram: {
      type: "swarm",
      nodes: [
        { id: "in", kind: "input", label: "Question", x: 12, y: 45 },
        { id: "rag", kind: "agent", label: "RAG agent", x: 40, y: 45 },
        { id: "eval", kind: "evaluate", label: "Judge (score)", x: 70, y: 45 },
        { id: "cond", kind: "condition", label: "Passed ≥ 0.7?", x: 100, y: 45 },
        { id: "approve", kind: "approval", label: "Human approve", x: 128, y: 18 },
        { id: "refine", kind: "loop", label: "Refine ↻", x: 128, y: 72 },
        { id: "out", kind: "output", label: "Answer", x: 150, y: 45 },
      ],
      edges: [
        { from: "in", to: "rag" },
        { from: "rag", to: "eval" },
        { from: "eval", to: "cond" },
        { from: "cond", to: "approve", label: "YES" },
        { from: "cond", to: "refine", label: "NO" },
        { from: "approve", to: "out" },
        { from: "refine", to: "out" },
      ],
    },
    steps: [
      {
        title: "Start with a RAG agent node",
        body: "Drag an Input node (📨) and an Agent node (🤖). Configure the agent for grounded retrieval — link your knowledge base so kb_search is on, and use a strict 'answer only from context' prompt (exactly like the RAG agent lab).",
        detail: [
          'RAG agent prompt: "Answer ONLY from the retrieved knowledge-base context, with citations. If it isn\'t there, say so."',
        ],
        concept:
          "This swarm composes patterns you've already built. The RAG agent is the same one from the standalone lab — now it's one node in a bigger graph.",
      },
      {
        title: "Add an Evaluate node (LLM-as-judge)",
        body: "Drag an Evaluate node (📊) after the RAG agent. It scores the answer against weighted metrics using a strong judge model.",
        detail: [
          "Default metrics include Faithfulness, Answer Relevancy, Completeness, and Coherence — each weighted.",
          "Judge model defaults to a strong model (e.g. GPT-5-class) at low temperature.",
          "Set a pass threshold (e.g. 0.7).",
        ],
        concept:
          "Automated evaluation turns fuzzy 'is this good?' into a number you can gate on — no human needed for the routine cases.",
      },
      {
        title: "Gate on the score with a Condition node",
        body: "Drag a Condition node (🔀) after Evaluate and ask whether the answer cleared the bar.",
        detail: ['Condition prompt: "Did the answer pass the evaluation threshold (score ≥ 0.7)?"'],
      },
      {
        title: "Add the Approval and Refine branches",
        body: "On YES, route to an Approval node (🛡️) so a human signs off before shipping. On NO, route to a Loop node (🔁) that refines the answer.",
        detail: [
          "YES branch → Approval node: set a title like 'Approve customer answer' and a risk level.",
          'NO branch → Loop node: "Revise the answer to better match the context and address the judge\'s critique. Append DONE when improved." Max iterations: 2.',
        ],
        concept:
          "Human-in-the-loop Approval pauses the run for a person on the high-stakes path — the safety valve for anything customer-facing.",
      },
      {
        title: "Converge on Output and label the branches",
        body: "Connect both Approval and Refine to a single Output node (✅). Label the Condition's edges YES (to Approval) and NO (to Refine).",
        detail: [
          "Approval → Output, Refine → Output.",
          "Label edges: YES → Approval, NO → Refine.",
        ],
        tip: "Watch the eval weights warning — if your metric weights don't sum sensibly, AgentSwarms flags it.",
      },
      {
        title: "Run the full gauntlet",
        body: "Run an in-scope question and approve it when the run pauses; then run a tricky one and watch a low score route to the refine loop instead.",
        detail: [
          "Approve when the Approval node pauses the run.",
          "Open the trace to see retrieve → judge → gate → approve/refine end to end.",
        ],
      },
    ],
    done: "You've built a production-grade pipeline: grounded retrieval, automated evaluation, a quality gate, and human oversight — every core pattern in one swarm.",
  },
];

export const BUILD_ALONGS: BuildAlong[] = [...AGENTS, ...SWARMS];

export function getBuildAlong(id: string): BuildAlong | undefined {
  return BUILD_ALONGS.find((b) => b.id === id);
}
