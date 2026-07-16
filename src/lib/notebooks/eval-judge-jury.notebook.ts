import type { Notebook } from "./types";

/**
 * Agentic Evals #3 — LLM-as-a-Judge & Jury.
 * Multi-dimensional rubric scoring, multi-judge consensus, agreement
 * variance as a confidence signal.
 */
export const evalJudgeJuryNotebook: Notebook = {
  id: "eval-judge-jury",
  title: "LLM-as-a-Judge & Jury — Rubrics, Consensus & Confidence",
  description:
    "Grade open-ended answers with a single LLM judge using a structured rubric, then upgrade to a 3-judge jury. Watch how disagreement between judges becomes your confidence signal.",
  difficulty: "intermediate",
  tags: ["evaluation"],
  subgroup: "Evaluation Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 3 · LLM-as-a-Judge & Jury

When code can't grade the answer, an LLM can. But a *single* judge has biases — it may prefer longer answers, its own writing style, or confident-sounding wrong answers.

This notebook does two things:

1. **Multi-dimensional rubric judging** — instead of "is this good?", we score *accuracy*, *completeness*, and *clarity* separately.
2. **The Jury pattern** — three different judges grade independently; the spread between them tells us how much to trust the verdict.

> **Key insight:** disagreement between judges isn't noise — it's a **confidence signal**. Three judges all give 5/5? Trust it. One gives 5, another 2? You have a problem to investigate.`,
    },

    // ───────── helpers
    {
      id: "helpers",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `ctx.state.judgeChat = async (model, system, user) => {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message ?? JSON.stringify(data));
  const raw = data.choices[0].message.content.trim().replace(/^\`\`\`(?:json)?\s*|\s*\`\`\`$/g, "");
  return JSON.parse(raw);
};
return "ready";
`,
    },

    // ───────── 1. single judge with rubric
    {
      id: "md-1",
      kind: "markdown",
      source: `## 1 · Single judge, multi-dimensional rubric

We grade three candidate answers to a question about Kubernetes pods on three axes:

- **accuracy** (technical correctness)
- **completeness** (covers the important angles)
- **clarity** (a non-expert can follow)

Each axis has score-level descriptions so the judge knows what 5 vs 3 vs 1 means — without anchors, scores drift.`,
    },
    {
      id: "single",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { judgeChat } = ctx.state;

const QUESTION = "Explain what a Kubernetes pod is and why it's the smallest deployable unit.";

const candidates = [
  { id: "A", text: "A pod is a small Kubernetes thing." },
  { id: "B", text: "A pod is one or more containers that share network and storage, scheduled together on a node. It's the smallest deployable unit because Kubernetes manages pods, not individual containers." },
  { id: "C", text: "A Kubernetes pod is an atomic deployable unit consisting of one or more tightly coupled containers that share a network namespace (same IP, port space) and storage volumes. It's the smallest unit because Kubernetes' scheduler, lifecycle, and networking model all operate at the pod level — containers inside a pod cannot be scheduled separately." },
];

const RUBRIC = \`You are a strict technical evaluator. Score the answer on three axes (1–5):

accuracy:
  5 = fully correct, no factual errors
  3 = mostly right but missing nuance or has minor errors
  1 = wrong or misleading

completeness:
  5 = covers all key points: definition, what's inside, why it's atomic
  3 = covers definition but misses one of the key points
  1 = vague or trivial

clarity:
  5 = a junior engineer could follow it
  3 = readable but needs re-reading
  1 = confusing or jargon-soup

Reply ONLY JSON: { "accuracy": n, "completeness": n, "clarity": n, "reasoning": "<=25 words" }\`;

const results = [];
for (const c of candidates) {
  const score = await judgeChat(
    "google/gemini-2.5-pro",
    RUBRIC,
    \`QUESTION: \${QUESTION}\\n\\nANSWER: \${c.text}\`
  );
  const avg = +((score.accuracy + score.completeness + score.clarity) / 3).toFixed(2);
  results.push({ id: c.id, ...score, average: avg });
}
return results;
`,
    },
    {
      id: "md-1x",
      kind: "markdown",
      source: `Candidate **A** should score ~1s across the board, **B** in the 3-4 range, **C** mostly 5s. The rubric does most of the heavy lifting — the same judge with a vague *"score 1-5"* prompt gives wildly different answers run to run.`,
    },

    // ───────── 2. jury
    {
      id: "md-2",
      kind: "markdown",
      source: `## 2 · The Jury — three judges, one verdict

Same rubric, but now three *different* model families judge independently:

- \`google/gemini-2.5-pro\`
- \`openai/gpt-5\`
- \`openai/gpt-5-mini\`

We average their scores and compute the **standard deviation** as our confidence signal.`,
    },
    {
      id: "jury",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { judgeChat } = ctx.state;

const JURY = ["google/gemini-2.5-pro", "openai/gpt-5", "openai/gpt-5-mini"];

const QUESTION = "Is it safe to use 'eval()' on user input in Python?";
const answers = {
  safe_looking_but_wrong:
    "Yes, eval() is safe as long as you sanitize input by removing dangerous keywords like 'import' and 'os' before passing it in.",
  correct:
    "No. eval() executes arbitrary Python and any blacklist of forbidden keywords can be bypassed. Use ast.literal_eval for parsing literals, or a proper parser/sandbox for anything else.",
};

const RUBRIC = \`Score the answer on a single axis 1–5:
  5 = factually correct and safe advice
  3 = partially correct, missing critical caveats
  1 = factually wrong or actively dangerous
Reply ONLY JSON: { "score": n, "reasoning": "<=20 words" }\`;

async function juryScore(answer) {
  const scores = [];
  for (const model of JURY) {
    const v = await judgeChat(model, RUBRIC, \`QUESTION: \${QUESTION}\\nANSWER: \${answer}\`);
    scores.push({ judge: model, score: v.score, reasoning: v.reasoning });
  }
  const nums = scores.map((s) => s.score);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  const stddev = Math.sqrt(variance);
  return { scores, mean: +mean.toFixed(2), stddev: +stddev.toFixed(2) };
}

return {
  dangerous_answer: await juryScore(answers.safe_looking_but_wrong),
  correct_answer:   await juryScore(answers.correct),
};
`,
    },
    {
      id: "md-2x",
      kind: "markdown",
      source: `Look at the **\`stddev\`** field. The correct answer usually has stddev near 0 — every judge agrees it's a 5. The dangerous answer often produces *higher* stddev: one judge sees the surface plausibility and scores a 3, another catches the security flaw and scores 1.

### How to act on stddev

- **stddev ≤ 0.5** → confident verdict, use the mean.
- **stddev 0.5–1.0** → borderline, log for human review.
- **stddev > 1.0** → judges fundamentally disagree. The example is either ambiguous or your rubric is unclear. **This is where to invest debugging time.**

### Cost reality check

A 3-judge jury triples your eval cost and latency. Use it when:
- The decision matters (release gate, model selection).
- You're building a labeled benchmark.
- A single judge is giving you weird results and you need a second opinion.

For per-PR smoke evals on cheap features, a single calibrated judge is fine.

### Up next
Notebook 4: **Evaluating Your Judge** — how do you know your judge itself is reliable? Spoiler: you label a small benchmark and measure TPR/TNR on the *judge*.`,
    },
  ],
};
