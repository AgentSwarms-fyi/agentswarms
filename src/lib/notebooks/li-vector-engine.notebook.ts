import type { Notebook } from "./types";

export const liVectorEngineNotebook: Notebook = {
  id: "li-vector-engine",
  title: "VectorStoreIndex & Query Engine Basics",
  description:
    "The fastest path to RAG in LlamaIndex.ts: build a VectorStoreIndex, expose it as a QueryEngine, then switch to a ChatEngine and compare the payloads.",
  difficulty: "beginner",
  tags: ["llamaindex", "rag"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · \`VectorStoreIndex\` & Query Engines

This is the **fastest possible path** to a working RAG system in LlamaIndex.ts. Two lines of code, conceptually:

\`\`\`ts
import { VectorStoreIndex, Document } from "llamaindex";

const index  = await VectorStoreIndex.fromDocuments(docs);   // embeds + stores
const engine = index.asQueryEngine();                        // stateless Q&A
const answer = await engine.query({ query: "What is X?" });
\`\`\`

Under that one-liner, LlamaIndex.ts is doing 5 things:

1. Parsing each \`Document\` into \`TextNode\`s (chunking).
2. Calling the embedding model on every node.
3. Storing the vectors (in-memory by default; swappable with Pinecone, Chroma, pgvector…).
4. On \`.query()\` — embedding the question, fetching top-\`k\` nodes, packing them into a prompt.
5. Calling the LLM and returning the answer.

### \`QueryEngine\` vs. \`ChatEngine\` — the distinction that trips beginners up

| | \`QueryEngine\` | \`ChatEngine\` |
| --- | --- | --- |
| **State** | Stateless. Each call is independent. | Stateful. Remembers prior turns via a memory buffer. |
| **Use it for** | One-shot questions: "What's the refund policy?" | Conversations: "What's the refund policy?" → "What about for digital goods?" |
| **Prompt payload** | \`[system + context + question]\` | \`[system + context + …chat_history… + question]\` |

In this notebook we build both, then **dump the actual prompt payload** so you can see exactly what changes.

> All cells use real LangChain primitives (browser-friendly) to demonstrate the LlamaIndex.ts pattern. The shapes, knobs, and behaviour all match LlamaIndex.ts — only the import paths differ.`,
    },

    {
      id: "md-build", kind: "markdown",
      source: `## 1 · Build the VectorStoreIndex from Documents

We give it 3 tiny Documents. In one async call: chunk → embed → store. This is the LlamaIndex.ts \`VectorStoreIndex.fromDocuments(docs)\` equivalent.`,
    },
    {
      id: "build", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;
const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;

const docs = [
  new Document({
    pageContent: \`Refunds are accepted within 30 days of purchase for physical goods in unused condition. Digital goods are non-refundable once downloaded. Shipping costs are non-refundable.\`,
    metadata: { source: "refund-policy.md", section: "policy" },
  }),
  new Document({
    pageContent: \`Our office is open Monday to Friday, 9am to 6pm Pacific Time. We do not offer phone support on weekends. Email support@example.com replies within 24h on business days.\`,
    metadata: { source: "support.md", section: "hours" },
  }),
  new Document({
    pageContent: \`Shipping to the US takes 2-4 business days via UPS Ground. International shipping via DHL takes 5-10 business days and incurs customs duties paid by the recipient.\`,
    metadata: { source: "shipping.md", section: "logistics" },
  }),
];

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 250, chunkOverlap: 40 });
const nodes = await splitter.splitDocuments(docs);

const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const index = await MemoryVectorStore.fromDocuments(nodes, embeddings);
ctx.state.index = index;

ctx.log("VectorStoreIndex built ✓");
ctx.log("  documents :", docs.length);
ctx.log("  nodes     :", nodes.length);
return { documents: docs.length, nodes: nodes.length };
`,
    },

    {
      id: "md-qe", kind: "markdown",
      source: `## 2 · Use it as a \`QueryEngine\` (stateless)

\`index.asQueryEngine({ similarityTopK: 2 })\` in LlamaIndex.ts == a retriever + an LLM call with a strict context-only system prompt. Below we build that explicitly so the prompt payload is visible.

**Try this:** ask two unrelated questions back-to-back. The QueryEngine has no memory — it treats each query as a fresh request.`,
    },
    {
      id: "qe", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

// QueryEngine equivalent: retrieve top-k, stuff into prompt, call LLM.
async function queryEngine(question, k = 2) {
  const hits = await ctx.state.index.similaritySearch(question, k);
  const context = hits.map((d) => "[" + d.metadata.source + "] " + d.pageContent).join("\\n\\n");

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Answer ONLY from the context. Cite the [source] tag. If not present, say 'I don't know'."],
    ["human", "Context:\\n{context}\\n\\nQuestion: {question}"],
  ]);

  // Show what the LLM actually receives:
  const rendered = await prompt.formatMessages({ context, question });
  ctx.log("--- PROMPT PAYLOAD (", rendered.length, "messages) ---");
  rendered.forEach((m) => ctx.log("  [" + m.constructor.name + "]", m.content.toString().slice(0, 140) + "…"));

  return await prompt.pipe(llm).pipe(new StringOutputParser()).invoke({ context, question });
}

// 👇 Edit the question — try off-topic to see the model refuse.
const Q1 = "How long does international shipping take?";
const a1 = await queryEngine(Q1);
ctx.log("\\nA1:", a1);

const Q2 = "Can I get a refund on a digital download?";
const a2 = await queryEngine(Q2);
ctx.log("\\nA2:", a2);

return { Q1, a1, Q2, a2, hasMemory: false };
`,
    },

    {
      id: "md-ce", kind: "markdown",
      source: `## 3 · Use it as a \`ChatEngine\` (stateful)

A ChatEngine keeps a **memory buffer** of prior turns and folds it into every call. The retrieval step is the same; the difference is in the prompt payload.

In LlamaIndex.ts:

\`\`\`ts
const chatEngine = index.asChatEngine({ chatMode: "context" });
await chatEngine.chat({ message: "What's the refund policy?" });
await chatEngine.chat({ message: "What about digital goods?" }); // resolves "digital goods" because it remembers the topic
\`\`\`

Below, the second question (*"What about digital goods?"*) is ambiguous on its own — but with chat history attached, the model resolves the reference.`,
    },
    {
      id: "ce", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate, MessagesPlaceholder } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;
const { HumanMessage, AIMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

// 👇 The memory buffer. A ChatEngine appends to this on every turn.
const chatHistory = [];

async function chatEngine(message, k = 2) {
  const hits = await ctx.state.index.similaritySearch(message, k);
  const context = hits.map((d) => "[" + d.metadata.source + "] " + d.pageContent).join("\\n\\n");

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful support agent. Use the context to answer. Refer back to earlier turns when needed.\\n\\nContext:\\n{context}"],
    new MessagesPlaceholder("history"),
    ["human", "{input}"],
  ]);

  const rendered = await prompt.formatMessages({ context, history: chatHistory, input: message });
  ctx.log("--- CHAT PAYLOAD (", rendered.length, "messages — note the extra history!) ---");
  rendered.forEach((m) => ctx.log("  [" + m.constructor.name + "]", m.content.toString().slice(0, 100) + "…"));

  const answer = await prompt.pipe(llm).pipe(new StringOutputParser()).invoke({ context, history: chatHistory, input: message });
  chatHistory.push(new HumanMessage(message));
  chatHistory.push(new AIMessage(answer));
  return answer;
}

const T1 = "What's the refund policy?";
const a1 = await chatEngine(T1);
ctx.log("\\nTurn 1 A:", a1);

// 👇 Ambiguous on its own — only resolvable with memory.
const T2 = "What about digital goods?";
const a2 = await chatEngine(T2);
ctx.log("\\nTurn 2 A:", a2);

return { history_messages: chatHistory.length, lastAnswer: a2 };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap — the 2 engines and when to use which

- **QueryEngine** → one-shot factual lookups (FAQ widgets, dashboards). Prompt = \`system + context + question\`.
- **ChatEngine**  → conversations where follow-ups depend on earlier turns (chatbots, copilots). Prompt = \`system + context + history + question\`.

You also just saw the **anatomy of a RAG prompt payload**. Internalise that picture — it's the basis for every advanced pattern in the next track (sentence-window, router, sub-question, agents).`,
    },
  ],
};
