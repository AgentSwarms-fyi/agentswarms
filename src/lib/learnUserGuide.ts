/**
 * The "Using AgentSwarms" curriculum module.
 * A practical, click-by-click walkthrough of every section of the app —
 * what it does, why it exists, and how it maps to the concepts in the rest
 * of the curriculum.
 */

export const userGuideIntro = {
  title: "Using AgentSwarms — the practical handbook",
  tagline:
    "Where every button is, what it does, and the workflow that turns a blank screen into a production-ready swarm.",
  body: "AgentSwarms is built around a simple promise: every concept in the curriculum (prompts, RAG, tools, guardrails, multi-agent swarms, evals) has a real, clickable surface in the app. This handbook walks through each section in the order you'll actually use them, with concrete steps and the underlying 'why' so you understand what the platform is doing on your behalf.",
};

/**
 * The end-to-end journey we recommend to new users.
 * Used to render the "Suggested journey" stepper at the top of the section.
 */
export const userJourney: { step: number; title: string; goal: string; route: string }[] = [
  {
    step: 1,
    title: "Sign in & set a budget",
    goal: "Cap how much your experiments can spend before you write a single prompt.",
    route: "/budgets",
  },
  {
    step: 2,
    title: "Pick or build an agent",
    goal: "Start from a template, or build one from scratch.",
    route: "/agents",
  },
  {
    step: 3,
    title: "Chat in the Playground",
    goal: "Test, iterate on the system prompt, switch models, watch the trace.",
    route: "/playground",
  },
  {
    step: 4,
    title: "Add knowledge (RAG)",
    goal: "Upload PDFs/URLs so the agent grounds answers in your documents.",
    route: "/knowledge",
  },
  {
    step: 5,
    title: "Save a prompt to your library",
    goal: "Capture the system prompt that's working so you can reuse it across agents.",
    route: "/prompts",
  },
  {
    step: 6,
    title: "Wire up tools & integrations",
    goal: "Let the agent DO things — call APIs, send emails, hit MCP servers.",
    route: "/integrations",
  },
  {
    step: 7,
    title: "Compose a swarm",
    goal: "Split a hard task across specialized agents with typed handoffs.",
    route: "/swarms",
  },
  {
    step: 8,
    title: "Inspect traces & spend",
    goal: "Debug regressions, attribute cost, and build your first eval.",
    route: "/traces",
  },
  {
    step: 9,
    title: "Share or export",
    goal: "Export portable JSON or share a read-only link to your agent.",
    route: "/agents",
  },
];

/**
 * Every top-level section of the app, in sidebar order.
 * Each entry is a mini-lesson: what the screen is, why it exists, the
 * step-by-step you should run the first time, and the expert-level tips
 * once you've done it twice.
 */
export type SectionGuide = {
  id: string;
  route: string;
  title: string;
  chip: string;
  summary: string;
  whyItExists: string;
  firstTimeSteps: string[];
  expertTips: string[];
  pitfalls: string[];
  conceptsUnlocked: string[];
};

export const sectionGuides: SectionGuide[] = [
  {
    id: "guide-dashboard",
    route: "/dashboard",
    title: "Dashboard",
    chip: "Your home base",
    summary:
      "The first screen after login. A live snapshot of agent activity, recent traces, spend-to-date, and the approvals waiting on a human.",
    whyItExists:
      "When you start running multiple agents and swarms, you need a single 'is anything on fire?' view. The dashboard surfaces the things that need your attention before they become incidents — failed runs, cost spikes, pending approvals.",
    firstTimeSteps: [
      "Glance at the spend tile to confirm budgets are configured (if it's blank, head to /budgets first).",
      "Check the Approval Inbox card — any agent action gated by a human shows up here.",
      "Click into a recent trace to see what your agents have been doing while you were away.",
    ],
    expertTips: [
      "Pin the dashboard as your browser homepage during a launch — it's your mission control.",
      "Use it as a daily standup artifact: 'here's what the agents did, here's what they couldn't do alone.'",
    ],
    pitfalls: [
      "Don't treat dashboard tiles as eval signals. They're operational, not evaluative — for quality you still need /traces.",
    ],
    conceptsUnlocked: ["Observability", "HITL approvals", "Cost attribution"],
  },
  {
    id: "guide-agents",
    route: "/agents",
    title: "Agent Builder",
    chip: "Build a single agent",
    summary:
      "The form-based builder for an individual agent: provider, model, system prompt, knowledge base, tools, guardrails, spend caps.",
    whyItExists:
      "Every concept in agentic AI bottoms out in 'what happens when ONE model gets ONE prompt?'. The Agent Builder is where you control every variable that shapes that answer — and the screen you'll spend the most time on.",
    firstTimeSteps: [
      "Click 'New Agent'. Give it a clear name (future-you will thank you).",
      "Pick a provider. If unsure, start with 'AgentSwarms AI' — it's pre-wired and free to try.",
      "Write a system prompt: who is this agent, what does it do, what does it NOT do.",
      "Set temperature: 0.2 for factual/coding tasks, 0.7 for creative ones.",
      "(Optional) Attach a knowledge base from the dropdown to ground answers in your docs.",
      "(Optional) Toggle tools the agent is allowed to call — start with read-only ones.",
      "Set a daily spend cap so a runaway loop can't drain your budget.",
      "Save, then click 'Chat' to test it in the Playground.",
    ],
    expertTips: [
      "Encode policy in the system prompt ('Never recommend a competitor', 'Always cite sources'). The prompt IS the contract.",
      "Use 'Guarded' badge as a signal: any agent touching real users should have at least PII redaction on.",
      "Start from a template instead of building from scratch — you'll learn the patterns faster.",
      "Keep the tool list small (≤15). Model tool-selection accuracy degrades fast above that.",
    ],
    pitfalls: [
      "Vague system prompts ('be helpful') produce vague agents. Be specific about scope, format, and refusal behavior.",
      "Cranking max_tokens to the limit just inflates cost. Set it to the smallest value that still completes the task.",
      "Don't enable write/destructive tools (refunds, deletes) without an approval gate.",
    ],
    conceptsUnlocked: [
      "System prompts",
      "Provider/model selection",
      "RAG attachment",
      "Tool wiring",
      "Guardrails",
    ],
  },
  {
    id: "guide-playground",
    route: "/playground",
    title: "Playground",
    chip: "Chat & iterate",
    summary:
      "A live chat interface wired to whichever agent you select. Streams tokens, shows tool calls inline, lets you switch models mid-conversation.",
    whyItExists:
      "Concepts only stick when you watch a real model react to a real prompt. The Playground is the feedback loop: write prompt → see response → tweak → repeat. It's where intuition is built.",
    firstTimeSteps: [
      "Pick an agent from the dropdown (or arrive here from /agents via 'Chat').",
      "Send the agent a hard, realistic question — not 'hi'.",
      "Open the trace panel to see the actual messages, tool calls, and token counts.",
      "Tweak the system prompt back in /agents and re-test. Compare outputs side-by-side mentally.",
    ],
    expertTips: [
      "Use the model switcher to A/B test the SAME prompt across providers. Cost and quality differ wildly.",
      "Drag in a file (PDF, image) to test multimodal flows without leaving the chat.",
      "Keep a 'golden prompts' doc — 5–10 prompts you re-run after every system-prompt change. That's the seed of an eval suite.",
    ],
    pitfalls: [
      "Don't trust a single good answer. Models are stochastic — re-run the same prompt 3x before declaring victory.",
      "Streaming hides cost surprises. Keep one eye on the token counter at the bottom.",
    ],
    conceptsUnlocked: [
      "Temperature effects",
      "Provider differences",
      "Tool-call traces",
      "Streaming",
    ],
  },
  {
    id: "guide-knowledge",
    route: "/knowledge",
    title: "Knowledge Bases",
    chip: "Your RAG corpus",
    summary:
      "Create knowledge bases, upload PDFs/docs/URLs, and attach them to any agent so answers are grounded in YOUR content with citations.",
    whyItExists:
      "LLMs hallucinate. RAG (Retrieval-Augmented Generation) is the proven fix: at query time, the platform finds the most relevant chunks of your documents and feeds them to the model alongside the question. The agent then answers with citations instead of guesses.",
    firstTimeSteps: [
      "Click 'New Knowledge Base'. Name it after the domain ('Product docs', 'HR handbook').",
      "Drop in a single PDF or paste a URL. Wait for ingestion to finish.",
      "Go to /agents, edit an agent, set its 'Knowledge base' to the one you just created.",
      "Open the Playground and ask a narrow question that's only answerable from that document.",
      "Inspect the trace — you should see the retrieved chunks the model used to answer.",
    ],
    expertTips: [
      "Smaller, focused KBs beat one giant 'everything' KB. Retrieval accuracy degrades with corpus size.",
      "Curate ruthlessly: an outdated chunk in your KB will produce confidently wrong answers.",
      "Keep one KB per audience (customers, employees, devs). Different audiences need different language and policies.",
    ],
    pitfalls: [
      "If the agent answers from its own training data instead of your KB, your system prompt isn't strict enough. Add: 'If the answer isn't in the provided context, say so.'",
      "Garbage chunking → garbage retrieval. If answers feel 'half right', inspect chunk size and overlap.",
    ],
    conceptsUnlocked: ["RAG", "Embeddings", "Chunking", "Citations"],
  },
  {
    id: "guide-prompts",
    route: "/prompts",
    title: "Prompt Library",
    chip: "Reusable system prompts",
    summary:
      "A personal, searchable library of system prompts — yours plus a curated catalogue of starter prompts (support, engineering, research, sales, data, writing, productivity, education, ops). Filter by category, search by keyword or tag, and one-click insert into the Agent Builder or Playground.",
    whyItExists:
      "The system prompt is the single highest-leverage piece of an agent. Once you find one that works, you do NOT want to retype or copy-paste it across agents — that's how prompt drift happens (the same agent slowly becomes three slightly different agents in three places). The Prompt Library treats prompts like first-class assets: versioned in the database, tagged, searchable, and reusable. Anthropic and OpenAI both ship public prompt libraries for the same reason — proven prompts beat freshly-improvised ones almost every time.",
    firstTimeSteps: [
      "Open /prompts. The 'Catalogue' tab shows curated starter prompts; the 'My Prompts' tab is your personal library (empty at first).",
      "Use the category dropdown ('Support', 'Engineering', 'Research', etc.) and the search box to find a prompt that's close to what you need.",
      "Click 'Save to my library' on a catalogue prompt to fork it — now it's editable.",
      "Open it from 'My Prompts', tweak the wording, add tags ('production', 'v2', 'tone-friendly'), and save.",
      "Go to /agents → New Agent. In the system-prompt field, click 'Insert from library' and pick the prompt you just saved.",
      "Run the agent in the Playground. If it works, you're done. If it doesn't, edit the prompt in /prompts (single source of truth) and re-test.",
    ],
    expertTips: [
      "Tag prompts by lifecycle stage: 'draft', 'staging', 'production'. Only point production agents at 'production' prompts.",
      "Prefix the title with a version number ('v3 · Refund triage') so older versions stay around for diffing and rollback.",
      "Use tags as cheap evals: 'no-pii', 'json-only', 'cite-sources' — then filter for prompts that match the policy you need.",
      "Treat the Prompt Library like git for prompts: edit deliberately, leave a short description of what changed, and never overwrite a prompt that's used by a production agent without a copy.",
      "The same prompt can be used inside swarm nodes, not just standalone agents — insert it into the Router or any Worker node from the same picker.",
    ],
    pitfalls: [
      "Don't paste secrets or real customer data into prompts. The library is encrypted at rest, but prompts get echoed in traces — keep them generic and inject runtime variables via the agent, not the prompt body.",
      "Resist the urge to maintain one mega-prompt that 'does everything'. Smaller, sharper prompts compose better and are easier to eval.",
      "If two agents need 90% the same prompt, save the shared part as a base prompt and append the agent-specific bit in the Agent Builder — not by duplicating the whole thing.",
      "Catalogue prompts are starting points, not finished work. Always read them end-to-end before pointing a production agent at one.",
    ],
    conceptsUnlocked: [
      "Prompt versioning",
      "Prompt-as-asset",
      "Reusability across agents & swarms",
      "Tag-driven discovery",
    ],
  },
  {
    id: "guide-skills",
    route: "/skills",
    title: "Skill Library & Builder",
    chip: "Reusable agent skills",
    summary:
      "A library of structured markdown skills (when-to-use + steps + constraints). Sample skills are built-in and read-only; your own skills are editable, AI-generatable, and attachable to any agent or swarm node. At runtime the platform prepends them to the system prompt so the agent actually follows them.",
    whyItExists:
      "A system prompt answers 'who is this agent?'. A skill answers 'what does it know how to DO?'. As soon as you have more than one situation an agent must handle (refunds AND escalations AND tone control), stuffing it all into one mega-prompt collapses — instructions conflict, tokens explode, debugging becomes impossible. Skills are the agent equivalent of small, named functions: composable, swappable, version-controlled in one place, reusable across many agents. Anthropic, OpenAI's GPTs, and most modern agent frameworks all converge on this pattern for the same reason.",
    firstTimeSteps: [
      "Open /skills. The 'Sample Skills' tab shows curated, read-only starters (SQL Reviewer, RAG Citations, Refusal Policy, …).",
      "Click any sample to read the full markdown — note the When-to-use / Instructions / Constraints structure. That structure is the skill.",
      "Switch to 'My Skills' and click 'New skill'. Either write the markdown by hand or click 'Generate with AI', describe the behaviour ('Review SQL queries for safety and performance'), and let the generator scaffold a structured skill.",
      "Save it. Now go to /agents → New (or edit) → 'Skills' picker → attach the sample(s) and your own skill.",
      "Test in /playground. Ask the agent something the skill applies to — it should now follow the steps verbatim.",
      "(Optional) On /swarms, select an Agent node → in the Inspector, attach the same skills. Skills work identically on swarm nodes.",
    ],
    expertTips: [
      "1–5 skills per agent is the sweet spot. Beyond that you pay for the tokens AND risk contradictions between skills.",
      "Keep skills behavioural ('how to review a PR'), not factual ('list of our products') — facts belong in a Knowledge Base.",
      "Don't restate the system prompt inside a skill. The system prompt is identity; the skill is situational know-how. Keep them disjoint.",
      "Use the AI generator as a draft tool, not final output. Read every line — a skill is a contract the agent will follow.",
      "Swap regional variants by detaching one skill and attaching another (e.g. 'EU Privacy Skill' vs 'US Privacy Skill') without touching the prompt.",
    ],
    pitfalls: [
      "Attaching too many skills makes every response slower and more expensive — and the agent starts cherry-picking which to obey.",
      "Skills are not magic safety — a malicious user can still try prompt injection. Pair behavioural skills with real guardrails (PII redaction, tool-call gating).",
      "Don't put secrets, API keys, or customer data in a skill. Skills are echoed in traces.",
      "Sample skills are read-only by design — fork them to /My Skills if you want to customise.",
    ],
    conceptsUnlocked: [
      "Skills vs system prompt",
      "Skill composition",
      "Reusable behaviours across agents & swarm nodes",
      "Structured markdown playbooks",
    ],
  },
  {
    id: "guide-swarms",
    route: "/swarms",
    title: "Swarm Canvas",
    chip: "Multi-agent orchestration",
    summary:
      "A drag-and-drop canvas where you compose multiple agents into a workflow — Router → Workers → Tools → Reviewer — with typed handoffs between them.",
    whyItExists:
      "Some tasks are too big or too varied for one agent. A swarm splits the work: a Router decides who handles what, specialized Workers do the work, a Reviewer checks quality. You get better outputs AND a debuggable pipeline.",
    firstTimeSteps: [
      "Click 'New Swarm' (or 'Use template' to start from one of the gallery patterns).",
      "Drag an Agent node onto the canvas. Configure it as a Researcher.",
      "Drag a second Agent node — make it a Writer.",
      "Connect them with an edge: Researcher → Writer.",
      "Hit 'Run', enter a prompt, watch each step stream in the Run panel.",
      "Open Traces afterward to see exactly what each agent received and produced.",
    ],
    expertTips: [
      "Start with 2 nodes. Most 'I need a swarm' problems are actually 'I need a better single agent with 2 tools.'",
      "Add a Reviewer node when output quality matters more than latency.",
      "Use the Patterns gallery (/patterns) to learn the canonical shapes: orchestrator, peer-to-peer, supervisor.",
      "Export your swarm as a portable JSON — you can re-import it anywhere or version-control it in git.",
    ],
    pitfalls: [
      "Don't build a 7-node swarm before you've tested the 2-node version. Complexity hides bugs.",
      "Latency stacks up linearly across nodes. A 3-second swarm of 5 agents = 15 seconds end-to-end.",
      "Cost stacks too. Every node is its own LLM call.",
    ],
    conceptsUnlocked: [
      "Multi-agent orchestration",
      "Handoffs",
      "Routers vs supervisors",
      "Pipeline traces",
    ],
  },
  {
    id: "guide-patterns",
    route: "/patterns",
    title: "Patterns",
    chip: "Reusable swarm shapes",
    summary:
      "A gallery of canonical agent-orchestration patterns — orchestrator-worker, sequential pipeline, parallel fan-out, supervisor — each with a guided tour.",
    whyItExists:
      "You don't need to invent multi-agent architectures from scratch. The literature (and our painful experience) has converged on a small set of patterns that work. Patterns is a teaching surface so you copy the right shape for your problem.",
    firstTimeSteps: [
      "Open /patterns and scroll the gallery.",
      "Click 'Take the tour' on the pattern that matches your problem (search? routing? quality control?).",
      "Use 'Fork to Swarm' to drop the pattern onto a new canvas you can edit.",
    ],
    expertTips: [
      "When in doubt, start with 'Orchestrator + Workers'. It's the most general-purpose and easiest to debug.",
      "Sequential pipelines are great for content generation; parallel fan-out shines for research/comparison.",
    ],
    pitfalls: [
      "Picking a pattern by aesthetics, not by problem shape. Read the 'Best for' column before forking.",
    ],
    conceptsUnlocked: [
      "Orchestrator pattern",
      "Pipeline pattern",
      "Fan-out/fan-in",
      "Supervisor pattern",
    ],
  },
  {
    id: "guide-templates",
    route: "/templates",
    title: "Templates",
    chip: "Production-grade starters",
    summary:
      "Pre-built, real-world agents and swarms (customer support, research analyst, code reviewer, etc.) you can provision into your account in one click.",
    whyItExists:
      "The fastest way to learn is to read working code. Templates are end-to-end examples — system prompts, tool wiring, KBs, the whole thing — that you can fork and modify rather than scaffold from zero.",
    firstTimeSteps: [
      "Browse the template grid; pick one whose use case is closest to yours.",
      "Click into the template detail page to read the architecture and the prompts.",
      "Hit 'Provision' to copy the agent (and any swarms/KBs it needs) into your account.",
      "Open it in /agents or /swarms and start customizing.",
    ],
    expertTips: [
      "Read the system prompts of templates you'll never use. The patterns transfer.",
      "Use the template tour in the Playground to see how the original author intended each agent to be queried.",
    ],
    pitfalls: [
      "Provisioning a template doesn't validate it against YOUR data. Always re-test with your real prompts.",
    ],
    conceptsUnlocked: ["Production patterns", "Fork-to-customize workflow"],
  },
  {
    id: "guide-integrations",
    route: "/integrations",
    title: "Integrations",
    chip: "Connect outside services",
    summary:
      "Wire up webhooks, n8n flows, Zapier, and other external services so your agents can DO things in the real world (send emails, update CRMs, post to Slack).",
    whyItExists:
      "An agent that can only chat is a toy. The moment it can call external APIs, it becomes useful. Integrations is the safe, audited surface for those connections — every call is logged, rate-limited, and (optionally) gated by an approval.",
    firstTimeSteps: [
      "Click 'New Integration' and pick a type (HTTP webhook, n8n, Slack, etc.).",
      "Paste the endpoint and any auth tokens. Test the connection.",
      "Go to /agents, edit an agent, and toggle the integration ON in its tools list.",
      "Test from the Playground — the trace will show the external call and its response.",
    ],
    expertTips: [
      "Start with READ-only integrations. Once they're stable, graduate to write/destructive ones gated by /approvals.",
      "Name integrations by purpose, not by vendor: 'Send shipping update email' beats 'Sendgrid #2'.",
    ],
    pitfalls: [
      "Hardcoding production URLs into a dev integration. Use separate integrations per environment.",
      "Not setting a timeout. A hung external call hangs the agent.",
    ],
    conceptsUnlocked: ["Function calling", "Webhooks", "Idempotency", "Approval gates"],
  },
  {
    id: "guide-mcp",
    route: "/mcp",
    title: "MCP Servers",
    chip: "Standardized tool servers",
    summary:
      "Connect to Model Context Protocol servers — the emerging open standard for exposing tools and data to any AI client. One MCP server → usable from AgentSwarms, Claude Desktop, Cursor, etc.",
    whyItExists:
      "MCP is becoming the USB-C of agent tools: instead of writing N×M integrations (every agent client × every data source), you write ONE MCP server and any compliant client can use it. AgentSwarms ships first-class MCP support so you're not locked into bespoke wiring.",
    firstTimeSteps: [
      "Click 'Add MCP Server'. Paste the server URL.",
      "Choose auth (none, bearer token, API key). Save.",
      "AgentSwarms pings the server and lists the tools it exposes.",
      "Toggle which tools are visible to which agents on /agents.",
    ],
    expertTips: [
      "Public MCP servers exist for Postgres, Slack, GitHub, and more — try one before writing your own.",
      "An internal MCP server in front of your data warehouse is a great pattern: agents see a stable tool surface, you keep auth and audit centralized.",
    ],
    pitfalls: [
      "Granting agents access to a write-capable MCP tool without an approval gate. MCP standardizes the protocol, not the safety.",
    ],
    conceptsUnlocked: [
      "Model Context Protocol",
      "Tool standardization",
      "Centralized auth for agent tools",
    ],
  },
  {
    id: "guide-traces",
    route: "/traces",
    title: "Traces & Observability",
    chip: "Observability",
    summary:
      "Every agent and swarm run logs a full trace: prompts, model thinking, tool calls (RAG, SQL, graph search, web), tokens, latency, and per-node cost. Drill into a run on /analytics/observability to see the swarm flow as a live graph with edges and per-node telemetry.",
    whyItExists:
      "If you can't trace it, you can't trust it. Traces are the difference between 'the agent is broken sometimes' and 'on Tuesday at 14:32 the Graph Search node called kb_graph_search with this exact query, returned 0 hits, and the synthesizer hallucinated.' Every production decision starts here, and for swarms a flat log is not enough — you need the graph view to see where a handoff went wrong.",
    firstTimeSteps: [
      "Run 5–10 chats in the Playground (single agent) and at least one swarm from /swarms.",
      "Open /traces for the flat, sortable list. Sort by latency, cost, or status to find the worst offender.",
      "Click any trace to see the full request, response, retrieved context, and tool calls inline.",
      "For swarm runs, click 'Open in Observability' (or go to /analytics/observability) to see the run as a flow canvas with nodes, edges, and per-node cost/tokens/latency.",
      "Click a node in the canvas — the side panel opens on the INPUT first (system prompt + user/handoff message), then OUTPUT, then THINKING, then tool calls.",
      "Diagnose the failing step: was it the prompt, the model, the retrieval (kb_search / kb_graph_search), the SQL tool, or a bad handoff? Fix it in /agents or /swarms and re-run.",
    ],
    expertTips: [
      "Per-node cost is computed server-side from the model's actual price table — trust the per-node USD figures, not estimates. The total at the top of the canvas is the sum of all node costs.",
      "The 'Thinking' tab on each node captures the model's reasoning content (when the provider exposes it) — invaluable for debugging silent failures where the answer is wrong but the tool calls look right.",
      "RAG hits, SQL queries, and graph subgraph results are all captured per-node — open the tool call to see exactly which chunks/rows/edges the model saw.",
      "Build your eval suite from real failed traces, not synthetic prompts. Bookmark filters you re-use ('failed swarm runs in last 24h', 'cost > $0.10', 'kb_graph_search returned empty').",
      "Export traces periodically — they're your audit trail for compliance.",
    ],
    pitfalls: [
      "Reading only the final response. The full picture is in the input, retrieved context, tool calls, and (for swarms) the upstream node that handed off bad data.",
      "Ignoring the latency column. Slow agents lose users even if they're correct.",
      "Treating an empty tool result as a bug in the tool. Often it's a bad query the upstream node generated — open the input panel of the node that called the tool first.",
    ],
    conceptsUnlocked: [
      "Observability",
      "Swarm flow visualization",
      "Per-node cost attribution",
      "Reasoning capture",
      "Eval-driven development",
      "Audit trails",
    ],
  },
  {
    id: "guide-analytics",
    route: "/analytics",
    title: "Analytics",
    chip: "Aggregate insights",
    summary:
      "Charts and tables that aggregate your traces over time: spend by provider, requests by agent, latency distributions, cost trends.",
    whyItExists:
      "Individual traces tell you about one run; analytics tells you about the system. It's where you spot drift ('Gemini calls doubled this week') and capacity questions ('we'll hit our budget in 11 days at this rate').",
    firstTimeSteps: [
      "Pick a time range (24h, 7d, 30d, or custom).",
      "Look at the spend-over-time chart — anomalies usually mean a runaway loop or a model swap.",
      "Check 'Cost by Provider' to see where money is going.",
      "Check 'Requests by Agent' to see which agent is doing the most work (or being abused).",
    ],
    expertTips: [
      "Compare week-over-week, not day-over-day. Daily noise hides real trends.",
      "Use 'Cost by Provider' to inform your model strategy: if 80% of spend is one provider, ask whether a cheaper one would do for half your traffic.",
    ],
    pitfalls: [
      "Optimizing on aggregates without sampling individual traces. The mean often hides bimodal behavior.",
    ],
    conceptsUnlocked: ["FinOps for AI", "Aggregate observability", "Drift detection"],
  },
  {
    id: "guide-budgets",
    route: "/budgets",
    title: "Budgets",
    chip: "Spend guardrails",
    summary:
      "Set monthly caps on total AI spend, per-agent daily limits, and alert thresholds (50/80/100%). Optionally auto-disable agents when limits trip.",
    whyItExists:
      "Agents can spend real money fast — a single buggy loop can burn $100 in minutes. Budgets are the seat-belt: you decide the maximum your curiosity (or a bug) is allowed to cost, and the platform enforces it.",
    firstTimeSteps: [
      "Set a monthly cap. If unsure, start with $10 — you can raise it later.",
      "Enable alerts at 50/80/100%.",
      "On /agents, set per-agent daily caps for any agent that runs unattended.",
      "Toggle 'Auto-disable on limit' for agents that touch production traffic.",
    ],
    expertTips: [
      "Use per-agent caps as a chargeback mechanism in teams: every team owns their agents and their budget.",
      "Anomaly alerts > static caps. A 5x spike in a normally-cheap agent is more useful than 'you hit your cap.'",
    ],
    pitfalls: [
      "Setting a cap so high it never triggers. The point is to be told BEFORE you hit it, not after.",
      "Forgetting to re-enable auto-disabled agents after fixing the bug.",
    ],
    conceptsUnlocked: ["Cost guardrails", "FinOps", "Soft vs hard limits"],
  },
  {
    id: "guide-account",
    route: "/account",
    title: "Account & Provider Keys",
    chip: "Credentials & profile",
    summary:
      "Manage your profile, swap your password, and (most importantly) add your own API keys for OpenAI, Anthropic, Gemini, Bedrock, Vertex, OCI, Azure, etc.",
    whyItExists:
      "AgentSwarms can run on the built-in 'AgentSwarms AI' gateway with zero setup, but the real power comes from connecting your own provider keys: you keep ownership of usage, you negotiate your own enterprise pricing, and you choose which models are available.",
    firstTimeSteps: [
      "Open the 'Provider Credentials' tab.",
      "Click 'Add Credential', pick a provider, paste your API key, save.",
      "Hit 'Test' — a green badge means the key works.",
      "On /agents, you can now select that provider when building agents.",
    ],
    expertTips: [
      "Add multiple credentials per provider (dev, staging, prod) and label them clearly.",
      "Rotate keys quarterly. Re-test after every rotation.",
      "For Bedrock/Vertex/OCI, the form asks for the regional config — wrong region = mysterious 'model not found' errors.",
    ],
    pitfalls: [
      "Pasting a key with a stray newline or a 'Bearer ' prefix copied from docs. The platform strips common prefixes but be careful.",
      "Forgetting that test responses also consume credits.",
    ],
    conceptsUnlocked: [
      "Bring-your-own-key (BYOK)",
      "Multi-provider strategy",
      "Credential lifecycle",
    ],
  },
];

/**
 * The cross-cutting workflows that span multiple sections.
 * These are the "how do I actually accomplish X?" recipes.
 */
export const workflows: { title: string; goal: string; steps: string[] }[] = [
  {
    title: "Build a customer-support agent grounded in your docs",
    goal: "Answer customer questions from your help center, with citations, no hallucinations.",
    steps: [
      "Knowledge → New KB → upload your help-center PDFs or paste URLs.",
      "Agents → New Agent → write a strict support system prompt ('Only answer from provided context. If unsure, say so and offer to escalate').",
      "Attach the KB. Set temperature to 0.2 for factual consistency.",
      "Playground → ask 10 real questions from your support inbox. Inspect each trace.",
      "Iterate the system prompt until the trace shows correct retrieval AND faithful answers.",
      "Budgets → set a $1/day cap. Traces → bookmark a 'failed runs' filter.",
    ],
  },
  {
    title: "Turn a one-shot agent into a multi-step research swarm",
    goal: "Take 'research X and write a brief' from one slow agent to a fast, parallel swarm.",
    steps: [
      "Verify the single-agent version actually works in the Playground first.",
      "Patterns → fork the 'Sequential Pipeline' template into a new swarm.",
      "Agent 1 = Researcher (web-search tool, returns JSON of sources).",
      "Agent 2 = Synthesizer (no tools, just writes the brief from Researcher's JSON).",
      "Agent 3 = Reviewer (checks tone, length, factual claims).",
      "Run end-to-end. Inspect traces — every step is debuggable in isolation.",
      "Export to portable JSON for version control.",
    ],
  },
  {
    title: "Add an approval gate before an agent does anything risky",
    goal: "Stop an agent from sending real emails / refunds / deletes without a human OK.",
    steps: [
      "Agents → edit the agent. In the tool config, mark write/destructive tools as 'Requires approval'.",
      "When the agent calls that tool, the call lands in /approvals (and the dashboard inbox).",
      "Approve or reject. The agent resumes (or gracefully fails) based on your decision.",
      "Audit: every approval decision is logged in the trace with who decided, when, and why.",
    ],
  },
  {
    title: "Ship the same swarm to a teammate (no lock-in)",
    goal: "Give a colleague a working copy of your swarm without copy-pasting prompts.",
    steps: [
      "Swarms → open your swarm → Export → download the .swarm.json file.",
      "Send it to your teammate (or commit it to git).",
      "They open Swarms → Import → drop the file. The full swarm — agents, prompts, edges — is reconstructed.",
      "Bonus: the same JSON can be re-implemented in LangGraph or CrewAI in an afternoon. Truly portable.",
    ],
  },
  {
    title: "Attach a Skill to an agent and verify it actually fires",
    goal: "Move situational know-how out of the system prompt and into a reusable, attachable skill.",
    steps: [
      "Skills → Sample Skills → open 'SQL Reviewer'. Read the structure: When-to-use / Instructions / Constraints.",
      "Skills → My Skills → New skill → 'Generate with AI'. Brief: 'Reviews customer-support replies for tone — friendly, never condescending, never makes promises about refunds.' Save.",
      "Agents → edit any chat agent → Skills picker → attach the SQL Reviewer sample AND your tone skill. Save.",
      "Playground → open that agent → ask: 'Review this query: SELECT * FROM users; -- why is it slow?'. The reply should follow the SQL Reviewer's exact output format.",
      "Now ask a support-style question. The reply should follow the tone rules you wrote.",
      "Detach the tone skill, ask again — observe the difference. That's how you know skills are doing real work, not theatre.",
      "Bonus: open /swarms, select an Agent node, attach the same skills in the Inspector — the same skill works identically inside a swarm.",
    ],
  },
];
