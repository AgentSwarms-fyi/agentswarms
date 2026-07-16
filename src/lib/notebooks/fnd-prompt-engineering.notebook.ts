import type { Notebook } from "./types";

/**
 * Foundations Lab #1 — Prompt Engineering & Text Generation.
 * Beginner-friendly tour from "first prompt" to advanced patterns
 * (system vs user, few-shot, chain-of-thought, role/persona, structured
 * output, controlled generation with temperature/top_p). Runs entirely
 * through the notebook proxy — no API keys leave the browser.
 */
export const fndPromptEngineeringNotebook: Notebook = {
  id: "fnd-prompt-engineering",
  title: "Prompt Engineering & Text Generation Lab",
  description:
    "Start here. Learn the building blocks of prompting — system vs user roles, few-shot examples, chain-of-thought, persona/style control, structured JSON, and temperature/top_p — all with runnable cells.",
  difficulty: "beginner",
  tags: ["content"],
  subgroup: "Prompting Basics",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 1 · Prompt Engineering & Text Generation Lab

Welcome — this is the very first notebook on the platform. If you have **never written a prompt before**, you are in the right place.

We use the **raw \`fetch\` API** here (no LangChain yet) so you can see exactly what a request to an LLM looks like. Later notebooks wrap this in fancy libraries; you'll appreciate them much more after seeing the raw thing.

### What you will learn
1. The anatomy of a chat request: \`model\`, \`messages\`, \`system\` vs \`user\`
2. **Few-shot prompting** — teach the model a pattern by example
3. **Chain-of-thought** — ask the model to reason step-by-step
4. **Persona & style** — control tone, voice, format
5. **Structured JSON output** — get machine-readable answers
6. **Decoding params** — \`temperature\` and \`top_p\` (creativity dials)
7. **Comparing prompts** — same task, three prompt styles, see the difference

### How to run a cell
Click **Run** on each cell, or press **Shift+Enter**. Edit the code freely — it's yours.`,
    },

    // ───────────────────────────────── 1. Anatomy of a chat call
    { id: "md-1", kind: "markdown", source: `## 1 · Anatomy of a chat request

Every modern LLM API follows the same shape:

\`\`\`json
{
  "model": "<which AI brain to use>",
  "messages": [
    { "role": "system", "content": "Instructions for the AI's behaviour" },
    { "role": "user",   "content": "What the user actually said" }
  ]
}
\`\`\`

- **system** message = the "job description" or rules. Set once at the start.
- **user** message = what the human is asking right now.
- **assistant** message = what the AI said previously (used to keep context in multi-turn chats).

Below we send the simplest possible request. The function \`callAI()\` is just a wrapper around \`fetch\` — you can read it on line 1.` },
    {
      id: "first-call", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 Tiny helper — same wrapper used in every cell below.
async function callAI(messages, opts = {}) {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: opts.model ?? "google/gemini-3-flash-preview",
      messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.response_format ? { response_format: opts.response_format } : {}),
    }),
  });
  if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
  const json = await res.json();
  return json.choices[0].message.content;
}
ctx.state.callAI = callAI;   // re-use in later cells

// 🎬 First call — change the prompt and run it again.
const answer = await callAI([
  { role: "system", content: "You are a friendly tutor. Reply in one short sentence." },
  { role: "user",   content: "What is a Large Language Model?" },
]);
return answer;
`,
    },
    { id: "md-1x", kind: "markdown", source: `**Try it:** Re-run with the system prompt changed to *"You explain things like the user is five."* Notice how the **same question** produces a completely different answer based on the system instruction. That's the whole point of role-based prompting.` },

    // ───────────────────────────────── 2. Zero-shot vs Few-shot
    { id: "md-2", kind: "markdown", source: `## 2 · Few-shot prompting — teach by example

**Zero-shot** = you just ask the question.
**Few-shot** = you give the model 2-3 worked examples *before* the real question, so it learns the pattern you want.

This is one of the highest-ROI tricks in prompting. Models are excellent pattern matchers — if you show them the format, they will copy it.

Below we ask the model to classify a customer email as *Bug / Feature Request / Billing*. We do it **twice**: once with no examples, once with three. Compare.` },
    {
      id: "few-shot", kind: "code", language: "js", runtime: "browser",
      source: `const callAI = ctx.state.callAI;
const newEmail = "Hi, I was charged twice last month for my subscription. Can you help?";

// (A) Zero-shot — just ask
const zeroShot = await callAI([
  { role: "system", content: "Classify the email as one of: Bug, Feature Request, Billing." },
  { role: "user",   content: newEmail },
], { temperature: 0 });

// (B) Few-shot — show 3 examples first, THEN the real one
const fewShot = await callAI([
  { role: "system", content: "Classify each email as one of: Bug, Feature Request, Billing. Reply with only the label." },
  { role: "user",   content: "App crashes when I upload a 10MB file." },
  { role: "assistant", content: "Bug" },
  { role: "user",   content: "Could you add dark mode please?" },
  { role: "assistant", content: "Feature Request" },
  { role: "user",   content: "I cancelled but still got charged." },
  { role: "assistant", content: "Billing" },
  { role: "user",   content: newEmail },
], { temperature: 0 });

return { zero_shot: zeroShot, few_shot: fewShot };
`,
    },
    { id: "md-2x", kind: "markdown", source: `Zero-shot often returns extra chatter ("This email appears to be about..."). Few-shot usually returns just \`Billing\` — because every example in the history was a single word.

**Rule of thumb:** if you find yourself writing "please reply with ONLY the label", you probably want a few-shot prompt instead.` },

    // ───────────────────────────────── 3. Chain-of-thought
    { id: "md-3", kind: "markdown", source: `## 3 · Chain-of-thought — ask the model to think step-by-step

For tasks that involve **reasoning** (math, logic, multi-step problems), the single most effective phrase is:

> *"Let's think step by step."*

This forces the model to write out intermediate reasoning before committing to an answer, which dramatically improves accuracy on tricky problems.` },
    {
      id: "cot", kind: "code", language: "js", runtime: "browser",
      source: `const callAI = ctx.state.callAI;

const puzzle = "Alice has 3x as many marbles as Bob. Together they have 24. " +
               "Alice gives 4 to Bob. How many does Bob have now?";

// (A) No reasoning — straight answer
const blunt = await callAI([
  { role: "system", content: "Reply with only the final number." },
  { role: "user",   content: puzzle },
], { temperature: 0 });

// (B) Chain-of-thought
const reasoned = await callAI([
  { role: "system", content: "Solve the problem. Think step by step, show your reasoning, then write 'ANSWER: <number>' on the last line." },
  { role: "user",   content: puzzle },
], { temperature: 0 });

return { blunt, reasoned };
`,
    },
    { id: "md-3x", kind: "markdown", source: `The blunt version sometimes guesses wrong; the reasoned version is reliable because the model **commits to intermediate steps** before answering.

In production you usually want both: the reasoning (for debugging / trust) **and** a clean final answer. The convention \`ANSWER: …\` on the last line makes it trivial to parse with a regex.` },

    // ───────────────────────────────── 4. Persona & style
    { id: "md-4", kind: "markdown", source: `## 4 · Persona & style — same facts, different voice

The system prompt isn't just for rules — it's also where you set **voice, tone, audience, and format**. Below we ask the same question three times, varying only the persona.` },
    {
      id: "persona", kind: "code", language: "js", runtime: "browser",
      source: `const callAI = ctx.state.callAI;
const question = "Explain why the sky is blue.";

const personas = [
  "You are a Nobel-prize physicist. Be precise and use proper terminology.",
  "You are a kindergarten teacher. Use a simple metaphor a 5-year-old understands.",
  "You are a sarcastic comedian. Be funny but still factually correct.",
];

const answers = await Promise.all(
  personas.map((p) => callAI([
    { role: "system", content: p + " Reply in 2 sentences max." },
    { role: "user",   content: question },
  ], { temperature: 0.7 }))
);

return personas.map((p, i) => ({ persona: p.split(".")[0], answer: answers[i] }));
`,
    },
    { id: "md-4x", kind: "markdown", source: `**Takeaway:** persona is one of the cheapest ways to control output. You don't need a fine-tuned model — you just need a sharper system prompt.` },

    // ───────────────────────────────── 5. Structured JSON output
    { id: "md-5", kind: "markdown", source: `## 5 · Structured output — get JSON back, not prose

If your downstream code needs to *use* the answer (save to a DB, render a UI, call another API), prose is useless — you want **structured JSON**.

Two ways to get it:

1. **Ask politely in the prompt** + tell the model the shape. Works but flaky.
2. **\`response_format: { type: "json_object" }\`** — the API guarantees valid JSON.

We'll do #2.` },
    {
      id: "json-out", kind: "code", language: "js", runtime: "browser",
      source: `const callAI = ctx.state.callAI;

const review = "Loved the battery life on the new Phone X, but the camera in low light is mediocre " +
               "and Face ID doesn't work with sunglasses. Overall I'd give it a 7/10.";

const raw = await callAI([
  { role: "system", content: \`Extract a product review into JSON with this exact shape:
{
  "product": string,
  "rating_out_of_10": number,
  "pros": string[],
  "cons": string[],
  "summary": string  // <=15 words
}\` },
  { role: "user", content: review },
], { temperature: 0, response_format: { type: "json_object" } });

// raw is a JSON-shaped string — parse it
const parsed = JSON.parse(raw);
return parsed;
`,
    },
    { id: "md-5x", kind: "markdown", source: `Now you can do \`parsed.cons.length\`, render the rating as stars, etc. This is the foundation of every "AI does something useful in an app" feature. Later notebooks (LangChain's \`withStructuredOutput\`, LlamaIndex pydantic-like schemas) just put nicer ergonomics on top of this.` },

    // ───────────────────────────────── 6. Temperature & top_p
    { id: "md-6", kind: "markdown", source: `## 6 · Temperature & top_p — the creativity dials

- **\`temperature\` (0–2)** — how random the model's word choice is. \`0\` = deterministic / boring / factual. \`1.2\` = creative / surprising / sometimes wrong.
- **\`top_p\` (0–1)** — only sample from the top-N% of likely words. \`0.1\` = very conservative; \`1.0\` = anything goes.

Use **low temperature** for code, math, extraction, classification.
Use **higher temperature** for brainstorming, creative writing, ad copy.` },
    {
      id: "temp", kind: "code", language: "js", runtime: "browser",
      source: `const callAI = ctx.state.callAI;
const messages = [
  { role: "system", content: "You write taglines. One line, <= 8 words." },
  { role: "user",   content: "Tagline for a productivity app for indie developers." },
];

const cold = await callAI(messages, { temperature: 0 });
const warm = await callAI(messages, { temperature: 0.9 });
const hot  = await callAI(messages, { temperature: 1.3 });

return { temperature_0: cold, temperature_0_9: warm, temperature_1_3: hot };
`,
    },
    { id: "md-6x", kind: "markdown", source: `Re-run the cell a few times. The \`temperature: 0\` answer is (almost) always the same; the hot one varies wildly. That variance is **a feature** when brainstorming, **a bug** when generating SQL.` },

    // ───────────────────────────────── 7. Side-by-side comparison
    { id: "md-7", kind: "markdown", source: `## 7 · Putting it together — three prompts, one task

Final exercise. We give the model the same gnarly text and ask it to write a tweet, using three prompt strategies:

1. **Naïve** — just ask
2. **Persona + constraints** — give a voice and explicit rules
3. **Few-shot + persona + constraints** — the kitchen sink

Read the outputs and judge for yourself which is most usable.` },
    {
      id: "compare", kind: "code", language: "js", runtime: "browser",
      source: `const callAI = ctx.state.callAI;

const article = \`Researchers at MIT showed that small language models, when fine-tuned on
high-quality reasoning traces, can match or beat much larger models on multi-step math
benchmarks while running 40x cheaper at inference time. The paper argues that data quality,
not model size, is now the main bottleneck for reasoning capability.\`;

// 1 — Naïve
const naive = await callAI([
  { role: "user", content: "Write a tweet about this:\\n" + article },
], { temperature: 0.7 });

// 2 — Persona + constraints
const persona = await callAI([
  { role: "system", content: "You write tweets for an AI engineering audience. Max 240 chars. " +
    "No hashtags. No emojis. End with a sharp takeaway." },
  { role: "user",   content: "Tweet this:\\n" + article },
], { temperature: 0.7 });

// 3 — Few-shot + persona + constraints
const fewshot = await callAI([
  { role: "system", content: "You write tweets for an AI engineering audience. Max 240 chars. " +
    "No hashtags. No emojis. End with a sharp takeaway. Match the style of these examples." },
  { role: "user",     content: "Topic: GPT-4 turbo price cut" },
  { role: "assistant", content: "GPT-4 turbo just got 3x cheaper. The economics of 'just use the biggest model' finally make sense for startups. The moat is no longer model access — it's the data you feed it." },
  { role: "user",     content: "Topic: vector DBs commoditizing" },
  { role: "assistant", content: "Every Postgres install now ships pgvector. The 'vector database' as a category is collapsing into 'feature of your existing DB'. Pick your battles — RAG quality lives in chunking, not storage." },
  { role: "user",     content: "Topic: " + article },
], { temperature: 0.7 });

return { naive, persona, few_shot: fewshot };
`,
    },
    { id: "md-7x", kind: "markdown", source: `Notice how prompt #3 produces tweets that *sound like* the example tweets — same rhythm, same closer. That's pattern transfer in action.

### You're done with notebook 1 🎉
Next: the **Image & Multimodal Lab** — same fetch wrapper, but with pictures going in and coming out.` },
  ],
};
