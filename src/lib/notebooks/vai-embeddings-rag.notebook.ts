import type { Notebook } from "./types";

export const vaiEmbeddingsRagNotebook: Notebook = {
  id: "vai-embeddings-rag",
  title: "embed, embedMany & cosineSimilarity (Mini RAG)",
  description:
    "The Vercel AI SDK's embedding helpers — one function for a single embedding, one for batches, plus cosineSimilarity. Build a full mini-RAG pipeline in one cell.",
  difficulty: "intermediate",
  tags: ["rag"],
  subgroup: "Embeddings & RAG",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 5 · Embeddings & a Mini RAG Pipeline

The Vercel AI SDK has the same single-call shape for embeddings as it does for text generation:

\`\`\`ts
import { embed, embedMany, cosineSimilarity } from "ai";
import { openai } from "@ai-sdk/openai";

const { embedding } = await embed({
  model: openai.textEmbeddingModel("text-embedding-3-small"),
  value: "What is RAG?",
});

const { embeddings, usage } = await embedMany({
  model: openai.textEmbeddingModel("text-embedding-3-small"),
  values: ["doc one...", "doc two...", "doc three..."],
});

const sim = cosineSimilarity(embedding, embeddings[0]); // 0..1 (higher = more similar)
\`\`\`

That's the whole API surface for retrieval:

| Function | Use for |
| --- | --- |
| \`embed({ model, value })\` | A single embedding — typically the **query**. |
| \`embedMany({ model, values })\` | Batched embeddings — typically your **document chunks**. Auto-batches under the provider's limit. |
| \`cosineSimilarity(a, b)\` | Pure JS, no provider call. Use for top-k ranking in memory. |

For production at scale you store \`embeddings\` in a vector DB (pgvector, Pinecone, Qdrant, Chroma). The SDK doesn't ship a vector store — that's a deliberate design choice. **You bring the storage; the SDK gives you the math.**

Below we build a full Mini-RAG pipeline: chunk → embed → retrieve top-k → grounded answer with citations.`,
    },

    {
      id: "md-ingest", kind: "markdown",
      source: `## 1 · Ingest: chunk + \`embedMany\``,
    },
    {
      id: "ingest", kind: "code", language: "js", runtime: "browser",
      source: `// Mini "knowledge base" — 6 fictional policy snippets.
const docs = [
  { id: "ret-1", text: "Returns: Items can be returned within 30 days of delivery for a full refund. Items must be in original packaging." },
  { id: "ret-2", text: "Returns: Final-sale items, gift cards, and personalised products cannot be returned." },
  { id: "ship-1", text: "Shipping: Standard delivery takes 3-5 business days within the US. Free for orders over $50." },
  { id: "ship-2", text: "Shipping: Express delivery (1-2 days) costs $14.99. International shipping varies by country." },
  { id: "war-1", text: "Warranty: Electronics carry a 1-year manufacturer warranty covering defects in materials and workmanship." },
  { id: "war-2", text: "Warranty: Damage from drops, water, or unauthorised repairs is not covered by warranty." },
];

// embedMany — batched call, returns { embeddings: number[][], usage }
async function embedMany({ model, values }) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model, input: values }),
  });
  const data = await res.json();
  return { embeddings: data.data.map((d) => d.embedding), usage: data.usage };
}

const { embeddings, usage } = await embedMany({
  model: "google/gemini-embedding-001",
  values: docs.map((d) => d.text),
});

const store = docs.map((d, i) => ({ ...d, embedding: embeddings[i] }));
ctx.state.store = store;
ctx.log("ingested", store.length, "docs · embedding dim:", embeddings[0].length, "· tokens:", JSON.stringify(usage));
return { docCount: store.length, dim: embeddings[0].length };
`,
    },

    {
      id: "md-query", kind: "markdown",
      source: `## 2 · Query: \`embed\` + \`cosineSimilarity\` + generate

The retrieval step is just: embed the query, rank with \`cosineSimilarity\`, slice top-k.`,
    },
    {
      id: "query", kind: "code", language: "js", runtime: "browser",
      source: `// embed — single value
async function embed({ model, value }) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model, input: value }),
  });
  return { embedding: (await res.json()).data[0].embedding };
}

// Pure-JS cosine similarity. Same shape the SDK ships.
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function askRag(question, k = 3) {
  ctx.log("\\nQ:", question);
  const { embedding } = await embed({ model: "google/gemini-embedding-001", value: question });

  // Rank, slice, take top-k.
  const ranked = ctx.state.store
    .map((d) => ({ ...d, score: cosineSimilarity(embedding, d.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  ctx.log("top-k:");
  ranked.forEach((r) => ctx.log(\`  [\${r.score.toFixed(3)}] \${r.id}: \${r.text.slice(0, 70)}…\`));

  const context = ranked.map((r) => \`[\${r.id}] \${r.text}\`).join("\\n");
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: "Answer ONLY from the provided context. Cite the [id] of each fact you use. If not in context, say 'Not in policy.'" },
        { role: "user", content: \`Context:\\n\${context}\\n\\nQuestion: \${question}\` },
      ],
    }),
  });
  const answer = (await res.json()).choices[0].message.content;
  ctx.log("A:", answer);
  return { question, answer, citations: ranked.map((r) => r.id) };
}

const out = [
  await askRag("Can I return a gift card?"),
  await askRag("How long does express shipping take and what does it cost?"),
  await askRag("Is water damage covered by the warranty?"),
  await askRag("Do you ship to Mars?"),  // ← should refuse — not in context
];
return out;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & next steps

You now know the full Vercel SDK RAG toolkit:

- **\`embed\`** — single query embedding.
- **\`embedMany\`** — batched document embeddings, auto-chunked to the provider's limit.
- **\`cosineSimilarity\`** — local ranking math, no provider call.
- Stitch together with \`generateText\` for a grounded answer.

### Production swaps

| Step | Prototype (this notebook) | Production |
| --- | --- | --- |
| Chunking | One row per snippet | Recursive text splitter (LangChain TS, llamaindex.ts, or your own) with overlap |
| Storage | In-memory array | pgvector / Pinecone / Qdrant / Chroma |
| Ranking | \`cosineSimilarity\` over all docs | Vector DB ANN index + metadata filter |
| Reranking | None | Cohere Rerank / Voyage Rerank as a second pass on top-50 |
| Eval | Eyeballing | The **RAG Triad** notebook in the *Agentic Evals* track |

The SDK's job is steps 1, 4 and the final \`generateText\` — everything else is provider-agnostic infra you bring yourself. That separation is what makes the Vercel AI SDK survive provider churn.`,
    },
  ],
};
