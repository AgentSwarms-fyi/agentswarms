import type { Notebook } from "./types";

/**
 * Agentic Evals #5 — RAG Evaluation Triad.
 * Context Relevance, Faithfulness, Answer Relevance, plus the classic
 * "right answer for the wrong reasons" trap.
 */
export const evalRagTriadNotebook: Notebook = {
  id: "eval-rag-triad",
  title: "RAG Evaluation Triad — Context Relevance, Faithfulness, Answer Relevance",
  description:
    "Three judges that together diagnose any RAG failure: did retrieval get the right context, did the LLM stay grounded in it, and did the final answer address the question. Includes a deliberately broken pipeline where the answer is right for the wrong reasons.",
  difficulty: "intermediate",
  tags: ["evaluation", "rag"],
  subgroup: "RAG & Agent Evaluation",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 5 · The RAG Evaluation Triad

When a RAG pipeline produces a bad answer, *which* component failed? The retriever? The prompt? The model?

You can't tell from the final answer alone. The **RAG Triad** (popularized by RAGAS and TruLens) decomposes the problem into three independent judges:

\`\`\`
        QUESTION ────────────────────────┐
            │                            │
            ▼                            │
     ┌─────────────┐                     │
     │  Retriever  │──► CONTEXT ─────────┤
     └─────────────┘         │           │
                             │           │
                             ▼           ▼
                          ┌──────────────────┐
                          │      LLM         │──► ANSWER
                          └──────────────────┘
\`\`\`

- **Context Relevance** — \`question vs context\`. Did the retriever fetch useful chunks?
- **Faithfulness (Groundedness)** — \`context vs answer\`. Is every claim in the answer supported by the context?
- **Answer Relevance** — \`question vs answer\`. Does the answer actually address what was asked?

The killer demo: we'll build a pipeline where the retriever fetches the **wrong document**, but the LLM produces a **correct answer anyway** (from pre-training memory). Final-answer evals say "great!". The triad catches the **faithfulness** failure — and tells you your retriever is dead weight.`,
    },

    // ───────── corpus & retriever
    {
      id: "md-c",
      kind: "markdown",
      source: `## Step 1 · A tiny corpus and a "broken" retriever

Three documents. Our retriever is intentionally bad: it always returns the *second* document, regardless of the question.

This simulates a real production bug: stale embeddings, wrong filter, off-by-one index — pick your poison.`,
    },
    {
      id: "corpus",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const DOCS = [
  { id: "d1", text: "The Eiffel Tower is 330 metres tall (including antennae) and is located in Paris, France." },
  { id: "d2", text: "Mount Everest is the highest mountain on Earth, with a peak elevation of 8,849 metres above sea level." },
  { id: "d3", text: "The Great Wall of China stretches over 21,000 km across northern China and was built over many dynasties." },
];

// "Broken" retriever: always returns d2 — pretend a config bug
ctx.state.brokenRetrieve = (_question) => [DOCS[1]];

// "Honest" retriever: returns whichever doc shares the most words with the question
ctx.state.honestRetrieve = (question) => {
  const qWords = new Set(question.toLowerCase().split(/\\W+/));
  const scored = DOCS.map((d) => ({
    doc: d,
    score: d.text.toLowerCase().split(/\\W+/).filter((w) => qWords.has(w)).length,
  })).sort((a, b) => b.score - a.score);
  return [scored[0].doc];
};

// LLM call
ctx.state.ask = async (system, user) => {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash", temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  return (await res.json()).choices[0].message.content;
};
return "corpus ready";
`,
    },

    // ───────── run pipeline
    {
      id: "md-r",
      kind: "markdown",
      source: `## Step 2 · Run the (broken) pipeline

We ask *"How tall is the Eiffel Tower?"*. The broken retriever returns the **Everest** doc. The LLM answers anyway — and probably gets it right from its training data.

A naïve "did we get the right answer?" eval would say ✅.`,
    },
    {
      id: "run",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { brokenRetrieve, ask } = ctx.state;
const QUESTION = "How tall is the Eiffel Tower?";
const ctxDocs = brokenRetrieve(QUESTION);
const contextText = ctxDocs.map((d) => d.text).join("\\n");

const answer = await ask(
  "Answer the question using ONLY the provided context. If the context doesn't contain the answer, say so.",
  \`CONTEXT:\\n\${contextText}\\n\\nQUESTION: \${QUESTION}\`
);

ctx.state.run = { question: QUESTION, context: contextText, answer };
return ctx.state.run;
`,
    },

    // ───────── judges
    {
      id: "md-j",
      kind: "markdown",
      source: `## Step 3 · The three judges

One judge per leg of the triad. Each is binary + reason — the cleanest design.`,
    },
    {
      id: "judges",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `async function judge(system, user) {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro", temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  return JSON.parse((await res.json()).choices[0].message.content);
}

ctx.state.judgeContextRelevance = (question, context) => judge(
  \`Decide if the CONTEXT contains information that would help answer the QUESTION.
Reply JSON: { "verdict": "RELEVANT" | "IRRELEVANT", "why": "<=15 words" }\`,
  \`QUESTION: \${question}\\nCONTEXT: \${context}\`
);

ctx.state.judgeFaithfulness = (context, answer) => judge(
  \`Decide if every factual claim in the ANSWER is supported by the CONTEXT.
If the answer states facts that are correct in the real world but NOT present in the context, that is UNFAITHFUL.
Reply JSON: { "verdict": "FAITHFUL" | "UNFAITHFUL", "why": "<=20 words" }\`,
  \`CONTEXT: \${context}\\nANSWER: \${answer}\`
);

ctx.state.judgeAnswerRelevance = (question, answer) => judge(
  \`Decide if the ANSWER directly addresses the QUESTION.
Reply JSON: { "verdict": "RELEVANT" | "IRRELEVANT", "why": "<=15 words" }\`,
  \`QUESTION: \${question}\\nANSWER: \${answer}\`
);
return "judges ready";
`,
    },

    // ───────── score the broken run
    {
      id: "md-s",
      kind: "markdown",
      source: `## Step 4 · Score the broken pipeline

This is the punchline. Watch the three verdicts:`,
    },
    {
      id: "score-broken",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { run, judgeContextRelevance, judgeFaithfulness, judgeAnswerRelevance } = ctx.state;

const [ctxRel, faith, ansRel] = await Promise.all([
  judgeContextRelevance(run.question, run.context),
  judgeFaithfulness(run.context, run.answer),
  judgeAnswerRelevance(run.question, run.answer),
]);

return {
  question: run.question,
  context: run.context,
  answer: run.answer,
  context_relevance: ctxRel,
  faithfulness:      faith,
  answer_relevance:  ansRel,
  diagnosis:
    ctxRel.verdict === "IRRELEVANT" && ansRel.verdict === "RELEVANT"
      ? "🚨 Right answer for the wrong reasons. Retriever returned irrelevant context but the LLM answered from pre-training. Your RAG layer is doing nothing."
      : "Looks OK.",
};
`,
    },
    {
      id: "md-sx",
      kind: "markdown",
      source: `**Context Relevance** flips to IRRELEVANT. **Faithfulness** flips to UNFAITHFUL (the answer's "330m" isn't anywhere in the Everest doc). **Answer Relevance** stays RELEVANT — because the answer *is* about the Eiffel Tower's height.

Without the triad, you'd never notice your retriever was dead. With it, you have an exact pointer: *"context_relevance is failing — fix the retriever first."*`,
    },

    // ───────── fix it
    {
      id: "md-f",
      kind: "markdown",
      source: `## Step 5 · Run again with the honest retriever

Now we swap to the keyword-matching retriever and re-score. All three should turn green.`,
    },
    {
      id: "fixed",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { honestRetrieve, ask, judgeContextRelevance, judgeFaithfulness, judgeAnswerRelevance } = ctx.state;
const Q = "How tall is the Eiffel Tower?";
const ctxDocs = honestRetrieve(Q);
const c = ctxDocs.map((d) => d.text).join("\\n");
const a = await ask(
  "Answer using ONLY the provided context.",
  \`CONTEXT:\\n\${c}\\n\\nQUESTION: \${Q}\`
);
const [cr, fa, ar] = await Promise.all([
  judgeContextRelevance(Q, c),
  judgeFaithfulness(c, a),
  judgeAnswerRelevance(Q, a),
]);
return { question: Q, context: c, answer: a,
         context_relevance: cr, faithfulness: fa, answer_relevance: ar };
`,
    },
    {
      id: "md-end",
      kind: "markdown",
      source: `### Operational pattern

Run the triad on a sample of production traffic continuously. Set alerts on:

- **Context Relevance drop** → retriever degradation (stale index, bad chunking, embedding model change).
- **Faithfulness drop** → model is hallucinating despite good context (prompt too loose, model swap regression).
- **Answer Relevance drop** → off-topic answers (usually a prompt or context-overflow issue).

### Up next
Notebook 6: **Agent Trajectory & Path Efficiency** — even when the final answer is correct, *how* the agent got there matters.`,
    },
  ],
};
