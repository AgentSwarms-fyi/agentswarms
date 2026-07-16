import type { Notebook } from "./types";

export const voltFundamentalsNotebook: Notebook = {
  id: "volt-fundamentals",
  title: "VoltAgent Fundamentals — Agent, instructions, generateText & streamText",
  description:
    "The VoltAgent mental model: an Agent (name + instructions + model + tools + memory) registered on a `new VoltAgent({ agents })` root, called via generateText() for batch and streamText() for live chat.",
  difficulty: "beginner",
  tags: ["agent"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 1 · VoltAgent — the AI agent engineering platform

**VoltAgent** (\`@voltagent/core\`) is an open-source TypeScript framework for production AI agents. It is built on top of the Vercel AI SDK and adds a typed agent model, a workflow engine, memory + RAG primitives, guardrails, MCP, and voice — all wired into a single \`VoltAgent\` root with observability built in.

\`\`\`ts
import { VoltAgent, Agent } from "@voltagent/core";
import { honoServer } from "@voltagent/server-hono";
import { openai } from "@ai-sdk/openai";

const supportAgent = new Agent({
  name: "support-agent",                       // stable identifier — used for tracing, memory keys, RPC
  instructions: "You are a polite support rep. Reply in 3 short sentences.",
  model: openai("gpt-4o-mini"),                // any ai-sdk provider works
});

export const voltAgent = new VoltAgent({
  agents: { supportAgent },                    // every agent lives on the root
  server: honoServer({ port: 3141 }),          // typed HTTP server + VoltOps console
});

const { text } = await supportAgent.generateText("Refund please?");
\`\`\`

### The two ways to call an agent

| Method | Returns | Use for |
| --- | --- | --- |
| \`agent.generateText(input, options?)\` | \`{ text, toolCalls, toolResults, usage, finishReason }\` once the model finishes | Batch jobs, evals, anything non-interactive |
| \`agent.streamText(input, options?)\` | A stream with \`textStream\`, \`fullStream\`, \`toUIMessageStreamResponse()\` | Chat UIs, copilots, anything the user watches |

Both take the same arguments. **Streaming is opt-in by changing the method name, not by rewriting the call** — the same pattern the Vercel AI SDK uses, because VoltAgent wraps it.

Below we hand-roll a tiny \`Agent\` that mirrors the real VoltAgent surface so every step is visible, but the LLM calls hit a real OpenAI-compatible endpoint, so the outputs you see are genuine model responses.`,
    },

    {
      id: "md-agent", kind: "markdown",
      source: `## 1 · An Agent that calls a real model

The cell below builds a VoltAgent-shaped \`Agent\` class with exactly the API the real package exposes: \`new Agent({ name, instructions, model })\` plus \`.generateText()\` and \`.streamText()\`. Both methods share the same code path — only the response handling differs.`,
    },
    {
      id: "define-agent", kind: "code", language: "js", runtime: "browser",
      source: `// Tiny VoltAgent-shaped Agent. Real package: \`import { Agent } from "@voltagent/core"\`.
ctx.state.Agent = class Agent {
  constructor({ name, instructions, model, tools }) {
    Object.assign(this, { name, instructions, model, tools: tools ?? {} });
  }
  _messages(input) {
    const turns = typeof input === "string"
      ? [{ role: "user", content: input }]
      : Array.isArray(input) ? input : [{ role: "user", content: input.prompt }];
    return [{ role: "system", content: this.instructions }, ...turns];
  }
  async generateText(input, options = {}) {
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model: this.model, temperature: options.temperature ?? 0.7, messages: this._messages(input) }),
    });
    const data = await res.json();
    return {
      text: data.choices[0].message.content,
      finishReason: data.choices[0].finish_reason,
      usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
    };
  }
  async streamText(input, options = {}) {
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model: this.model, stream: true, temperature: options.temperature ?? 0.7, messages: this._messages(input) }),
    });
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

// VoltAgent root container — registry + observability hub.
ctx.state.VoltAgent = class VoltAgent {
  constructor({ agents = {} } = {}) { this.agents = agents; }
  getAgent(name) { return this.agents[name]; }
}

ctx.log("Agent and VoltAgent classes defined.");`,
    },
    {
      id: "md-config", kind: "markdown",
      source: `### 2 · Register & Configure
We instantiate the \`Agent\` and register it into a \`VoltAgent\` container. In production, this container handles global configuration, telemetry, and serves as the registry for all your agents.`,
    },
    {
      id: "config-agent", kind: "code", language: "js", runtime: "browser",
      source: `const { Agent, VoltAgent } = ctx.state;

const supportAgent = new Agent({
  name: "support-agent",
  instructions: "You are a friendly retail support agent for an e-bike shop. Reply in 3 short sentences. Always close with a single emoji.",
  model: "google/gemini-3-flash-preview",
});

ctx.state.volt = new VoltAgent({ agents: { supportAgent } });
ctx.log("Agent 'support-agent' registered on VoltAgent root.");`,
    },
    {
      id: "md-generate", kind: "markdown",
      source: `### 3 · Simple Batch Generation
Use \`generateText()\` when you need the complete response at once. It's ideal for background tasks, data extraction, or any non-chat workflow.`,
    },
    {
      id: "generate-text", kind: "code", language: "js", runtime: "browser",
      source: `const volt = ctx.state.volt;
const batch = await volt.getAgent("supportAgent").generateText("My battery only lasts 20km now. What can I do?");

ctx.log("─── generateText() ───");
ctx.log(batch.text);
ctx.log("finishReason:", batch.finishReason, "| usage:", JSON.stringify(batch.usage));

return { text: batch.text };`,
    },
    {
      id: "md-stream", kind: "markdown",
      source: `### 4 · Streaming for Real-time Interaction
Use \`streamText()\` for chat interfaces. It returns an async generator (\`textStream\`) that yields text chunks as they arrive from the model.`,
    },
    {
      id: "stream-text", kind: "code", language: "js", runtime: "browser",
      source: `const volt = ctx.state.volt;
const live = await volt.getAgent("supportAgent").streamText("How do I keep the brakes from squeaking?");

ctx.log("─── streamText() ───");
let full = "", i = 0;
for await (const delta of live.textStream) {
  full += delta; i++;
  if (i % 5 === 0) ctx.log(\`chunk #\${i}: \${JSON.stringify(delta)}\`);
}
ctx.log("\\nfinal:", full);

return { streamedChunks: i };`,
    },

    {
      id: "md-multi", kind: "markdown",
      source: `## 2 · Multi-turn conversations
\`generateText()\` and \`streamText()\` both accept a full message array. While VoltAgent has high-level Memory modules, you can also manage state manually by passing the conversation history.`,
    },
    {
      id: "define-tutor", kind: "code", language: "js", runtime: "browser",
      source: `const { Agent } = ctx.state;

ctx.state.tutor = new Agent({
  name: "tutor",
  instructions: "You are a Socratic TypeScript tutor. Never give the answer outright — guide with one short question.",
  model: "google/gemini-3-flash-preview",
});

ctx.state.history = [];
ctx.log("Tutor agent initialized.");`,
    },
    {
      id: "md-run-multi", kind: "markdown",
      source: `### Driving the Conversation
We'll define a simple \`ask\` function that appends user input to the history, gets the response, and appends that too.`,
    },
    {
      id: "run-multi", kind: "code", language: "js", runtime: "browser",
      source: `const { tutor, history } = ctx.state;

async function ask(q) {
  history.push({ role: "user", content: q });
  const { text } = await tutor.generateText(history);
  history.push({ role: "assistant", content: text });
  ctx.log("user:     ", q);
  ctx.log("assistant:", text, "\\n");
}

await ask("What's the difference between 'unknown' and 'any'?");
await ask("Hmm, give me a tiny code example.");
await ask("Ok — so what would the compiler complain about if I used 'any' instead?");

return { turns: history.length / 2 };`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & the rest of the VoltAgent surface

You now know VoltAgent's smallest useful program — an \`Agent\` registered on a \`VoltAgent\` root, called via \`.generateText()\` or \`.streamText()\`. The rest of the framework is layered on top:

| Concept | Notebook |
| --- | --- |
| \`createTool({ name, parameters, execute })\` — typed function calling | Tools |
| \`new Memory({ storage, embedding, vector })\` — threads + working + semantic memory | Memory |
| Retrievers + vector stores (LanceDB, Pinecone, Chroma) | RAG |
| Input/output guardrail bundles (PII, profanity, prompt-injection, HTML) | Guardrails |
| \`MCPClient\` — talk to any Model Context Protocol server | MCP |
| \`@voltagent/voice\` — TTS/STT with OpenAI or ElevenLabs | Voice |
| \`createWorkflowChain().andThen().andAgent().andAll()\` — typed step graphs | Workflow |

### One more thing — the unified model router

Throughout this track we use \`"google/gemini-3-flash-preview"\` as a string. Real VoltAgent accepts any ai-sdk model object (\`openai("gpt-4o")\`, \`anthropic("claude-4-sonnet")\`, etc.) so swapping providers is one line.`,
    },
  ],
};
