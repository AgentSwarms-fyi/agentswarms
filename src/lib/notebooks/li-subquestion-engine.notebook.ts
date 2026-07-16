import type { Notebook } from "./types";

export const liSubQuestionEngineNotebook: Notebook = {
  id: "li-subquestion-engine",
  title: "Sub-Question Query Engine (Decomposing Prompts)",
  description:
    "Take a comparative question, decompose it into independent sub-questions, run them across separate per-document indices in parallel, then synthesise the answer.",
  difficulty: "advanced",
  tags: ["llamaindex", "rag"],
  subgroup: "Advanced RAG Patterns",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 5 · Sub-Question Query Engine — *Decomposing Prompts*

Ask a normal RAG system:

> "Compare Acme's Q3 revenue to Globex's Q3 revenue and tell me who grew faster."

It will fail. The top-k retriever picks chunks from *one* document; a single embedding can't capture "facts about A *and* facts about B *and* a comparison". 

The fix LlamaIndex pioneered:

1. **Decompose** the question into independent sub-questions, one per data source.
2. **Run** each sub-question against the right per-document index, in parallel.
3. **Compile** the sub-answers + the original question into a final synthesis call.

### The LlamaIndex.ts API

\`\`\`ts
import { SubQuestionQueryEngine, QueryEngineTool } from "llamaindex";

const engine = SubQuestionQueryEngine.fromDefaults({
  queryEngineTools: [
    QueryEngineTool.from({ queryEngine: acmeIndex.asQueryEngine(),   metadata: { name: "acme",   description: "Acme Q3 financial report" } }),
    QueryEngineTool.from({ queryEngine: globexIndex.asQueryEngine(), metadata: { name: "globex", description: "Globex Q3 financial report" } }),
  ],
});

await engine.query({ query: "Compare Acme and Globex Q3 revenue and growth." });
\`\`\`

Under the hood: one LLM call decomposes the question, \`Promise.all\` runs the sub-queries in parallel, one final LLM call synthesises. We build that whole waterfall below.`,
    },

    {
      id: "md-corpora", kind: "markdown",
      source: `## 1 · Build two separate per-document indices

Each document gets its **own** vector index, registered under a name + description (the metadata the decomposer will use).`,
    },
    {
      id: "corpora", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;
const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;

const ACME = \`Acme Corp Q3 Report.
Revenue: $42M, up 18% YoY. Gross margin 71%. Hired 23 engineers. Largest risk is customer concentration (top 5 = 38% ARR). EMEA grew 31% YoY.\`;
const GLOBEX = \`Globex Inc Q3 Report.
Revenue: $58M, up 9% YoY. Gross margin 64%. Hired 11 engineers. Largest risk is regulatory scrutiny in the EU. APAC grew 22% YoY.\`;

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 200, chunkOverlap: 30 });
const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

async function buildIndex(text, source) {
  const docs = await splitter.splitDocuments([new Document({ pageContent: text, metadata: { source } })]);
  return await MemoryVectorStore.fromDocuments(docs, embeddings);
}

const tools = [
  { name: "acme",   description: "Acme Corp Q3 financial report — revenue, margins, hiring, risks.", index: await buildIndex(ACME, "acme-q3.md") },
  { name: "globex", description: "Globex Inc Q3 financial report — revenue, margins, hiring, risks.", index: await buildIndex(GLOBEX, "globex-q3.md") },
];

ctx.state.tools = tools;
ctx.log("Built", tools.length, "per-document indices:", tools.map((t) => t.name).join(", "));
return tools.map((t) => ({ tool: t.name, description: t.description }));
`,
    },

    {
      id: "md-decompose", kind: "markdown",
      source: `## 2 · Decompose the user question into sub-questions

A single structured LLM call. Input = (user question, list of available tools). Output = an array of \`{ subQuestion, tool }\`.

The model decides which sub-questions to ask *and* which index each should be routed to.`,
    },
    {
      id: "decompose", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { z } = ctx.lc;

const decomposeLlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(z.object({
  subQuestions: z.array(z.object({
    subQuestion: z.string(),
    tool: z.enum(ctx.state.tools.map((t) => t.name)),
  })).min(1).max(8),
}));

async function decompose(question) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Decompose the user's question into the MINIMUM set of self-contained sub-questions. " +
      "Each sub-question must be answerable by a SINGLE tool. " +
      "Available tools:\\n" +
      ctx.state.tools.map((t) => "- " + t.name + ": " + t.description).join("\\n")],
    ["human", "{q}"],
  ]);
  return await prompt.pipe(decomposeLlm).invoke({ q: question });
}

ctx.state.decompose = decompose;

// 👇 Try other comparative questions. Notice it produces ONE per (fact, tool).
const Q = "Compare Acme and Globex on Q3 revenue, growth rate, and their largest risk.";
const plan = await decompose(Q);
ctx.log("Decomposition plan for:", Q);
plan.subQuestions.forEach((s, i) => ctx.log("  [" + (i + 1) + "] [" + s.tool + "]", s.subQuestion));
ctx.state.lastPlan = { question: Q, plan };
return plan;
`,
    },

    {
      id: "md-execute", kind: "markdown",
      source: `## 3 · Execute every sub-question in parallel (the waterfall)

\`Promise.all\` over the sub-questions. Each one retrieves from *its own* per-document index and gets answered independently. Watch the log — every sub-query fires concurrently.`,
    },
    {
      id: "execute", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

const subQALlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});
const subQAPrompt = ChatPromptTemplate.fromMessages([
  ["system", "Answer ONLY from the context. Be brief — one or two sentences."],
  ["human", "Context:\\n{context}\\n\\nQuestion: {question}"],
]);
const subQAChain = subQAPrompt.pipe(subQALlm).pipe(new StringOutputParser());

const toolByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));
const plan = ctx.state.lastPlan.plan.subQuestions;

const t0 = Date.now();
const subAnswers = await Promise.all(plan.map(async (s, i) => {
  const start = Date.now();
  ctx.log("⏱ start", i + 1, "[" + s.tool + "] →", s.subQuestion);
  const hits = await toolByName[s.tool].index.similaritySearch(s.subQuestion, 2);
  const context = hits.map((h) => h.pageContent).join("\\n");
  const answer = await subQAChain.invoke({ context, question: s.subQuestion });
  ctx.log("✓ done ", i + 1, "[" + s.tool + "] (" + (Date.now() - start) + "ms):", answer);
  return { ...s, answer };
}));
ctx.log("All", subAnswers.length, "sub-queries finished in", Date.now() - t0, "ms (parallel)");

ctx.state.subAnswers = subAnswers;
return subAnswers;
`,
    },

    {
      id: "md-synthesize", kind: "markdown",
      source: `## 4 · Synthesise the final answer

The original question plus every (sub-question, sub-answer) goes into one last LLM call. The model now has everything it needs to compare and answer in one shot — no retrieval gap.`,
    },
    {
      id: "synthesize", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

const synthLlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const subBlock = ctx.state.subAnswers
  .map((s, i) => "[" + (i + 1) + "] (" + s.tool + ") " + s.subQuestion + "\\n    → " + s.answer)
  .join("\\n");

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are answering a comparative question by combining sub-answers from independent sources. " +
    "Be precise. Cite source tools in parentheses where helpful."],
  ["human", "Original question: {q}\\n\\nSub-answers:\\n{sub}\\n\\nWrite the final answer."],
]);

const final = await prompt.pipe(synthLlm).pipe(new StringOutputParser()).invoke({
  q: ctx.state.lastPlan.question,
  sub: subBlock,
});

ctx.log("\\n=== FINAL ANSWER ===\\n" + final);
return final;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## When you need this pattern

- Cross-document comparison ("Compare X and Y on…")
- Multi-fact questions where each fact lives in a different source
- Reports that aggregate across documents

**It is not free.** A sub-question engine makes \`1 (decompose) + N (sub-queries) + 1 (synth)\` LLM calls — count tokens and latency. Use the **Router Query Engine** (previous notebook) when one tool would do; reach for sub-questions when one tool *can't* do it.`,
    },
  ],
};
