import type { Notebook } from "./types";

export const liDataAgentNotebook: Notebook = {
  id: "li-data-agent",
  title: "Context-Augmented Data Agent",
  description:
    "An autonomous agent equipped with multiple query engines as tools. It decides which index to search, when to cross-reference, and when it has enough to answer.",
  difficulty: "advanced",
  tags: ["llamaindex", "agent", "rag"],
  subgroup: "Data Agents",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 6 · Context-Augmented Data Agent

LlamaIndex's **Data Agent** is a special kind of agent: its tools are **query engines over your knowledge bases**, not arbitrary HTTP APIs. The agent reads the tool *descriptions*, decides which KB to search, formulates the right sub-query for that KB, and decides on each turn whether it has enough to answer.

The mental model:

\`\`\`text
                user question
                     │
                ┌────▼────┐
                │  AGENT  │  ← reads tool descriptions, picks a tool
                └────┬────┘
       ┌─────────────┼─────────────┐
  product_manual   refund_policy   shipping_rates
   (query engine)  (query engine)  (query engine)
       │             │             │
       └──── answers fed back into agent state ────┐
                                                   ▼
                          agent calls more tools OR answers
\`\`\`

### The LlamaIndex.ts API

\`\`\`ts
import { OpenAIAgent, QueryEngineTool } from "llamaindex";

const agent = new OpenAIAgent({
  tools: [
    QueryEngineTool.from({ queryEngine: manualIdx.asQueryEngine(), metadata: { name: "product_manual", description: "Use for product specs, features, setup steps." } }),
    QueryEngineTool.from({ queryEngine: policyIdx.asQueryEngine(), metadata: { name: "company_policy", description: "Use for refunds, returns, warranty, shipping policy." } }),
  ],
});

await agent.chat({ message: "My X-300 won't turn on. Can I return it within 60 days?" });
// → agent calls product_manual ("X-300 power troubleshooting") + company_policy ("return window"), then answers.
\`\`\`

We replicate that with our standard tool-calling loop. Each tool wraps a real vector index over its own document. Watch the agent decide which tools to call.`,
    },

    {
      id: "md-kbs", kind: "markdown",
      source: `## 1 · Build two independent KBs

A Product Manual KB and a Company Policy KB. Two separate vector indices.`,
    },
    {
      id: "kbs", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;
const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;

const PRODUCT_MANUAL = \`X-300 Robot Vacuum — Owner's Manual.
Power: The X-300 uses a 14.4V lithium-ion battery. To reset: hold the power button for 10 seconds until the LED flashes blue twice.
Troubleshooting: If the unit will not turn on, check (1) the dock is plugged in, (2) the bottom power switch is set to ON, (3) the battery is seated correctly.
Maintenance: Empty the dust bin after each use. Replace the HEPA filter every 90 days.
Warranty: The X-300 carries a 24-month manufacturer warranty against defects.\`;

const COMPANY_POLICY = \`Acme Returns and Refunds.
Return window: Customers may return any unopened product within 30 days for a full refund. Opened products may be returned within 14 days subject to a 15% restocking fee.
Defective products: Defective products under warranty are eligible for free replacement at any time within the warranty period — return shipping is prepaid.
Shipping: Domestic returns are free. International returns are at customer expense.
Refund timing: Refunds are processed within 5 business days of receiving the returned item.\`;

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 220, chunkOverlap: 40 });
const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

async function buildKB(text, source) {
  const docs = await splitter.splitDocuments([new Document({ pageContent: text, metadata: { source } })]);
  return await MemoryVectorStore.fromDocuments(docs, embeddings);
}

ctx.state.kb_manual = await buildKB(PRODUCT_MANUAL, "x300-manual.md");
ctx.state.kb_policy = await buildKB(COMPANY_POLICY, "returns-policy.md");
ctx.log("Built KBs: product_manual + company_policy ✓");
return { kbs: ["product_manual", "company_policy"] };
`,
    },

    {
      id: "md-agent", kind: "markdown",
      source: `## 2 · Wrap each KB as a tool the agent can call

Each tool is a thin function: take a query string → similarity-search the KB → return the joined text. The tool's *description* is what the agent uses to decide which one to call. **Make descriptions sharp** — vague descriptions cause the agent to thrash between tools.`,
    },
    {
      id: "agent", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { tool } = ctx.lc.tools;
const { z } = ctx.lc;
const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

const productManualTool = tool(
  async ({ query }) => {
    const hits = await ctx.state.kb_manual.similaritySearch(query, 2);
    return JSON.stringify(hits.map((h) => ({ source: h.metadata.source, text: h.pageContent })));
  },
  {
    name: "product_manual",
    description: "Search the X-300 Robot Vacuum product manual. Use for: setup, troubleshooting, specs, maintenance, warranty length.",
    schema: z.object({ query: z.string().describe("Natural-language query about the product.") }),
  },
);

const companyPolicyTool = tool(
  async ({ query }) => {
    const hits = await ctx.state.kb_policy.similaritySearch(query, 2);
    return JSON.stringify(hits.map((h) => ({ source: h.metadata.source, text: h.pageContent })));
  },
  {
    name: "company_policy",
    description: "Search Acme's returns and refunds policy. Use for: return windows, refund timing, restocking fees, shipping costs, defective-product process.",
    schema: z.object({ query: z.string().describe("Natural-language query about refunds, returns, shipping, or warranty claims.") }),
  },
);

const tools = [productManualTool, companyPolicyTool];
const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(tools);

ctx.state.llm = llm;
ctx.state.toolsByName = toolsByName;
ctx.log("Agent armed with tools:", Object.keys(toolsByName).join(", "));
return Object.keys(toolsByName);
`,
    },

    {
      id: "md-run", kind: "markdown",
      source: `## 3 · Ask a question that requires BOTH KBs

The classic "cross-reference" case: *the X-300 won't power on, can I return it under warranty?* The agent should:

1. Search **product_manual** for power troubleshooting (so it gives a useful answer first).
2. Search **company_policy** for the defective-product / warranty return process.
3. Synthesise one answer that combines both.

You'll see each tool call logged so you can follow the agent's reasoning.`,
    },
    {
      id: "run", kind: "code", language: "js", runtime: "browser",
      source: `const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

// 👇 Edit the question. Try one that only needs ONE KB to see the agent NOT call the other.
const QUESTION = "My X-300 vacuum won't turn on even after I reset it. It's 4 months old. Can I return it for free, and how long until I get my money back?";

const msgs = [
  new SystemMessage(
    "You are a support agent for Acme. " +
    "Use product_manual for hardware/troubleshooting questions and company_policy for returns/warranty questions. " +
    "Cross-reference both tools when the user's question spans both. Cite the [source] tag in your final answer.",
  ),
  new HumanMessage(QUESTION),
];

let finalAnswer = "(unfinished)";
for (let turn = 1; turn <= 6; turn++) {
  const ai = await ctx.state.llm.invoke(msgs);
  msgs.push(ai);
  const calls = ai.tool_calls ?? [];

  if (calls.length === 0) {
    finalAnswer = ai.content;
    ctx.log("\\n[turn " + turn + "] FINAL ANSWER:\\n" + finalAnswer);
    break;
  }

  ctx.log("[turn " + turn + "] tool calls:", calls.map((c) => c.name + "(" + JSON.stringify(c.args) + ")").join(", "));
  for (const c of calls) {
    const result = await ctx.state.toolsByName[c.name].invoke(c.args);
    msgs.push(new ToolMessage({ content: String(result), tool_call_id: c.id }));
  }
}

return { question: QUESTION, finalAnswer, turns: msgs.length };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Why "Data Agents" are different from generic agents

- **Tools are query engines, not arbitrary actions.** The agent isn't calling Stripe or sending emails — it's *reading from your data*. This is much safer and the failure modes are mostly "wrong KB picked" → still recoverable.
- **The description is the API.** With 10 KBs in production, your tool descriptions are the only thing keeping the agent from chaotic search behaviour. Treat them like API docs.
- **It scales to dozens of indices.** Build one per document, one per data source, one per modality — and let the agent route. This is where teams move once they outgrow single-index RAG.

In the final notebook we'll **measure** how well any of this is actually working — Faithfulness and Answer Relevancy scoring with LLM judges (the "RAG Triad").`,
    },
  ],
};
