import type { Notebook } from "./types";

export const oaiSessionsMemoryNotebook: Notebook = {
  id: "oai-sessions-memory",
  title: "Sessions — Multi-Turn Memory the SDK Way",
  description:
    "Use a Session object to persist conversation history across run() calls. Build an in-memory session, then see what a SQLite/Redis-backed session would do under the hood.",
  difficulty: "intermediate",
  tags: ["agent"],
  subgroup: "Memory",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 5 · Sessions — Stateful Conversations

By default, \`Runner.run(agent, input)\` is **stateless**. The agent has no idea you spoke to it before. To carry memory across turns, the SDK gives you the **Session** abstraction.

A Session is just an interface with four methods:

\`\`\`ts
interface Session {
  getItems(limit?: number): Promise<Item[]>;
  addItems(items: Item[]): Promise<void>;
  popItem(): Promise<Item | null>;
  clearSession(): Promise<void>;
}
\`\`\`

Pass a session to \`run\`:

\`\`\`ts
import { Agent, run, SQLiteSession } from "@openai/agents";

const session = new SQLiteSession("user_42");          // or OpenAIConversationsSession, or your own
const agent   = new Agent({ name: "Helper", instructions: "..." });

await run(agent, "My name is Sam.",        { session });
await run(agent, "What's my name?",        { session });  // → "Your name is Sam."
\`\`\`

Built-in implementations:
- **\`SQLiteSession\`** — local file, perfect for prototypes & desktop apps.
- **\`OpenAIConversationsSession\`** — uses OpenAI's hosted Conversations API; survives across servers, billed by OpenAI.
- **Custom** — implement the 4 methods over Redis, Postgres, Supabase, etc.

> The history lives **outside the agent**. Two runs with the same session share memory; two sessions are isolated. This is how you safely run an agent for thousands of concurrent users on the same process.

Below we build an in-memory session that satisfies the interface, then run a multi-turn conversation.`,
    },

    {
      id: "md-session", kind: "markdown",
      source: `## 1 · Implement an in-memory Session

This is exactly the contract the SDK accepts. A SQLite or Redis session is the same 4 methods over a different backing store.`,
    },
    {
      id: "session", kind: "code", language: "js", runtime: "browser",
      source: `class InMemorySession {
  constructor(id) { this.id = id; this.items = []; }
  async getItems(limit) { return limit ? this.items.slice(-limit) : [...this.items]; }
  async addItems(items) { this.items.push(...items); }
  async popItem() { return this.items.pop() ?? null; }
  async clearSession() { this.items = []; }
}

// Two independent sessions — they cannot see each other.
ctx.state.sessionAlice = new InMemorySession("alice");
ctx.state.sessionBob   = new InMemorySession("bob");

ctx.log("Sessions created: alice, bob");
return { alice: 0, bob: 0 };
`,
    },

    {
      id: "md-run", kind: "markdown",
      source: `## 2 · A \`runWithSession\` that mirrors \`run(agent, input, { session })\`

Before each call: load history → prepend it to the messages. After each call: append the new turn to the session. That's literally all the SDK does.

> 🔍 Watch the message count grow turn by turn. Alice and Bob never see each other.`,
    },
    {
      id: "run", kind: "code", language: "js", runtime: "browser",
      source: `const agent = {
  instructions: "You are a friendly concierge. Use prior turns to personalise replies. Keep answers under 25 words.",
  model: "google/gemini-3-flash-preview",
};

async function runWithSession(input, session) {
  const history = await session.getItems();
  const messages = [
    { role: "system", content: agent.instructions },
    ...history,
    { role: "user", content: input },
  ];
  ctx.log(\`  → [\${session.id}] sending \${messages.length} msgs (history=\${history.length})\`);
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: agent.model, messages }),
  });
  const reply = (await res.json()).choices[0].message.content;
  await session.addItems([
    { role: "user", content: input },
    { role: "assistant", content: reply },
  ]);
  return reply;
}

// ── Alice's conversation ──
ctx.log("\\n=== ALICE ===");
ctx.log("alice asks 1:", "Hey, I'm Alice. I'm planning a trip to Lisbon next month.");
ctx.log("alice answer 1:", await runWithSession("Hey, I'm Alice. I'm planning a trip to Lisbon next month.", ctx.state.sessionAlice));
ctx.log("alice asks 2:", "What are 2 must-see things there?");
ctx.log("alice answer 2:", await runWithSession("What are 2 must-see things there?", ctx.state.sessionAlice));
ctx.log("alice asks 3:", "Remind me — where am I going?");
ctx.log("alice answer 3:", await runWithSession("Remind me — where am I going?", ctx.state.sessionAlice));

// ── Bob's conversation — separate session, separate memory ──
ctx.log("\\n=== BOB ===");
ctx.log("bob asks 1:", "What's the capital of France?");
ctx.log("bob answer 1:", await runWithSession("What's the capital of France?", ctx.state.sessionBob));
ctx.log("bob asks 2:", "Who am I?");
ctx.log("bob answer 2:", await runWithSession("Who am I?", ctx.state.sessionBob));

return {
  alice_messages: (await ctx.state.sessionAlice.getItems()).length,
  bob_messages:   (await ctx.state.sessionBob.getItems()).length,
};
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & production patterns

- A **Session** is a 4-method interface — \`getItems\` / \`addItems\` / \`popItem\` / \`clearSession\`.
- The SDK ships SQLite + OpenAI hosted sessions; rolling your own over Supabase or Redis takes ~30 lines.
- Sessions are scoped by ID — one session per user, per chat thread, per workflow run. They never leak between scopes.

### Production patterns to bolt on

- **History truncation** — call \`getItems(limit=20)\` to cap context size; older turns get summarised by a separate "memorizer" agent.
- **Episodic + semantic memory** — store turns AND embed them; on each turn retrieve top-k semantically-relevant past memories (this is the *AgentMemory* pattern).
- **HITL replay** — \`popItem()\` lets you let a human edit the last assistant message before re-running.
- **Tool-call history** — items can include \`tool_calls\` and \`tool\` messages; the agent re-reads its own prior actions and avoids redundant work.

Together with handoffs (Notebook 2) and structured output (Notebook 4), sessions complete the production agent skeleton.`,
    },
  ],
};
