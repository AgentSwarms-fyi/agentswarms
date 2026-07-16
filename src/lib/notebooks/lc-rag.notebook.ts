import type { Notebook } from "./types";

export const lcRagNotebook: Notebook = {
  id: "lc-rag",
  title: "Embeddings, RAG & RAG-with-Tools",
  description:
    "Pulls real documents from the platform Knowledge Base, chunks them, embeds them, builds a full LCEL RAG chain, then wraps the retriever as a tool inside a multi-tool agent loop.",
  difficulty: "advanced",
  tags: ["langchain", "rag"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 5 · Embeddings & Retrieval-Augmented Generation

RAG = "look up relevant context, then ask the LLM with that context attached". This notebook walks the entire pipeline using **real Knowledge Base documents** — the same store that powers Agents, Swarms, and the \`kb_search\` tool. Nothing is inline; the source content lives in \`/knowledge\`.

Pipeline stages we'll build:

1. **Load** documents from the platform's Knowledge Base
2. **Chunk** them with control over strategy / size / overlap
3. **Embed** each chunk with an OpenAI-compatible embedding model
4. **Store** the vectors for similarity search
5. **Retrieve + generate** with a full LCEL chain
6. **Tool-calling agent** that uses retrieval as one of several tools

### Chunking, embeddings, vector stores — the short version

- **Chunking** trades precision against context. Too small → fragmented facts. Too large → diluted embedding signal. Recursive splitting (paragraphs → sentences → chars) preserves structure; overlap of 10–20% prevents answers being cut in half.
- **Embeddings** map text to a vector where cosine distance ≈ semantic distance. We use \`google/gemini-embedding-001\` (the platform default — same model the production KB uses, so vectors are comparable).
- **Vector stores** index those vectors for nearest-neighbour search. In this notebook we use \`MemoryVectorStore\` for transparency; in production the platform persists vectors in pgvector (\`kb_chunks\`).`,
    },

    // 1 — Load docs from the Knowledge Base
    {
      id: "md-load", kind: "markdown",
      source: `## 1 · Load real KB documents\n\n\`ctx.kb.listDocuments()\` returns every doc in the **Sample · Notebook RAG Lab** knowledge base (read-only sample). To use your own data, pass \`ctx.kb.listDocuments("<your-kb-id>")\` (find KB IDs at \`/knowledge\`).`,
    },
    {
      id: "load-corpus", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 To use one of your own KBs, swap this for: const KB_ID = "<your kb id>";
const KB_ID = ctx.kb.RAG_LAB_KB_ID;

const { documents } = await ctx.kb.listDocuments(KB_ID);
ctx.log("found", documents.length, "documents in KB");
documents.forEach((d) => ctx.log("  •", d.name, "(" + d.length + " chars)"));

// Pull the full text of each document.
const loaded = await Promise.all(documents.map((d) => ctx.kb.getDocument(d.id)));
ctx.state.rawDocs = loaded;
return loaded.map((d) => ({ name: d.name, length: d.content.length }));
`,
    },

    // 2 — Chunk
    {
      id: "md-chunk", kind: "markdown",
      source: `## 2 · Chunk the corpus\n\n\`RecursiveCharacterTextSplitter\` keeps cuts on natural boundaries. Tune \`chunkSize\` / \`chunkOverlap\` and watch chunk count + later retrieval quality change.`,
    },
    {
      id: "chunk", kind: "code", language: "js", runtime: "browser",
      source: `const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { Document } = ctx.lc.documents;

// 👇 Tune me.
const CHUNK_SIZE = 320;
const CHUNK_OVERLAP = 60;

const raw = ctx.state.rawDocs.map((d) => new Document({
  pageContent: d.content,
  metadata: { source: d.name, kbDocumentId: d.id },
}));

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });
const chunks = await splitter.splitDocuments(raw);

ctx.state.chunks = chunks;
ctx.log("produced", chunks.length, "chunks from", raw.length, "documents");
return {
  chunks: chunks.length,
  bySource: chunks.reduce((acc, c) => {
    acc[c.metadata.source] = (acc[c.metadata.source] || 0) + 1;
    return acc;
  }, {}),
};
`,
    },

    // 3 — Embed + index
    {
      id: "md-embed", kind: "markdown",
      source: `## 3 · Embed every chunk and index for similarity search\n\nOne pass: \`MemoryVectorStore.fromDocuments\` embeds each chunk through our gateway proxy and keeps the resulting vectors in RAM. We also run a quick similarity probe so you can see retrieval working before we add the LLM.`,
    },
    {
      id: "embed", kind: "code", language: "js", runtime: "browser",
      source: `const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;

const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const store = await MemoryVectorStore.fromDocuments(ctx.state.chunks, embeddings);
ctx.state.store = store;
ctx.state.embeddings = embeddings;

// Sanity probe — should return chunks from the LangChain primer doc.
const probe = await store.similaritySearch("what does LangGraph add?", 2);
return probe.map((d) => ({ source: d.metadata.source, snippet: d.pageContent.slice(0, 100) + "…" }));
`,
    },

    // 4 — LCEL RAG chain
    {
      id: "md-chain", kind: "markdown",
      source: `## 4 · A full RAG chain with LCEL\n\nClassic LangChain Expression Language: retriever ➜ prompt ➜ LLM ➜ string parser. \`RunnablePassthrough\` passes the question through to the prompt while *also* using it to drive retrieval. The system prompt forbids the model from answering outside the retrieved context — try an off-topic question and watch it refuse.`,
    },
    {
      id: "rag-chain", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;
const { RunnablePassthrough, RunnableSequence } = ctx.lc.runnables;

const retriever = ctx.state.store.asRetriever({ k: 3 });

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "Answer ONLY from the provided context. Quote source names when you can. If the context doesn't cover it, reply: 'I don't know'."],
  ["human", "Context:\\n{context}\\n\\nQuestion: {question}"],
]);

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const formatDocs = (docs) =>
  docs.map((d) => "[" + d.metadata.source + "] " + d.pageContent).join("\\n\\n");

const ragChain = RunnableSequence.from([
  { context: async (q) => formatDocs(await retriever.invoke(q)), question: new RunnablePassthrough() },
  prompt,
  llm,
  new StringOutputParser(),
]);

ctx.state.ragChain = ragChain;
return await ragChain.invoke("What does LangGraph add on top of LangChain, and why does chunk overlap matter?");
`,
    },

    // 5 — RAG as a tool inside an agent
    {
      id: "md-agent", kind: "markdown",
      source: `## 5 · Production shape: RAG **as a tool** inside an agent\n\nThe most production-shaped pattern: wrap the retriever as a typed \`tool\`, give the agent other tools too, let it decide whether to *search the KB*, *do math*, or *both*. This is exactly how the platform's \`kb_search\` tool works on real Agents — except here you can read every line.`,
    },
    {
      id: "rag-agent", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { tool } = ctx.lc.tools;
const { z } = ctx.lc;
const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

const retriever = ctx.state.store.asRetriever({ k: 3 });

// 🔧 Tool 1: search the knowledge base (same shape as the platform's kb_search).
const kbSearch = tool(
  async ({ query }) => {
    const docs = await retriever.invoke(query);
    return JSON.stringify(docs.map((d) => ({ source: d.metadata.source, text: d.pageContent })));
  },
  {
    name: "kb_search",
    description: "Search the Notebook RAG Lab knowledge base for grounded context.",
    schema: z.object({ query: z.string().describe("Natural-language query") }),
  },
);

// 🔧 Tool 2: calculator.
const calc = tool(
  async ({ expr }) => String(Function('"use strict";return (' + expr + ')')()),
  { name: "calc", description: "Evaluate a simple math expression.", schema: z.object({ expr: z.string() }) },
);

const tools = [kbSearch, calc];
const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(tools);

const msgs = [
  new SystemMessage("Use kb_search for product questions. Use calc for math. Cite sources from kb_search."),
  new HumanMessage("Explain what LangGraph adds, and tell me 17 * 23."),
];

for (let i = 0; i < 5; i++) {
  const ai = await llm.invoke(msgs);
  msgs.push(ai);
  const calls = ai.tool_calls ?? [];
  if (!calls.length) return ai.content;
  ctx.log("turn", i + 1, "→", calls.map((c) => c.name).join(", "));
  for (const c of calls) {
    const out = await toolsByName[c.name].invoke(c.args);
    msgs.push(new ToolMessage({ content: String(out), tool_call_id: c.id }));
  }
}
return "(stopped at maxSteps)";
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## You just built the platform's RAG path from scratch\n\nEvery piece you used here has a production counterpart:\n\n| Notebook | Production |\n| --- | --- |\n| \`ctx.kb.getDocument()\` | \`knowledge_documents\` table, RLS-scoped |\n| \`RecursiveCharacterTextSplitter\` | Per-document RAG settings (\`/knowledge\` → doc → Settings) |\n| \`OpenAIEmbeddings(gemini-embedding-001)\` | \`embedAndStoreDocuments()\` server helper |\n| \`MemoryVectorStore\` | \`kb_chunks\` pgvector table + \`match_kb_chunks()\` RPC |\n| \`kb_search\` tool | Built-in \`kb_search\` tool on Agents |\n\nSwap the KB ID in cell 1 to point at one of your own knowledge bases and the entire pipeline runs against your data.`,
    },
  ],
};
