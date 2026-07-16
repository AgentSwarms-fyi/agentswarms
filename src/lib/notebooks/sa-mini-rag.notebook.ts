import type { Notebook } from "./types";

export const saMiniRagNotebook: Notebook = {
  id: "sa-mini-rag",
  title: "Basic Document RAG (Embeddings & Retrieval)",
  description:
    "Pull a real document from the platform Knowledge Base, chunk it, embed every chunk with the embedding model, retrieve the top matches for a question, then ground the LLM on those matches. Tune chunk size and watch retrieval quality change.",
  difficulty: "beginner",
  tags: ["agent", "langchain", "rag"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 9 · Basic Document RAG

Retrieval-Augmented Generation answers questions from **your documents**, not from the LLM's parametric memory. The whole pipeline is four steps:

1. **Load** the source document
2. **Chunk** it into passages small enough to embed cleanly
3. **Embed** every chunk into a vector space
4. **Retrieve** the top-k closest chunks for a user query, then ask the LLM to answer **only from those chunks**

In this notebook every step runs live. The source document comes from the platform's Knowledge Base — the same store that powers Agents and Swarms. We're using the read-only **Sample · Notebook RAG Lab** > *Eiffel Tower* document, but you can swap in any KB document you have access to (your own uploads work too).

## Why chunk at all?

An embedding model maps **a passage** into one vector. If you embed an entire 50-page document into a single vector, every query returns "yes, this is about the document" and nothing more specific. If you embed every single word, each vector loses the surrounding context that gives it meaning. The sweet spot is a chunk big enough to be a coherent idea (a paragraph or two) but small enough that the resulting vector still represents *one* topic.

Typical knobs:

- **chunkSize** — target characters per chunk. 500–1500 chars is a common starting band for general prose.
- **chunkOverlap** — characters shared between adjacent chunks (≈10–20% of chunkSize). Prevents an answer from being split across a cut.
- **strategy** — *recursive* (paragraph → sentence → character) preserves structure; *fixed* every-N-chars is simplest but butchers sentences; *semantic* cuts where adjacent-sentence embeddings diverge (see the Semantic Chunking notebook).`,
    },

    {
      id: "md-load", kind: "markdown",
      source: `## 1 · Load the source document from the Knowledge Base\n\n\`ctx.kb.getDocument()\` calls a server function that fetches a row from \`knowledge_documents\` via the same RLS policy used by Agents — sample docs are visible to everyone; your own docs are visible to you. The cell below pulls the Eiffel Tower entry by its stable sample ID.\n\n**Swap it for your own KB doc** by replacing the ID with any document ID from \`/knowledge\`.`,
    },
    {
      id: "load", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 The Notebook RAG Lab ships with stable sample doc IDs. Change this
//    to any document UUID from your /knowledge page to use your own data.
const DOCUMENT_ID = ctx.kb.DOCS.eiffelTower;

const doc = await ctx.kb.getDocument(DOCUMENT_ID);
ctx.state.doc = doc;

ctx.log("loaded:", doc.name);
ctx.log("source:", doc.isSample ? "sample (read-only)" : "your own KB document");
ctx.log("length:", doc.content.length, "chars");
return { name: doc.name, length: doc.content.length, preview: doc.content.slice(0, 220) };
`,
    },

    {
      id: "md-chunk", kind: "markdown",
      source: `## 2 · Chunk the document\n\n\`RecursiveCharacterTextSplitter\` tries paragraphs first, then sentences, then characters — it keeps cuts on natural boundaries whenever possible. Edit \`chunkSize\` / \`chunkOverlap\` below and re-run all later cells to see retrieval quality change in real time.\n\n- Drop \`chunkSize\` to 80 → answers fragment because no single chunk holds a full fact.\n- Push \`chunkSize\` to 2000 → only one or two chunks exist, so retrieval becomes useless (every query returns "the whole doc").`,
    },
    {
      id: "chunk", kind: "code", language: "js", runtime: "browser",
      source: `const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { Document } = ctx.lc.documents;

// 👇 Tune these and re-run cells 3 + 4 to feel the tradeoff.
const CHUNK_SIZE = 250;
const CHUNK_OVERLAP = 40;

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

const docs = await splitter.splitDocuments([
  new Document({
    pageContent: ctx.state.doc.content,
    metadata: { source: ctx.state.doc.name, kbDocumentId: ctx.state.doc.id },
  }),
]);

ctx.state.chunks = docs;
ctx.log("produced", docs.length, "chunks");
docs.forEach((d, i) => ctx.log("  #" + (i + 1), "[" + d.pageContent.length + " chars]:", d.pageContent.slice(0, 80) + (d.pageContent.length > 80 ? "…" : "")));

return { count: docs.length, sizes: docs.map((d) => d.pageContent.length) };
`,
    },

    {
      id: "md-embed", kind: "markdown",
      source: `## 3 · Embed every chunk\n\n\`OpenAIEmbeddings\` runs through our OpenAI-compatible \`/v1/embeddings\` proxy on the Lovable AI Gateway. We use \`google/gemini-embedding-001\` — the platform default that backs the production Knowledge Base too.\n\n\`MemoryVectorStore.fromDocuments\` embeds every chunk in one pass and keeps the resulting vectors in browser RAM. In production you'd write these vectors to pgvector / Pinecone / etc. — the platform's Knowledge Base does exactly that under the hood (see \`kb_chunks\`).`,
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

// Probe the dimensionality so you can see what just got created.
const [probe] = await embeddings.embedDocuments([ctx.state.chunks[0].pageContent.slice(0, 200)]);
ctx.log("embedded", ctx.state.chunks.length, "chunks →", probe.length, "-dim vectors");
return { chunks: ctx.state.chunks.length, dimensions: probe.length };
`,
    },

    {
      id: "md-ask", kind: "markdown",
      source: `## 4 · Retrieve + ask\n\nEdit \`QUESTION\` and re-run. Two things happen:\n\n1. The retriever embeds the question with the *same* model used for the chunks, then returns the \`k\` chunks whose vectors are closest by cosine similarity.\n2. We stuff those chunks into the system prompt with a strict rule: **"Answer ONLY from the context. If the answer isn't there, reply 'I don't know'."**\n\nTry an off-topic question (e.g. *"Who won the 2018 World Cup?"*) — the model should refuse rather than hallucinate. That refusal is *grounding* working as intended.`,
    },
    {
      id: "ask", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

// 👇 Edit this question. Try on-topic AND off-topic queries.
const QUESTION = "How tall is the Eiffel Tower and who built it?";

const retriever = ctx.state.store.asRetriever({ k: 2 });
const hits = await retriever.invoke(QUESTION);
ctx.log("retrieved", hits.length, "chunks for question");
hits.forEach((d, i) => ctx.log("  hit", i + 1, "→", d.pageContent.slice(0, 120) + "…"));

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "Answer ONLY from the context. If the answer isn't there, reply: 'I don't know'."],
  ["human", "Context:\\n{context}\\n\\nQuestion: {question}"],
]);

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const chain = prompt.pipe(llm).pipe(new StringOutputParser());
return await chain.invoke({
  context: hits.map((d) => "- " + d.pageContent).join("\\n"),
  question: QUESTION,
});
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Where to go next\n\n- **Swap the document.** Open \`/knowledge\`, upload one of your own files, copy its document ID, and paste it into cell 1. The rest of the pipeline runs unchanged.\n- **List everything available.** \`await ctx.kb.listDocuments()\` returns all docs in the Notebook RAG Lab. Pass a \`knowledgeBaseId\` to scope to one of your own KBs.\n- **Promote to production.** The platform's Knowledge Base already chunks + embeds + stores in pgvector for you — see Agents → Tools → \`kb_search\`. This notebook just makes the same pipeline transparent.\n- **Then graduate to:** *Embeddings, RAG & RAG-with-Tools* (full LCEL chain + tool-calling agent that uses retrieval as one of several tools).`,
    },
  ],
};
