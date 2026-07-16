import type { Notebook } from "./types";

export const mstMemoryNotebook: Notebook = {
  id: "mst-memory",
  title: "Memory — threads, working memory & semantic recall",
  description:
    "Mastra's three-layer memory model: a recent message window, a structured working-memory object the model rewrites, and semantic recall over an embedded message archive. Built and queried against real embeddings.",
  difficulty: "intermediate",
  tags: ["agent", "rag"],
  subgroup: "Memory & State",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 4 · Memory — \`new Memory({ storage, vector, options })\`

By default, an agent is amnesic — each \`generate()\` call sees only the messages you pass. Mastra's \`Memory\` module gives an agent persistent, scoped, semantically-searchable conversation history without leaking history across users.

\`\`\`ts
import { Memory } from "@mastra/memory";
import { Agent } from "@mastra/core/agent";

const memory = new Memory({
  storage: postgresStorage,        // where threads + messages live
  vector:  pgVectorStore,          // where embedded messages live (for semantic recall)
  embedder: "openai/text-embedding-3-small",
  options: {
    lastMessages: 20,                                  // recency window
    semanticRecall: { topK: 4, messageRange: 2 },      // pull back distant-but-relevant turns
    workingMemory: { enabled: true, schema: profileSchema },
  },
});

const agent = new Agent({
  id: "concierge",
  name: "Concierge",
  instructions: "Help the user plan trips. Use working memory to remember their preferences.",
  model: "openai/gpt-5",
  memory,
});

// Each conversation has a \`threadId\` (the conversation) and a \`resourceId\` (the user).
await agent.generate("Hi, I'm Marco — I love sushi and hate flying economy.",
  { memory: { thread: "t-42", resource: "user-marco" } });
\`\`\`

### Three layers, three jobs

| Layer | What it stores | When it's pulled in |
| --- | --- | --- |
| **Recent window** (\`lastMessages: N\`) | The last N turns from this thread | Every call — cheap, deterministic |
| **Working memory** (\`workingMemory.schema\`) | A structured object the LLM rewrites as it learns (name, prefs, current task) | Every call — short, dense, persistent across threads if you scope by \`resourceId\` |
| **Semantic recall** (\`vector + topK\`) | Every past message, embedded | Only when something old is relevant to the current question |

The split is intentional: the recent window keeps recent context for free, working memory keeps **distilled** facts cheap and always-on, and semantic recall handles the long tail. None of them alone is enough — together they're how production agents stay coherent over thousands of turns.

Below we build all three.`,
    },

    {
      id: "md-window-setup", kind: "markdown",
      source: `## 1 · The recency window — \`lastMessages\`

Easiest layer. We keep a sliding tail of the most recent N messages, drop the rest. The model sees: \`[system, ...lastN, currentUser]\`. First, we setup the storage logic.`,
    },
    {
      id: "window-storage", kind: "code", language: "js", runtime: "browser",
      source: `ctx.state.Memory = class Memory {
  constructor({ options = {} } = {}) { 
    this.options = options; 
    this.threads = new Map(); 
  }
  _thread(id) { 
    if (!this.threads.has(id)) this.threads.set(id, []); 
    return this.threads.get(id); 
  }
  recent(threadId) {
    const N = this.options.lastMessages ?? 10;
    return this._thread(threadId).slice(-N);
  }
  append(threadId, role, content) { 
    this._thread(threadId).push({ role, content }); 
  }
};

ctx.state.memoryInstance = new ctx.state.Memory({ options: { lastMessages: 6 } });
return { status: "Memory class and instance initialized" };`,
    },

    {
      id: "md-window-agent", kind: "markdown",
      source: `### Interacting with the recency window

Now we build an agent that uses this memory. On every \`generate()\` call, it pulls the \`recent()\` messages and appends the new exchange after the response.`,
    },
    {
      id: "window-agent", kind: "code", language: "js", runtime: "browser",
      source: `const { Memory, memoryInstance: memory } = ctx.state;\nif (!Memory) throw new Error("Please run the setup cells first.");

ctx.state.Agent = class Agent {
  constructor({ instructions, model, memory }) { Object.assign(this, { instructions, model, memory }); }
  async generate(input, { threadId }) {
    const messages = [
      { role: "system", content: this.instructions },
      ...this.memory.recent(threadId),
      { role: "user", content: input },
    ];
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model: this.model, messages }),
    });
    if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("AI response did not include a message: " + JSON.stringify(data).slice(0, 200));
    const text = msg.content;
    this.memory.append(threadId, "user", input);
    this.memory.append(threadId, "assistant", text);
    return { text };
  }
};

const agent = new ctx.state.Agent({
  instructions: "You are a terse trip concierge. Reply in one sentence.",
  model: "google/gemini-3-flash-preview",
  memory,
});

const t = "t-1";
const qs = ["Planning a 4-day trip to Lisbon.", "I'm vegetarian and hate crowds.", "Neighborhood recommendation?"];

for (const q of qs) {
  const { text } = await agent.generate(q, { threadId: t });
  ctx.log("user:     ", q);
  ctx.log("assistant:", text, "\\n");
}
return { stored: memory._thread(t).length };`,
    },

    {
      id: "md-working-setup", kind: "markdown",
      source: `## 2 · Working memory — a structured object the model rewrites

Working memory is a tiny **JSON document scoped to a user (resource)**. It keeps distilled facts like preferences and goals always-on. First, we define the schema and the memory store.`,
    },
    {
      id: "wm-setup", kind: "code", language: "js", runtime: "browser",
      source: `const PROFILE_SCHEMA = { name: "", homeCity: "", dietary: [], dislikes: [], goals: "" };

ctx.state.WorkingMemory = class WorkingMemory {
  constructor() { this.profiles = new Map(); }
  load(resourceId) { return this.profiles.get(resourceId) ?? structuredClone(PROFILE_SCHEMA); }
  save(resourceId, p) { this.profiles.set(resourceId, p); }
};

ctx.state.wmInstance = new ctx.state.WorkingMemory();
return { schema: PROFILE_SCHEMA };`,
    },

    {
      id: "md-working-update", kind: "markdown",
      source: `### Updating working memory

The model sees the current working memory in the system prompt and is instructed to provide an updated version after its reply. We then parse and save this update.`,
    },
    {
      id: "wm-update", kind: "code", language: "js", runtime: "browser",
      source: `const { WorkingMemory, wmInstance: memory } = ctx.state;

ctx.state.WMAgent = class Agent {
  constructor({ instructions, model, memory }) { Object.assign(this, { instructions, model, memory }); }
  async generate(input, { resourceId }) {
    const profile = this.memory.load(resourceId);
    const system = \`\${this.instructions}
You have a structured WORKING MEMORY. After your reply, emit an updated JSON block:
<MEM>\${JSON.stringify(profile)}</MEM>
Current memory: \${JSON.stringify(profile)}\`;

    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: system }, { role: "user", content: input }],
      }),
    });
    if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("AI response did not include a message: " + JSON.stringify(data).slice(0, 200));
    const raw = msg.content;
    const m = raw.match(/<MEM>([\\s\\S]+?)<\\/MEM>/);
    if (m) { try { this.memory.save(resourceId, { ...profile, ...(() => { try { return JSON.parse(m[1]); } catch { return {}; } })() }); } catch {} }
    return { text: raw.replace(/<MEM>[\\s\\S]+?<\\/MEM>/, "").trim(), profile: this.memory.load(resourceId) };
  }
};

const agent = new ctx.state.WMAgent({
  instructions: "You are a personal travel concierge. Be warm, concise, and remember what you learn.",
  model: "google/gemini-3-flash-preview",
  memory,
});

const { text, profile } = await agent.generate("I'm Marco. I live in Berlin and I'm gluten-intolerant.", { resourceId: "u1" });
ctx.log("assistant:", text);
ctx.log("memory →  ", JSON.stringify(profile));
return { profile };`,
    },

    {
      id: "md-semantic-helpers", kind: "markdown",
      source: `## 3 · Semantic recall — pulling back the right old message

Semantic recall embeds every message into a vector store to allow retrieving old relevant context. First, let's define our embedding and similarity helpers.`,
    },
    {
      id: "semantic-helpers", kind: "code", language: "js", runtime: "browser",
      source: `ctx.state.embed = async (texts) => {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error("Embedding call failed: " + res.status + " " + await res.text());
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error("Embedding response did not include data: " + JSON.stringify(data).slice(0, 200));
  return data.data.map((d) => d.embedding);
};

ctx.state.cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

return { status: "Helpers initialized" };`,
    },

    {
      id: "md-semantic-index", kind: "markdown",
      source: `### Building the vector index

We create a \`SemanticMemory\` class that stores messages alongside their vector embeddings. This allows us to perform similarity searches later.`,
    },
    {
      id: "semantic-index", kind: "code", language: "js", runtime: "browser",
      source: `const { embed, cos } = ctx.state;

ctx.state.SemanticMemory = class SemanticMemory {
  constructor({ topK = 3 } = {}) { this.topK = topK; this.archive = []; }
  async append(role, text, turn) {
    const [vec] = await embed([text]);
    this.archive.push({ role, text, vec, turn });
  }
  async semanticRecall(query) {
    if (!this.archive.length) return [];
    const [qv] = await embed([query]);
    return this.archive
      .map((m) => ({ ...m, score: cos(qv, m.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK);
  }
};

ctx.state.semanticInstance = new ctx.state.SemanticMemory({ topK: 2 });
return { status: "SemanticMemory initialized" };`,
    },

    {
      id: "md-semantic-query", kind: "markdown",
      source: `### Seeding and Semantic Recall Query

We seed the archive with a conversation. Then, we query it to find relevant info that the recency window might have forgotten.`,
    },
    {
      id: "semantic-query", kind: "code", language: "js", runtime: "browser",
      source: `const memory = ctx.state.semanticInstance;
const history = [
  ["user", "I'm Marco from Berlin."],
  ["user", "I hate flying economy class — always upgrade if I can."],
  ["user", "I'm vegetarian, but I do eat eggs and dairy."],
  ["assistant", "Noted."],
  ["user", "What documentary did you recommend last week?"],
  ["assistant", "Honeyland."],
];

for (let i = 0; i < history.length; i++) await memory.append(history[i][0], history[i][1], i);

const query = "Should I book my Lisbon flight with the cheap carrier?";
const recalled = await memory.semanticRecall(query);

ctx.log(\`query: \${query}\\n\`);
for (const r of recalled) {
  ctx.log(\`  turn \${r.turn}  score=\${r.score.toFixed(3)}  [\${r.role}] \${r.text}\`);
}

return { hits: recalled.length };`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

Real Mastra wires these three layers behind one config:

\`\`\`ts
new Memory({
  storage,
  vector,
  embedder: "openai/text-embedding-3-small",
  options: {
    lastMessages:   20,
    semanticRecall: { topK: 4, messageRange: 2 },   // also pulls 2 neighbours around each hit
    workingMemory:  { enabled: true, schema: profileSchema },
  },
});
\`\`\`

| Layer | Cost | Coverage | When it wins |
| --- | --- | --- | --- |
| Recency window | Free (already in context) | Last N turns of *this* thread | Short chats, immediate context |
| Working memory | One small JSON object per user | Distilled facts the LLM chose to keep | Cross-thread continuity ("Marco prefers …") |
| Semantic recall | One embed per new turn + a vector lookup | All past turns of all threads (if you choose) | Long-running assistants, support transcripts, anything that outgrows the window |

> **Scopes — the part most people get wrong:** \`threadId\` is "this conversation". \`resourceId\` is "this user". Working memory and semantic recall both default to **thread scope**; opt into \`scope: "resource"\` if you want them to follow the user across threads. Get this wrong and you'll either repeat questions every session (too narrow) or leak info across users (too wide).`,
    },
  ],
};
