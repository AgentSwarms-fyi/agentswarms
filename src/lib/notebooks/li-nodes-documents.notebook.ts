import type { Notebook } from "./types";

export const liNodesDocumentsNotebook: Notebook = {
  id: "li-nodes-documents",
  title: "From Raw Text to Nodes (Document vs. TextNode)",
  description:
    "LlamaIndex's Document/TextNode model: attach metadata, define how a Document is parsed into atomic Nodes, and watch metadata flow into each chunk.",
  difficulty: "beginner",
  tags: ["llamaindex", "rag"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 1 · From Raw Text to Nodes — \`Document\` vs. \`TextNode\`

> **New to coding?** Read the markdown in each cell first, then run the code cell below it. Tweak one value, re-run, and watch the output change. That's the whole loop.

LlamaIndex.ts is a TypeScript framework for **building RAG systems** (Retrieval-Augmented Generation — "look things up, *then* ask the LLM"). Before you can search anything, you need to convert raw text into the two core data types LlamaIndex revolves around:

| Type | What it is | When you create it |
| --- | --- | --- |
| \`Document\` | A whole source: a PDF, a webpage, a database row. Holds the **full text** + **metadata** (title, author, URL, tags…). | Once per source file. |
| \`TextNode\` | An atomic **chunk** of a Document — usually a paragraph or a sentence. Inherits the parent Document's metadata + adds its own (chunk index, char position). | One Document produces many TextNodes via a **node parser** (chunker). |

### Why this two-level model matters

When the retriever finds a relevant chunk, you don't just want the chunk — you want to know **where it came from** (which document, which page, which author). That's what metadata is for. Every TextNode keeps a pointer back to its parent Document, so retrieval results stay traceable.

### The LlamaIndex.ts API you'll see in the wild

\`\`\`ts
import { Document, SentenceSplitter } from "llamaindex";

const doc = new Document({
  text: "Long article text…",
  metadata: { author: "Ada Lovelace", category: "history", year: 1843 },
});

const parser = new SentenceSplitter({ chunkSize: 200, chunkOverlap: 30 });
const nodes  = parser.getNodesFromDocuments([doc]);
// → nodes[i].metadata still has { author, category, year } + { chunkIndex, startCharIdx, … }
\`\`\`

**In this notebook** we build the *same* pipeline on the existing browser-ready stack (LangChain's \`Document\` + \`RecursiveCharacterTextSplitter\`) so every cell runs live. The data model and metadata-inheritance behaviour are identical to LlamaIndex.ts — only the import paths differ.`,
    },

    {
      id: "md-doc", kind: "markdown",
      source: `## 1 · Create a \`Document\` with metadata

A Document is just \`{ text, metadata }\`. The \`metadata\` is a free-form object — put whatever your downstream code can use to filter or display results. Common keys: \`source\`, \`author\`, \`category\`, \`date\`, \`url\`, \`tags\`.

**Try this:** change the \`metadata\` values below and re-run. You'll see the metadata follow the chunks through every later cell.`,
    },
    {
      id: "doc", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;

// 👇 Edit the metadata — every TextNode parsed from this Document inherits it.
const doc = new Document({
  pageContent: \`The transformer architecture was introduced in 2017 by Vaswani et al.
in the paper "Attention Is All You Need". It replaced recurrent layers with
self-attention, enabling massive parallelism and longer effective context.

The original model had 6 encoder and 6 decoder layers, 8 attention heads,
and 512-dimensional embeddings. Training used 8 NVIDIA P100 GPUs for 12 hours
on a small task and 3.5 days on the full WMT 2014 English-to-German set.

Modern descendants (GPT, BERT, Llama, Gemini) all keep the self-attention
core but tweak the layer count, position encoding, normalization, and
training objective. The architecture has proven remarkably general — the
same recipe powers vision transformers, audio transformers, and protein
folding networks.\`,
  metadata: {
    source: "transformer-history.md",
    author: "Ada Notebook",
    category: "ml-history",
    year: 2017,
    tags: ["transformers", "attention"],
  },
});

ctx.state.doc = doc;
ctx.log("Document length:", doc.pageContent.length, "chars");
ctx.log("Document metadata:", JSON.stringify(doc.metadata));
return { length: doc.pageContent.length, metadata: doc.metadata };
`,
    },

    {
      id: "md-parse", kind: "markdown",
      source: `## 2 · Parse the Document into TextNodes (chunks)

A **node parser** turns a Document into a list of TextNodes. In LlamaIndex.ts this is \`SentenceSplitter\` / \`SentenceWindowNodeParser\` / etc. Here we use \`RecursiveCharacterTextSplitter\`, which has the same job and the same two knobs:

- **\`chunkSize\`** — target characters per chunk. Too small (50) → ideas fragment across chunks. Too large (2000) → embedding signal gets diluted ("this chunk is about everything").
- **\`chunkOverlap\`** — how many characters adjacent chunks share. ~10–20% of \`chunkSize\` is a good default — it stops answers being sliced in half at a chunk boundary.

**Notice** how each resulting node *automatically inherits* the parent Document's metadata, plus adds its own \`loc\` info (which slice of the source it came from). That metadata is what lets a retrieval result say "this came from \`transformer-history.md\` by Ada Notebook".`,
    },
    {
      id: "parse", kind: "code", language: "js", runtime: "browser",
      source: `const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;

// 👇 Edit these and re-run to feel the tradeoff.
const CHUNK_SIZE = 220;
const CHUNK_OVERLAP = 40;

const parser = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

const nodes = await parser.splitDocuments([ctx.state.doc]);
ctx.state.nodes = nodes;

ctx.log("Parsed", nodes.length, "TextNodes from 1 Document");
ctx.log("--- First node ---");
ctx.log("text  :", nodes[0].pageContent);
ctx.log("meta  :", JSON.stringify(nodes[0].metadata));

return nodes.map((n, i) => ({
  nodeIndex: i,
  charCount: n.pageContent.length,
  inheritedAuthor: n.metadata.author,
  inheritedCategory: n.metadata.category,
  preview: n.pageContent.slice(0, 60) + (n.pageContent.length > 60 ? "…" : ""),
}));
`,
    },

    {
      id: "md-custom", kind: "markdown",
      source: `## 3 · Custom node parsing — attach your own metadata per chunk

Sometimes you want each chunk to carry its *own* metadata, beyond what it inherited. Classic examples:

- A \`chunkIndex\` (so you can show "page 3 of 7" in a UI).
- A computed \`tokenCount\` for budgeting.
- A \`section\` extracted from a header line at the top of the chunk.

The LlamaIndex.ts way is to subclass the node parser or run a post-processing pass over the returned nodes. The post-processing pattern is simpler and identical in effect — that's what we do here.`,
    },
    {
      id: "custom", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 Pretend each chunk should know which paragraph (roughly) it came from.
// We also count words and detect any all-caps "section header" at the top.
const enriched = ctx.state.nodes.map((node, i) => {
  const text = node.pageContent;
  const firstLine = text.split("\\n")[0] || "";
  const looksLikeHeader = firstLine.length < 60 && firstLine === firstLine.toUpperCase() && /[A-Z]/.test(firstLine);
  return {
    ...node,
    metadata: {
      ...node.metadata,
      chunkIndex: i,
      wordCount: text.split(/\\s+/).filter(Boolean).length,
      section: looksLikeHeader ? firstLine : "body",
    },
  };
});

ctx.state.nodes = enriched;

ctx.log("Sample enriched metadata:");
enriched.slice(0, 3).forEach((n) =>
  ctx.log("  #" + n.metadata.chunkIndex,
          "·", n.metadata.wordCount, "words",
          "·", n.metadata.section,
          "·", n.metadata.author),
);

return enriched.map((n) => n.metadata);
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## You just built the LlamaIndex \`Document → TextNode\` pipeline

What you should walk away with:

1. **Documents hold sources.** TextNodes hold *atoms of those sources*. Always work with both — never just raw strings.
2. **Metadata is inherited automatically.** Anything you attach to the Document flows down into every chunk. This is what makes retrieval *traceable* later.
3. **The node parser is a knob, not a magic step.** \`chunkSize\` and \`chunkOverlap\` directly determine retrieval quality. There is no "correct" value — only what works for your text shape.

In the next notebook (**VectorStoreIndex & Query Engine Basics**) we'll feed nodes like these into an index, expose them as a Query Engine, and ask real questions.`,
    },
  ],
};
