import type { Notebook } from "./types";

export const liSentenceWindowNotebook: Notebook = {
  id: "li-sentence-window",
  title: "Sentence Window Retrieval",
  description:
    "Embed single sentences for precision, then expand to a configurable window of surrounding sentences at query time. Slide the window and see the prompt grow.",
  difficulty: "intermediate",
  tags: ["llamaindex", "rag"],
  subgroup: "Advanced RAG Patterns",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 3 · Sentence Window Retrieval

A core problem with vanilla RAG: **you have to pick a chunk size, and every chunk size is wrong somewhere.**

- Big chunks (500–1000 chars) → the embedding represents *several ideas at once*. Search precision drops.
- Small chunks (single sentence) → the embedding is sharp, but the chunk alone often lacks the context the LLM needs to answer.

**Sentence Window Retrieval** is LlamaIndex's elegant fix:

1. **Embed single sentences** — maximally precise retrieval signal.
2. **At query time**, when a sentence matches, fetch a **window of N sentences before and after it** as the context handed to the LLM.

You get precise *retrieval* and rich *context* — without the usual tradeoff.

### The LlamaIndex.ts API

\`\`\`ts
import { SentenceWindowNodeParser, MetadataReplacementPostProcessor } from "llamaindex";

const parser = new SentenceWindowNodeParser({ windowSize: 3 });
const nodes  = parser.getNodesFromDocuments([doc]);
const index  = await VectorStoreIndex.fromNodes(nodes);

const engine = index.asQueryEngine({
  nodePostprocessors: [new MetadataReplacementPostProcessor("window")],
});
\`\`\`

Each node stores: \`text\` (the single sentence — what gets embedded) and \`metadata.window\` (sentence ± N — what's substituted in at query time).

In this notebook we build that exact pipeline by hand so you can see the substitution happen.`,
    },

    {
      id: "md-prep", kind: "markdown",
      source: `## 1 · Split the source into individual sentences

The unit we embed is **one sentence**. We also store, alongside each sentence, the index range it covers so we can rebuild a window later.`,
    },
    {
      id: "prep", kind: "code", language: "js", runtime: "browser",
      source: `const TEXT = \`The Eiffel Tower was completed in 1889 for the World's Fair in Paris. \\
It stands 330 meters tall including its antennas. \\
Gustave Eiffel's company designed and built it as a centerpiece of the exposition. \\
When it opened, many prominent Parisians signed a petition denouncing it as an eyesore. \\
The tower was originally intended to stand for only 20 years. \\
It was saved by becoming a radio transmission antenna in the early 1900s. \\
Today it receives nearly 7 million visitors annually. \\
The structure is repainted every 7 years using around 60 tons of paint. \\
The paint is applied in three shades, with the darkest at the bottom, to give a uniform appearance against the Paris sky. \\
At night, the tower's golden lighting uses 20,000 light bulbs that sparkle every hour on the hour.\`;

// Simple sentence splitter (good enough for the demo).
const sentences = TEXT.split(/(?<=[.!?])\\s+/).map((s) => s.trim()).filter(Boolean);

ctx.state.sentences = sentences;
ctx.log("Split into", sentences.length, "sentences:");
sentences.forEach((s, i) => ctx.log("  #" + i, "·", s.slice(0, 80) + (s.length > 80 ? "…" : "")));
return { count: sentences.length };
`,
    },

    {
      id: "md-embed", kind: "markdown",
      source: `## 2 · Embed each sentence as its own node

This is the precision step. Every sentence becomes one vector. Notice each node also stores its \`sentenceIndex\` so we can fetch its neighbours later.`,
    },
    {
      id: "embed", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;
const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;

const sentenceNodes = ctx.state.sentences.map((s, i) =>
  new Document({
    pageContent: s, // what gets embedded — JUST the sentence
    metadata: { sentenceIndex: i, source: "eiffel.md" },
  }),
);

const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const store = await MemoryVectorStore.fromDocuments(sentenceNodes, embeddings);
ctx.state.store = store;
ctx.log("Embedded", sentenceNodes.length, "single-sentence nodes ✓");
return { embedded: sentenceNodes.length };
`,
    },

    {
      id: "md-window", kind: "markdown",
      source: `## 3 · Retrieve a sentence, then expand to a window

This is the LlamaIndex \`MetadataReplacementPostProcessor("window")\` step. The retriever returns matching sentences; we substitute each with its **window** (\`N\` sentences before + the match + \`N\` after) before sending to the LLM.

**Slide \`WINDOW_SIZE\`** below and re-run. With \`0\` the LLM only sees the matched sentence (often too little). With \`3\` it sees a paragraph-sized neighbourhood. Watch the prompt payload size grow.`,
    },
    {
      id: "window", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

// 👇 The knob from the notebook intro. Try 0, 1, 3, 5.
const WINDOW_SIZE = 2;

// 👇 Edit the question.
const QUESTION = "Why was the Eiffel Tower not torn down after 20 years?";

const matches = await ctx.state.store.similaritySearch(QUESTION, 2);
ctx.log("Matched sentences (the precise retrieval signal):");
matches.forEach((m) => ctx.log("  →", m.pageContent));

// Expand each match to its window of surrounding sentences.
const sentences = ctx.state.sentences;
function buildWindow(centerIdx) {
  const start = Math.max(0, centerIdx - WINDOW_SIZE);
  const end   = Math.min(sentences.length, centerIdx + WINDOW_SIZE + 1);
  return sentences.slice(start, end).join(" ");
}

const contextWindows = matches.map((m) => ({
  matched: m.pageContent,
  window:  buildWindow(m.metadata.sentenceIndex),
}));

ctx.log("\\n--- Expanded windows handed to the LLM (WINDOW_SIZE =", WINDOW_SIZE, ") ---");
contextWindows.forEach((w, i) => ctx.log("  [" + i + "]", w.window));

const context = contextWindows.map((w) => w.window).join("\\n\\n");
ctx.log("\\nTotal context chars:", context.length, "(grows with WINDOW_SIZE)");

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "Answer ONLY from the provided context windows."],
  ["human", "Context:\\n{context}\\n\\nQuestion: {question}"],
]);
const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

return await prompt.pipe(llm).pipe(new StringOutputParser()).invoke({ context, question: QUESTION });
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## When to reach for sentence-window retrieval

- Long-form documents (books, transcripts, legal contracts) where a single answer often hinges on **the sentence before or after** a key claim.
- Cases where vanilla chunked RAG returns "almost right" answers — sentence-window typically improves *faithfulness* without changing the index size much (you index the same characters, just split finer).

**Tradeoffs to know:**

- Indexing cost goes up (more vectors).
- Prompt tokens at query time go up (each match expands).
- It's still vector-only. For *global* questions like "summarise the whole document", you'll want the **Router Query Engine** in the next notebook.`,
    },
  ],
};
