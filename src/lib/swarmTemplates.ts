// Real, runnable multi-agent swarm templates.
// Each template is a small graph that the in-browser orchestrator
// (src/lib/swarmRuntime.ts) can execute end-to-end against /api/chat.
//
// Node positions are pre-laid out so the canvas looks readable on first load.

import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { SwarmNodeData } from "./swarmRuntime";

export type SwarmTourStep = {
  nodeId: string; // which node this step explains
  title: string; // short label, e.g. "Step 2 — Classifier"
  what: string; // what this node does
  why: string; // why it exists in the pipeline
  watchFor: string; // what to look for when running
  // Optional: a real-world reference (paper, case study, blog post)
  // illustrating the same pattern in production at a real organization.
  realWorldRef?: {
    org: string; // e.g. "Klarna"
    label: string; // short descriptive line of how they use it
    url: string; // canonical link
  };
};

// A real-world case study attached to the whole template — shown as a
// banner at the top of the guided tour so learners can read up on
// production deployments of the same architecture.
export type SwarmCaseStudy = {
  org: string; // e.g. "Klarna"
  headline: string; // one-line summary of impact
  quote?: string; // optional pull quote / testimonial
  source: string; // human-readable source name (e.g. "Klarna 2024 Q1 report")
  url: string; // canonical link
};

export type SwarmTemplate = {
  id: string;
  title: string;
  tagline: string;
  description: string;
  category:
    | "Customer Support"
    | "Research"
    | "Engineering"
    | "Sales"
    | "Marketing"
    | "Financial Services"
    | "Healthcare"
    | "Legal"
    | "Debugging"
    | "Operations"
    | "HR & Talent"
    | "Insurance"
    | "Manufacturing"
    | "Cybersecurity"
    | "Education"
    | "Retail";
  exampleInput: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
  tour: SwarmTourStep[];
  // Optional real-world case studies — multiple orgs running similar swarms.
  caseStudies?: SwarmCaseStudy[];
};

const FLASH = "openai/gpt-4o-mini";
const PRO = "google/gemini-2.5-pro";

const baseEdge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
});

// Labeled edge — required for `condition` (label "yes"/"no") and `router`
// (label = a route name) branches so the runtime knows which edge to follow.
const labeledEdge = (id: string, source: string, target: string, label: string): Edge => ({
  id,
  source,
  target,
  label,
});

// The bundled, read-only sample knowledge base ("Sample · Notebook RAG Lab").
// Seeded is_sample=true, so every user can retrieve from it out of the box —
// which is what makes the RAG nodes in these templates runnable with no setup.
const SAMPLE_KB_ID = "c0ffee00-0000-4000-8000-000000000001";

// A rerank-capable model available through the built-in OpenRouter provider —
// used to re-order KB hits before they reach the answering agent.
const KB_RERANKER = { provider: "openrouter", model: "llama-nemotron-rerank-vl-1b-v2" } as const;

export const SWARM_TEMPLATES: SwarmTemplate[] = [
  // ── DURABILITY CHECK — the smallest graph that exercises suspend/resume ──
  // Deliberately tiny, and deliberately not as rich as the featured four: it
  // exists so that a failure points at exactly one thing. Every other template
  // mixes retrieval, judging and routing, so when one breaks you cannot tell
  // which part did it.
  //
  //   input → summarise → APPROVAL → approved? → output
  //
  // What it proves, in order:
  //   1. the run reaches the approval node and PARKS (status "suspended")
  //   2. its checkpoint survives, routing decisions included
  //   3. approving from the bell menu resumes it FROM THAT NODE
  //   4. the summarise agent does not run twice (the trace shows one entry)
  //   5. rejecting fails the run with the reason instead of continuing
  {
    id: "approval-durability-check",
    title: "Approval durability check",
    tagline: "input → agent → human approval → branch — the suspend/resume test",
    description:
      'A minimal swarm for verifying that runs survive being parked at a human approval. Run it from the API or a schedule with "Reject approvals" OFF and it stops at the approval step reporting status "suspended" rather than finishing. Approve it from the bell menu and it resumes from that step — the agent above it does not run a second time. Reject it and the run fails with your reason. Small on purpose: if something breaks, there is only one place it can be.',
    category: "Operations",
    exampleInput:
      "Refund request #4821: customer reports the item arrived damaged and wants a full refund of $240.",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 200 },
        data: { kind: "input", label: "Request", outputVar: "input", avatar: "📥" },
      },
      {
        id: "summarise",
        type: "agent",
        position: { x: 360, y: 200 },
        data: {
          kind: "agent",
          label: "Summarise for the approver",
          avatar: "🧾",
          systemPrompt:
            "Summarise the request in at most three short lines a human can approve or reject at a glance: what is being asked, the amount or impact, and the single biggest risk of saying yes. No preamble.",
          inputs: ["input"],
          outputVar: "summary",
          // A cheap model on purpose: this swarm tests the suspend/resume
          // mechanics, not the quality of the summary.
          provider: "openrouter",
          model: "openrouter/free",
        },
      },
      {
        id: "approval",
        type: "approval",
        position: { x: 720, y: 200 },
        data: {
          kind: "approval",
          label: "Human approval",
          avatar: "🛡️",
          approvalTitle: "Approve this request",
          approvalRisk: "medium",
          inputs: ["summary"],
          outputVar: "approved_summary",
        },
      },
      {
        id: "check",
        type: "condition",
        position: { x: 1060, y: 200 },
        data: {
          kind: "condition",
          label: "Approved?",
          avatar: "❓",
          // Only reached when a human approved — a rejection fails the run
          // outright. The branch exists so the graph has a routing decision to
          // checkpoint, which is what proves dead edges survive a resume.
          condition: "Did the approver let this proceed?",
          inputs: ["approved_summary"],
          outputVar: "decision",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1400, y: 200 },
        data: {
          kind: "output",
          label: "Result",
          avatar: "✅",
          inputs: ["approved_summary"],
          outputVar: "final",
        },
      },
    ],
    edges: [
      { id: "e1", source: "in", target: "summarise" },
      { id: "e2", source: "summarise", target: "approval" },
      { id: "e3", source: "approval", target: "check" },
      { id: "e4", source: "check", target: "out", label: "yes" },
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Input",
        what: "The request enters here and is captured into the `input` variable.",
        why: "Every swarm needs one entry point so downstream nodes have a known variable to read.",
        watchFor: "The status dot turning green.",
      },
      {
        nodeId: "summarise",
        title: "Step 2 — Summarise",
        what: "A cheap model reduces the request to three lines an approver can judge at a glance.",
        why: "The approver sees this text in the bell menu, so it has to stand alone — they will not have the original request in front of them.",
        watchFor:
          "Note the time this node takes. After you approve and the run resumes, it should NOT run again — that is the whole point of the checkpoint.",
      },
      {
        nodeId: "approval",
        title: "Step 3 — Human approval (the interesting one)",
        what: 'Run headlessly with "Reject approvals" off, the run stops here, writes a checkpoint and reports status "suspended". It is neither finished nor failed.',
        why: "Before checkpointing existed there was nothing to park: an unattended run could only auto-approve or fail. Now the run survives the process that started it and waits for a real decision.",
        watchFor:
          'A new item in the bell menu, and the run showing "suspended" in Recent runs rather than success or error.',
      },
      {
        nodeId: "check",
        title: "Step 4 — Approved?",
        what: "A branch that only runs once a human let the request through; rejection fails the run before this point.",
        why: "It exists so the graph contains a routing decision. Those decisions are checkpointed too — without them a resumed run would treat every branch as live and take paths the condition had ruled out.",
        watchFor: "The rejected branch greying out and staying grey after the resume.",
      },
      {
        nodeId: "out",
        title: "Step 5 — Result",
        what: "The approved summary is returned as the run's final output.",
        why: "Reaching this node at all is the proof: the run finished on the other side of a human decision and a process boundary.",
        watchFor:
          'The run flipping from "suspended" to "success" with one trace covering both halves — not two separate runs.',
      },
    ],
  },

  // ==================================================================
  // FEATURED — four comprehensive, fully-runnable sample swarms.
  // Together they exercise every canvas node type plus models, the
  // bundled sample knowledge base, sample datasets, built-in tools,
  // guardrails, skills, memory and reranking — so a new user can open
  // any one and learn which node to reach for, and when.
  //
  // Node-type coverage across the four:
  //   input · agent · router · condition · retrieve · evaluate ·
  //   approval · output   (Support Copilot)
  //   input · set_var · tool · agent · extract · output   (Revenue Ops)
  //   input · agent · foreach · merge · loop · output   (Research Desk)
  //   input · extract · agent · http · function · condition ·
  //   approval · output   (Incident Response)
  // ==================================================================

  // ── FEATURED 1 — Support Copilot: routed, KB-grounded, judged, approved ──
  {
    id: "support-copilot",
    title: "Support Copilot",
    tagline: "Router → KB retrieval → grounded answer → LLM judge → human approval",
    description:
      "A production-shaped support assistant. An intelligent router sends each request down the right path; product questions are answered strictly from the knowledge base (with reranking, citation checks and PII guardrails), an LLM judge scores the draft for faithfulness, and anything low-confidence or sensitive waits for human approval before it goes out.",
    category: "Customer Support",
    exampleInput:
      "How does retrieval-augmented generation reduce hallucinations, and when should I use it instead of fine-tuning?",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 320 },
        data: { kind: "input", label: "Customer request", outputVar: "input", avatar: "💬" },
      },
      {
        id: "router",
        type: "router",
        position: { x: 300, y: 320 },
        data: {
          kind: "router",
          label: "Intake router",
          avatar: "🚦",
          provider: "openrouter",
          model: FLASH,
          temperature: 0,
          routerPrompt:
            "Classify the customer's request and pick the single best route:\n" +
            "- 'product' — a how-to, concept, or technical question answerable from product documentation.\n" +
            "- 'account' — billing, login, or account-access issues.\n" +
            "- 'sensitive' — refunds, legal, security, or anything risky a human must own.",
          inputs: ["input"],
        },
      },
      {
        id: "retrieve",
        type: "retrieve",
        position: { x: 580, y: 140 },
        data: {
          kind: "retrieve",
          label: "KB retrieval",
          avatar: "📚",
          knowledgeBaseId: SAMPLE_KB_ID,
          retrieveQuery: "{{input}}",
          retrieveTopK: 5,
          inputs: ["input"],
          outputVar: "context",
        },
      },
      {
        id: "answerer",
        type: "agent",
        position: { x: 860, y: 140 },
        data: {
          kind: "agent",
          label: "Grounded answerer",
          avatar: "🤖",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "You are a product support engineer. Answer the customer's question using ONLY the retrieved context. " +
            "Name the documents you drew on. If the context does not cover it, say so plainly and suggest a next step — never invent details. " +
            "You may call kb_search or kb_graph_search to pull additional passages if the first retrieval is thin.",
          inputs: ["input", "context"],
          outputVar: "draft_answer",
          knowledgeBaseId: SAMPLE_KB_ID,
          enabledTools: ["kb_search", "kb_graph_search"],
          reranker: KB_RERANKER,
          skillIds: ["sample:support-tone"],
          memory: {
            stm_enabled: true,
            stm_window_messages: 6,
            ltm_enabled: true,
            ltm_scope: "swarm",
          },
          guardrails: {
            enableOutputFilters: true,
            blockPII: true,
            enableCitationCheck: true,
            enableHallucinationFilter: true,
            contentSafetyLevel: "medium",
          },
        },
      },
      {
        id: "judge",
        type: "evaluate",
        position: { x: 1140, y: 140 },
        data: {
          kind: "evaluate",
          label: "Answer judge",
          avatar: "⚖️",
          provider: "openrouter",
          model: FLASH,
          evalMetrics: [
            {
              id: "faithfulness",
              name: "Faithfulness",
              enabled: true,
              weight: 0.5,
              description:
                "Are all claims in the answer grounded in the retrieved context? Catches hallucinations.",
            },
            {
              id: "answer_relevancy",
              name: "Answer Relevancy",
              enabled: true,
              weight: 0.3,
              description: "Does the answer actually address the customer's question?",
            },
            {
              id: "completeness",
              name: "Completeness",
              enabled: true,
              weight: 0.2,
              description: "Does it cover every part of the question, not just the easy half?",
            },
          ],
          evalReferenceInput: "input",
          evalPassThreshold: 0.7,
          inputs: ["draft_answer"],
          outputVar: "eval",
        },
      },
      {
        id: "gate",
        type: "condition",
        position: { x: 1420, y: 140 },
        data: {
          kind: "condition",
          label: "Confident enough?",
          avatar: "❓",
          provider: "openrouter",
          model: FLASH,
          conditionPrompt:
            "Read the evaluation JSON. Did the answer clear the quality bar (pass = true, or overall_score >= 0.7)?",
          inputs: ["eval"],
        },
      },
      {
        id: "account",
        type: "agent",
        position: { x: 580, y: 380 },
        data: {
          kind: "agent",
          label: "Account assistant",
          avatar: "🔐",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "You handle account and billing questions. Walk the customer through the exact steps to resolve it. " +
            "Never ask for passwords or full card numbers. If you cannot fully resolve it, hand off to a human.",
          inputs: ["input"],
          outputVar: "account_reply",
          skillIds: ["sample:support-tone"],
          guardrails: { blockPII: true, enableOutputFilters: true, contentSafetyLevel: "medium" },
        },
      },
      {
        id: "approval",
        type: "approval",
        position: { x: 1140, y: 400 },
        data: {
          kind: "approval",
          label: "Human approval",
          avatar: "🛡️",
          approvalTitle: "Send reply to customer",
          approvalRisk: "medium",
          inputs: ["draft_answer", "account_reply"],
          outputVar: "approved_reply",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1700, y: 260 },
        data: {
          kind: "output",
          label: "Reply sent",
          avatar: "✅",
          inputs: ["approved_reply", "draft_answer"],
        },
      },
    ],
    edges: [
      baseEdge("e1", "in", "router"),
      labeledEdge("e2", "router", "retrieve", "product"),
      labeledEdge("e3", "router", "account", "account"),
      labeledEdge("e4", "router", "approval", "sensitive"),
      baseEdge("e5", "retrieve", "answerer"),
      baseEdge("e6", "answerer", "judge"),
      baseEdge("e7", "judge", "gate"),
      labeledEdge("e8", "gate", "out", "yes"),
      labeledEdge("e9", "gate", "approval", "no"),
      baseEdge("e10", "account", "approval"),
      baseEdge("e11", "approval", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Input",
        what: "The customer's message enters here and is captured into the `input` variable.",
        why: "Every swarm needs one entry point so downstream nodes have a known variable to read.",
        watchFor: "The status dot turning green as the message is captured.",
      },
      {
        nodeId: "router",
        title: "Step 2 — Router (N-way)",
        what: "A fast model reads the request and picks one of three labelled branches: product, account, or sensitive.",
        why: "A router replaces a wall of if/else nodes — it sends each request down the one path that fits, and the others are skipped.",
        watchFor: "Only the chosen branch lights up; the other two go grey (skipped).",
        realWorldRef: {
          org: "Klarna",
          label:
            "Klarna's assistant classifies then routes millions of chats — the same classify-then-route pattern.",
          url: "https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/",
        },
      },
      {
        nodeId: "retrieve",
        title: "Step 3 — Retrieve (no LLM)",
        what: "A standalone knowledge-base search pulls the top passages for the question from the bundled sample KB.",
        why: "Retrieving before generating is the core of RAG — the model answers from grounded source text, not memory.",
        watchFor: "Retrieved snippets appear as the node's output, stored in `context`.",
      },
      {
        nodeId: "answerer",
        title: "Step 4 — Grounded answerer",
        what: "A stronger model drafts the reply from the retrieved context, with reranking, a support-tone skill, memory, and PII / citation / hallucination guardrails.",
        why: "This one node shows how models, tools, a reranker, skills, memory and guardrails stack on a single agent.",
        watchFor: "A cited answer that stays within the retrieved material.",
        realWorldRef: {
          org: "Anthropic — Contextual Retrieval",
          label: "Reranking retrieved chunks before generation measurably cuts retrieval failures.",
          url: "https://www.anthropic.com/news/contextual-retrieval",
        },
      },
      {
        nodeId: "judge",
        title: "Step 5 — LLM judge",
        what: "An evaluate node scores the draft on faithfulness, relevancy and completeness and returns a pass/fail scorecard.",
        why: "LLM-as-a-judge is how you put an automatic quality gate in front of a human, so people only review the borderline cases.",
        watchFor: "A JSON scorecard with per-metric scores and an overall pass boolean.",
      },
      {
        nodeId: "gate",
        title: "Step 6 — Condition (yes/no)",
        what: "A binary branch: if the judge passed, go straight to output; if not, divert to human approval.",
        why: "Conditions turn a score into control flow — confident answers ship automatically, weak ones get a human.",
        watchFor: "Exactly one outgoing edge (yes or no) stays live.",
      },
      {
        nodeId: "approval",
        title: "Step 7 — Human approval",
        what: "Execution pauses. The approver sees the proposed reply and approves or rejects it.",
        why: "Human-in-the-loop is the safety valve for anything with real-world consequences.",
        watchFor: "The node turns amber and waits — open the Approvals inbox to act.",
        realWorldRef: {
          org: "Intercom Fin",
          label:
            "Fin escalates a meaningful share of issues to humans — the same HITL pattern in production.",
          url: "https://www.intercom.com/blog/announcing-fin/",
        },
      },
      {
        nodeId: "out",
        title: "Step 8 — Output",
        what: "The approved (or auto-passed) reply is the final result of the run.",
        why: "A terminal output node is what your app or webhook reads when the swarm finishes.",
        watchFor: "Final output in the run panel on the right.",
      },
    ],
    caseStudies: [
      {
        org: "Klarna",
        headline:
          "AI assistant doing the work of 700 full-time agents in month one — 2.3M conversations, ~25% fewer repeat inquiries.",
        source: "Klarna press release, Feb 2024",
        url: "https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/",
      },
    ],
  },

  // ── FEATURED 2 — Revenue Ops Analyst: typed form → SQL → verified → brief ──
  {
    id: "revops-analyst",
    title: "Revenue Ops Analyst",
    tagline: "Typed form → SQL over your data → verified math → KPIs → exec brief",
    description:
      "Ask a plain-English question about the business and get a defensible answer. A typed intake form drives a SQL analyst over the sample sales dataset, a second agent independently re-checks the arithmetic with a calculator, the key numbers are pulled into a structured object, and an exec brief is written — stamped with the report date from a deterministic tool node.",
    category: "Sales",
    exampleInput: "Which regions grew fastest, and what was total revenue by segment?",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 240 },
        data: {
          kind: "input",
          label: "Analysis request",
          avatar: "📊",
          outputVar: "input",
          inputFields: [
            {
              name: "question",
              label: "Business question",
              type: "textarea",
              required: true,
              placeholder: "Which regions grew fastest last quarter, and by how much?",
            },
            {
              name: "segment",
              label: "Segment focus",
              type: "select",
              options: ["All", "Enterprise", "Mid-Market", "SMB"],
            },
          ],
        },
      },
      {
        id: "setup",
        type: "set_var",
        position: { x: 320, y: 240 },
        data: {
          kind: "set_var",
          label: "Set report context",
          avatar: "🧷",
          stateAssignments: [
            { key: "report_title", value: "Revenue analysis — {{segment}} segment" },
            { key: "currency", value: "USD" },
          ],
          inputs: ["input"],
          outputVar: "setup",
        },
      },
      {
        id: "clock",
        type: "tool",
        position: { x: 600, y: 240 },
        data: {
          kind: "tool",
          label: "Report timestamp",
          avatar: "🕒",
          toolId: "datetime",
          toolArgs: {},
          outputVar: "now",
        },
      },
      {
        id: "sql",
        type: "agent",
        position: { x: 880, y: 240 },
        data: {
          kind: "agent",
          label: "SQL analyst",
          avatar: "🗄️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.1,
          systemPrompt:
            "You are a data analyst. Use the sql_query tool to answer the question against the `saas_sales` table. " +
            "Inspect the schema first, then write correct SQL and report the exact figures you found. " +
            "Focus on the requested segment when one is given. Show the SQL you ran.",
          inputs: ["question", "segment"],
          outputVar: "findings",
          enabledTools: ["sql_query"],
          toolConfigs: { sql_table_names: ["saas_sales"] },
          skillIds: ["sample:sql-analyst"],
        },
      },
      {
        id: "verify",
        type: "agent",
        position: { x: 1160, y: 240 },
        data: {
          kind: "agent",
          label: "Math check",
          avatar: "🧮",
          provider: "openrouter",
          model: FLASH,
          temperature: 0,
          systemPrompt:
            "You verify the arithmetic in the analyst's findings. Use the calculator tool to independently recompute any " +
            "growth rates, sums, and percentages. Flag anything that does not check out; otherwise confirm the numbers stand.",
          inputs: ["findings"],
          outputVar: "verified",
          enabledTools: ["calculator"],
        },
      },
      {
        id: "kpis",
        type: "extract",
        position: { x: 880, y: 440 },
        data: {
          kind: "extract",
          label: "Extract KPIs",
          avatar: "🔢",
          provider: "openrouter",
          model: FLASH,
          extractSchema: [
            {
              name: "headline_metric",
              type: "string",
              description: "The single most important finding, in one short phrase",
            },
            { name: "value", type: "number", description: "The headline metric's numeric value" },
            {
              name: "growth_pct",
              type: "number",
              description: "Period-over-period growth percentage if present, else null",
            },
            {
              name: "top_segment",
              type: "string",
              description: "The best-performing region or segment",
            },
          ],
          inputs: ["verified"],
          outputVar: "kpis",
        },
      },
      {
        id: "brief",
        type: "agent",
        position: { x: 1160, y: 440 },
        data: {
          kind: "agent",
          label: "Exec brief writer",
          avatar: "📝",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "Write a crisp 4-sentence executive brief titled '{{report_title}}', as of {{now}}. " +
            "Use the verified findings and the extracted KPIs. Lead with the headline number in {{currency}}. No filler.",
          inputs: ["verified", "kpis", "report_title", "now"],
          outputVar: "exec_brief",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1440, y: 440 },
        data: { kind: "output", label: "Executive brief", avatar: "✅", inputs: ["exec_brief"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "setup"),
      baseEdge("e2", "setup", "clock"),
      baseEdge("e3", "clock", "sql"),
      baseEdge("e4", "sql", "verify"),
      baseEdge("e5", "verify", "kpis"),
      baseEdge("e6", "kpis", "brief"),
      baseEdge("e7", "brief", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Input form",
        what: "A typed intake form: a free-text question plus a segment picker. Each field is seeded into flow state under its own name.",
        why: "Structured inputs beat a single text box when a swarm needs specific parameters — the Run panel renders a field per entry.",
        watchFor: "Two fields in the Run panel; their values land in `question` and `segment`.",
      },
      {
        nodeId: "setup",
        title: "Step 2 — Set Variable",
        what: "Deterministically writes `report_title` and `currency` into flow state using {{segment}} templating — no LLM call.",
        why: "Set-Variable nodes hold constants and derived values so later prompts stay clean and consistent.",
        watchFor: "The composed report title echoing your chosen segment.",
      },
      {
        nodeId: "clock",
        title: "Step 3 — Tool node (datetime)",
        what: "Calls the built-in datetime tool directly, with no model in the loop, and stores the timestamp in `now`.",
        why: "A Tool node is the cheapest, most reliable way to run one deterministic tool — no tokens, no variance.",
        watchFor: "An ISO timestamp captured into `now`.",
      },
      {
        nodeId: "sql",
        title: "Step 4 — SQL analyst",
        what: "An agent with the sql_query tool (scoped to `saas_sales`) and a SQL-analyst skill introspects the schema and queries the data.",
        why: "This is text-to-SQL: the model reasons, but the actual numbers come from your real data, not a guess.",
        watchFor: "The SQL it ran and the concrete figures it returned.",
        realWorldRef: {
          org: "Pinterest",
          label:
            "Pinterest's internal Text-to-SQL assistant lets analysts query the warehouse in plain English.",
          url: "https://medium.com/pinterest-engineering/how-we-built-text-to-sql-at-pinterest-30bad30dabff",
        },
      },
      {
        nodeId: "verify",
        title: "Step 5 — Math check (calculator)",
        what: "A second agent independently recomputes the arithmetic with the calculator tool.",
        why: "Cross-checking a model's math with a deterministic tool is a simple, powerful guard against confident-but-wrong numbers.",
        watchFor: "Confirmation, or a flag on any figure that does not reconcile.",
      },
      {
        nodeId: "kpis",
        title: "Step 6 — Extract (structured output)",
        what: "Pulls the headline metric, value, growth %, and top segment into a strict JSON object.",
        why: "Extract turns prose into typed fields your dashboard, API, or next node can consume reliably.",
        watchFor: "A clean JSON object with exactly the declared fields.",
      },
      {
        nodeId: "brief",
        title: "Step 7 — Exec brief writer",
        what: "Writes the final brief from the verified findings and KPIs, titled and dated from earlier flow state.",
        why: "Separating analysis from writing keeps each prompt focused and the output consistent.",
        watchFor: "A 4-sentence brief that leads with the headline number.",
      },
      {
        nodeId: "out",
        title: "Step 8 — Output",
        what: "The executive brief is the final result.",
        why: "The terminal node your report scheduler or app reads.",
        watchFor: "Final brief in the run panel.",
      },
    ],
    caseStudies: [
      {
        org: "Uber (QueryGPT)",
        headline:
          "Uber built an internal text-to-SQL assistant estimated to save ~140,000 hours a year of query-writing.",
        source: "Uber Engineering blog",
        url: "https://www.uber.com/blog/query-gpt/",
      },
    ],
  },

  // ── FEATURED 3 — Research Desk: plan → map (web) → reduce → self-editing loop ──
  {
    id: "research-desk",
    title: "Market Research Desk",
    tagline: "Plan → for-each web research → merge → synthesize → self-editing loop",
    description:
      "A map-reduce research pipeline. A planner splits the topic into sub-questions; a for-each node fans out and researches each one on the live web (search + browse); the findings are merged, synthesized into a themed brief, and then polished by a self-editing loop that keeps iterating until the draft needs no further change.",
    category: "Research",
    exampleInput:
      "The state of open-weight vs proprietary LLMs in 2026: cost, capability, and where each wins.",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 260 },
        data: { kind: "input", label: "Research topic", outputVar: "input", avatar: "🔎" },
      },
      {
        id: "planner",
        type: "agent",
        position: { x: 320, y: 260 },
        data: {
          kind: "agent",
          label: "Planner",
          avatar: "🗺️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "Break the research topic into exactly 3 focused sub-questions a researcher can investigate independently. " +
            "Reply with the 3 sub-questions, one per line, with no numbering, bullets, or extra text.",
          inputs: ["input"],
          outputVar: "plan",
        },
      },
      {
        id: "research",
        type: "foreach",
        position: { x: 600, y: 260 },
        data: {
          kind: "foreach",
          label: "Research each (web)",
          avatar: "🌐",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.3,
          foreachInput: "plan",
          foreachItemVar: "subq",
          maxIters: 3,
          systemPrompt:
            "Research this sub-question: {{subq}}\n" +
            "Use web_search to find current sources and web_browse to read the most relevant one in full. " +
            "Answer in 2-3 grounded sentences and cite the source URL inline.",
          enabledTools: ["web_search", "web_browse"],
          inputs: ["plan"],
          outputVar: "findings_arr",
        },
      },
      {
        id: "merge",
        type: "merge",
        position: { x: 880, y: 260 },
        data: {
          kind: "merge",
          label: "Combine findings",
          avatar: "🧵",
          mergeMode: "concat",
          mergeSeparator: "\n\n---\n\n",
          inputs: ["findings_arr"],
          outputVar: "merged",
        },
      },
      {
        id: "synth",
        type: "agent",
        position: { x: 1160, y: 260 },
        data: {
          kind: "agent",
          label: "Synthesizer",
          avatar: "🧩",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "Merge the researched findings into one coherent brief organized by theme. Remove redundancy, " +
            "keep it under 300 words, and preserve the inline citations.",
          inputs: ["merged"],
          outputVar: "draft",
          skillIds: ["sample:research-synthesizer"],
        },
      },
      {
        id: "editor",
        type: "loop",
        position: { x: 1440, y: 260 },
        data: {
          kind: "loop",
          label: "Self-editing polish",
          avatar: "✒️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          maxIters: 3,
          systemPrompt:
            "You are a demanding editor. Improve the brief for clarity, flow, and concision while keeping every fact " +
            "and citation intact. When the brief is already excellent and needs no further change, output the final " +
            "version and then, on its own line, the single word DONE.",
          inputs: ["draft"],
          outputVar: "final_brief",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1720, y: 260 },
        data: { kind: "output", label: "Research brief", avatar: "✅", inputs: ["final_brief"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "planner"),
      baseEdge("e2", "planner", "research"),
      baseEdge("e3", "research", "merge"),
      baseEdge("e4", "merge", "synth"),
      baseEdge("e5", "synth", "editor"),
      baseEdge("e6", "editor", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Input",
        what: "The research topic enters here.",
        why: "One entry point feeds the whole pipeline.",
        watchFor: "The topic captured into `input`.",
      },
      {
        nodeId: "planner",
        title: "Step 2 — Planner (map step)",
        what: "Splits the topic into three independent sub-questions, one per line.",
        why: "Decomposition is the 'map' half of map-reduce — smaller questions get better, more focused answers.",
        watchFor: "Three clean sub-questions with no numbering.",
      },
      {
        nodeId: "research",
        title: "Step 3 — For-Each (fan-out)",
        what: "Runs its agent body once per sub-question, each time researching on the live web with search + browse.",
        why: "For-Each is how you apply the same reasoning to every item of a list — parallel-style fan-out over the plan.",
        watchFor: "The iteration counter advancing 1→2→3; results collected into an array.",
        realWorldRef: {
          org: "Stanford STORM",
          label:
            "STORM researches a topic by asking and answering many sub-questions, then synthesizing — the same shape.",
          url: "https://storm.genie.stanford.edu/",
        },
      },
      {
        nodeId: "merge",
        title: "Step 4 — Merge (reduce step)",
        what: "Concatenates the array of findings into a single block, separated by rules.",
        why: "Merge is the 'reduce' half — it collapses many outputs into one value for the next node.",
        watchFor: "All three findings joined into one text.",
      },
      {
        nodeId: "synth",
        title: "Step 5 — Synthesizer",
        what: "Rewrites the merged findings into one themed brief, using a research-synthesis skill.",
        why: "A dedicated synthesis step turns raw notes into a narrative, keeping citations.",
        watchFor: "A tight, themed draft under 300 words.",
      },
      {
        nodeId: "editor",
        title: "Step 6 — Loop (self-refine)",
        what: "An editor re-drafts the brief up to 3 times, stopping early the moment it emits DONE.",
        why: "A loop lets a model iteratively improve its own output until a quality bar is met — reflection in a single node.",
        watchFor: "Iteration badges, and an early stop when the editor signals DONE.",
      },
      {
        nodeId: "out",
        title: "Step 7 — Output",
        what: "The polished brief is the final result.",
        why: "What your app or export reads when the run finishes.",
        watchFor: "Final brief in the run panel.",
      },
    ],
    caseStudies: [
      {
        org: "GPT Researcher",
        headline:
          "A popular open-source agent that plans sub-questions, researches each on the web, and synthesizes a cited report — the same plan/map/reduce loop.",
        source: "GPT Researcher (open source)",
        url: "https://github.com/assafelovic/gpt-researcher",
      },
    ],
  },

  // ── FEATURED 4 — Incident Response: parse → SQL + HTTP → scored → routed → approved ──
  {
    id: "secops-triage",
    title: "Incident Response Triage",
    tagline: "Extract → validate → SQL + HTTP enrich → risk score → route → approve",
    description:
      "A SecOps triage swarm. An LLM extracts the fields from a raw SIEM alert, a deterministic function validates them into clean JSON, the source IP's history is looked up in the sample alerts dataset and enriched with a live HTTP geolocation lookup, a sandboxed function computes a risk score, and the swarm routes on the result — high-risk containment waits for human approval, everything else is auto-documented with PII redaction.",
    category: "Cybersecurity",
    exampleInput:
      '{"rule":"Multiple failed SSH logins then success","src_ip":"185.220.101.4","severity":"high","host":"prod-api-02"}',
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 300 },
        data: { kind: "input", label: "SIEM alert", outputVar: "input", avatar: "🚨" },
      },
      {
        id: "parse",
        type: "extract",
        position: { x: 320, y: 300 },
        data: {
          kind: "extract",
          label: "Parse alert",
          avatar: "🧾",
          provider: "openrouter",
          model: FLASH,
          extractSchema: [
            { name: "src_ip", type: "string", description: "The source IP address in the alert" },
            {
              name: "signature",
              type: "string",
              description: "The rule name or attack signature",
            },
            {
              name: "severity_hint",
              type: "string",
              description: "low, medium, high, or critical if stated",
            },
          ],
          temperature: 0,
          inputs: ["input"],
          outputVar: "raw_alert",
        },
      },
      {
        id: "normalize",
        type: "function",
        position: { x: 600, y: 300 },
        data: {
          kind: "function",
          label: "Validate fields",
          avatar: "🧷",
          functionCode: [
            "const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };",
            'const findIp = (s) => { const m = String(s).match(/\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b/); return m ? m[0] : ""; };',
            'const findSev = (s) => { const m = String(s).toLowerCase().match(/\\b(critical|high|medium|low)\\b/); return m ? m[1] : ""; };',
            "const ex = parse(ctx.vars.raw_alert) || {};",
            "const raw = parse(ctx.vars.input) || {};",
            'const blob = String(ctx.vars.raw_alert || "") + " " + String(ctx.vars.input || "");',
            'const src_ip = ex.src_ip || ex.source_ip || ex.ip || raw.src_ip || raw.source_ip || raw.ip || findIp(blob) || "unknown";',
            'const signature = ex.signature || ex.rule || raw.signature || raw.rule || "unknown";',
            'const severity = String(ex.severity_hint || ex.severity || raw.severity || findSev(blob) || "low").toLowerCase();',
            "return JSON.stringify({ src_ip: src_ip, signature: signature, severity: severity });",
          ].join("\n"),
          inputs: ["raw_alert", "input"],
          outputVar: "alert",
        },
      },
      {
        id: "history",
        type: "agent",
        position: { x: 600, y: 160 },
        data: {
          kind: "agent",
          label: "History lookup",
          avatar: "🗄️",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.1,
          systemPrompt:
            "Use sql_query against the `siem_alerts` table to find how many prior alerts involve this source IP or " +
            "signature. Summarize the pattern in a sentence or two: how often it recurs and the worst severity seen. " +
            "State plainly if there is no prior history.",
          inputs: ["alert"],
          outputVar: "history",
          enabledTools: ["sql_query"],
          toolConfigs: { sql_table_names: ["siem_alerts"] },
        },
      },
      {
        id: "geo",
        type: "http",
        position: { x: 600, y: 440 },
        data: {
          kind: "http",
          label: "Geo / ASN enrich",
          avatar: "🌍",
          httpMethod: "GET",
          httpUrl: "https://ip-api.com/json/{{alert.src_ip}}",
          httpTimeoutMs: 8000,
          inputs: ["alert"],
          outputVar: "geo",
        },
      },
      {
        id: "score",
        type: "function",
        position: { x: 900, y: 300 },
        data: {
          kind: "function",
          label: "Risk score",
          avatar: "🧮",
          functionCode: [
            "let a = {};",
            'try { a = JSON.parse(ctx.vars.alert || "{}") || {}; } catch (e) { a = {}; }',
            "const rank = { low: 1, medium: 2, high: 3, critical: 4 };",
            'let score = (rank[String(a.severity || "").toLowerCase()] || 1) * 18;',
            'const hist = String(ctx.vars.history || "").toLowerCase();',
            'if (hist.includes("repeat") || hist.includes("multiple") || hist.includes("prior") || hist.includes("recur")) score += 28;',
            'const geo = String(ctx.vars.geo || "").toLowerCase();',
            'if (geo.includes("hosting") || geo.includes("proxy") || geo.includes("anonymous") || geo.includes("tor")) score += 24;',
            "score = Math.min(100, score);",
            'const band = score >= 70 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";',
            'return JSON.stringify({ ip: a.src_ip || "unknown", score: score, band: band });',
          ].join("\n"),
          inputs: ["alert", "history", "geo"],
          outputVar: "risk",
        },
      },
      {
        id: "route",
        type: "condition",
        position: { x: 1180, y: 300 },
        data: {
          kind: "condition",
          label: "High risk?",
          avatar: "❓",
          provider: "openrouter",
          model: FLASH,
          conditionPrompt: "Read the risk JSON. Is this HIGH risk (band is HIGH, or score >= 70)?",
          inputs: ["risk"],
        },
      },
      {
        id: "approval",
        type: "approval",
        position: { x: 1460, y: 160 },
        data: {
          kind: "approval",
          label: "Approve containment",
          avatar: "🛡️",
          approvalTitle: "Isolate host and block source IP",
          approvalRisk: "high",
          inputs: ["risk", "alert"],
          outputVar: "containment",
        },
      },
      {
        id: "report",
        type: "agent",
        position: { x: 1460, y: 440 },
        data: {
          kind: "agent",
          label: "Incident report",
          avatar: "📄",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "Write a concise incident report: what triggered the alert, the history and geo enrichment, the computed " +
            "risk band, and the action taken (containment approved, or auto-closed as low risk). Redact any personal data.",
          inputs: ["alert", "history", "geo", "risk", "containment"],
          outputVar: "incident_report",
          guardrails: { blockPII: true, enableOutputFilters: true, contentSafetyLevel: "high" },
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1740, y: 300 },
        data: {
          kind: "output",
          label: "Incident record",
          avatar: "✅",
          inputs: ["incident_report"],
        },
      },
    ],
    edges: [
      baseEdge("e1", "in", "parse"),
      baseEdge("e2", "parse", "normalize"),
      baseEdge("e3", "normalize", "history"),
      baseEdge("e4", "normalize", "geo"),
      baseEdge("e5", "history", "score"),
      baseEdge("e6", "geo", "score"),
      baseEdge("e7", "score", "route"),
      labeledEdge("e8", "route", "approval", "yes"),
      labeledEdge("e9", "route", "report", "no"),
      baseEdge("e10", "approval", "report"),
      baseEdge("e11", "report", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Input",
        what: "A raw SIEM alert (JSON-ish) enters here.",
        why: "The single entry point for the alert payload.",
        watchFor: "The alert captured into `input`.",
      },
      {
        nodeId: "parse",
        title: "Step 2 — Extract (LLM)",
        what: "An LLM pulls the source IP, signature, and severity out of the messy, vendor-specific alert text.",
        why: "Extraction copes with unstructured alert formats that rigid parsers can't — but an LLM's output is best-effort, not guaranteed.",
        watchFor:
          "A best-effort JSON object — which the next node validates before anyone trusts it.",
      },
      {
        nodeId: "normalize",
        title: "Step 3 — Function (validate the extraction)",
        what: "Deterministic JavaScript takes the LLM's fields — or falls back to parsing the raw alert, or a regex — and emits clean, guaranteed-valid JSON.",
        why: "Never trust an LLM's structured output blindly. A tiny validation function makes every downstream node (SQL, the HTTP URL, the scorer) safe from a malformed or prose-wrapped extract.",
        watchFor:
          "A tidy `{ src_ip, signature, severity }` object the rest of the swarm relies on.",
      },
      {
        nodeId: "history",
        title: "Step 4 — SQL history lookup",
        what: "An agent queries the `siem_alerts` dataset for prior activity from this IP or signature.",
        why: "Grounding triage in your own historical data is what separates a real SOC assistant from a guesser.",
        watchFor: "A short summary of prior occurrences and worst severity.",
      },
      {
        nodeId: "geo",
        title: "Step 5 — HTTP enrich (parallel)",
        what: "A deterministic HTTP GET to a public geolocation API, templating the validated IP straight into the URL. It sits at the same graph level as the SQL lookup — the canvas runs same-level nodes in parallel; deployed (headless) runs execute them one after another.",
        why: "HTTP nodes bring in external, non-LLM data (threat intel, geo, CMDB) and run server-side, so no CORS or keys leak to the browser.",
        watchFor: "A JSON response with country / ISP for the IP.",
      },
      {
        nodeId: "score",
        title: "Step 6 — Function (deterministic scoring)",
        what: "Sandboxed JavaScript combines severity, history, and geo into a numeric risk score and band — no LLM, no variance.",
        why: "When logic must be exact and auditable, a Function node beats a prompt: same inputs always give the same score.",
        watchFor: "A JSON risk object with a stable `score` and `band`.",
      },
      {
        nodeId: "route",
        title: "Step 7 — Condition",
        what: "Branches on the score: HIGH risk goes to human approval, everything else straight to the report.",
        why: "Risk-based routing focuses scarce human attention only where it matters.",
        watchFor: "One live branch — approval (yes) or report (no).",
      },
      {
        nodeId: "approval",
        title: "Step 8 — Human approval (high-risk only)",
        what: "Containment (isolate host, block IP) pauses for a human to approve — a high-risk gate.",
        why: "Destructive, high-blast-radius actions should never be fully autonomous.",
        watchFor: "The node waits amber; approve or reject from the Approvals inbox.",
        realWorldRef: {
          org: "SOAR (Tines / Torq)",
          label:
            "Modern SOC automation auto-enriches and scores alerts, then gates containment on human approval.",
          url: "https://www.tines.com/",
        },
      },
      {
        nodeId: "report",
        title: "Step 9 — Incident report",
        what: "Writes the final incident record from every prior signal, with PII redaction guardrails on.",
        why: "A clean, redacted write-up is the artifact the SOC keeps — and the guardrails keep personal data out of it.",
        watchFor: "A tidy report noting the action taken.",
      },
      {
        nodeId: "out",
        title: "Step 10 — Output",
        what: "The incident record is the final result.",
        why: "What your ticketing system or SIEM annotation reads.",
        watchFor: "Final record in the run panel.",
      },
    ],
    caseStudies: [
      {
        org: "Microsoft Security Copilot",
        headline:
          "Enrich-score-then-escalate is the shape of production SOC automation — cutting mean time to triage while keeping humans on containment.",
        source: "Microsoft Security Copilot",
        url: "https://www.microsoft.com/en-us/security/business/ai-machine-learning/microsoft-security-copilot",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 1. Customer Support Triage (3 agents + approval)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "support-triage",
    title: "Customer Support Triage",
    tagline: "Classifier → Responder → QA reviewer with human approval",
    description:
      "A real triage swarm: a Classifier categorizes the ticket, a Responder drafts a reply, a QA reviewer checks tone and accuracy, and a human approves before the reply is sent.",
    category: "Customer Support",
    exampleInput:
      "Hi — I ordered the SonicPro X2 last week and the right earcup arrived cracked. This is the second time. I want a $50 refund, not a replacement. Order #A-48291.",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 50, y: 220 },
        data: { kind: "input", label: "Customer message", outputVar: "input", avatar: "📨" },
      },
      {
        id: "classifier",
        type: "agent",
        position: { x: 320, y: 220 },
        data: {
          kind: "agent",
          label: "Classifier",
          avatar: "🔍",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.1,
          systemPrompt:
            "You categorize support tickets. Output a JSON object exactly like " +
            '{"category":"refund|warranty|shipping|technical|other","urgency":"low|medium|high","summary":"one sentence"}. ' +
            "Output JSON only, no prose.",
          inputs: ["input"],
          outputVar: "classification",
        },
      },
      {
        id: "responder",
        type: "agent",
        position: { x: 320, y: 440 },
        data: {
          kind: "agent",
          label: "Responder",
          avatar: "✍️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "You are a friendly support agent. Use the classification to write a concise, " +
            "empathetic reply. If the ticket is a refund above $25, explicitly note that supervisor approval is needed. " +
            "Sign as 'The SonicPro Care Team'.",
          inputs: ["input", "classification"],
          outputVar: "draft_reply",
        },
      },
      {
        id: "qa",
        type: "agent",
        position: { x: 640, y: 440 },
        data: {
          kind: "agent",
          label: "QA Reviewer",
          avatar: "🧐",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.2,
          systemPrompt:
            "You are a strict QA reviewer. Read the draft reply. If it is on-tone, accurate, " +
            "and free of promises the company can't keep, return it verbatim with a single line " +
            "'QA: PASS' prepended. Otherwise rewrite it and prepend 'QA: REWRITTEN'.",
          inputs: ["draft_reply"],
          outputVar: "qa_reply",
        },
      },
      {
        id: "approval",
        type: "approval",
        position: { x: 960, y: 440 },
        data: {
          kind: "approval",
          label: "Human approval",
          avatar: "🛡️",
          approvalTitle: "Send refund reply to customer",
          approvalRisk: "medium",
          inputs: ["qa_reply"],
          outputVar: "approved_reply",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1240, y: 440 },
        data: {
          kind: "output",
          label: "Sent to customer",
          avatar: "✅",
          inputs: ["approved_reply"],
        },
      },
    ],
    edges: [
      baseEdge("e1", "in", "classifier"),
      baseEdge("e2", "classifier", "responder"),
      baseEdge("e3", "in", "responder"),
      baseEdge("e4", "responder", "qa"),
      baseEdge("e5", "qa", "approval"),
      baseEdge("e6", "approval", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Input",
        what: "The customer message enters the swarm here.",
        why: "Every swarm needs a single entry point so downstream nodes have a known variable to read.",
        watchFor:
          "The status dot turning green immediately as the input is captured into the `input` variable.",
      },
      {
        nodeId: "classifier",
        title: "Step 2 — Classifier",
        what: "A fast Gemini Flash agent labels the ticket as refund/warranty/shipping/etc and rates urgency.",
        why: "Classifying first lets us route work and lets the next agent write a more targeted reply.",
        watchFor:
          "JSON output with `category`, `urgency`, and a one-line summary stored in `classification`.",
        realWorldRef: {
          org: "Klarna",
          label:
            "Klarna's customer-service AI handles 2.3M chats — work of 700 agents — using a similar classify-then-respond pipeline.",
          url: "https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/",
        },
      },
      {
        nodeId: "responder",
        title: "Step 3 — Responder",
        what: "A stronger Gemini Pro model drafts the customer reply, using both the original message and the classification.",
        why: "Splitting classification from drafting keeps each prompt focused — better quality than one giant prompt.",
        watchFor:
          "An empathetic reply that explicitly mentions the refund needs supervisor approval.",
      },
      {
        nodeId: "qa",
        title: "Step 4 — QA Reviewer",
        what: "A second pass that checks tone, accuracy, and over-promising.",
        why: "Self-review catches hallucinations and policy violations before a human ever sees the draft.",
        watchFor: "The reply is prefixed with `QA: PASS` or `QA: REWRITTEN`.",
        realWorldRef: {
          org: "Anthropic / Constitutional AI",
          label:
            "Self-critique is the same idea as Constitutional AI — a model reviews its own draft against a written rubric.",
          url: "https://www.anthropic.com/news/claudes-constitution",
        },
      },
      {
        nodeId: "approval",
        title: "Step 5 — Human approval",
        what: "Execution pauses here. The approver sees the proposed reply and approves or rejects.",
        why: "Human-in-the-loop is the safety valve for any action with real-world consequences (refunds, emails, transactions).",
        watchFor: "The node turns amber and waits — open the Approvals inbox to act.",
        realWorldRef: {
          org: "Intercom Fin",
          label:
            "Intercom's Fin escalates a meaningful share of issues to humans — same HITL pattern, in production at thousands of companies.",
          url: "https://www.intercom.com/blog/announcing-fin/",
        },
      },
      {
        nodeId: "out",
        title: "Step 6 — Output",
        what: "The approved reply is the final result of the run.",
        why: "A terminal output node is what your application or webhook reads when the swarm finishes.",
        watchFor: "Final output appears in the run panel on the right.",
      },
    ],
    caseStudies: [
      {
        org: "Klarna",
        headline:
          "AI assistant doing the work of 700 full-time agents in its first month — 2.3M conversations, ~25% lower repeat inquiries.",
        quote: "It is on par with human agents in regard to customer satisfaction score.",
        source: "Klarna press release, Feb 2024",
        url: "https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/",
      },
      {
        org: "Intercom (Fin)",
        headline:
          "Resolves up to ~50% of customer questions instantly with a multi-step agent + retrieval pattern.",
        source: "Intercom Fin announcement",
        url: "https://www.intercom.com/blog/announcing-fin/",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2. Research → Report (4 agents)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "research-report",
    title: "Research → Report Writer",
    tagline: "Planner → Researcher → Synthesizer → Editor",
    description:
      "A research pipeline: a Planner breaks the topic into sub-questions, a Researcher answers each one, a Synthesizer merges the findings, and an Editor polishes the final report.",
    category: "Research",
    exampleInput:
      "Write a one-page brief on the trade-offs between RAG and fine-tuning for adapting LLMs to a private knowledge base in 2026.",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 50, y: 220 },
        data: { kind: "input", label: "Research topic", outputVar: "input", avatar: "📋" },
      },
      {
        id: "planner",
        type: "agent",
        position: { x: 320, y: 220 },
        data: {
          kind: "agent",
          label: "Planner",
          avatar: "🗺️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "Break the user's research topic into 3-5 specific sub-questions a researcher should answer. " +
            "Return them as a numbered list, one per line. Nothing else.",
          inputs: ["input"],
          outputVar: "plan",
        },
      },
      {
        id: "researcher",
        type: "agent",
        position: { x: 640, y: 220 },
        data: {
          kind: "agent",
          label: "Researcher",
          avatar: "🔬",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "Answer each sub-question from the plan with 2-4 grounded, factual sentences. " +
            "Use the `web_search` tool to find fresh sources, and `web_browse` to read promising URLs in full. " +
            "Prefix each answer with the question number, and cite source URLs inline. Be precise; avoid filler.",
          inputs: ["plan"],
          outputVar: "findings",
          enabledTools: ["web_search", "web_browse"],
        },
      },
      {
        id: "synth",
        type: "agent",
        position: { x: 960, y: 220 },
        data: {
          kind: "agent",
          label: "Synthesizer",
          avatar: "🧩",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "Merge the researcher's findings into a single coherent narrative organized by theme. " +
            "Drop redundancy. Keep it under 400 words.",
          inputs: ["findings"],
          outputVar: "draft",
        },
      },
      {
        id: "editor",
        type: "agent",
        position: { x: 1280, y: 220 },
        data: {
          kind: "agent",
          label: "Editor",
          avatar: "✒️",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.3,
          systemPrompt:
            "Polish the draft: fix grammar, tighten sentences, add a one-line title at the top, " +
            "and end with a 3-bullet 'Key takeaways' section. Markdown.",
          inputs: ["draft"],
          outputVar: "report",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1600, y: 220 },
        data: { kind: "output", label: "Final report", avatar: "📄", inputs: ["report"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "planner"),
      baseEdge("e2", "planner", "researcher"),
      baseEdge("e3", "researcher", "synth"),
      baseEdge("e4", "synth", "editor"),
      baseEdge("e5", "editor", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Topic",
        what: "The research question enters here.",
        why: "A single explicit topic gives the planner something concrete to decompose.",
        watchFor: "The topic stored as the `input` variable.",
      },
      {
        nodeId: "planner",
        title: "Step 2 — Planner",
        what: "Breaks the topic into 3–5 specific sub-questions.",
        why: "LLMs answer narrow questions much better than broad ones — planning is how we get depth.",
        watchFor: "A numbered list of crisp sub-questions in `plan`.",
        realWorldRef: {
          org: "Stanford STORM",
          label:
            "Stanford's STORM (Synthesizing Topic Outlines through Retrieval and Multi-perspective Question Asking) uses the exact same plan-then-research pattern to write Wikipedia-quality articles.",
          url: "https://arxiv.org/abs/2402.14207",
        },
      },
      {
        nodeId: "researcher",
        title: "Step 3 — Researcher",
        what: "Answers each sub-question with grounded, factual sentences.",
        why: "Iterating per sub-question keeps each answer focused and easier to verify.",
        watchFor: "Numbered answers in `findings`, one cluster per sub-question.",
      },
      {
        nodeId: "synth",
        title: "Step 4 — Synthesizer",
        what: "Merges the findings into a single coherent narrative organized by theme.",
        why: "Raw findings are repetitive; synthesis is where the real report shape emerges.",
        watchFor: "A ~400 word draft with no duplicate facts.",
        realWorldRef: {
          org: "OpenAI Deep Research",
          label:
            "OpenAI's Deep Research agent runs a multi-step plan → browse → synthesize → cite loop — same shape as this template, scaled up with web tools.",
          url: "https://openai.com/index/introducing-deep-research/",
        },
      },
      {
        nodeId: "editor",
        title: "Step 5 — Editor",
        what: "Polishes prose, adds a title, and appends a Key takeaways list.",
        why: "A dedicated editor pass dramatically improves readability without rewriting the substance.",
        watchFor: "Markdown output with title + 3-bullet takeaways.",
      },
      {
        nodeId: "out",
        title: "Step 6 — Final report",
        what: "The polished report is the run's terminal output.",
        why: "Downstream apps consume this single value — no need to track intermediate variables.",
        watchFor: "The full report in the run panel.",
      },
    ],
    caseStudies: [
      {
        org: "OpenAI",
        headline:
          "Deep Research agent autonomously plans, browses, and synthesizes multi-source reports — citation-grade quality from a single prompt.",
        source: "OpenAI Deep Research launch, Feb 2025",
        url: "https://openai.com/index/introducing-deep-research/",
      },
      {
        org: "Stanford NLP",
        headline:
          "STORM generates encyclopedia-style articles via a planner + multi-perspective researcher + synthesis pipeline (open-source).",
        source: "Shao et al., NAACL 2024",
        url: "https://arxiv.org/abs/2402.14207",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 3. Sales lead enrichment (4 agents + approval)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "sales-enrichment",
    title: "Sales Lead Enrichment",
    tagline: "Intake → Enricher → Scorer → Email drafter (with approval)",
    description:
      "A B2B sales swarm: parses the raw lead, enriches it with inferred firmographics, scores fit on a 0-100 ICP scale, and drafts a personalized outreach email — gated by human approval before send.",
    category: "Sales",
    exampleInput:
      "Lead from website form: Sarah Chen, Head of Engineering at Vespertine Robotics. Said: 'Looking for an LLM observability tool that supports self-hosted models. We have 35 engineers.'",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 50, y: 220 },
        data: { kind: "input", label: "Raw lead", outputVar: "input", avatar: "📥" },
      },
      {
        id: "intake",
        type: "agent",
        position: { x: 320, y: 220 },
        data: {
          kind: "agent",
          label: "Intake parser",
          avatar: "📝",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.1,
          systemPrompt:
            "Extract structured fields from the raw lead text. Return JSON with keys: " +
            "name, role, company, team_size (number or null), expressed_need, channel.",
          inputs: ["input"],
          outputVar: "lead",
        },
      },
      {
        id: "enricher",
        type: "agent",
        position: { x: 640, y: 220 },
        data: {
          kind: "agent",
          label: "Enricher",
          avatar: "🧬",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "Given the parsed lead, use `web_search` and `web_browse` to look up the company online (LinkedIn, Crunchbase, website) " +
            "and enrich the lead with real firmographics (industry, company stage, funding, headcount, " +
            "likely budget tier) and the most relevant pain points. Return a short markdown brief citing your sources.",
          inputs: ["lead"],
          outputVar: "enriched",
          enabledTools: ["web_search", "web_browse"],
        },
      },
      {
        id: "scorer",
        type: "agent",
        position: { x: 960, y: 220 },
        data: {
          kind: "agent",
          label: "ICP Scorer",
          avatar: "💯",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.0,
          systemPrompt:
            "Our ICP is engineering teams of 20-200 evaluating LLM observability for self-hosted models. " +
            "Score this enriched lead on a 0-100 scale. Output JSON: " +
            '{"score":N,"reason":"one sentence","tier":"hot|warm|cold"}.',
          inputs: ["enriched"],
          outputVar: "score",
        },
      },
      {
        id: "drafter",
        type: "agent",
        position: { x: 1280, y: 220 },
        data: {
          kind: "agent",
          label: "Email drafter",
          avatar: "✉️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.6,
          systemPrompt:
            "Write a 6-sentence outreach email tailored to the enriched lead and score. " +
            "Reference their stated need verbatim. Sign as 'Alex from AgentSwarms'. No subject line.",
          inputs: ["lead", "enriched", "score"],
          outputVar: "email",
        },
      },
      {
        id: "approval",
        type: "approval",
        position: { x: 1600, y: 220 },
        data: {
          kind: "approval",
          label: "Approve send",
          avatar: "🛡️",
          approvalTitle: "Send outreach email",
          approvalRisk: "low",
          inputs: ["email"],
          outputVar: "sent",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1900, y: 220 },
        data: { kind: "output", label: "Sent", avatar: "📤", inputs: ["sent"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "intake"),
      baseEdge("e2", "intake", "enricher"),
      baseEdge("e3", "enricher", "scorer"),
      baseEdge("e4", "scorer", "drafter"),
      baseEdge("e5", "drafter", "approval"),
      baseEdge("e6", "approval", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Raw lead",
        what: "Free-form lead text from the website form, email, or CRM.",
        why: "Real leads arrive unstructured — the swarm has to do the parsing, not you.",
        watchFor: "The full raw string in the `input` variable.",
      },
      {
        nodeId: "intake",
        title: "Step 2 — Intake parser",
        what: "Extracts name, role, company, team size, and stated need into structured JSON.",
        why: "Structured fields are what every downstream node (and your CRM) actually need.",
        watchFor: "Clean JSON in the `lead` variable.",
      },
      {
        nodeId: "enricher",
        title: "Step 3 — Enricher",
        what: "Infers industry, company stage, and likely pain points from the parsed lead.",
        why: "Enrichment turns 5 fields into the context a salesperson needs to write a relevant email.",
        watchFor: "A short markdown brief in `enriched`.",
        realWorldRef: {
          org: "Clay",
          label:
            "Clay's GTM platform chains LLM enrichment + waterfall data lookups for ~750k+ users — same parse → enrich → score shape, productionized.",
          url: "https://www.clay.com/",
        },
      },
      {
        nodeId: "scorer",
        title: "Step 4 — ICP scorer",
        what: "Scores the enriched lead 0–100 against your Ideal Customer Profile.",
        why: "Scoring lets you triage outreach: hot leads to a human, warm to automation, cold to a nurture list.",
        watchFor: "JSON with `score`, `reason`, and `tier` in `score`.",
      },
      {
        nodeId: "drafter",
        title: "Step 5 — Email drafter",
        what: "Writes a 6-sentence personalized outreach email referencing the stated need verbatim.",
        why: "Personalization is what gets replies — and the swarm has all three context blobs (lead, enriched, score) to draw from.",
        watchFor: "An email that reads like a human wrote it, in `email`.",
        realWorldRef: {
          org: "Salesforce Agentforce",
          label:
            "Agentforce's SDR agent performs the same enrich → score → draft → handoff loop, deployed across thousands of Salesforce orgs.",
          url: "https://www.salesforce.com/agentforce/",
        },
      },
      {
        nodeId: "approval",
        title: "Step 6 — Approve send",
        what: "Pauses for a human to review the email before it actually goes out.",
        why: "You almost never want an LLM emailing prospects unsupervised — approval is the safety valve.",
        watchFor: "Node turns amber; act in the Approvals inbox.",
      },
      {
        nodeId: "out",
        title: "Step 7 — Sent",
        what: "Final terminal node confirming the email was sent.",
        why: "Gives your CRM webhook a single deterministic value to react to.",
        watchFor: "Output appears once approval is granted.",
      },
    ],
    caseStudies: [
      {
        org: "Clay",
        headline:
          "GTM teams chain dozens of LLM-powered enrichment agents on every lead — Clay reports 8,000+ paying customers and a $1.25B valuation built on this pattern.",
        source: "Clay funding announcement, 2025",
        url: "https://www.clay.com/",
      },
      {
        org: "Salesforce",
        headline:
          "Agentforce SDR autonomously researches, scores, and drafts outreach for inbound leads — sold as a packaged agent on the Salesforce platform.",
        source: "Salesforce Agentforce product page",
        url: "https://www.salesforce.com/agentforce/",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 4. Code review pipeline (3 reviewers merged)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "code-review",
    title: "Code Review Pipeline",
    tagline: "Static summarizer → Security & Style reviewers → Merged comment",
    description:
      "Paste a diff or snippet and three specialist reviewers analyze it: a static-analysis summarizer, a security reviewer, and a style reviewer. A merger combines them into a single PR comment.",
    category: "Engineering",
    exampleInput:
      "```ts\nexport function login(req, res) {\n  const { user, pass } = req.body;\n  const sql = `SELECT * FROM users WHERE name='${user}' AND pass='${pass}'`;\n  db.query(sql, (e, r) => { if (r) res.cookie('token', user); res.send('ok'); });\n}\n```",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 50, y: 320 },
        data: { kind: "input", label: "Code / diff", outputVar: "input", avatar: "💻" },
      },
      {
        id: "summary",
        type: "agent",
        position: { x: 320, y: 320 },
        data: {
          kind: "agent",
          label: "Static summarizer",
          avatar: "🔎",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.2,
          systemPrompt:
            "Describe what the code does in 2-3 sentences. List inputs, outputs, and side effects.",
          inputs: ["input"],
          outputVar: "summary",
        },
      },
      {
        id: "security",
        type: "agent",
        position: { x: 640, y: 180 },
        data: {
          kind: "agent",
          label: "Security reviewer",
          avatar: "🛡️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.1,
          systemPrompt:
            "Identify security vulnerabilities (injection, auth, secrets, unsafe deserialization, etc.). " +
            "List findings as a markdown list with severity tags [HIGH] / [MED] / [LOW] and one-line fix suggestions.",
          inputs: ["input", "summary"],
          outputVar: "security_findings",
        },
      },
      {
        id: "style",
        type: "agent",
        position: { x: 640, y: 460 },
        data: {
          kind: "agent",
          label: "Style reviewer",
          avatar: "🎨",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.2,
          systemPrompt:
            "Review style and maintainability: naming, dead code, complexity, missing types, error handling. " +
            "List findings as a short markdown list with concrete suggestions.",
          inputs: ["input", "summary"],
          outputVar: "style_findings",
        },
      },
      {
        id: "merger",
        type: "agent",
        position: { x: 960, y: 320 },
        data: {
          kind: "agent",
          label: "PR merger",
          avatar: "🧵",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "Combine the security and style findings into a single PR review comment. " +
            "Start with a one-line verdict (Approve / Request changes / Block). " +
            "Then a 'Security' section, then 'Style', then a 'Suggested next steps' list. Markdown.",
          inputs: ["summary", "security_findings", "style_findings"],
          outputVar: "review",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1280, y: 320 },
        data: { kind: "output", label: "PR comment", avatar: "💬", inputs: ["review"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "summary"),
      baseEdge("e2", "summary", "security"),
      baseEdge("e3", "summary", "style"),
      baseEdge("e4", "in", "security"),
      baseEdge("e5", "in", "style"),
      baseEdge("e6", "security", "merger"),
      baseEdge("e7", "style", "merger"),
      baseEdge("e8", "merger", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Code",
        what: "The diff or snippet to review enters here.",
        why: "All three reviewers read the same source-of-truth so their findings line up with the code.",
        watchFor: "Code captured into the `input` variable.",
      },
      {
        nodeId: "summary",
        title: "Step 2 — Static summarizer",
        what: "Describes what the code does in plain English, plus inputs/outputs/side effects.",
        why: "Reviewers downstream do a much better job when they start from a clear summary instead of cold-reading code.",
        watchFor: "A 2–3 sentence explanation in `summary`.",
      },
      {
        nodeId: "security",
        title: "Step 3 — Security reviewer (parallel)",
        what: "Specialist reviewer focused only on vulnerabilities — injection, auth, secrets, etc.",
        why: "Specialization beats generalist prompts: a focused reviewer catches more real issues.",
        watchFor: "Severity-tagged findings in `security_findings`.",
        realWorldRef: {
          org: "GitHub Copilot Autofix",
          label:
            "GitHub's Autofix uses a dedicated security-focused agent on every PR — same specialist-reviewer pattern, shipped to millions of repos.",
          url: "https://github.blog/2024-03-20-found-means-fixed-introducing-code-scanning-autofix-powered-by-github-copilot-and-codeql/",
        },
      },
      {
        nodeId: "style",
        title: "Step 4 — Style reviewer (parallel)",
        what: "Specialist focused on naming, complexity, types, and maintainability.",
        why: "Runs in parallel with the security reviewer — the runtime fans out automatically.",
        watchFor: "A markdown list in `style_findings`.",
      },
      {
        nodeId: "merger",
        title: "Step 5 — PR merger",
        what: "Combines both specialist reports into a single PR comment with a verdict.",
        why: "Reviewers shouldn't post two separate comments — the merger is what makes this feel like one cohesive review.",
        watchFor: "Verdict line + Security + Style + Next steps in `review`.",
        realWorldRef: {
          org: "Cognition Devin",
          label:
            "Devin merges multi-agent code review + planning + execution into a single PR comment — same fan-out / fan-in pattern.",
          url: "https://www.cognition.ai/blog/introducing-devin",
        },
      },
      {
        nodeId: "out",
        title: "Step 6 — PR comment",
        what: "The final review comment, ready to post to the pull request.",
        why: "Your CI/webhook reads this single value and posts to GitHub/GitLab.",
        watchFor: "Markdown output in the run panel.",
      },
    ],
    caseStudies: [
      {
        org: "GitHub",
        headline:
          "Copilot Autofix proposes patches for ~⅔ of detected vulnerabilities, ~3× faster median fix time vs humans alone.",
        source: "GitHub Engineering blog, 2024",
        url: "https://github.blog/2024-03-20-found-means-fixed-introducing-code-scanning-autofix-powered-by-github-copilot-and-codeql/",
      },
      {
        org: "CodeRabbit",
        headline:
          "CodeRabbit ships an OSS-friendly multi-agent PR reviewer used by 5,000+ orgs — security + style + summary agents merged into one comment.",
        source: "CodeRabbit website",
        url: "https://www.coderabbit.ai/",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 5. Financial earnings analyst (Bloomberg / JPMorgan style)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "earnings-analyst",
    title: "Earnings Call Analyst Desk",
    tagline:
      "Transcript splitter → Numbers extractor + Tone analyst + Risk scanner → Compliance check → Analyst memo",
    description:
      "A buy-side / sell-side analyst desk in miniature. The swarm ingests an earnings call transcript, runs three specialist agents in parallel (numbers, tone, risk), passes the merged view through a compliance reviewer, and produces a one-page analyst memo with an explicit BUY / HOLD / SELL view — gated by human approval before publishing.",
    category: "Financial Services",
    exampleInput:
      "Q3 2025 earnings call transcript — Vespertine Robotics (NASDAQ: VSPR). CEO opening: 'Revenue grew 38% YoY to $412M. Gross margin expanded 220bps to 64.1%. We are reaffirming full-year guidance of $1.65B–$1.70B and raising operating margin guidance to 18%. We did see softness in our APAC industrial segment, particularly China, where orders were down 12% sequentially. We took a $14M restructuring charge to consolidate two manufacturing sites…' [analyst Q&A: questions on China exposure, AI capex sustainability, and competitive pressure from Symbotic.]",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 50, y: 360 },
        data: { kind: "input", label: "Earnings transcript", outputVar: "input", avatar: "📄" },
      },
      {
        id: "splitter",
        type: "agent",
        position: { x: 320, y: 360 },
        data: {
          kind: "agent",
          label: "Transcript splitter",
          avatar: "✂️",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.0,
          systemPrompt:
            "Split the earnings call into three labeled sections: 'PREPARED_REMARKS', 'GUIDANCE', and 'QA'. " +
            "Return a single string with each section delimited by '===<SECTION>===' headers. Preserve original wording.",
          inputs: ["input"],
          outputVar: "sections",
        },
      },
      {
        id: "numbers",
        type: "agent",
        position: { x: 640, y: 180 },
        data: {
          kind: "agent",
          label: "Numbers extractor",
          avatar: "📊",
          provider: "openrouter",
          model: PRO,
          temperature: 0.0,
          systemPrompt:
            "You are a financial data extractor. Pull every numerical claim from the transcript into JSON: " +
            '{"revenue":{"value":"$412M","yoy":"+38%","period":"Q3 2025"}, "gross_margin":..., "guidance":..., "segment_callouts":[...]} ' +
            "Only include numbers that are stated in the source; never invent figures. Output valid JSON only.",
          inputs: ["sections"],
          outputVar: "numbers",
          enabledTools: ["web_search", "web_browse"],
        },
      },
      {
        id: "tone",
        type: "agent",
        position: { x: 640, y: 360 },
        data: {
          kind: "agent",
          label: "Tone analyst",
          avatar: "🎙️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.2,
          systemPrompt:
            "Analyze management tone vs the prior quarter's typical posture (cautious / confident / defensive / hedging). " +
            "Score 1-10 on (1) confidence, (2) transparency, (3) defensiveness in the Q&A. " +
            'Return JSON {"confidence":N,"transparency":N,"defensiveness":N,"notable_phrases":["..."],"summary":"two sentences"}.',
          inputs: ["sections"],
          outputVar: "tone",
        },
      },
      {
        id: "risk",
        type: "agent",
        position: { x: 640, y: 540 },
        data: {
          kind: "agent",
          label: "Risk scanner",
          avatar: "⚠️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.1,
          systemPrompt:
            "Identify forward-looking risks the company disclosed or implied: macro, geopolitical, customer concentration, regulatory, competitive, FX, restructuring. " +
            "Output a markdown bullet list. For each risk: [SEVERITY: HIGH/MED/LOW] one-line description, then 'Source quote: \"…\"'. " +
            "Never invent risks not supported by the transcript.",
          inputs: ["sections"],
          outputVar: "risks",
          enabledTools: ["web_search", "web_browse"],
        },
      },
      {
        id: "compliance",
        type: "agent",
        position: { x: 960, y: 360 },
        data: {
          kind: "agent",
          label: "Compliance reviewer",
          avatar: "⚖️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.0,
          systemPrompt:
            "You are a sell-side compliance officer. Review the extracted numbers, tone, and risks. " +
            "Flag anything that (a) cites figures not in the source, (b) makes forward-looking statements without a hedge, (c) implies non-public material information. " +
            'Return JSON: {"verdict":"clean|needs_edits|block","issues":["..."],"required_disclaimers":["..."]}. ' +
            "Be strict: when in doubt, flag.",
          inputs: ["numbers", "tone", "risks"],
          outputVar: "compliance",
        },
      },
      {
        id: "memo",
        type: "agent",
        position: { x: 1280, y: 360 },
        data: {
          kind: "agent",
          label: "Analyst memo",
          avatar: "📝",
          provider: "openrouter",
          model: PRO,
          temperature: 0.3,
          systemPrompt:
            "Write a one-page analyst memo in markdown. Structure: " +
            "## Verdict (single line: BUY / HOLD / SELL with 1-sentence rationale) " +
            "## Numbers (tight bullets sourced from `numbers`) " +
            "## Management read (1 paragraph from `tone`) " +
            "## Key risks (bullets from `risks`) " +
            "## What we're watching next quarter (3 bullets) " +
            "Include any disclaimers from `compliance.required_disclaimers` verbatim at the bottom. " +
            "If `compliance.verdict` is 'block', return only: 'BLOCKED BY COMPLIANCE: ' followed by the issues.",
          inputs: ["numbers", "tone", "risks", "compliance"],
          outputVar: "memo",
        },
      },
      {
        id: "approval",
        type: "approval",
        position: { x: 1600, y: 360 },
        data: {
          kind: "approval",
          label: "PM approval",
          avatar: "🛡️",
          approvalTitle: "Publish analyst memo to desk",
          approvalRisk: "high",
          inputs: ["memo"],
          outputVar: "approved_memo",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1880, y: 360 },
        data: { kind: "output", label: "Published memo", avatar: "📬", inputs: ["approved_memo"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "splitter"),
      baseEdge("e2", "splitter", "numbers"),
      baseEdge("e3", "splitter", "tone"),
      baseEdge("e4", "splitter", "risk"),
      baseEdge("e5", "numbers", "compliance"),
      baseEdge("e6", "tone", "compliance"),
      baseEdge("e7", "risk", "compliance"),
      baseEdge("e8", "numbers", "memo"),
      baseEdge("e9", "tone", "memo"),
      baseEdge("e10", "risk", "memo"),
      baseEdge("e11", "compliance", "memo"),
      baseEdge("e12", "memo", "approval"),
      baseEdge("e13", "approval", "out"),
    ],
    tour: [
      {
        nodeId: "in",
        title: "Step 1 — Transcript",
        what: "The earnings call text drops in here.",
        why: "Real analyst desks ingest raw transcripts within minutes of the call ending — this is the same entry point.",
        watchFor: "Transcript stored in `input`.",
      },
      {
        nodeId: "splitter",
        title: "Step 2 — Splitter",
        what: "Cuts the call into Prepared Remarks / Guidance / Q&A so downstream agents can focus.",
        why: "Each section has a different signal: prepared remarks for numbers, Q&A for management tone, guidance for risk.",
        watchFor: "Three labeled sections in `sections`.",
      },
      {
        nodeId: "numbers",
        title: "Step 3 — Numbers extractor (parallel)",
        what: "Pulls every numerical claim into structured JSON, never invents figures.",
        why: "Quoting numbers correctly is non-negotiable on a financial desk — a dedicated extractor is much more reliable than a generalist.",
        watchFor: "Clean JSON in `numbers` with revenue / margin / guidance / segments.",
        realWorldRef: {
          org: "BloombergGPT",
          label:
            "Bloomberg trained a 50B-parameter financial LLM specifically to extract and normalize earnings figures across thousands of calls.",
          url: "https://www.bloomberg.com/company/press/bloomberggpt-50-billion-parameter-llm-tuned-finance/",
        },
      },
      {
        nodeId: "tone",
        title: "Step 4 — Tone analyst (parallel)",
        what: "Scores management confidence, transparency, defensiveness; surfaces notable phrasing.",
        why: "Tone shifts vs prior quarters are how analysts catch trouble before the numbers reflect it.",
        watchFor: "JSON with three scores + notable phrases in `tone`.",
      },
      {
        nodeId: "risk",
        title: "Step 5 — Risk scanner (parallel)",
        what: "Surfaces forward-looking risks with severity tags and source quotes.",
        why: "Quoting the source is what makes the memo defensible to compliance and clients.",
        watchFor: "Markdown bullets with [HIGH/MED/LOW] tags in `risks`.",
        realWorldRef: {
          org: "JPMorgan IndexGPT",
          label:
            "JPMorgan filed for AI tooling that scans filings and earnings for forward-looking risk signals — same shape, deployed in regulated production.",
          url: "https://www.jpmorgan.com/technology/artificial-intelligence",
        },
      },
      {
        nodeId: "compliance",
        title: "Step 6 — Compliance reviewer",
        what: "Strict reviewer that blocks the memo if any number was invented or any forward-looking statement lacks a hedge.",
        why: "On regulated desks this gate is mandatory. Building it into the swarm means the LLM can't accidentally publish a violation.",
        watchFor: "`compliance.verdict` is `clean`, `needs_edits`, or `block`.",
        realWorldRef: {
          org: "Morgan Stanley AI @ Scale",
          label:
            "Morgan Stanley's GPT-4 wealth-management assistant ships with a mandatory compliance review layer before any client-facing output.",
          url: "https://openai.com/index/morgan-stanley/",
        },
      },
      {
        nodeId: "memo",
        title: "Step 7 — Analyst memo",
        what: "Writes the one-page memo with explicit BUY/HOLD/SELL, sourced numbers, tone read, risks, and compliance disclaimers.",
        why: "The whole point — analyst output that reads like a junior analyst wrote it, with citations a senior PM would accept.",
        watchFor: "Markdown memo in `memo`, or a 'BLOCKED BY COMPLIANCE' line.",
      },
      {
        nodeId: "approval",
        title: "Step 8 — PM approval",
        what: "Portfolio manager signs off before the memo lands on the desk.",
        why: "High-stakes outputs always cross a human's desk — this is the gate.",
        watchFor: "Node turns amber until approved.",
      },
      {
        nodeId: "out",
        title: "Step 9 — Published",
        what: "Final, approved memo ready to push to the desk's notes system.",
        why: "Your downstream system (Slack, Bloomberg note, internal portal) reads this one value.",
        watchFor: "Final memo in the run panel.",
      },
    ],
    caseStudies: [
      {
        org: "Morgan Stanley",
        headline:
          "GPT-4 wealth-management assistant gives 16,000 advisors instant access to ~100k research docs — vetted via mandatory compliance layer.",
        quote:
          "We've taken our intellectual capital and made it instantly accessible — but always with a human and compliance in the loop.",
        source: "OpenAI customer story — Morgan Stanley",
        url: "https://openai.com/index/morgan-stanley/",
      },
      {
        org: "Bloomberg",
        headline:
          "BloombergGPT (50B params) trained on financial filings + news for earnings extraction, sentiment, and structured Q&A.",
        source: "Bloomberg Press, March 2023",
        url: "https://www.bloomberg.com/company/press/bloomberggpt-50-billion-parameter-llm-tuned-finance/",
      },
      {
        org: "JPMorgan Chase",
        headline:
          "Rolled out an internal LLM Suite to 60,000+ employees for research, drafting, and risk summarization — explicit guardrails for client output.",
        source: "Financial Times coverage, 2024",
        url: "https://www.ft.com/content/29782343-657f-474c-b7e3-22acb8a6bcd1",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // API Enrichment — HTTP → Extract → Set Variable → agent
  // Demonstrates the deterministic data nodes + JSON-path variables.
  // ──────────────────────────────────────────────────────────────────
  {
    id: "api-enrichment",
    title: "API Enrichment (HTTP → Extract)",
    tagline: "Fetch a GitHub profile, extract fields, write an intro",
    description:
      "The deterministic data nodes in action: an HTTP node calls a public REST API, an Extract node turns the JSON response into typed fields, a Set Variable node composes a headline from a JSON path, and an agent writes a short intro. No API key needed — GitHub's public API is keyless.",
    category: "Operations",
    exampleInput: "torvalds",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 240 },
        data: { kind: "input", label: "GitHub username", outputVar: "input", avatar: "📨" },
      },
      {
        id: "fetch",
        type: "http",
        position: { x: 300, y: 240 },
        data: {
          kind: "http",
          label: "Fetch profile",
          avatar: "🌐",
          httpMethod: "GET",
          httpUrl: "https://api.github.com/users/{{input}}",
          httpHeaders: [{ key: "Accept", value: "application/vnd.github+json" }],
          inputs: ["input"],
          outputVar: "profile_json",
        },
      },
      {
        id: "extract",
        type: "extract",
        position: { x: 560, y: 240 },
        data: {
          kind: "extract",
          label: "Extract fields",
          avatar: "🧩",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.1,
          extractSchema: [
            { name: "name", type: "string", description: "the person's full name" },
            { name: "bio", type: "string", description: "their short bio (or null)" },
            { name: "followers", type: "number", description: "follower count" },
            { name: "public_repos", type: "number", description: "number of public repositories" },
          ],
          inputs: ["profile_json"],
          outputVar: "profile",
        },
      },
      {
        id: "headline",
        type: "set_var",
        position: { x: 820, y: 240 },
        data: {
          kind: "set_var",
          label: "Compose headline",
          avatar: "🔧",
          stateAssignments: [
            {
              key: "headline",
              value:
                "{{profile.name}} — {{profile.followers}} followers, {{profile.public_repos}} repos",
            },
          ],
          inputs: ["profile"],
          outputVar: "headline_set",
        },
      },
      {
        id: "writer",
        type: "agent",
        position: { x: 1080, y: 240 },
        data: {
          kind: "agent",
          label: "Intro writer",
          avatar: "✍️",
          provider: "openrouter",
          model: PRO,
          temperature: 0.5,
          systemPrompt:
            "You write a warm two-sentence introduction for an open-source developer. Use only the facts provided (a headline and a JSON profile with a bio). Do not invent facts.\n\nHeadline: {{headline}}",
          inputs: ["profile"],
          outputVar: "intro",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1340, y: 240 },
        data: { kind: "output", label: "Developer intro", avatar: "✅", inputs: ["intro"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "fetch"),
      baseEdge("e2", "fetch", "extract"),
      baseEdge("e3", "extract", "headline"),
      baseEdge("e4", "headline", "writer"),
      baseEdge("e5", "writer", "out"),
    ],
    tour: [
      {
        nodeId: "fetch",
        title: "Step 1 — HTTP Request",
        what: "Calls https://api.github.com/users/{{input}} — the {{input}} is filled from the run input.",
        why: "The HTTP node runs server-side, so it isn't blocked by browser CORS and can carry secrets via {{secret:NAME}} without exposing them.",
        watchFor:
          "The raw JSON profile landing in the `profile_json` variable (see the Flow variables panel).",
      },
      {
        nodeId: "extract",
        title: "Step 2 — Extract",
        what: "Turns the messy JSON into exactly four typed fields (name, bio, followers, public_repos).",
        why: "Downstream nodes get clean, predictable values instead of parsing raw API output themselves.",
        watchFor:
          "The `profile` variable becoming a small JSON object with just the fields you asked for.",
      },
      {
        nodeId: "headline",
        title: "Step 3 — Set Variable",
        what: "Builds a `headline` string using JSON-path templating: {{profile.name}}, {{profile.followers}}.",
        why: "Set Variable lets you compose and reshape flow state without an LLM call.",
        watchFor: "The `headline` key appearing in the Flow variables panel.",
      },
      {
        nodeId: "writer",
        title: "Step 4 — Intro writer",
        what: "An agent writes the final intro, with {{headline}} interpolated straight into its prompt.",
        why: "Shows that flow-state variables resolve inside agent prompts too, not just the data nodes.",
        watchFor: "A friendly two-sentence intro grounded only in the fetched facts.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Batch Summarizer — For-Each maps an agent over an array
  // ──────────────────────────────────────────────────────────────────
  {
    id: "batch-summarizer",
    title: "Batch Summarizer (For-Each)",
    tagline: "Summarize each line of a list, then synthesize",
    description:
      "The For-Each node maps an agent body over every element of an array. Paste one item per line; each is summarized in its own LLM call, the results are collected into a JSON array, and a synthesizer writes a combined executive brief.",
    category: "Research",
    exampleInput:
      "The James Webb telescope detected some of the earliest known galaxies\nA new battery chemistry doubles EV range in cold weather\nResearchers trained a model to fold proteins faster than AlphaFold",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 240 },
        data: { kind: "input", label: "Items (one per line)", outputVar: "input", avatar: "📨" },
      },
      {
        id: "each",
        type: "foreach",
        position: { x: 340, y: 240 },
        data: {
          kind: "foreach",
          label: "Summarize each",
          avatar: "🔁",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.3,
          maxIters: 25,
          foreachItemVar: "item",
          foreachInput: "input",
          systemPrompt:
            'Summarize this item in one punchy sentence and add a 1-5 "impact" score. Return JSON only: {"summary": "...", "impact": <1-5>}.\n\nItem: {{item}}',
          inputs: ["input"],
          outputVar: "summaries",
        },
      },
      {
        id: "synth",
        type: "agent",
        position: { x: 640, y: 240 },
        data: {
          kind: "agent",
          label: "Synthesizer",
          avatar: "🧠",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "You are given a JSON array of per-item summaries, each with an impact score. Write a 3-bullet executive brief ordered by impact (highest first), then a one-line overall takeaway.",
          inputs: ["summaries"],
          outputVar: "brief",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 920, y: 240 },
        data: { kind: "output", label: "Executive brief", avatar: "✅", inputs: ["brief"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "each"),
      baseEdge("e2", "each", "synth"),
      baseEdge("e3", "synth", "out"),
    ],
    tour: [
      {
        nodeId: "each",
        title: "Step 1 — For Each",
        what: "Splits the input into an array (one item per line) and runs its agent body once per item.",
        why: "Batch/fan-out patterns — processing each row, file, or search result — are a first-class primitive, not a hack.",
        watchFor:
          "The loop-iteration events ticking up in the event log, then a JSON array in the `summaries` variable.",
      },
      {
        nodeId: "synth",
        title: "Step 2 — Synthesizer",
        what: "Reads the collected `summaries` array and writes one combined brief.",
        why: "For-Each collects per-item results into a single value the next node can reason over.",
        watchFor: "A 3-bullet brief ordered by the impact scores each item was given.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Deterministic Web Research — Tool node (no LLM) → Extract → agent
  // ──────────────────────────────────────────────────────────────────
  {
    id: "tool-research",
    title: "Deterministic Web Research (Tool → Extract)",
    tagline: "Web search with no LLM, then extract + brief",
    description:
      "The Tool node runs the web_search tool directly — no LLM turn, no tokens. An Extract node pulls the results into typed fields and an agent writes a short brief. Web search uses your workspace Firecrawl key if set, otherwise falls back to DuckDuckGo.",
    category: "Research",
    exampleInput: "electric vehicle battery recycling startups",
    nodes: [
      {
        id: "in",
        type: "input",
        position: { x: 40, y: 240 },
        data: { kind: "input", label: "Search topic", outputVar: "input", avatar: "📨" },
      },
      {
        id: "search",
        type: "tool",
        position: { x: 320, y: 240 },
        data: {
          kind: "tool",
          label: "Web search",
          avatar: "🛠️",
          toolId: "web_search",
          toolArgs: { query: "{{input}}" },
          inputs: ["input"],
          outputVar: "results",
        },
      },
      {
        id: "extract",
        type: "extract",
        position: { x: 600, y: 240 },
        data: {
          kind: "extract",
          label: "Top findings",
          avatar: "🧩",
          provider: "openrouter",
          model: FLASH,
          temperature: 0.1,
          extractSchema: [
            {
              name: "top_titles",
              type: "array",
              description: "titles of the most relevant results",
            },
            {
              name: "key_themes",
              type: "array",
              description: "2-4 recurring themes across the results",
            },
          ],
          inputs: ["results"],
          outputVar: "findings",
        },
      },
      {
        id: "brief",
        type: "agent",
        position: { x: 880, y: 240 },
        data: {
          kind: "agent",
          label: "Analyst",
          avatar: "🧠",
          provider: "openrouter",
          model: PRO,
          temperature: 0.4,
          systemPrompt:
            "Write a 4-sentence research brief from the extracted findings (titles + themes). Make clear it is based on a quick web scan, not exhaustive research.",
          inputs: ["findings"],
          outputVar: "summary",
        },
      },
      {
        id: "out",
        type: "output",
        position: { x: 1160, y: 240 },
        data: { kind: "output", label: "Research brief", avatar: "✅", inputs: ["summary"] },
      },
    ],
    edges: [
      baseEdge("e1", "in", "search"),
      baseEdge("e2", "search", "extract"),
      baseEdge("e3", "extract", "brief"),
      baseEdge("e4", "brief", "out"),
    ],
    tour: [
      {
        nodeId: "search",
        title: "Step 1 — Tool (deterministic)",
        what: "Runs web_search directly with your topic — no LLM decides whether or how to call it.",
        why: "When you always want a specific tool run, a deterministic Tool node is cheaper and more predictable than asking an agent to call it.",
        watchFor: "Raw search results in the `results` variable, produced with zero tokens.",
      },
      {
        nodeId: "extract",
        title: "Step 2 — Extract",
        what: "Distills the raw results into top titles and recurring themes.",
        why: "Keeps the final agent focused on clean signal instead of raw tool output.",
        watchFor: "The `findings` variable holding two arrays.",
      },
      {
        nodeId: "brief",
        title: "Step 3 — Analyst",
        what: "Writes the final brief from the structured findings.",
        why: "The only LLM-reasoning step in the chain — everything before it is deterministic.",
        watchFor: "A concise, appropriately-hedged 4-sentence brief.",
      },
    ],
  },
];

export function getSwarmTemplate(id: string): SwarmTemplate | undefined {
  return SWARM_TEMPLATES.find((t) => t.id === id);
}
