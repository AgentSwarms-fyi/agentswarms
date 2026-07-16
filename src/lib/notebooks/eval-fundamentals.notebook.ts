import type { Notebook } from "./types";

/**
 * Agentic Evals #1 — Evaluation Fundamentals.
 * Deterministic vs. semantic assertions, embedding similarity, and the
 * canonical LLM-as-a-Judge pattern. Pure raw fetch — no frameworks — so
 * every moving piece is visible.
 */
export const evalFundamentalsNotebook: Notebook = {
  id: "eval-fundamentals",
  title: "Evaluation Fundamentals — Deterministic vs Semantic & LLM-as-Judge",
  description:
    "Why classic unit tests fail with LLMs. Build a strict regex check, a semantic similarity check using embeddings, and finally a structured LLM judge that grades on a rubric.",
  difficulty: "beginner",
  tags: ["evaluation"],
  subgroup: "Evaluation Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 1 · Evaluation Fundamentals

You shipped an agent. How do you *prove* it works?

Normal software testing — \`expect(answer).toBe("Paris")\` — falls apart with LLMs because:

- The model might answer *"The capital of France is Paris."* — same meaning, totally different string.
- The model is **stochastic**. Run it twice, get two answers.
- "Correct" often means *acceptable*, not *exact*.

This notebook builds the three foundational evaluator types you'll re-use everywhere:

1. **Deterministic / exact-match** — the strictest. Cheap. Brittle.
2. **Semantic similarity (embedding distance)** — close-in-meaning, not close-in-letters.
3. **LLM-as-a-Judge** — a stronger model grades the weaker one against a rubric.

We start with one shared helper, then add evaluators on top of it.`,
    },

    // ───────── helpers
    {
      id: "md-h",
      kind: "markdown",
      source: `## Shared helpers

Reusable tiny wrappers around \`/chat/completions\` and \`/embeddings\`. We stash them on \`ctx.state\` so every following cell can use them without redefining anything.`,
    },
    {
      id: "helpers",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Chat helper
async function chat(messages, opts = {}) {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: opts.model ?? "google/gemini-2.5-flash",
      messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.response_format ? { response_format: opts.response_format } : {}),
    }),
  });
  if (!res.ok) throw new Error("chat failed: " + res.status + " " + await res.text());
  const j = await res.json();
  return j.choices[0].message.content;
}

// Embedding helper — returns a Float32Array vector for a string
async function embed(text) {
  const res = await ctx.fetch(ctx.aiBaseURL + "/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error("embed failed: " + res.status + " " + await res.text());
  const j = await res.json();
  return j.data[0].embedding;
}

// Cosine similarity — 1.0 = identical meaning, 0 = unrelated, -1 = opposite
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

ctx.state.chat = chat;
ctx.state.embed = embed;
ctx.state.cosine = cosine;
return "helpers ready ✓";
`,
    },

    // ───────── 1. exact match
    {
      id: "md-1",
      kind: "markdown",
      source: `## 1 · The naïve exact-match evaluator

We ask the model *"What is the capital of France?"* and check the answer against the string \`"Paris"\`.

Watch what happens when the model is even slightly chatty.`,
    },
    {
      id: "exact",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { chat } = ctx.state;

const expected = "Paris";
const answer = await chat([
  { role: "user", content: "What is the capital of France?" },
], { temperature: 0 });

const exactPass = answer === expected;
const regexPass = /\\bParis\\b/.test(answer);

return { model_answer: answer, exact_match_pass: exactPass, loose_regex_pass: regexPass };
`,
    },
    {
      id: "md-1x",
      kind: "markdown",
      source: `Usually the model answers *"The capital of France is Paris."* — \`exact_match_pass\` is **false** even though the answer is perfect.

A loose regex catches more, but it still breaks the moment the model says *"That would be Paris, the City of Light."* with extra punctuation, or translates the word, or pluralizes it. **String matching does not scale.**`,
    },

    // ───────── 2. semantic similarity
    {
      id: "md-2",
      kind: "markdown",
      source: `## 2 · Semantic similarity — grade meaning, not letters

We turn both strings into **embedding vectors** (high-dimensional points where "similar meaning" = "close together"), then measure the angle between them with **cosine similarity**.

- \`1.0\` → identical meaning
- \`>0.85\` → safely similar (typical pass threshold)
- \`0.6 – 0.85\` → related but not the same
- \`<0.5\` → off-topic / wrong

Below we score four candidate answers against the gold answer.`,
    },
    {
      id: "semantic",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { embed, cosine } = ctx.state;

const gold = "Paris is the capital of France.";
const candidates = [
  "Paris",                                          // perfect short
  "The capital of France is Paris.",                // chatty but right
  "Paris, the City of Light, is France's capital.", // creative but right
  "London is the capital of France.",               // wrong
];

const goldVec = await embed(gold);
const scored = [];
for (const c of candidates) {
  const v = await embed(c);
  scored.push({ candidate: c, similarity: +cosine(goldVec, v).toFixed(3) });
}

const THRESHOLD = 0.75;
return scored.map((s) => ({ ...s, pass: s.similarity >= THRESHOLD }));
`,
    },
    {
      id: "md-2x",
      kind: "markdown",
      source: `Notice the wrong "London" answer typically still scores ~0.6 — the *topic* (capitals, countries) is similar. That's a gotcha: **semantic similarity grades topicality, not factual correctness.** It's great for catching off-topic answers, but it can wave through subtle factual errors.

That limitation is exactly why we need a smarter evaluator next.`,
    },

    // ───────── 3. LLM-as-Judge
    {
      id: "md-3",
      kind: "markdown",
      source: `## 3 · LLM-as-a-Judge — a stronger model grades the weaker one

The pattern:

1. A small/fast model produces an answer.
2. A **stronger** model receives \`{ question, answer, gold }\` and a strict rubric.
3. The judge returns a structured score (we force JSON via \`response_format\`).

Below we grade three mock support-agent replies on a 1–5 scale for **accuracy** and **tone**.`,
    },
    {
      id: "judge",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { chat } = ctx.state;

const supportReplies = [
  { customer: "I was charged twice for my plan.",
    agent: "I'm sorry about that. I can see the duplicate charge from 03/14 — I've issued a refund, which should appear in 3–5 business days." },
  { customer: "I was charged twice for my plan.",
    agent: "That's not my problem. Read the FAQ." },
  { customer: "I was charged twice for my plan.",
    agent: "Refund issued." },
];

const RUBRIC = \`You are a strict QA reviewer for a customer-support team.
Score the agent reply against the customer message on two axes from 1 to 5:

- accuracy   : 5 = directly resolves the issue with concrete next steps,
               3 = acknowledges but vague, 1 = wrong or dismissive.
- tone       : 5 = warm, professional, empathetic,
               3 = neutral, 1 = rude or robotic.

Reply ONLY with JSON:
{ "accuracy": number, "tone": number, "reasoning": string (<=20 words) }\`;

async function judgeOne({ customer, agent }) {
  const raw = await chat([
    { role: "system", content: RUBRIC },
    { role: "user", content: \`CUSTOMER: \${customer}\\nAGENT: \${agent}\` },
  ], { model: "google/gemini-2.5-pro", temperature: 0, response_format: { type: "json_object" } });
  return JSON.parse(raw);
}

const results = [];
for (const ex of supportReplies) {
  const score = await judgeOne(ex);
  results.push({ agent_reply: ex.agent, ...score });
}
return results;
`,
    },
    {
      id: "md-3x",
      kind: "markdown",
      source: `Two things make this work:

1. **Strict scale with score-level descriptions.** "Score 1–5" alone gives mush; defining what each number means anchors the judge.
2. **Forced JSON output.** Without \`response_format: { type: "json_object" }\` the judge would wrap scores in prose and your parser would break.

### The three rules of LLM-as-Judge

- **Use a stronger model than the one being judged.** A 2.5-flash agent judged by a 2.5-pro evaluator is the canonical setup.
- **Temperature 0 on the judge** — you want repeatable verdicts.
- **One concept per judge.** A single judge that scores "accuracy AND tone AND completeness" muddles signal. Better to run three small judges. We'll do this properly in notebook #4 (Evaluating Your Judge).

### Up next
Notebook 2: **Programmatic Evaluation** — where you *can* check answers with code (numbers, structured fields, classification), do so. It's free, fast, and beats any judge.`,
    },
  ],
};
