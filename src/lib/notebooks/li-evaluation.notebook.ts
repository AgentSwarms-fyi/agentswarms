import type { Notebook } from "./types";

export const liEvaluationNotebook: Notebook = {
  id: "li-evaluation",
  title: "Evaluating Faithfulness & Answer Relevancy (RAG Triad)",
  description:
    "Score a RAG answer with two LLM judges — Faithfulness (is the answer grounded in context?) and Answer Relevancy (does it answer the question?). Corrupt the context and watch the scores collapse.",
  difficulty: "advanced",
  tags: ["llamaindex", "rag", "evaluation"],
  subgroup: "Production Evaluation",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 7 · Evaluating Faithfulness & Answer Relevancy

You cannot improve what you cannot measure. Once a RAG system is in production, the question stops being *"does this look right?"* and becomes *"how often does it hallucinate, and how often does it answer the wrong question?"*

LlamaIndex.ts ships **evaluator primitives** that use an LLM as a judge to score each answer on two of the three legs of what's called the **RAG Triad**:

| Metric | What it measures | What a low score means |
| --- | --- | --- |
| **Faithfulness** | Is every claim in the answer **supported by the retrieved context**? | 🚨 The model **hallucinated** — invented facts the context doesn't support. |
| **Answer Relevancy** | Does the answer **actually address the user's question**? | 🚨 The model went off-topic / answered a different question / dumped context without addressing intent. |
| (Context Relevancy) | (Bonus 3rd leg — is the *retrieved context* even relevant to the question? — covered in advanced eval notebooks.) | |

### The LlamaIndex.ts API

\`\`\`ts
import { FaithfulnessEvaluator, RelevancyEvaluator } from "llamaindex";

const faithful = new FaithfulnessEvaluator({ llm });
const relevant = new RelevancyEvaluator({ llm });

const r1 = await faithful.evaluate({ query, response, contexts });
// → { passing: boolean, score: 0..1, feedback: string }

const r2 = await relevant.evaluate({ query, response });
\`\`\`

Each evaluator is just a structured LLM call with a carefully worded rubric. We implement both below using \`withStructuredOutput\` so the rubric and the scoring logic are fully visible.

### Why this is so important

A hallucinated answer that *sounds right* is far more dangerous than a wrong answer that sounds wrong. LLM-as-judge eval is the cheapest way to surface hallucinations *at scale* without humans reading every output.`,
    },

    {
      id: "md-setup", kind: "markdown",
      source: `## 1 · Build a tiny RAG pipeline (the thing we'll evaluate)

A one-document KB. We'll run the same question through it twice in the next cells — once with **good** retrieved context, once with **corrupted** context — and watch the scores diverge.`,
    },
    {
      id: "setup", kind: "code", language: "js", runtime: "browser",
      source: `const { Document } = ctx.lc.documents;
const { RecursiveCharacterTextSplitter } = ctx.lc.textSplitters;
const { OpenAIEmbeddings } = ctx.lc.openai;
const { MemoryVectorStore } = ctx.lc.vectorstores;
const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

const SOURCE = \`Mount Everest stands at 8,848.86 meters above sea level, making it the highest mountain above sea level on Earth. It lies on the border between Nepal and the Tibet Autonomous Region of China. The first confirmed summit was by Edmund Hillary and Tenzing Norgay on May 29, 1953.\`;

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 200, chunkOverlap: 30 });
const chunks = await splitter.splitDocuments([new Document({ pageContent: SOURCE, metadata: { source: "everest.md" } })]);

const embeddings = new OpenAIEmbeddings({
  model: "google/gemini-embedding-001",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});
ctx.state.index = await MemoryVectorStore.fromDocuments(chunks, embeddings);

ctx.state.answerLlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.3,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

async function ragAnswer(question, contexts) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Answer the user using the provided context. Be specific."],
    ["human", "Context:\\n{ctx}\\n\\nQuestion: {q}"],
  ]);
  return await prompt.pipe(ctx.state.answerLlm).pipe(new StringOutputParser()).invoke({ ctx: contexts.join("\\n"), q: question });
}
ctx.state.ragAnswer = ragAnswer;

ctx.log("RAG pipeline ready. Index size:", chunks.length, "chunks.");
return { chunks: chunks.length };
`,
    },

    {
      id: "md-judges", kind: "markdown",
      source: `## 2 · Build the two LLM judges

Each is a small structured-output call. Read the system prompts carefully — they ARE the rubric.

- **Faithfulness judge**: "For each claim in the answer, is it supported by the context? Score 0–1."
- **Answer Relevancy judge**: "Does the answer actually address the question? Score 0–1."`,
    },
    {
      id: "judges", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { z } = ctx.lc;

const judgeLlm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const scoreSchema = z.object({
  score:    z.number().min(0).max(1).describe("0 = totally fails, 1 = fully passes"),
  passing:  z.boolean(),
  feedback: z.string().describe("One short paragraph explaining the score."),
});

const faithfulnessPrompt = ChatPromptTemplate.fromMessages([
  ["system",
    "You are a strict faithfulness judge. For every factual claim in the ANSWER, decide if it is directly supported by the CONTEXT. " +
    "If any claim is invented or contradicts the context, score below 0.5 and set passing=false. " +
    "Do not reward fluency. Only reward grounding."],
  ["human", "Question: {q}\\n\\nContext:\\n{ctx}\\n\\nAnswer:\\n{a}\\n\\nScore Faithfulness (0–1)."],
]);
const faithfulnessJudge = faithfulnessPrompt.pipe(judgeLlm.withStructuredOutput(scoreSchema));

const relevancyPrompt = ChatPromptTemplate.fromMessages([
  ["system",
    "You are an answer-relevancy judge. Decide if the ANSWER directly addresses what the QUESTION is asking for. " +
    "If the answer is off-topic, partial, or evasive, score below 0.5 and set passing=false. " +
    "Do not consider whether the answer is factually true here — only whether it answers the question."],
  ["human", "Question: {q}\\n\\nAnswer:\\n{a}\\n\\nScore Answer Relevancy (0–1)."],
]);
const relevancyJudge = relevancyPrompt.pipe(judgeLlm.withStructuredOutput(scoreSchema));

ctx.state.faithfulnessJudge = faithfulnessJudge;
ctx.state.relevancyJudge = relevancyJudge;
ctx.log("Both judges armed ✓");
return { judges: ["faithfulness", "answer_relevancy"] };
`,
    },

    {
      id: "md-good", kind: "markdown",
      source: `## 3 · Evaluate a GOOD answer (proper retrieved context)

Standard RAG path: retrieve real context, generate answer, score both metrics. Expect both scores to be high (≥0.8) and \`passing: true\`.`,
    },
    {
      id: "good", kind: "code", language: "js", runtime: "browser",
      source: `const Q = "How tall is Mount Everest and who first summited it?";

const hits = await ctx.state.index.similaritySearch(Q, 2);
const contexts = hits.map((h) => h.pageContent);
const answer = await ctx.state.ragAnswer(Q, contexts);
ctx.log("ANSWER:", answer);

const f = await ctx.state.faithfulnessJudge.invoke({ q: Q, ctx: contexts.join("\\n"), a: answer });
const r = await ctx.state.relevancyJudge.invoke({ q: Q, a: answer });

ctx.log("\\nFaithfulness   :", f.score, "·", f.passing ? "PASS" : "FAIL", "·", f.feedback);
ctx.log("Answer Relevancy:", r.score, "·", r.passing ? "PASS" : "FAIL", "·", r.feedback);
return { faithfulness: f, answer_relevancy: r };
`,
    },

    {
      id: "md-bad", kind: "markdown",
      source: `## 4 · Evaluate a BAD answer (corrupted context — should hallucinate)

We intentionally feed the LLM **wrong context** about a *different* mountain. The model is likely to either parrot the wrong context (low faithfulness vs. the *real* source we judge against) or invent facts.

We pass the **original true context** to the faithfulness judge — so when the answer drifts, faithfulness collapses. This is exactly the **"Hallucination Alert"** the user wants to see.`,
    },
    {
      id: "bad", kind: "code", language: "js", runtime: "browser",
      source: `const Q = "How tall is Mount Everest and who first summited it?";

// 👇 Corrupted context — wrong heights, wrong climbers, wrong dates.
const corruptedContexts = [
  "Mount Everest stands at 5,250 meters and is located entirely in Bhutan. The first ascent was made by Reinhold Messner in 1978 without oxygen.",
];
const answer = await ctx.state.ragAnswer(Q, corruptedContexts);
ctx.log("HALLUCINATED ANSWER:", answer);

// Judge against the REAL source, not the corrupted context.
const truthContext = [
  "Mount Everest stands at 8,848.86 meters above sea level. The first confirmed summit was by Edmund Hillary and Tenzing Norgay on May 29, 1953, on the Nepal/Tibet border.",
];

const f = await ctx.state.faithfulnessJudge.invoke({ q: Q, ctx: truthContext.join("\\n"), a: answer });
const r = await ctx.state.relevancyJudge.invoke({ q: Q, a: answer });

ctx.log("\\nFaithfulness   :", f.score, "·", f.passing ? "PASS" : "🚨 HALLUCINATION", "·", f.feedback);
ctx.log("Answer Relevancy:", r.score, "·", r.passing ? "PASS" : "FAIL", "·", r.feedback);

// Note: Answer Relevancy can stay HIGH even when Faithfulness collapses —
// because the answer still *addresses the question*, it's just wrong.
// That asymmetry is the whole reason we evaluate BOTH.
return { faithfulness: f, answer_relevancy: r };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## What you just built

A complete, two-judge eval harness. In production you'd:

1. **Run it on every release** — pick a fixed eval set of (question, expected context) pairs and track score deltas between RAG configurations (chunk size, top-k, model, prompt).
2. **Trigger on score drops** — page on faithfulness < 0.7 across the eval set.
3. **Pair with human review** for the failing cases — LLM judges drift; humans recalibrate.

The pattern you just learnt is **library-agnostic**. LlamaIndex.ts wraps it as \`FaithfulnessEvaluator\` / \`RelevancyEvaluator\`. LangChain wraps it as \`labeled_score_string\`. Ragas has \`faithfulness\` and \`answer_relevancy\`. All three are doing what cells 2–4 above just did.

### You've finished the LlamaIndex.ts track 🎉

You can now:
- Model your data as \`Document\` + \`TextNode\` with rich metadata.
- Build \`VectorStoreIndex\` and serve it as a Query Engine or Chat Engine.
- Apply **sentence-window**, **router**, and **sub-question** patterns to fix the failure modes vanilla RAG hits in production.
- Build **Data Agents** that orchestrate multiple knowledge bases.
- **Measure** whether any of it actually works.

Next stop: take a real document from \`/knowledge\`, swap it into any of these notebooks, and see your data flow through the same pipelines.`,
    },
  ],
};
