import type { Notebook } from "./types";

export const mstFundamentalsNotebook: Notebook = {
  id: "mst-fundamentals",
  title: "Mastra Fundamentals — Agent, instructions, generate & stream",
  description:
    "The Mastra mental model: a typed Agent (id + name + instructions + model + tools + memory) wired into a root Mastra container. Use generate() for batch and stream() for live chat — both with the same configuration.",
  difficulty: "beginner",
  tags: ["agent"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 1 · Mastra — the TypeScript-first agent framework

**Mastra** (\`@mastra/core\`) is a batteries-included agent framework for TypeScript. It is opinionated where LangChain is permissive: every Agent has a stable \`id\`, a typed \`instructions\` prompt, exactly one \`model\`, a typed tool map, and an optional \`memory\` module. Workflows are typed step graphs. Everything plugs into a single \`Mastra\` root that owns the agents, workflows, vector stores and telemetry.

\`\`\`ts
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";

const supportAgent = new Agent({
  id: "support-agent",                         // stable identifier — used for tracing, memory keys, RPC
  name: "Support Agent",                       // human-readable label
  instructions: "You are a polite support rep. Keep replies under 4 sentences.",
  model: "openai/gpt-5",                       // any provider/model-id the model router supports
});

export const mastra = new Mastra({
  agents: { supportAgent },                    // every agent lives on the root
});

const { text } = await mastra.getAgent("supportAgent").generate("Refund please?");
\`\`\`

### Why \`Mastra\` exists

You could call \`agent.generate()\` directly, but the root container is what turns a bag of agents into an app:

| Mastra root gives you | Why it matters |
| --- | --- |
| One place to register agents, workflows, vector stores, MCP servers | No global singletons — pass \`mastra\` around or import it once |
| A shared logger + telemetry pipeline | Every \`generate\`/\`stream\`/tool-call call is auto-traced (OTel-compatible) |
| Typed RPC via \`mastra dev\` | The local playground exposes every agent as a typed HTTP endpoint |
| A consistent storage / memory backend | Agents share message persistence without rewiring |

### The two ways to call an agent

| Method | Returns | Use for |
| --- | --- | --- |
| \`agent.generate(input, options?)\` | \`{ text, toolCalls, toolResults, usage, finishReason, steps }\` after the model finishes | Background jobs, batch evals, anything non-interactive |
| \`agent.stream(input, options?)\` | A stream with \`textStream\`, \`fullStream\`, \`toUIMessageStreamResponse()\` | Chat UIs, copilots, anything the user is staring at |

Both take the same arguments. **Streaming is opt-in by changing the method name, not by rewriting the call.** That symmetry is the same design choice the Vercel AI SDK made — and is no coincidence: Mastra wraps the Vercel AI SDK under the hood, then adds the framework layer on top.

Below we hand-roll a tiny \`Agent\` that mirrors the real Mastra surface so every step is visible — but the LLM calls hit a real OpenAI-compatible endpoint, so the outputs you see are genuine model responses.`,
    },
    {
      id: "md-agent", kind: "markdown",
      source: `## 1 · Defining the Agent architecture

Mastra-shaped agents follow a specific contract. Below we define a minimal \`Agent\` class that mirrors the real API: it takes a config with \`id\`, \`instructions\`, and \`model\`, then provides methods to communicate with an LLM. We also define a \`Mastra\` container to hold our agents.`,
    },
    {
      id: "agent-setup", kind: "code", language: "js", runtime: "browser",
      source: `// Tiny Mastra-shaped Agent. Real package: \`import { Agent } from "@mastra/core/agent"\`.
class Agent {
  constructor({ id, name, instructions, model }) {
    Object.assign(this, { id, name, instructions, model });
  }
  _messages(input) {
    const userTurns = typeof input === "string"
      ? [{ role: "user", content: input }]
      : Array.isArray(input) ? input : [{ role: "user", content: input.prompt }];
    return [{ role: "system", content: this.instructions }, ...userTurns];
  }
  async generate(input, options = {}) {
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model: this.model, temperature: options.temperature ?? 0.7, messages: this._messages(input) }),
    });
    if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("AI response did not include a message: " + JSON.stringify(data).slice(0, 200));
    return {
      text: msg.content,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
    };
  }
  async stream(input, options = {}) {
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model: this.model, stream: true, temperature: options.temperature ?? 0.7, messages: this._messages(input) }),
    });
    if (!res.ok) throw new Error("AI stream failed: " + res.status + " " + await res.text());
    if (!res.body) throw new Error("AI stream response had no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    return {
      textStream: (async function* () {
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\\n"); buf = lines.pop() ?? "";
          for (const l of lines) {
            if (!l.startsWith("data: ")) continue;
            const p = l.slice(6).trim();
            if (p === "[DONE]") return;
            try { const d = JSON.parse(p).choices?.[0]?.delta?.content; if (d) yield d; } catch {}
          }
        }
      })(),
    };
  }
}

// Mirror real Mastra root container.
class Mastra {
  constructor({ agents = {} } = {}) { this.agents = agents; }
  getAgent(id) { return this.agents[id]; }
}

const supportAgent = new Agent({
  id: "supportAgent",
  name: "Support Agent",
  instructions: "You are a friendly retail support agent for an e-bike shop. Reply in 3 short sentences. Always close with a single emoji.",
  model: "google/gemini-3-flash-preview",
});

ctx.state.mastra = new Mastra({ agents: { supportAgent } });
ctx.log("Registered supportAgent on the Mastra container.");`,
    },
    {
      id: "md-generate", kind: "markdown",
      source: `### 1a · Using generate() for batch responses

The \`.generate()\` method is the standard way to get a full response from an agent. It waits for the model to finish before returning the text, usage metadata, and finish reason. This is ideal for background tasks or non-interactive flows.`,
    },
    {
      id: "agent-generate", kind: "code", language: "js", runtime: "browser",
      source: `const mastra = ctx.state.mastra;\nif (!mastra) throw new Error("Please run the previous setup cells first.");
const batch = await mastra.getAgent("supportAgent").generate("My battery only lasts 20km now. What can I do?");

ctx.log("─── generate() ───");
ctx.log(batch.text);
ctx.log("finishReason:", batch.finishReason, "| usage:", JSON.stringify(batch.usage));

ctx.state.lastBatchText = batch.text;`,
    },
    {
      id: "md-stream", kind: "markdown",
      source: `### 1b · Using stream() for real-time tokens

For chat interfaces, we use \`.stream()\`. It returns a \`textStream\` (an async iterable) that yields chunks as they arrive from the model. The API signature remains identical to \`.generate()\`.`,
    },
    {
      id: "agent-stream", kind: "code", language: "js", runtime: "browser",
      source: `const mastra = ctx.state.mastra;\nif (!mastra) throw new Error("Please run the previous setup cells first.");
ctx.log("─── stream() ───");

const live = await mastra.getAgent("supportAgent").stream("How do I keep the brakes from squeaking?");
let full = "", i = 0;

for await (const delta of live.textStream) {
  full += delta; i++;
  if (i % 5 === 0) ctx.log(\`δ #\${i}: \${JSON.stringify(delta)}\`);
}

ctx.log("\\nfinal:", full);
return { batch: ctx.state.lastBatchText, streamedChunks: i };`,
    },
    {
      id: "md-multi", kind: "markdown",
      source: `## 2 · Multi-turn conversations — pass an array of messages

Mastra's \`generate()\` accepts either a string (one user turn) or a full message array. Memory is a separate module (covered in notebook 4), but you can hand-roll multi-turn behavior by threading messages yourself.`,
    },
    {
      id: "tutor-setup", kind: "code", language: "js", runtime: "browser",
      source: `class Agent {
  constructor(cfg) { Object.assign(this, cfg); }
  async generate(messages) {
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: this.instructions }, ...messages],
      }),
    });
    if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
    const d = await res.json();
    const msg = d.choices?.[0]?.message;
    if (!msg) throw new Error("AI response did not include a message: " + JSON.stringify(d).slice(0, 200));
    return { text: msg.content };
  }
}

ctx.state.tutor = new Agent({
  id: "tutorAgent",
  name: "TypeScript Tutor",
  instructions: "You are a Socratic TypeScript tutor. Never give the answer outright — guide with one short question.",
  model: "google/gemini-3-flash-preview",
});

ctx.log("Tutor agent ready.");`,
    },
    {
      id: "md-tutor-run", kind: "markdown",
      source: `### 2a · Running a conversation loop

By keeping an array of \`history\` and appending each turn, we can maintain state across multiple calls. Each \`ask()\` call sends the entire history back to the model.`,
    },
    {
      id: "tutor-run", kind: "code", language: "js", runtime: "browser",
      source: `const tutor = ctx.state.tutor;
const history = [];

async function ask(q) {
  history.push({ role: "user", content: q });
  const { text } = await tutor.generate(history);
  history.push({ role: "assistant", content: text });
  ctx.log("user:     ", q);
  ctx.log("assistant:", text, "\\n");
}

const questions = [
  "What's the difference between 'unknown' and 'any'?",
  "Hmm, give me a tiny code example.",
  "Ok — so what would the compiler complain about if I used 'any' instead?"
];

for (const q of questions) {
  await ask(q);
}

return { turns: history.length / 2 };`,
    },
    {
      id: "outro", kind: "markdown",
      source: `## Recap & the rest of the Mastra surface

You now know Mastra's smallest useful program — an \`Agent\` registered on a \`Mastra\` root, called via \`.generate()\` or \`.stream()\`. The rest of the framework is layered on this same shape:

| Concept | Notebook |
| --- | --- |
| \`createTool({ id, inputSchema, outputSchema, execute })\` — typed function calling | 2 — Tools |
| \`createWorkflow\` / \`createStep\` — typed DAGs with \`.then\` / \`.parallel\` / \`.branch\` | 3 — Workflows |
| \`new Memory({ storage, vector, options })\` — threads, semantic recall, working memory | 4 — Memory |
| \`MDocument\` + \`embedMany\` + a vector store — production RAG | 5 — RAG |
| Eval scorers (faithfulness, answer-relevancy, custom) + telemetry | 6 — Evals & Observability |

### One more thing — the unified model router

Throughout this track we pass \`model: "google/gemini-3-flash-preview"\`. Real Mastra accepts the same \`provider/model-id\` string and resolves the right Vercel AI SDK provider for you — so swapping \`"openai/gpt-5"\` for \`"anthropic/claude-4-sonnet"\` requires zero other changes. That's the same uniform contract you saw in the Vercel AI SDK track, made first-class.`,
    },
  ],
};
