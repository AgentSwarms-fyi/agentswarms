import type { Notebook } from "./types";

export const mstRagNotebook: Notebook = {
  id: "mst-rag",
  title: "RAG — MDocument, chunking, embedMany & createVectorQueryTool",
  description:
    "Mastra's RAG stack end to end: build an MDocument, chunk it with the recursive strategy, embed with embedMany, store in an in-browser vector index, and expose it to an Agent as a real createVectorQueryTool over a tiny e-bike support knowledge base.",
  difficulty: "intermediate",
  tags: ["agent", "rag"],
  subgroup: "RAG",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 5 · RAG — \`MDocument\`, \`chunk\`, \`embedMany\`, \`createVectorQueryTool\`

Mastra ships a focused RAG stack in **\`@mastra/rag\`** that maps cleanly onto a real production pipeline:

1. **\`MDocument\`** wraps raw text/HTML/Markdown plus metadata.
2. **\`doc.chunk({ strategy, maxSize, overlap })\`** splits it into retrieval-sized pieces.
3. **\`embedMany\`** (from \`ai\`) turns chunks into vectors using any provider through the model router.
4. **A vector store** (\`PgVector\`, \`PineconeVector\`, \`LibSqlVector\`, \`UpstashVector\`, …) holds the vectors.
5. **\`createVectorQueryTool\`** packages the retrieval as a typed Mastra tool an Agent can call.

\`\`\`ts
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { PgVector } from "@mastra/pg";
import { createVectorQueryTool } from "@mastra/rag";

const doc = MDocument.fromMarkdown(supportHandbookMd, { source: "handbook.md" });
const chunks = await doc.chunk({ strategy: "recursive", maxSize: 256, overlap: 50 });

const { embeddings } = await embedMany({
  model:  new ModelRouterEmbeddingModel("openai/text-embedding-3-small"),
  values: chunks.map((c) => c.text),
});

const pg = new PgVector({ id: "pg", connectionString: process.env.PG_URL });
await pg.upsert({
  indexName: "support",
  vectors: embeddings,
  metadata: chunks.map((c) => ({ text: c.text, ...c.metadata })),
});

const supportSearch = createVectorQueryTool({
  vectorStoreName: "pg",
  indexName: "support",
  model: new ModelRouterEmbeddingModel("openai/text-embedding-3-small"),
});
// → an Agent with this tool can answer questions grounded in the handbook
\`\`\`

### Chunking strategies you'll actually use

| Strategy | When |
| --- | --- |
| \`recursive\` | Default. Splits on paragraph → sentence → word boundaries until under \`maxSize\`. Almost always the right answer. |
| \`character\` | Hard char count. Use only when you genuinely don't care about meaning (logs). |
| \`markdown\` | Respects heading hierarchy — chunks carry their nearest H1/H2 in metadata. Great for docs. |
| \`html\` | DOM-aware, keeps element scope. Web scrape post-processing. |
| \`json\` | Splits arrays of objects so each chunk is still parseable JSON. |
| \`token\` | Split on real model tokens (needs a tokenizer). For when context-window accounting must be exact. |

### Vector stores Mastra ships adapters for

\`PgVector\`, \`PineconeVector\`, \`LibSqlVector\` (local SQLite + FAISS-style),  \`UpstashVector\`, \`QdrantVector\`, \`ChromaVector\`, \`AstraVector\` — all behind one interface (\`upsert\`, \`query\`, \`createIndex\`).

Below we run the *whole pipeline* in the browser: build an MDocument from a tiny e-bike support handbook, chunk → embed → store in an in-memory vector index → give it to an Agent.`,
    },

    {
      id: "md-load",
      kind: "markdown",
      source: `## 1 · Load Docs
We start by defining our knowledge base—a Lumos E-Bike support handbook—and a mirror of the Mastra \`MDocument\` class for chunking.`,
    },
    {
      id: "load-docs",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const HANDBOOK = \`
# Lumos E-Bike Support Handbook

## Battery & Range
Our 504Wh battery delivers 60–80 km of mixed-terrain range when new. Cold weather (below 5°C) reduces range by 20–35%. Always store the battery indoors at 40–80% charge between rides. A full charge takes 4.5 hours with the standard 2A charger or 2 hours with the optional 4A fast charger.

To preserve battery health, avoid leaving the battery fully drained for more than 48 hours. Capacity loss above 20% within the first 18 months is covered under warranty.

## Brakes
Lumos bikes use hydraulic disc brakes. A high-pitched squeal during the first 50 km is normal — pads bed in. If the squeal persists, clean the rotors with isopropyl alcohol (never WD-40) and a clean cloth. Replace pads when the friction material is under 1 mm thick.

If the brake lever feels spongy, air may have entered the line. Bleeding the system requires Shimano mineral oil — do not substitute DOT fluid.

## Tires & Punctures
Stock tires are tubeless-ready Schwalbe Marathon Plus, run at 50–65 psi depending on rider weight. Below 4 mm of tread, replace. Sealant tops up every 6 months for tubeless setups.

For roadside punctures, our included tube fits even in tubeless mode — install it, ride home, then re-seal at your bench.

## Motor & Controller
The mid-drive Bosch motor is sealed and not user-serviceable. Error codes shown on the display map to specific issues:
- Error 500: torque-sensor mismatch — restart the bike with no load on the pedals.
- Error 502: short to ground — water ingress likely; do not ride, contact support.
- Error 503: speed-sensor magnet missing — check the rear spoke magnet alignment.

## Warranty & Returns
Frames are warranted for 5 years against manufacturing defects. Electrical components (battery, controller, display) are covered for 2 years. Wear items (pads, tires, chain, cassette) are not warranted.

We accept returns within 30 days of delivery. After 14 days, returns are subject to a 50% restocking fee. Bikes ridden more than 50 km cannot be returned.
\`;

class MDocument {
  constructor(text, metadata = {}) { this.text = text; this.metadata = metadata; }
  static fromMarkdown(text, metadata) { return new MDocument(text, metadata); }
  async chunk({ maxSize = 320, overlap = 40 } = {}) {
    const paras = this.text.split(/\\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const out = [];
    let currentH2 = null;
    for (const para of paras) {
      const h2 = para.match(/^##\\s+(.+)/);
      if (h2) { currentH2 = h2[1].trim(); continue; }
      const sentences = para.split(/(?<=[.!?])\\s+/);
      let buf = "";
      for (const s of sentences) {
        if ((buf + " " + s).trim().length > maxSize && buf) {
          out.push({ text: buf.trim(), metadata: { ...this.metadata, section: currentH2 } });
          buf = buf.slice(Math.max(0, buf.length - overlap));
        }
        buf = (buf + " " + s).trim();
      }
      if (buf) out.push({ text: buf, metadata: { ...this.metadata, section: currentH2 } });
    }
    return out;
  }
}

ctx.state.HANDBOOK = HANDBOOK;
ctx.state.MDocument = MDocument;
ctx.log("Handbook loaded.");`,
    },

    {
      id: "md-chunk",
      kind: "markdown",
      source: `## 2 · Chunk with MDocument
Large documents need to be split into smaller chunks so that the most relevant pieces can fit into the LLM's context window. \`MDocument\` handles this by splitting on paragraph and sentence boundaries.`,
    },
    {
      id: "chunk-docs",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { HANDBOOK, MDocument } = ctx.state;
const doc = MDocument.fromMarkdown(HANDBOOK, { source: "lumos-handbook.md" });
const chunks = await doc.chunk({ maxSize: 320, overlap: 40 });

ctx.state.chunks = chunks;
ctx.log(\`Split handbook into \${chunks.length} chunks.\`);
for (const c of chunks.slice(0, 2)) {
  ctx.log(\`[\${c.metadata.section}] \${c.text.slice(0, 80)}...\`);
}`,
    },

    {
      id: "md-embed",
      kind: "markdown",
      source: `## 3 · Embed
We convert our text chunks into numerical vectors (embeddings) using the OpenAI \`text-embedding-3-small\` model. This allows us to perform semantic search based on meaning rather than just keywords.`,
    },
    {
      id: "embed-chunks",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { chunks } = ctx.state;

async function embedMany({ values }) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: values }),
  });
  if (!res.ok) throw new Error("Embedding call failed: " + res.status + " " + await res.text());
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error("Embedding response did not include data: " + JSON.stringify(data).slice(0, 200));
  return { embeddings: data.data.map((d) => d.embedding) };
}

const { embeddings } = await embedMany({ values: chunks.map((c) => c.text) });
ctx.state.embeddings = embeddings;
ctx.log(\`Generated \${embeddings.length} embeddings.\`);`,
    },

    {
      id: "md-vector",
      kind: "markdown",
      source: `## 4 · Build Vector Index
We store the embeddings in a simple in-memory vector store. This store uses cosine similarity to find the most relevant chunks for a given query.`,
    },
    {
      id: "build-index",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { chunks, embeddings } = ctx.state;
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

class MemoryVector {
  constructor() { this.indices = new Map(); }
  async createIndex({ indexName }) { this.indices.set(indexName, []); }
  async upsert({ indexName, vectors, metadata }) {
    const ix = this.indices.get(indexName) ?? [];
    for (let i = 0; i < vectors.length; i++) ix.push({ vec: vectors[i], metadata: metadata[i] });
    this.indices.set(indexName, ix);
  }
  async query({ indexName, queryVector, topK = 4 }) {
    return (this.indices.get(indexName) ?? [])
      .map((r) => ({ ...r, score: cos(queryVector, r.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => ({ score: r.score, metadata: r.metadata }));
  }
}

const vector = new MemoryVector();
await vector.createIndex({ indexName: "support" });
await vector.upsert({
  indexName: "support",
  vectors: embeddings,
  metadata: chunks.map((c) => ({ text: c.text, ...c.metadata })),
});

ctx.state.vector = vector;
ctx.state.indexName = "support";
ctx.log("Vector index built.");`,
    },

    {
      id: "md-retrieve",
      kind: "markdown",
      source: `## 5 · Run a Retrieval Query
Before building the agent, we can test the vector store by performing a direct semantic search. This shows us what information the agent will be able to see.`,
    },
    {
      id: "test-retrieval",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { vector, indexName } = ctx.state;
async function embedOne(text) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: [text] }),
  });
  if (!res.ok) throw new Error("Embedding call failed: " + res.status + " " + await res.text());
  const data = await res.json();
  if (!Array.isArray(data.data) || !data.data[0]?.embedding) throw new Error("Embedding response did not include data: " + JSON.stringify(data).slice(0, 200));
  return data.data[0].embedding;
}

const query = "What should I do if my brakes squeal?";
const queryVector = await embedOne(query);
const hits = await vector.query({ indexName, queryVector, topK: 2 });

ctx.log(\`Query: "\${query}"\`);
hits.forEach((h, i) => ctx.log(\`Hit #\${i+1} [\${h.metadata.section}] (score: \${h.score.toFixed(3)}): \${h.metadata.text.slice(0, 100)}...\`));

ctx.state.embedOne = embedOne;`,
    },

    {
      id: "md-agent",
      kind: "markdown",
      source: `## 6 · Build RAG Agent
We wrap the retrieval logic into a tool and give it to an agent. We instruct the agent to *only* answer using the retrieved context, preventing it from hallucinating information not found in the handbook.`,
    },
    {
      id: "build-agent",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { vector, indexName, embedOne } = ctx.state;
const z = ctx.lc.z;\nfunction zodToJson(schema) {
  const rawShape = schema?._def?.shape ?? schema?.shape;
  const shape = typeof rawShape === "function" ? rawShape() : rawShape;
  if (shape && typeof shape === "object") {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(shape)) {
      required.push(key);
      properties[key] = zodToJson(value);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  const def = schema?._def ?? {};
  const type = def.type ?? def.typeName;
  if (type === "number" || type === "ZodNumber") return { type: "number" };
  if (type === "boolean" || type === "ZodBoolean") return { type: "boolean" };
  if (type === "enum" || type === "ZodEnum") return { type: "string", enum: Object.values(def.entries ?? def.values ?? {}) };
  if (type === "array" || type === "ZodArray") return { type: "array", items: zodToJson(def.element ?? def.type) };
  return { type: "string" };
}

const supportSearch = {
  id: "vectorQueryContent",
  description: "Search the e-bike support handbook for relevant sections.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    const queryVector = await embedOne(query);
    const hits = await vector.query({ indexName, queryVector, topK: 3 });
    return {
      context: hits.map((h) => \`[\${h.metadata.section}] \${h.metadata.text}\`).join("\\n\\n"),
      sources: hits.map((h) => h.metadata.section),
    };
  },
};

class Agent {
  constructor({ instructions, model, tools }) { Object.assign(this, { instructions, model, tools }); }
  async generate(prompt) {
    const messages = [{ role: "system", content: this.instructions }, { role: "user", content: prompt }];
    const toolSpecs = Object.values(this.tools).map((t) => ({
      type: "function",
      function: { name: t.id, description: t.description, parameters: zodToJson(t.inputSchema) },
    }));
    const usedSources = [];
    for (let step = 0; step < 4; step++) {
      const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
        body: JSON.stringify({ model: this.model, messages, tools: toolSpecs, tool_choice: "auto" }),
      });
      if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("AI response did not include a message: " + JSON.stringify(data).slice(0, 200));
      messages.push(msg);
      if (!msg.tool_calls || msg.tool_calls.length === 0) return { text: msg.content, sources: usedSources };
      for (const call of msg.tool_calls) {
        const tool = Object.values(this.tools).find((t) => t.id === call.function.name);
        if (!tool) throw new Error("Unknown tool requested: " + call.function.name);
        const out = await tool.execute(((args) => { try { return JSON.parse(args); } catch { return {}; } })(call.function.arguments || "{}"));
        usedSources.push(...(out.sources ?? []));
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
      }
    }
    return { text: "(max steps)", sources: usedSources };
  }
}

const supportAgent = new Agent({
  instructions: "You are a helpful e-bike support agent. Answer questions using ONLY the provided context. If the answer is not in the context, say you don't know.",
  model: "google/gemini-3-flash-preview",
  tools: { supportSearch },
});

ctx.state.supportAgent = supportAgent;
ctx.log("RAG Agent ready.");`,
    },

    {
      id: "md-ask",
      kind: "markdown",
      source: `## 7 · Ask a Question
Now we put the agent to work. Notice how it uses the tool to find information about the battery's performance in cold weather.`,
    },
    {
      id: "ask-agent",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { supportAgent } = ctx.state;
const { text } = await supportAgent.generate("My battery only lasts 30 km in winter — is something wrong?");
ctx.log("Answer:", text);`,
    },

    {
      id: "md-citations",
      kind: "markdown",
      source: `## 8 · Show Citations
A good RAG system provides citations. Because our chunks included the section names in their metadata, we can show exactly which parts of the handbook the agent used.`,
    },
    {
      id: "show-citations",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { supportAgent } = ctx.state;
const { text, sources } = await supportAgent.generate("How do I fix Error 503?");
ctx.log("Answer:", text);
ctx.log("Sources used:", [...new Set(sources)].join(", "));`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## Recap

You just ran every step of a real Mastra RAG pipeline:

| Step | Real Mastra | Notebook mirror |
| --- | --- | --- |
| Wrap source | \`MDocument.fromMarkdown\` | same shape |
| Chunk | \`doc.chunk({ strategy: "recursive", maxSize, overlap })\` | recursive splitter that respects \`##\` headers |
| Embed | \`embedMany({ model: ModelRouterEmbeddingModel(…) })\` | real \`text-embedding-3-small\` calls |
| Store | \`PgVector\`/\`LibSqlVector\`/… | in-memory store with same \`upsert\`/\`query\` API |
| Expose to agent | \`createVectorQueryTool({ vectorStore, indexName })\` | same shape; agent calls it before answering |

### Production patterns you'd add next

- **Reranking.** Pass an LLM reranker into \`createVectorQueryTool({ reranker: { model } })\` — Mastra runs your topK through a small judge model and reorders by relevance. Almost always worth the extra cost.
- **Metadata filtering.** \`PgVectorConfig.minScore: 0.7\` rejects weak hits. Per-tenant filtering via metadata (\`{ tenantId }\`) is how multi-tenant RAG stays safe.
- **Eval the pipeline.** The next notebook covers Mastra's eval scorers (faithfulness, answer-relevancy, context-precision) — the canonical way to know your RAG actually grounded the answer.`,
    },
  ],
};
