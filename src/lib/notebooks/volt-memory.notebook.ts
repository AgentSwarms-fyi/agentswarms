import type { Notebook } from "./types";

export const voltMemoryNotebook: Notebook = {
  id: "volt-memory",
  title: "Memory — threads, working memory & semantic recall",
  description:
    "VoltAgent's three-layer Memory: a conversation message window, structured working memory the model rewrites, and semantic recall over an embedded message archive — built and queried against real embeddings.",
  difficulty: "intermediate",
  tags: ["agent", "rag"],
  subgroup: "State & Memory",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 3 · Memory — \`new Memory({ storage, embedding, vector })\`

VoltAgent's \`Memory\` class is what makes an Agent *stateful*. It has three layers, each addressing a different failure mode:

| Layer | What it stores | Failure mode it fixes |
| --- | --- | --- |
| **Conversation history** | Raw messages per \`userId\`/\`conversationId\` thread | Agent forgets the last 2 turns |
| **Working memory** | A compact JSON/Markdown blob the *model* rewrites each turn | Important facts (name, preferences, goals) drown in long history |
| **Semantic recall** | Embeddings of every message in a vector store | Old conversations from days ago that are still relevant |

\`\`\`ts
import { Agent, Memory, InMemoryStorageAdapter, InMemoryVectorAdapter } from "@voltagent/core";
import { AiSdkEmbeddingAdapter } from "@voltagent/core";
import { openai } from "@ai-sdk/openai";

const memory = new Memory({
  storage:   new InMemoryStorageAdapter(),                                  // raw messages
  embedding: new AiSdkEmbeddingAdapter(openai.embedding("text-embedding-3-small")),
  vector:    new InMemoryVectorAdapter(),                                   // for semantic recall
  workingMemory: {
    enabled: true,
    scope: "user",                                                          // persists across conversations
    template: "## User\\n- name:\\n- preferences:\\n- open issues:\\n",
  },
  options: { semanticRecall: { topK: 3, messageRange: 2 } },
});

const support = new Agent({
  name: "support",
  instructions: "Use working memory to remember the user; cite recalled context when relevant.",
  model: openai("gpt-4o-mini"),
  memory,
});

await support.generateText("Hi, I'm Maya. I prefer terse answers.",
  { userId: "u-1", conversationId: "thread-1" });
\`\`\`

Storage adapters are pluggable: **LibSQL/SQLite, Postgres, Supabase, Managed Memory (hosted)**. The same agent code works against any of them.

Below we simulate all three layers in the browser so you can watch them evolve.`,
    },
    {
      id: "setup", kind: "markdown",
      source: `### 1. Setup Memory Helpers
First, let's define our AI helpers for embedding text and chatting with the model. We'll also initialize our memory state on \`ctx.state\` so it persists across cells.`,
    },
    {
      id: "setup-code", kind: "code", language: "js", runtime: "browser",
      source: `const AI = ctx.aiBaseURL, KEY = ctx.aiApiKey;

ctx.state.embed = async (text) => {
  const r = await ctx.fetch(\`\${AI}/embeddings\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.data[0].embedding;
};

ctx.state.cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

ctx.state.chat = async (messages) => {
  const r = await ctx.fetch(\`\${AI}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages,
    }),
  });
  if (!r.ok) throw new Error(\`AI request failed: \${r.status} \${await r.text()}\`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
  return data.choices[0].message.content;
};

ctx.state.memory = {
  threads: new Map(),
  archive: [],
  workingMemory: { name: null, preferences: [], openIssues: [] }
};

ctx.log("Helpers initialized and memory store created.");`,
    },
    {
      id: "threads", kind: "markdown",
      source: `### 2. Raw Thread Append/Read
The first layer is basic conversation history. We store messages in 'threads' identified by a \`conversationId\`. Every message is also archived with its embedding for later recall.`,
    },
    {
      id: "threads-code", kind: "code", language: "js", runtime: "browser",
      source: `const { memory, embed } = ctx.state;

ctx.state.append = async (conversationId, msg) => {
  if (!memory.threads.has(conversationId)) memory.threads.set(conversationId, []);
  memory.threads.get(conversationId).push(msg);
  
  // Also add to semantic archive for layer 3
  const vec = await embed(\`\${msg.role}: \${msg.content}\`);
  memory.archive.push({ msg, conversationId, vec });
};

ctx.state.recent = (conversationId, n = 4) => {
  return (memory.threads.get(conversationId) ?? []).slice(-n);
};

ctx.log("Thread management (Layer 1) is ready.");`,
    },
    {
      id: "working-memory", kind: "markdown",
      source: `### 3. Working Memory JSON Update
The second layer is **working memory**: a structured JSON blob that the agent updates after every turn. This keeps the most important facts immediately available without searching through history.`,
    },
    {
      id: "working-memory-code", kind: "code", language: "js", runtime: "browser",
      source: `const { memory, chat } = ctx.state;

ctx.state.updateWorkingMemory = async (latestUser, latestAssistant) => {
  const out = await chat([
    { role: "system", content: "Update this JSON working memory using the latest turn. Reply with JSON only, same shape." },
    { role: "user",   content: \`Current memory:\\n\${JSON.stringify(memory.workingMemory)}\\n\\nUser: \${latestUser}\\nAssistant: \${latestAssistant}\` },
  ], true);
  
  try {
    const cleaned = out.replace(/^\`\`\`(?:json)?\\s*/i, "").replace(/\`\`\`\\s*$/i, "").trim();
    const match = cleaned.match(/\\{[\\s\\S]*\\}/);
    memory.workingMemory = JSON.parse(match ? match[0] : cleaned);
    ctx.log("Working memory updated:", memory.workingMemory);
  } catch (e) {
    ctx.log("Could not parse working memory update; keeping previous. Raw:", out);
  }
};

ctx.log("Working memory (Layer 2) logic enabled.");`,
    },
    {
      id: "semantic-recall", kind: "markdown",
      source: `### 4. Semantic Recall via Embeddings
The third layer is **semantic recall**. We search our archive of previous messages using vector similarity to find context that might be relevant to the current query, even if it's from a different thread.`,
    },
    {
      id: "semantic-recall-code", kind: "code", language: "js", runtime: "browser",
      source: `const { memory, embed, cosine } = ctx.state;

ctx.state.recall = async (query, topK = 2) => {
  const q = await embed(query);
  return memory.archive
    .map(e => ({ ...e, score: cosine(q, e.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
};

ctx.log("Semantic recall (Layer 3) enabled.");`,
    },
    {
      id: "agent", kind: "markdown",
      source: `### 5. Agent using Memory
Now we combine all three layers into a single \`turn\` function. In every turn, the agent uses the recent history, the working memory, and semantic recall to generate its response.`,
    },
    {
      id: "agent-code", kind: "code", language: "js", runtime: "browser",
      source: `const { memory, chat, append, recent, recall, updateWorkingMemory } = ctx.state;

ctx.state.turn = async (conversationId, userText) => {
  const recentMsgs = recent(conversationId);
  const recalled = await recall(userText);
  
  const system = [
    "You are a helpful support agent. Be terse.",
    \`# Working memory\\n\${JSON.stringify(memory.workingMemory)}\`,
    recalled.length ? \`# Semantically recalled\\n\${recalled.map(r => \`- \${r.msg.role}: \${r.msg.content} (score=\${r.score.toFixed(2)})\`).join("\\n")}\` : "",
  ].filter(Boolean).join("\\n\\n");

  const messages = [
    { role: "system", content: system },
    ...recentMsgs,
    { role: "user", content: userText }
  ];
  
  const reply = await chat(messages);

  await append(conversationId, { role: "user", content: userText });
  await append(conversationId, { role: "assistant", content: reply });
  await updateWorkingMemory(userText, reply);

  ctx.log(\`\\n[conv=\${conversationId}] user: \${userText}\`);
  ctx.log(\`assistant: \${reply}\`);
  return reply;
};

ctx.log("Agent turn logic is ready.");`,
    },
    {
      id: "simulation", kind: "markdown",
      source: `### 6. Simulation: Learning from Interaction
Let's start a conversation. The agent will learn the user's name and her specific problem, storing them in working memory.`,
    },
    {
      id: "simulation-code", kind: "code", language: "js", runtime: "browser",
      source: `const { turn } = ctx.state;

await turn("thread-1", "Hi, I'm Maya. My e-bike battery range dropped from 60km to 20km.");
await turn("thread-1", "I prefer short answers, by the way.");
await turn("thread-1", "What should I check first?");`,
    },
    {
      id: "recall-simulation", kind: "markdown",
      source: `### 7. Simulation: Cross-Thread Semantic Recall
Now we start a **new** thread. Even though the recent conversation history is empty for this thread, semantic recall will find the battery issue from our previous discussion.`,
    },
    {
      id: "recall-simulation-code", kind: "code", language: "js", runtime: "browser",
      source: `const { turn, memory } = ctx.state;

ctx.log("\\n──── NEW conversation thread ────");
await turn("thread-2", "Quick reminder — what was that battery problem I had?");

return { 
  threads: memory.threads.size, 
  archived: memory.archive.length, 
  workingMemory: memory.workingMemory 
};`,
    },
    {
      id: "outro", kind: "markdown",
      source: `## What you just built

A faithful miniature of \`@voltagent/core\`'s **Memory** — three layers cooperating:

1. **Recent window** → the last few raw messages, threaded by \`conversationId\`.
2. **Working memory** → a JSON object the model rewrites every turn (user-scoped, persists across threads).
3. **Semantic recall** → embeddings over every message, queried by the *current* user turn.

In production you'd swap \`InMemoryStorageAdapter\` for \`LibSQLMemoryAdapter\` (local SQLite), \`PostgresStorageAdapter\`, \`SupabaseMemoryAdapter\`, or the hosted \`VoltAgentMemoryAdapter\`. The agent code never changes — that's the point of the adapter pattern.`,
    },
  ],
};
