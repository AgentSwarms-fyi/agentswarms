import type { Notebook } from "./types";

export const masHitlInvoiceNotebook: Notebook = {
  id: "mas-hitl-invoice",
  title: "Human-In-The-Loop Invoice Approver",
  description:
    "An agent reads an invoice and prepares to pay it. If the amount is over $500, the graph pauses mid-execution. You have to set an approval flag and re-run the resume cell — exactly how production HITL works.",
  difficulty: "intermediate",
  tags: ["langgraph", "multi-agent", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# HITL Invoice Approver

\`\`\`
                              over $500?
             ┌─────────┐    ┌──────────┐    ┌─────────┐
START ─▶ │ extract │ ─▶ │ approve  │ ─▶ │   pay   │ ─▶ END
             └─────────┘    └────▲─────┘    └─────────┘
                                  │ interruptBefore
                                  │ (graph pauses here)
\`\`\`

LangGraph's \`interruptBefore\` halts execution at a checkpoint. The graph state is persisted, and the caller (you, in the next cell) decides whether to resume.

**How HITL works in this notebook:**
1. Cell 4 runs the graph until it pauses before the \`approve\` node.
2. Cell 5 lets you set \`APPROVED = true\` or \`false\` and resume the same \`thread_id\`. The graph picks up exactly where it stopped.

This is not a simulation — \`MemorySaver\` is the same checkpointer interface used in production with Postgres or Redis.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · The state\n\nWe track the invoice text, the parsed amount, an approval decision, and a final receipt.` },
    {
      id: "state", kind: "code", language: "js", runtime: "browser",
      source: `const { Annotation } = ctx.lc.langgraph;

const InvoiceState = Annotation.Root({
  invoice:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  amount:   Annotation({ reducer: (_a, b) => b ?? _a, default: () => 0 }),
  vendor:   Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  approved: Annotation({ reducer: (_a, b) => b ?? _a, default: () => null }),
  receipt:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
});

ctx.state.InvoiceState = InvoiceState;
return { fields: Object.keys(InvoiceState.spec) };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · The nodes\n\nThree nodes: **extract** uses an LLM to parse the invoice; **approve** is the gate; **pay** "sends" the payment. The gate is what we pause before — we never want the LLM to autonomously approve money movement.` },
    {
      id: "nodes", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const Extract = z.object({ vendor: z.string(), amount_usd: z.number() });

async function extractNode(state) {
  const structured = llm.withStructuredOutput(Extract);
  const out = await structured.invoke([
    new SystemMessage("Extract the vendor and total USD amount from this invoice. Return numbers only for amount_usd."),
    new HumanMessage(state.invoice),
  ]);
  ctx.log("📄 extracted:", out);
  return { vendor: out.vendor, amount: out.amount_usd };
}

// approve is a no-op node — the real "approval" happens by the human resuming
// (or not). We only land here AFTER the human has set state.approved.
async function approveNode(state) {
  ctx.log("🚦 gate cleared, approved =", state.approved);
  return {};
}

async function payNode(state) {
  if (state.approved !== true) {
    return { receipt: "❌ Rejected. No payment sent to " + state.vendor + "." };
  }
  ctx.log("💸 paying $" + state.amount + " to " + state.vendor);
  return { receipt: "✅ Paid $" + state.amount + " to " + state.vendor + " (txn #" + Date.now() + ")" };
}

ctx.state.extractNode = extractNode;
ctx.state.approveNode = approveNode;
ctx.state.payNode = payNode;
return { ok: true };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · Compile the graph with an interrupt\n\nThe \`needsApproval\` conditional sends invoices under $500 straight to \`pay\`. Anything bigger goes through \`approve\` — and we pause **before** that node.` },
    {
      id: "compile", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, START, END, MemorySaver } = ctx.lc.langgraph;

const needsApproval = (s) => (s.amount > 500 ? "approve" : "pay");

const graph = new StateGraph(ctx.state.InvoiceState)
  .addNode("extract", ctx.state.extractNode)
  .addNode("approve", ctx.state.approveNode)
  .addNode("pay",     ctx.state.payNode)
  .addEdge(START, "extract")
  .addConditionalEdges("extract", needsApproval, { approve: "approve", pay: "pay" })
  .addEdge("approve", "pay")
  .addEdge("pay", END)
  .compile({
    checkpointer: new MemorySaver(),
    interruptBefore: ["approve"],   // 🚦 pause here
  });

ctx.state.invoiceGraph = graph;
return { compiled: true };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · Run until the graph pauses\n\nThe invoice below is for $1,240 — over the limit, so the graph will stop before \`approve\`. Inspect \`snap.next\` to confirm it really paused.` },
    {
      id: "run", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 Try lowering the amount in the invoice text — under $500 skips the gate.
const INVOICE = \`INVOICE #4421
Vendor: Acme Cloud Hosting
Service: Q1 dedicated server fees
Total due: $1,240.00 USD\`;

const cfg = { configurable: { thread_id: "invoice-1" } };

await ctx.state.invoiceGraph.invoke({ invoice: INVOICE }, cfg);
const snap = await ctx.state.invoiceGraph.getState(cfg);

ctx.state.invoiceCfg = cfg;

return {
  paused_at: snap.next,                     // ["approve"] if over $500
  vendor:    snap.values.vendor,
  amount:    snap.values.amount,
  receipt_so_far: snap.values.receipt || "(none yet — waiting on you)",
};
`,
    },

    { id: "md-5", kind: "markdown", source: `## 5 · Approve or reject, then resume\n\nThis is the human step. Set \`APPROVED\` below, run the cell, and the graph continues from the checkpoint. Run it again with the opposite value and watch the receipt flip.` },
    {
      id: "resume", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 EDIT THIS — your approval decision
const APPROVED = true;   // try false to see the rejection path

const graph = ctx.state.invoiceGraph;
const cfg = ctx.state.invoiceCfg;

// Patch the persisted state with the human's decision …
await graph.updateState(cfg, { approved: APPROVED });

// … then resume. Passing null as input means "continue from where you stopped".
const final = await graph.invoke(null, cfg);
return { decision: APPROVED, receipt: final.receipt };
`,
    },

    { id: "md-6", kind: "markdown", source: `**Things to try:**\n\n- Change the invoice amount to \`$120.00\` — re-run cells 4 and 5. The graph never pauses, it pays straight through, and \`paused_at\` is \`[]\`.\n- Set \`APPROVED = false\`, then immediately re-run cell 5 with \`APPROVED = true\` and a **new** \`thread_id\` in cell 4. Each thread is an independent checkpoint timeline.\n- In a real app, cell 5 would be a button on a dashboard — but the contract is identical: \`updateState\` then \`invoke(null, cfg)\`.` },
  ],
};
