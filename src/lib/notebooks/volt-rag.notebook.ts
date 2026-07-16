import type { Notebook } from "./types";

export const voltRagNotebook: Notebook = {
  id: "volt-rag",
  title: "RAG — Retrievers, embeddings & two retrieval patterns",
  description:
    "VoltAgent's RAG model: a custom Retriever that auto-attaches to every message, vs exposing retrieval as a typed tool the agent decides when to call. End-to-end over a small e-bike support knowledge base.",
  difficulty: "intermediate",
  tags: ["agent", "rag"],
  subgroup: "RAG",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 4 · RAG — Retrievers + the two attachment patterns

VoltAgent's RAG story is intentionally small. There is **one extension point** — the \`BaseRetriever\` class — and **two ways** to attach it to an Agent:

\`\`\`ts
import { Agent, BaseRetriever } from "@voltagent/core";

class HandbookRetriever extends BaseRetriever {
  async retrieve(input, options) {
    // input is the latest message text; return a string of grounded context
    const hits = await this.search(input);
    return hits.map(h => \`# \${h.title}\\n\${h.text}\`).join("\\n\\n");
  }
}

const handbook = new HandbookRetriever();

// Pattern A — Retriever attached directly. Every message auto-retrieves.
const agentA = new Agent({ name: "support-auto", model, instructions, memory, retriever: handbook });

// Pattern B — Retriever exposed as a tool. The model decides when to call it.
const agentB = new Agent({ name: "support-smart", model, instructions, memory,
  tools: [handbook.tool] });
\`\`\`

| Pattern | When to use | Trade-off |
| --- | --- | --- |
| **Retriever attached** | Every question is in-domain; latency budget tight | Wastes tokens on questions that don't need RAG |
| **Retriever as tool** | Mixed conversations; agent should *decide* whether to look | One extra round-trip when the model chooses to call it |

Below we build a real retriever over an e-bike support handbook, wire both patterns, and contrast the answers.`,
    },

    {
      id: "code", kind: "code", language: "js", runtime: "browser",
      source: `const AI = ctx.aiBaseURL, KEY = ctx.aiApiKey;

// ---- Knowledge base (tiny, embedded inline so the cell is self-contained) ----
const KB = [
  { title: "Battery health",  text: "If range drops 30%+, check tire pressure (recommended 60 psi), then run a calibration cycle: full charge to 100%, ride to <5%, full charge again." },
  { title: "Squeaky brakes",  text: "Squeaking is almost always glazing on the pads. Sand the pad surface with 120-grit, then bed in with 8 hard stops from 25 km/h." },
  { title: "Motor cutting out", text: "Intermittent motor cut-out is usually a loose torque-sensor connector at the bottom bracket. Reseat the connector and check for corrosion." },
  { title: "Warranty policy", text: "Frame: 5 years. Battery: 2 years and 70% capacity retention. Motor: 2 years. Excludes wear items (pads, tires, chains)." },
  { title: "Return window",   text: "30 days from delivery for unused bikes. Restocking fee: 10%. Custom builds are non-returnable." },
];

async function embed(text) {
  const r = await ctx.fetch(\`\${AI}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.data[0].embedding;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
async function chat(messages, tools) {
  const r = await ctx.fetch(\`\${AI}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages, ...(tools ? { tools } : {}) }),
  });
  if (!r.ok) throw new Error(\`AI request failed: \${r.status} \${await r.text()}\`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
  if (!data.choices?.[0]?.message) throw new Error("No message in response: " + JSON.stringify(data));
  return data.choices[0].message;
}

// Index the KB once
ctx.log("Indexing", KB.length, "docs...");
const INDEX = await Promise.all(KB.map(async d => ({ ...d, vec: await embed(\`\${d.title}. \${d.text}\`) })));

// ---- BaseRetriever ----
class BaseRetriever {
  constructor({ topK = 2 } = {}) { this.topK = topK; }
  async retrieve(query) {
    const q = await embed(query);
    return INDEX
      .map(d => ({ ...d, score: cosine(q, d.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK);
  }
}
const handbook = new BaseRetriever({ topK: 2 });

// ---- Pattern A: Retriever attached — every message auto-retrieves ----
async function patternA(question) {
  const hits = await handbook.retrieve(question);
  const grounded = hits.map(h => \`# \${h.title}\\n\${h.text}\`).join("\\n\\n");
  const msg = await chat([
    { role: "system", content: \`You are an e-bike support agent. Answer ONLY from this context:\\n\\n\${grounded}\\n\\nIf the context doesn't cover it, say so.\` },
    { role: "user", content: question },
  ]);
  return { answer: msg.content, retrievedTitles: hits.map(h => h.title) };
}

// ---- Pattern B: Retriever as a tool — model decides when to call ----
const tools = [{
  type: "function",
  function: {
    name: "search_handbook",
    description: "Search the official e-bike support handbook. Call this for any policy, mechanical, or warranty question.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
}];
async function patternB(question) {
  const messages = [
    { role: "system", content: "You are an e-bike support agent. Call search_handbook for any policy or mechanical question; answer chit-chat directly." },
    { role: "user", content: question },
  ];
  for (let step = 0; step < 3; step++) {
    const msg = await chat(messages, tools); messages.push(msg);
    if (!msg.tool_calls?.length) return { answer: msg.content, steps: step + 1 };
    for (const call of msg.tool_calls) {
      const { query } = JSON.parse(call.function.arguments);
      const hits = await handbook.retrieve(query);
      messages.push({ role: "tool", tool_call_id: call.id,
        content: hits.map(h => \`# \${h.title}\\n\${h.text}\`).join("\\n\\n") });
    }
  }
  return { answer: "(max steps reached)", steps: 3 };
}

// ---- Compare ----
const question = "My battery range dropped from 60 to 20 km — what should I check first?";
ctx.log("Q:", question, "\\n");

ctx.log("─── Pattern A (auto-retrieve) ───");
const a = await patternA(question);
ctx.log("retrieved:", a.retrievedTitles.join(", "));
ctx.log(a.answer);

ctx.log("\\n─── Pattern B (retriever-as-tool) ───");
const b = await patternB(question);
ctx.log("steps:", b.steps);
ctx.log(b.answer);

ctx.log("\\n─── Pattern B on chit-chat (should NOT retrieve) ───");
const c = await patternB("Hey, just wanted to say thanks for the help yesterday!");
ctx.log("steps:", c.steps);
ctx.log(c.answer);

return { patternA: a, patternB: b, chitchat: c };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

You built a real \`BaseRetriever\` and attached it both ways. In production you'd swap the in-memory \`INDEX\` for **LanceDB, Pinecone, Chroma, or Postgres pgvector** — VoltAgent has examples for each — but the retriever interface stays the same.

The "retriever-as-tool" pattern is the modern default for support agents because:

- **No wasted RAG calls on chit-chat** (you saw it skip retrieval on "thanks for the help").
- The model can call the retriever **multiple times** within one turn with different queries.
- Tool calls show up in observability with their query and hit count — easier to debug retrieval quality than auto-injected context.`,
    },
  ],
};
