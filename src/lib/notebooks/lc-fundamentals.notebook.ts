import type { Notebook } from "./types";

/**
 * LangChain Fundamentals — chat, messages, streaming, model_kwargs,
 * guardrails, multimodal. Browser-runnable, no mocks.
 */
export const lcFundamentalsNotebook: Notebook = {
  id: "lc-fundamentals",
  title: "LangChain Fundamentals",
  description:
    "Chat output, multi-turn message types, streaming, model_kwargs, simple guardrails, and vision/multimodal — all with real @langchain/openai.",
  difficulty: "beginner",
  tags: ["langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 1 · LangChain Fundamentals

This notebook is for absolute beginners. We'll do six tiny things with
**real LangChain** — no mocks:

1. First chat output
2. Multi-turn conversation using LangChain message types
3. Real-time **streaming** output
4. Tuning behaviour with **model_kwargs** + a simple **guardrail**
5. **Vision / multimodal** input

> Note on types: LangChain's Python uses **Pydantic** for structured args.
> The JS port uses **Zod**, which is the exact equivalent. Anywhere a
> Python tutorial says \`BaseModel\`, write \`z.object({...})\` here.

Hit **Shift+Enter** to run a cell.`,
    },

    // 1 — First chat
    { id: "md-1", kind: "markdown", source: `## 1 · First chat output\n\nThe smallest possible LangChain program: instantiate \`ChatOpenAI\`, call \`.invoke()\`.` },
    {
      id: "first-chat",
      kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const res = await llm.invoke("Say hello in 5 words.");
return res.content;
`,
    },
    { id: "md-1x", kind: "markdown", source: `\`llm.invoke(string)\` wraps the input in a \`HumanMessage\` and returns an \`AIMessage\`. The text lives on \`.content\`.` },

    // 2 — Multi-turn with message types
    { id: "md-2", kind: "markdown", source: `## 2 · Multi-turn with LangChain message types\n\nLangChain models a conversation as an **array of typed messages**: \`SystemMessage\`, \`HumanMessage\`, \`AIMessage\`. You append to the array as the conversation progresses.` },
    {
      id: "multi-turn", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage, AIMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.2,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const history = [
  new SystemMessage("You are a witty pirate. Reply in <=20 words."),
  new HumanMessage("What's your favourite breakfast?"),
];
const a1 = await llm.invoke(history);
history.push(a1);                                  // remember the answer

history.push(new HumanMessage("And to drink with it?"));
const a2 = await llm.invoke(history);

return { first: a1.content, follow_up: a2.content, messages_used: history.length };
`,
    },
    { id: "md-2x", kind: "markdown", source: `Notice the second turn references "**it**" — that only works because we sent the full message history. The model itself is stateless; **you** own the conversation array.` },

    // 3 — Streaming
    { id: "md-3", kind: "markdown", source: `## 3 · Real-time streaming\n\nUse \`.stream()\` (instead of \`.invoke()\`) to receive an async iterator of partial \`AIMessageChunk\`s. We append each chunk's \`.content\` to \`ctx.log\` so you see it grow live.` },
    {
      id: "streaming", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.7,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const stream = await llm.stream("Write a 4-line haiku about TypeScript.");
let full = "";
for await (const chunk of stream) {
  const t = typeof chunk.content === "string" ? chunk.content : "";
  full += t;
  if (t) ctx.log("chunk:", JSON.stringify(t));
}
return full;
`,
    },
    { id: "md-3x", kind: "markdown", source: `Each \`chunk\` is a real \`AIMessageChunk\`. In a UI you'd push these into a state setter — exactly how ChatGPT renders token-by-token.` },

    // 4 — model_kwargs + guardrails
    { id: "md-4", kind: "markdown", source: `## 4 · Fine-tune with \`modelKwargs\` + a simple guardrail\n\n\`ChatOpenAI\` exposes \`temperature\`, \`maxTokens\`, \`topP\`, \`presencePenalty\`, \`frequencyPenalty\`, and a free-form \`modelKwargs\` for provider-specific knobs. We'll also add a tiny **input guardrail** — refuse prompts containing banned words before they ever reach the model.` },
    {
      id: "kwargs-guard", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { RunnableLambda } = ctx.lc.runnables;

// 1. The model with fine-tuned behaviour
const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0.9,
  maxTokens: 80,
  topP: 0.95,
  presencePenalty: 0.3,
  modelKwargs: { seed: 42 },              // provider-specific extras
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

// 2. Guardrail: a plain Runnable that rejects bad input
const banned = ["password", "ssn", "credit card"];
const guard = RunnableLambda.from(async (input) => {
  const lower = String(input).toLowerCase();
  const hit = banned.find((w) => lower.includes(w));
  if (hit) throw new Error("Guardrail tripped: input contains '" + hit + "'");
  return input;
});

// 3. Compose with .pipe — guardrail runs BEFORE the model
const chain = guard.pipe(llm);

const safe = await chain.invoke("Suggest a fun weekend project idea.");
let blocked;
try { await chain.invoke("Tell me my password."); }
catch (e) { blocked = e.message; }

return { safe_answer: safe.content, blocked };
`,
    },
    { id: "md-4x", kind: "markdown", source: `Two ideas in one cell:\n\n- **\`modelKwargs\`** lets you pass any provider field LangChain doesn't model directly (\`seed\`, \`response_format\`, etc.).\n- **Guardrails** in LangChain are just \`Runnable\`s composed with \`.pipe()\`. There's no special class — input/output validators are regular chain steps.` },

    // 5 — Vision / multimodal
    { id: "md-5", kind: "markdown", source: `## 5 · Vision & multimodal\n\nMultimodal messages use a **content array** with mixed parts: \`{ type: "text" }\` and \`{ type: "image_url" }\`. Most Gemini and GPT-5 models accept this shape unchanged.` },
    {
      id: "vision", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-2.5-flash",   // multimodal-capable
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const imageUrl =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png";

const msg = new HumanMessage({
  content: [
    { type: "text", text: "Describe this image in one sentence, then list 3 colours you see." },
    { type: "image_url", image_url: { url: imageUrl } },
  ],
});

const res = await llm.invoke([msg]);
return res.content;
`,
    },
    { id: "md-5x", kind: "markdown", source: `That's the whole multimodal API — a content array on a normal \`HumanMessage\`. You can mix multiple images and text parts in any order. Vision lab and PDFs come in **Notebook 2**.` },
  ],
};
