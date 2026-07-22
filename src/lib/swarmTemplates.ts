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

export const SWARM_TEMPLATES: SwarmTemplate[] = [
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
