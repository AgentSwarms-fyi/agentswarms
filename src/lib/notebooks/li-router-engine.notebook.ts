import type { Notebook } from "./types";

export const liRouterEngineNotebook: Notebook = {
  id: "li-router-engine",
  title: "Router Query Engine (The Smart Switch)",
  description:
    "An LLM-selected router that dispatches a question to either a vector index (semantic lookup) or a summary index (global synthesis).",
  difficulty: "intermediate",
  tags: ["llamaindex", "rag", "routing"],
  subgroup: "Advanced RAG Patterns",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 4 · Router Query Engine — *The Smart Switch*

Two different question shapes need two different retrieval strategies:

| Question shape | Best index | Why |
| --- | --- | --- |
| "What was the Q3 revenue from EMEA?" — **specific lookup** | **Vector index** (semantic similarity) | You want the *one* passage that talks about this. |
| "Summarise this report." / "What are the main risks?" — **global synthesis** | **Summary index** (sees *every* chunk) | You need the model to read all of it, not just the top-k. |

Hard-coding which index to use is brittle — users mix question shapes constantly. LlamaIndex.ts ships a **\`RouterQueryEngine\`** that uses a small LLM call to pick the right tool per query.

### The LlamaIndex.ts API

\`\`\`ts
import { RouterQueryEngine, LLMSingleSelector } from "llamaindex";

const router = RouterQueryEngine.fromDefaults({
  selector: new LLMSingleSelector(),
  queryEngineTools: [
    {
      queryEngine: vectorIndex.asQueryEngine(),
      description: "Useful for specific, factual questions about details in the document.",
    },
    {
      queryEngine: summaryIndex.asQueryEngine(),
      description: "Useful for high-level summary or 'main themes' questions.",
    },
  ],
});

await router.query({ query: "What's the main argument?" }); // → summary
await router.query({ query: "What year was X founded?" });  // → vector
\`\`\`

The **selector** is just a structured LLM call: "Given the question and these tool descriptions, return the index of the best tool." We'll build that explicitly so you can read the routing decision.`,
    },

    {
      id: "md-build", kind: "markdown",
      source: `## 1 · Build both indices over the same corpus

We pretend to have a small "Q3 board report". We build:
- A **vector index** (chunked + embedded — for specific lookups).
- A **summary index** = a degenerate "retriever" that returns *every* chunk (so the LLM sees the whole document at once for global questions).`,
    },
    {
      id: "build", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;
const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;

const REPORT = \`Q3 2025 Board Report — Acme Corp.

Revenue: $42.1M, up 18% YoY. EMEA grew fastest at 31% YoY, driven by enterprise renewals.
Gross margin: 71%, down 2pp due to one-off cloud migration costs.

Hiring: We hired 23 engineers and 7 GTM hires this quarter. Attrition was 4%, below industry average.

Risks: Customer concentration remains the largest risk — top 5 accounts are 38% of ARR. We are investing in mid-market sales to dilute.

Product: Shipped agent runtime v2, multi-region storage, and SOC 2 Type II compliance.

Outlook: Q4 is expected to land between $44M and $47M. We expect FX headwinds of 1-2% on EMEA revenue.\`;

const docs = [new Document({ pageContent: REPORT, metadata: { source: "q3-report.md" } })];

// Vector index — chunk + embed.
const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 200, chunkOverlap: 30 });
const chunks = await splitter.splitDocuments(docs);

const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});
const vectorIndex = await MemoryVectorStore.fromDocuments(chunks, embeddings);

// Summary "index" — just keep the full document handy.
const summaryIndex = { fullText: REPORT };

ctx.state.vectorIndex = vectorIndex;
ctx.state.summaryIndex = summaryIndex;
ctx.state.chunkCount = chunks.length;
ctx.log("vector index :", chunks.length, "chunks embedded");
ctx.log("summary index:", REPORT.length, "chars stored whole");
return { vectorChunks: chunks.length, summaryChars: REPORT.length };
`,
    },

    {
      id: "md-route", kind: "markdown",
      source: `## 2 · Build the LLM router (selector)

The selector is a small structured-output LLM call. We hand it the question and tool descriptions, it returns the chosen tool name. This is exactly what LlamaIndex's \`LLMSingleSelector\` does internally.

Try the questions in the next cell to see the router branch on each one.`,
    },
    {
      id: "route", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;
const { z } = ctx.lc;

const TOOLS = [
  { name: "vector_lookup",   description: "Best for specific factual questions about details: numbers, names, dates, single facts." },
  { name: "summary_synthesis", description: "Best for high-level questions: summaries, themes, overall risks, main argument, outlook." },
];

const selectorLlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(z.object({
  tool: z.enum(["vector_lookup", "summary_synthesis"]),
  reason: z.string().describe("One short sentence explaining the choice."),
}));

async function selectTool(question) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a query router. Pick exactly one tool best suited to answer the user's question.\\n\\nTools:\\n" +
       TOOLS.map((t) => "- " + t.name + ": " + t.description).join("\\n")],
    ["human", "{q}"],
  ]);
  return await prompt.pipe(selectorLlm).invoke({ q: question });
}

ctx.state.selectTool = selectTool;

// Quick test of the selector on its own.
const probe = await selectTool("How big is the gross margin?");
ctx.log("Probe selection:", probe);
return probe;
`,
    },

    {
      id: "md-run", kind: "markdown",
      source: `## 3 · Run real questions through the router

For each question:

1. The selector picks the tool.
2. We branch — vector_lookup retrieves top-k chunks; summary_synthesis stuffs the whole document.
3. The answering LLM only sees the context the chosen path produced.

Watch the **router log** identify the chosen tool, and how the prompt size differs between the two paths.`,
    },
    {
      id: "run", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

const answerLlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const answerPrompt = ChatPromptTemplate.fromMessages([
  ["system", "Answer concisely using ONLY the context provided."],
  ["human", "Context:\\n{context}\\n\\nQuestion: {question}"],
]);
const answerChain = answerPrompt.pipe(answerLlm).pipe(new StringOutputParser());

async function routeAndAnswer(question) {
  const choice = await ctx.state.selectTool(question);
  ctx.log("\\nQ:", question);
  ctx.log("  → router picked:", choice.tool, "·", choice.reason);

  let context;
  if (choice.tool === "vector_lookup") {
    const hits = await ctx.state.vectorIndex.similaritySearch(question, 2);
    context = hits.map((h) => h.pageContent).join("\\n");
    ctx.log("  vector context size:", context.length, "chars (top-2)");
  } else {
    context = ctx.state.summaryIndex.fullText;
    ctx.log("  summary context size:", context.length, "chars (whole doc)");
  }

  const answer = await answerChain.invoke({ context, question });
  ctx.log("  ANSWER:", answer);
  return { question, picked: choice.tool, answer };
}

// 👇 Edit / add questions. Try ambiguous combos.
const QUESTIONS = [
  "What was the EMEA revenue growth?",            // expect → vector
  "What are the main risks called out in the report?", // expect → summary
  "How many engineers were hired in Q3?",         // expect → vector
  "Give me an overall summary of Q3 performance.", // expect → summary
];

const results = [];
for (const q of QUESTIONS) results.push(await routeAndAnswer(q));
return results.map((r) => ({ q: r.question, picked: r.picked }));
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## What you just built

A 2-tool LLM router. In real LlamaIndex.ts you'd pass *N* tools — one per document, one per data source, one per modality — and the same selector logic scales:

\`\`\`ts
queryEngineTools: [
  { queryEngine: financialsIndex.asQueryEngine(), description: "Financial questions" },
  { queryEngine: legalIndex.asQueryEngine(),     description: "Legal/contract questions" },
  { queryEngine: hrIndex.asQueryEngine(),        description: "HR/policy questions" },
]
\`\`\`

When you need to *combine* tools (e.g. "Compare A vs. B"), one router call isn't enough. That's what the **Sub-Question Query Engine** in the next notebook handles.`,
    },
  ],
};
