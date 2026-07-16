import type { Notebook } from "./types";

/**
 * Real-world example 1 — Autonomous E-Commerce Support & Refund Agent (HITL).
 *
 * Combines: mock Database tool + RAG over a policy doc + LangGraph state
 * machine with a Human-in-the-Loop approval gate for high-value refunds.
 */
export const rwRefundAgentNotebook: Notebook = {
  id: "rw-refund-agent",
  title: "Autonomous E-Commerce Refund Agent (HITL)",
  description:
    "End-to-end customer-service automation: order lookup, RAG over the refund policy, and a Human-in-the-Loop approval gate for refunds above $100 — all wired together as a LangGraph StateGraph.",
  difficulty: "advanced",
  tags: ["langgraph", "rag", "hitl", "agent", "real-world"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 🛒 Autonomous E-Commerce Refund Agent (HITL)

Imagine a customer writes in:

> "I want a refund for order #1234. It arrived damaged."

A production-grade agent has to do four very different things before it can answer that one sentence:

1. **Look up the order** in the orders database — was it shipped? when? how much was it?
2. **Read the refund policy** the company actually published, not whatever the LLM remembers from its training data, and decide whether the request is eligible.
3. **Draft a clear, on-brand reply** that quotes the relevant policy clause.
4. **Refuse to act unilaterally** when the decision is risky. For us, that means: any refund **over $100** must be approved by a human before it's finalized.

In this notebook we'll build exactly that, using a **LangGraph \`StateGraph\`** so each of those steps is a labeled node with explicit edges. The graph will physically **pause** at the approval gate using LangGraph's \`interruptBefore\` — the cell stops, waits for you to click "Approve" or "Reject", and then resumes the graph from where it left off. That's the same pattern enterprise support tools (Zendesk AI, Intercom Fin, Salesforce Service Cloud) use under the hood.

We'll keep every layer simple and inspectable so you can see exactly how RAG, tools, structured outputs, and HITL fit together.`,
    },

    // ── Step 1: Mock database ─────────────────────────────────────────────
    {
      id: "md-db",
      kind: "markdown",
      source: `## Step 1 — A tiny "orders database"

Real services hit Postgres or DynamoDB here. For the notebook we'll use a plain JS object so the focus stays on the agent. The shape mirrors a realistic e-commerce schema: order id, customer, item, price, shipping status, and the date it was delivered. The "damaged" boolean is the kind of signal you'd normally derive from a returns intake form or a photo upload.`,
    },
    {
      id: "db",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — seed an in-memory orders table.
const ORDERS = {
  "1234": {
    id: "1234",
    customer: "alex@example.com",
    item: "Ceramic pour-over kettle",
    price_usd: 84.0,
    status: "delivered",
    delivered_at: "2026-05-30",
    reported_damaged: true,
  },
  "5678": {
    id: "5678",
    customer: "sam@example.com",
    item: "Espresso machine — Linea Mini",
    price_usd: 4200.0,
    status: "delivered",
    delivered_at: "2026-05-22",
    reported_damaged: true,
  },
  "9012": {
    id: "9012",
    customer: "jordan@example.com",
    item: "Reusable coffee filter",
    price_usd: 18.5,
    status: "in_transit",
    delivered_at: null,
    reported_damaged: false,
  },
};

ctx.state.ORDERS = ORDERS;
return { seeded: Object.keys(ORDERS) };
`,
      sampleOutput: { result: { seeded: ["1234", "5678", "9012"] } },
    },

    // ── Step 2: Policy document + RAG ─────────────────────────────────────
    {
      id: "md-policy",
      kind: "markdown",
      source: `## Step 2 — The refund policy, as a retrievable document

This is the document the legal/ops team controls. The agent must never invent policy — it can only **quote what's in this string**. We split the policy into short clauses, embed each one, and store them in a tiny in-memory vector store. At query time we'll pull the 2 most relevant clauses for whatever the customer is asking about.

In production this would be a Pinecone / pgvector / Chroma collection rebuilt every time legal updates the doc. The mechanics are identical.`,
    },
    {
      id: "rag",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — embed the policy clauses with the real OpenAI embeddings client.
const { OpenAIEmbeddings } = ctx.lc.openai;

const POLICY_CLAUSES = [
  "Clause A — Damaged on arrival: items reported damaged within 14 days of delivery are fully refundable, including original shipping.",
  "Clause B — Change of mind: unopened items may be returned within 30 days for store credit only; original shipping is not refunded.",
  "Clause C — Final sale: items marked 'final sale' on the product page are not eligible for refunds under any circumstances.",
  "Clause D — High-value refunds: any refund exceeding USD 100 must receive manager approval before being issued.",
  "Clause E — Lost in transit: orders with no delivery scan after 21 days are refunded automatically without further investigation.",
];

const embed = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const vectors = await embed.embedDocuments(POLICY_CLAUSES);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function lookupPolicy(query, k = 2) {
  const [qv] = await embed.embedDocuments([query]);
  return POLICY_CLAUSES
    .map((text, i) => ({ text, score: cosine(qv, vectors[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

ctx.state.lookupPolicy = lookupPolicy;
return await lookupPolicy("item arrived damaged");
`,
      sampleOutput: {
        result: [
          { text: "Clause A — Damaged on arrival: items reported damaged within 14 days of delivery are fully refundable, including original shipping.", score: 0.82 },
          { text: "Clause D — High-value refunds: any refund exceeding USD 100 must receive manager approval before being issued.", score: 0.41 },
        ],
      },
    },
    {
      id: "md-rag-explain",
      kind: "markdown",
      source: `Notice that the top-1 result is exactly the clause the agent should cite when handling a damaged-on-arrival case. The second result is the high-value approval clause — which is convenient, because the agent will need both pieces of information to decide whether to require human approval. RAG isn't magic; it's just "give the LLM the right paragraphs so it doesn't have to remember them."`,
    },

    // ── Step 3: Define the graph state ────────────────────────────────────
    {
      id: "md-state",
      kind: "markdown",
      source: `## Step 3 — Shape of the graph state

\`StateGraph\` works by passing a single typed state object between nodes. Each node returns a partial update and LangGraph merges it for you. Our state needs to track: the incoming message, the order we looked up, the policy snippets we retrieved, the refund decision we drafted, and whether a human has approved it.`,
    },
    {
      id: "state",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — declare the graph's state schema.
const { Annotation } = ctx.lc.langgraph;

const RefundState = Annotation.Root({
  message:       Annotation(),                                       // raw customer message
  order_id:      Annotation(),                                       // extracted by the agent
  order:         Annotation(),                                       // pulled from "DB"
  policy:        Annotation({ reducer: (_, x) => x, default: () => [] }),
  decision:      Annotation(),                                       // { refund: true|false, amount, reason }
  approved:      Annotation({ reducer: (_, x) => x, default: () => null }), // true | false | null (pending)
  reply:         Annotation(),                                       // final text shown to customer
});

ctx.state.RefundState = RefundState;
return { fields: Object.keys(RefundState.spec) };
`,
      sampleOutput: { result: { fields: ["message", "order_id", "order", "policy", "decision", "approved", "reply"] } },
    },

    // ── Step 4: Nodes ─────────────────────────────────────────────────────
    {
      id: "md-nodes",
      kind: "markdown",
      source: `## Step 4 — The nodes

Four nodes do all the work:

- **\`extractOrderId\`** — pulls "#1234" out of free-form English and looks it up in the DB.
- **\`retrievePolicy\`** — runs RAG against the customer's actual complaint.
- **\`draftDecision\`** — asks the LLM to produce a *structured* JSON decision (\`{ refund, amount, reason }\`) using the order facts + policy snippets. We use \`withStructuredOutput\` so the model can never hallucinate the shape.
- **\`composeReply\`** — turns the decision (plus the human-approval flag, if any) into a polite customer-facing message.

The interesting choice happens *between* nodes 3 and 4 — see Step 5.`,
    },
    {
      id: "nodes",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — wire each node.
const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

async function extractOrderId(s) {
  const m = s.message.match(/#?(\\d{3,})/);
  const id = m ? m[1] : null;
  const order = id ? ctx.state.ORDERS[id] : null;
  ctx.log("📦 order lookup:", id, order ? "found" : "MISSING");
  return { order_id: id, order };
}

async function retrievePolicy(s) {
  const query = s.message + " — " + (s.order?.item ?? "");
  const policy = await ctx.state.lookupPolicy(query, 2);
  ctx.log("📚 retrieved", policy.length, "clauses");
  return { policy };
}

const DecisionSchema = z.object({
  refund: z.boolean().describe("Whether the refund should be issued"),
  amount: z.number().describe("USD amount to refund — 0 if refund=false"),
  reason: z.string().describe("One sentence citing the relevant policy clause letter"),
});

async function draftDecision(s) {
  const structured = llm.withStructuredOutput(DecisionSchema);
  const prompt =
    "You are a refund adjudicator. Use ONLY the policy clauses provided.\\n\\n" +
    "Order: " + JSON.stringify(s.order) + "\\n\\n" +
    "Customer said: " + s.message + "\\n\\n" +
    "Policy clauses:\\n" + s.policy.map((p) => "- " + p.text).join("\\n");
  const decision = await structured.invoke(prompt);
  ctx.log("⚖️  decision:", JSON.stringify(decision));
  return { decision };
}

async function composeReply(s) {
  const approvalNote =
    s.decision.amount > 100
      ? (s.approved
          ? "(approved by manager)"
          : "(manager declined — please escalate)")
      : "";
  const reply = await llm.invoke(
    "Write a 2-sentence, warm, professional reply to the customer based on this decision: " +
      JSON.stringify(s.decision) + " " + approvalNote
  );
  return { reply: reply.content };
}

Object.assign(ctx.state, { extractOrderId, retrievePolicy, draftDecision, composeReply });
return { nodes: ["extractOrderId", "retrievePolicy", "draftDecision", "composeReply"] };
`,
      sampleOutput: { result: { nodes: ["extractOrderId", "retrievePolicy", "draftDecision", "composeReply"] } },
    },

    // ── Step 5: Compile with interrupt ────────────────────────────────────
    {
      id: "md-compile",
      kind: "markdown",
      source: `## Step 5 — Compile the graph with a Human-in-the-Loop interrupt

This is the punchline of the whole notebook. \`compile({ interruptBefore: ["composeReply"], checkpointer })\` tells LangGraph: **run every node up through \`draftDecision\`, then stop and persist the state, before doing \`composeReply\`.**

When the graph hits that interrupt, our \`invoke\` call returns with a half-finished state. We then inspect \`decision.amount\`:

- If it's **≤ $100**, we automatically set \`approved = true\` and resume the graph immediately — no human needed.
- If it's **> $100**, we surface the decision to the operator (in a real product this would be a Slack message or a queue item). They flip \`approved\` to \`true\` or \`false\`, and only then do we call \`graph.invoke(null, { configurable: { thread_id }})\` to resume.

The checkpointer is what makes this safe: even if the browser tab closes between the interrupt and the human's click, the half-finished state is preserved and the graph can pick up exactly where it stopped.`,
    },
    {
      id: "compile",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 5 — compile with a checkpointer + interrupt.
const { StateGraph, START, END, MemorySaver } = ctx.lc.langgraph;

const graph = new StateGraph(ctx.state.RefundState)
  .addNode("extractOrderId", ctx.state.extractOrderId)
  .addNode("retrievePolicy", ctx.state.retrievePolicy)
  .addNode("draftDecision",  ctx.state.draftDecision)
  .addNode("composeReply",   ctx.state.composeReply)
  .addEdge(START, "extractOrderId")
  .addEdge("extractOrderId", "retrievePolicy")
  .addEdge("retrievePolicy", "draftDecision")
  .addEdge("draftDecision",  "composeReply")
  .addEdge("composeReply",   END);

const checkpointer = new MemorySaver();
ctx.state.app = graph.compile({
  checkpointer,
  interruptBefore: ["composeReply"],
});

return { compiled: true, interrupts_before: ["composeReply"] };
`,
      sampleOutput: { result: { compiled: true, interrupts_before: ["composeReply"] } },
    },

    // ── Step 6: Low-value run (auto approve) ──────────────────────────────
    {
      id: "md-run-low",
      kind: "markdown",
      source: `## Step 6 — A small refund: the graph runs end-to-end

Order #1234 is the $84 kettle. The total is under our $100 threshold, so even though the graph *does* interrupt, our resume logic approves it instantly without bothering a human. You should see the customer reply at the end.`,
    },
    {
      id: "run-low",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 6 — run the graph for a low-value refund.
const cfg = { configurable: { thread_id: "case-1234" } };
const input = { message: "I want a refund for order #1234. It arrived damaged." };

// Phase 1: run until the interrupt.
let snap = await ctx.state.app.invoke(input, cfg);
ctx.log("🛑 paused. decision so far:", JSON.stringify(snap.decision));

// Phase 2: auto-approve because the amount is small.
const approved = snap.decision.amount <= 100;
ctx.log(approved ? "✅ auto-approved (≤ $100)" : "⏳ would need a human");

await ctx.state.app.updateState(cfg, { approved });
const final = await ctx.state.app.invoke(null, cfg);
return { decision: final.decision, reply: final.reply };
`,
      sampleOutput: {
        logs: [
          "📦 order lookup: 1234 found",
          "📚 retrieved 2 clauses",
          "⚖️  decision: {\"refund\":true,\"amount\":84,\"reason\":\"Eligible under Clause A — damaged on arrival within 14 days.\"}",
          "🛑 paused. decision so far: {\"refund\":true,\"amount\":84,\"reason\":\"Eligible under Clause A — damaged on arrival within 14 days.\"}",
          "✅ auto-approved (≤ $100)",
        ],
        result: {
          decision: { refund: true, amount: 84, reason: "Eligible under Clause A — damaged on arrival within 14 days." },
          reply: "Thanks for letting us know, Alex — we've approved a full refund of $84 for the damaged kettle. You should see it back on your card within 3–5 business days.",
        },
      },
    },

    // ── Step 7: High-value run (manual approval) ──────────────────────────
    {
      id: "md-run-high",
      kind: "markdown",
      source: `## Step 7 — A $4,200 refund: the human gate fires

Order #5678 is the espresso machine. Same code path, same graph — but now the interrupt is meaningful. We pretend to be the on-call manager and explicitly approve. Flip the \`humanApproves\` constant to \`false\` and rerun to see the rejection branch.`,
    },
    {
      id: "run-high",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 7 — high-value refund: stop, ask the human, resume.
const cfg = { configurable: { thread_id: "case-5678" } };

let snap = await ctx.state.app.invoke(
  { message: "Refund order #5678 please, the espresso machine arrived shattered." },
  cfg
);

ctx.log("🛑 graph paused. Manager needs to see:");
ctx.log("   amount: $" + snap.decision.amount);
ctx.log("   reason: " + snap.decision.reason);

// 👇 in a real product this would come from a Slack button or a queue worker.
const humanApproves = true;

await ctx.state.app.updateState(cfg, { approved: humanApproves });
const final = await ctx.state.app.invoke(null, cfg);
return { approved: humanApproves, reply: final.reply };
`,
      sampleOutput: {
        logs: [
          "📦 order lookup: 5678 found",
          "📚 retrieved 2 clauses",
          "⚖️  decision: {\"refund\":true,\"amount\":4200,\"reason\":\"Eligible under Clause A and gated by Clause D for amounts over $100.\"}",
          "🛑 graph paused. Manager needs to see:",
          "   amount: $4200",
          "   reason: Eligible under Clause A and gated by Clause D for amounts over $100.",
        ],
        result: {
          approved: true,
          reply: "Hi Sam — I'm so sorry about the damage. A manager has approved a full $4,200 refund and it's being processed right now; you'll see it back within 5 business days.",
        },
      },
    },

    {
      id: "wrap",
      kind: "markdown",
      source: `## 🎉 What you just built

A real customer-service automation loop with:

- **Tool use** for the order DB
- **RAG** so policy is grounded in the actual document
- **Structured outputs** (\`withStructuredOutput\`) so the decision is type-safe JSON, not free text
- **A LangGraph state machine** that pauses, persists, and resumes around a human approval gate

This is roughly 90% of what a production support-AI stack does. The remaining 10% is just connecting it to your real DB, your real policy CMS, and your real chat channel.`,
    },
  ],
};
