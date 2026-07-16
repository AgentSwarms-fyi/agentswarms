import type { Notebook } from "./types";

export const vaiUiStreamingNotebook: Notebook = {
  id: "vai-ui-streaming",
  title: "UI Message Streaming, useChat & Tracing",
  description:
    "The other half of the SDK: how a streamText route handler talks to the useChat hook over UI Message Streams. Plus experimental_telemetry — the SDK's OpenTelemetry hook.",
  difficulty: "advanced",
  tags: ["content"],
  subgroup: "UI & Observability",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 6 · UI Message Streaming, \`useChat\` & Telemetry

The Vercel AI SDK has **two halves**: the *core* (which the last five notebooks covered) and the *UI* layer (\`@ai-sdk/react\`, \`@ai-sdk/vue\`, etc).

The contract between them is a **UI Message Stream** — a typed SSE format that carries text deltas, tool calls, tool results, structured object partials, sources, and metadata. Once your route handler returns it, the matching front-end hook (\`useChat\`, \`useCompletion\`, \`useObject\`) renders it for free.

### The server side — one line of glue

\`\`\`ts
// app/api/chat/route.ts
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const { messages } = await req.json();          // UI message format from useChat
  const result = streamText({
    model: openai("gpt-5"),
    messages: convertToModelMessages(messages),
    tools: { /* ... */ },
  });
  return result.toUIMessageStreamResponse();      // ← the magic
}
\`\`\`

### The client side — also one line

\`\`\`tsx
"use client";
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat();
  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => <div key={m.id}><b>{m.role}:</b> {m.content}</div>)}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
\`\`\`

That's a full streaming chat app in ~20 lines, end-to-end.

### Other UI hooks

| Hook | Use for | Pairs with |
| --- | --- | --- |
| \`useChat\` | Conversational chat with messages, tools, attachments. | \`streamText().toUIMessageStreamResponse()\` |
| \`useCompletion\` | Single-prompt-in, streaming-text-out. | \`streamText().toTextStreamResponse()\` |
| \`useObject\` | Streaming structured object (UI auto-renders partial fills). | \`streamObject().toTextStreamResponse()\` |

Below we **inspect the UI Message Stream format byte-by-byte** so you can read it (or build a custom client/server outside Next.js).`,
    },

    {
      id: "md-stream", kind: "markdown",
      source: `## 1 · What \`toUIMessageStreamResponse()\` actually sends on the wire

The UI message stream is SSE (\`text/event-stream\`) with line-prefixed typed parts:

| Prefix | Meaning |
| --- | --- |
| \`0:"chunk"\` | Text delta. |
| \`9:{...}\` | Tool call (toolCallId, toolName, args). |
| \`a:{...}\` | Tool result. |
| \`d:{...}\` | Finish event with usage and finishReason. |
| \`f:{...}\` | Metadata (messageId, model name, etc). |

We can't run a real \`useChat\` in a notebook, but we *can* simulate the framing by streaming model deltas into the same envelope so you understand exactly what the SDK is shipping.`,
    },
    {
      id: "stream", kind: "code", language: "js", runtime: "browser",
      source: `// A tiny "to UI message stream" encoder — exactly the prefixed line format
// the SDK emits to useChat / useObject.
function uiPart(type, payload) {
  const map = { text: "0", toolCall: "9", toolResult: "a", finish: "d", meta: "f" };
  return \`\${map[type]}:\${JSON.stringify(payload)}\\n\`;
}

const stream = [];
const messageId = "msg_" + Math.random().toString(36).slice(2, 8);

stream.push(uiPart("meta", { messageId, model: "google/gemini-3-flash-preview" }));

// Call the model with stream:true and forward deltas as UI text parts.
const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
  body: JSON.stringify({
    model: "google/gemini-3-flash-preview",
    stream: true,
    messages: [
      { role: "system", content: "Reply with exactly two short sentences." },
      { role: "user", content: "Why is streaming responses a better UX than waiting for the full answer?" },
    ],
  }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "", full = "", totalTokens = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const l of lines) {
    if (!l.startsWith("data: ")) continue;
    const p = l.slice(6).trim();
    if (p === "[DONE]") continue;
    try {
      const ev = JSON.parse(p);
      const d = ev.choices?.[0]?.delta?.content;
      if (d) { full += d; totalTokens++; stream.push(uiPart("text", d)); }
    } catch { /* keepalive */ }
  }
}
stream.push(uiPart("finish", { finishReason: "stop", usage: { completionTokens: totalTokens } }));

ctx.log("=== UI MESSAGE STREAM (what useChat receives over SSE) ===");
stream.slice(0, 25).forEach((line) => ctx.log(line.trimEnd()));
if (stream.length > 25) ctx.log(\`… (+\${stream.length - 25} more lines)\`);
ctx.log("\\n=== reconstructed full text ===\\n" + full);
return { parts: stream.length, fullText: full };
`,
    },

    {
      id: "md-telemetry", kind: "markdown",
      source: `## 2 · \`experimental_telemetry\` — OpenTelemetry spans for free

Every \`generateText\` / \`streamText\` / \`generateObject\` call can emit OTel spans:

\`\`\`ts
const result = await generateText({
  model:  openai("gpt-5"),
  prompt: "...",
  experimental_telemetry: {
    isEnabled: true,
    functionId: "ticket-classifier",     // logical name on the span
    metadata:   { userId, tenantId },    // attached to every span
    tracer:     myCustomTracer,          // optional — defaults to global OTel
  },
});
\`\`\`

What you get on the span:
- \`ai.model.id\` / \`ai.model.provider\`
- \`ai.usage.{promptTokens, completionTokens}\`
- \`ai.prompt.messages\` / \`ai.response.text\` (configurable — turn off in regulated environments)
- For agents: one nested span per step + per tool call.

Wire it to a Langfuse, Honeycomb, Braintrust, or Datadog OTel exporter and you have end-to-end traces with **zero per-call code**. This is the production observability story that the SDK ships with.

Below we simulate the span shape so you know what to expect downstream.`,
    },
    {
      id: "telemetry", kind: "code", language: "js", runtime: "browser",
      source: `// A toy OTel span emitter — same attribute keys the SDK uses.
function span(name, attrs) {
  return {
    name,
    timestamp: new Date().toISOString(),
    duration_ms: attrs._ms ?? 0,
    attributes: Object.fromEntries(Object.entries(attrs).filter(([k]) => !k.startsWith("_"))),
  };
}

const traceId = "trace_" + Math.random().toString(36).slice(2, 10);
const t0 = Date.now();

const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
  body: JSON.stringify({
    model: "google/gemini-3-flash-preview",
    messages: [
      { role: "system", content: "Classify the ticket: billing|tech|sales." },
      { role: "user", content: "Your /v1/runs endpoint just returned a 500." },
    ],
  }),
});
const data = await res.json();
const elapsed = Date.now() - t0;

const span1 = span("ai.generateText", {
  traceId,
  "ai.functionId": "ticket-classifier",
  "ai.model.provider": "google",
  "ai.model.id": "gemini-3-flash-preview",
  "ai.prompt.messages.count": 2,
  "ai.response.text": data.choices[0].message.content,
  "ai.usage.promptTokens":     data.usage?.prompt_tokens,
  "ai.usage.completionTokens": data.usage?.completion_tokens,
  "ai.response.finishReason":  data.choices[0].finish_reason,
  "metadata.tenantId":         "acme",
  _ms: elapsed,
});

ctx.log("=== OTel span (what experimental_telemetry emits) ===");
ctx.log(JSON.stringify(span1, null, 2));
return span1;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap — the full Vercel AI SDK in your head

You've now seen every major piece of the Vercel AI SDK:

| Notebook | Surface |
| --- | --- |
| 1 — Fundamentals | \`generateText\`, \`streamText\`, provider routing |
| 2 — Structured | \`generateObject\`, \`streamObject\`, Zod schemas, partial streams |
| 3 — Tools | \`tool({ description, parameters, execute })\`, \`stopWhen: stepCountIs(N)\` |
| 4 — Agents | \`Agent\` class, \`stopWhen + hasToolCall\`, \`prepareStep\`, \`onStepFinish\` |
| 5 — Embeddings | \`embed\`, \`embedMany\`, \`cosineSimilarity\`, mini-RAG |
| 6 — UI + Telemetry | \`toUIMessageStreamResponse()\`, \`useChat\`/\`useObject\`, \`experimental_telemetry\` |

### Things we couldn't fit (worth googling)

- **\`generateImage\`** / **\`generateSpeech\`** / **\`transcribe\`** — same one-call shape across providers.
- **Provider middleware** (\`wrapLanguageModel\`) — wrap any model with logging, caching, fallback, guardrails.
- **\`createProviderRegistry\`** — central \`provider:model\` routing for A/B and fallback chains.
- **Server actions integration** — Next.js \`<form action={...}>\` with \`useFormState\` of a streaming agent.

You now have two distinct mental models — **OpenAI Agents SDK** (Agent + Runner + handoffs) and **Vercel AI SDK** (functional primitives + UI streaming). Pick by team: Python-heavy & multi-agent? OpenAI SDK. TS/Next.js & UI-first? Vercel SDK. They are *not* mutually exclusive — many teams use the Vercel SDK for the UI streaming layer and the OpenAI Agents SDK for the backend orchestration.`,
    },
  ],
};
