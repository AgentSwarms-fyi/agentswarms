import type { Notebook } from "./types";

export const vaiFundamentalsNotebook: Notebook = {
  id: "vai-fundamentals",
  title: "generateText, streamText & Provider Routing",
  description:
    "The Vercel AI SDK's two workhorse functions and its unified provider API. One signature works across OpenAI, Anthropic, Google, Mistral, Groq, Bedrock, and 30+ others — swap one import and you're done.",
  difficulty: "beginner",
  tags: ["content"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 1 · The Vercel AI SDK — \`generateText\` & \`streamText\`

The **Vercel AI SDK** (\`npm i ai\`) is the most popular TypeScript-first LLM toolkit. Its design philosophy is the opposite of LangChain's: rather than 200 integrations, ship **a small set of strict, type-safe primitives** that work identically across every provider.

The two functions you'll use every day:

| Function | Returns | Use for |
| --- | --- | --- |
| **\`generateText\`** | \`{ text, usage, finishReason, toolCalls, toolResults, steps, … }\` after the model finishes | Background jobs, structured pipelines, anything non-interactive |
| **\`streamText\`** | A live stream object (\`textStream\`, \`fullStream\`, \`toUIMessageStreamResponse()\`) | Chat UIs, real-time copilots, anything where the user waits |

Both have the **same signature**. Streaming is opt-in by changing the function name, not by rewriting the call.

\`\`\`ts
import { generateText, streamText } from "ai";
import { openai }    from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google }    from "@ai-sdk/google";

// Identical call — only the model import changes.
const { text } = await generateText({
  model: openai("gpt-5"),                 // ← swap to anthropic("claude-4") or google("gemini-3.5-flash")
  system: "You are a concise haiku poet.",
  prompt: "Write a haiku about TypeScript.",
});
\`\`\`

That uniform \`model: provider("model-id")\` shape is the SDK's superpower. You can A/B providers, fall back on rate limits, or run a cheap model for triage + expensive for synthesis — all with no glue code.

### Other top-level args

| Arg | What it does |
| --- | --- |
| \`messages\` | Chat history (alternative to \`prompt\`). Each item is \`{ role, content }\`. |
| \`tools\` | Tool functions the model can call (Notebook 3). |
| \`stopWhen\` | When to stop the multi-step agent loop (Notebook 4). |
| \`temperature\`, \`topP\`, \`maxTokens\`, \`seed\`, \`presencePenalty\` | Standard sampling knobs. |
| \`experimental_telemetry\` | OpenTelemetry traces — works with any OTel collector. |

Below we use the same \`/chat/completions\` proxy to demonstrate both \`generateText\` and \`streamText\` shapes — the contract is identical.`,
    },

    {
      id: "md-generate", kind: "markdown",
      source: `## 1 · \`generateText\` — the all-at-once shape

Returns a full result object. Notice the keys — they're exactly what the SDK gives back: \`text\`, \`usage\`, \`finishReason\`.`,
    },
    {
      id: "generate", kind: "code", language: "js", runtime: "browser",
      source: `async function generateText({ model, system, prompt, temperature = 0.7 }) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await res.json();
  return {
    text: data.choices[0].message.content,
    usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
    finishReason: data.choices[0].finish_reason,
  };
}

// 👇 Swap the model id to A/B providers — the call shape stays identical.
const result = await generateText({
  model:  "google/gemini-3-flash-preview",
  system: "You are a concise haiku poet.",
  prompt: "Write a haiku about TypeScript.",
});

ctx.log("text:        ", result.text);
ctx.log("finishReason:", result.finishReason);
ctx.log("usage:       ", JSON.stringify(result.usage));
return result;
`,
    },

    {
      id: "md-stream", kind: "markdown",
      source: `## 2 · \`streamText\` — the live shape

Same args, but you iterate \`textStream\` to get deltas as they arrive. In a Next.js route handler you'd return \`stream.toUIMessageStreamResponse()\` and the matching \`useChat\` hook renders it automatically.`,
    },
    {
      id: "stream", kind: "code", language: "js", runtime: "browser",
      source: `async function* streamText({ model, system, prompt }) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({
      model, stream: true,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.startsWith("data: ")) continue;
      const p = l.slice(6).trim();
      if (p === "[DONE]") return;
      try { const ev = JSON.parse(p); const d = ev.choices?.[0]?.delta?.content; if (d) yield d; }
      catch { /* keepalives */ }
    }
  }
}

ctx.log("─── streamText('Tell me about Mars in 3 sentences.') ───\\n");
let full = "";
let i = 0;
for await (const chunk of streamText({
  model: "google/gemini-3-flash-preview",
  system: "Reply in plain text. Three sentences exactly.",
  prompt: "Tell me about Mars.",
})) {
  full += chunk;
  i++;
  if (i % 4 === 0) ctx.log(\`δ chunk #\${i}: \${JSON.stringify(chunk)}\`);
}
ctx.log("\\n─── final text ───\\n" + full);
return { chunks: i, text: full };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & the wider SDK surface

You now know the two core functions. The rest of the Vercel AI SDK is built on these same primitives:

| Function | Notebook |
| --- | --- |
| \`generateObject\` / \`streamObject\` (Zod-typed JSON output) | 2 — Structured Output |
| \`tool\`, \`stepCountIs\`, multi-step agent loop | 3 — Tools |
| \`Agent\` class, \`stopWhen\`, \`prepareStep\` | 4 — Agents |
| \`embed\`, \`embedMany\`, \`cosineSimilarity\` | 5 — Embeddings & RAG |
| \`toUIMessageStreamResponse\` + \`useChat\` | 6 — UI Streaming |

### Provider routing & registry

In real apps you'd use a registry to centralise model choice:

\`\`\`ts
import { createProviderRegistry } from "ai";

const registry = createProviderRegistry({ openai, anthropic, google });

await generateText({ model: registry.languageModel("anthropic:claude-4-sonnet"), prompt: "..." });
\`\`\`

This makes A/B testing or fallback chains trivial — and is why teams move to the Vercel AI SDK when they outgrow a single provider.`,
    },
  ],
};
