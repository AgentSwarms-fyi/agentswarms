import type { Notebook } from "./types";

/**
 * Agentic Evals #4 — Evaluating Your Judge.
 * Binary pass/fail benchmarks, TPR/TNR, repeatability, length-bias.
 */
export const evalMetaJudgeNotebook: Notebook = {
  id: "eval-meta-judge",
  title: "Evaluating Your Judge — TPR/TNR, Repeatability & Length Bias",
  description:
    "Your judge is just another model — you have to grade IT before trusting it. Build a tiny human-labeled benchmark, measure True Positive / True Negative Rate, run repeatability tests, and detect length bias.",
  difficulty: "intermediate",
  tags: ["evaluation"],
  subgroup: "Evaluation Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 4 · Evaluating Your Judge

An LLM-as-a-Judge is just another model. If it's wrong 30% of the time, you've built a measurement instrument that lies — and then made deployment decisions with it.

Before trusting any judge in a CI pipeline, you must **calibrate** it against a small human-labeled benchmark.

This notebook walks through the four checks every judge should pass:

1. **Binary failure-mode judges** — one judge per criterion (factual vs hallucinated), pass/fail only.
2. **TPR & TNR on a labeled benchmark** — how often does the judge agree with humans?
3. **Repeatability** — run the same example 5×, do verdicts flip?
4. **Length-bias detection** — does the judge prefer longer answers regardless of quality?

We finish with a **judge scorecard** that summarizes deploy-readiness.`,
    },

    // ───────── bench
    {
      id: "md-b",
      kind: "markdown",
      source: `## Step 1 · The labeled benchmark

In a real project this is 100+ human-reviewed examples. Here we use 8 to demonstrate. Each example has:

- The input the agent saw.
- The agent's output.
- A **human label**: "PASS" or "FAIL" on a single failure mode — *"is the output factually grounded?"*.

We split into a **dev set** (used while iterating on the judge prompt) and a **test set** (held out, used once to report final numbers).`,
    },
    {
      id: "bench",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Each example: question, agent answer, human "factually grounded?" verdict
const BENCH = [
  { q: "What year did the Berlin Wall fall?",      a: "It fell in 1989.",                                          human: "PASS" },
  { q: "What year did the Berlin Wall fall?",      a: "It fell in 1991, after the Soviet collapse.",               human: "FAIL" },
  { q: "What is the capital of Australia?",         a: "Canberra.",                                                 human: "PASS" },
  { q: "What is the capital of Australia?",         a: "Sydney.",                                                   human: "FAIL" },
  { q: "Boiling point of water at sea level?",      a: "100°C (212°F) at 1 atm.",                                   human: "PASS" },
  { q: "Boiling point of water at sea level?",      a: "Around 90°C, depending on weather.",                        human: "FAIL" },
  { q: "Who wrote 'Pride and Prejudice'?",          a: "Jane Austen, published 1813.",                              human: "PASS" },
  { q: "Who wrote 'Pride and Prejudice'?",          a: "Charlotte Brontë.",                                         human: "FAIL" },
];

// Split: 4 dev, 4 test
ctx.state.DEV  = BENCH.slice(0, 4);
ctx.state.TEST = BENCH.slice(4);

ctx.state.runJudge = async (system, ex) => {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro", temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: \`QUESTION: \${ex.q}\\nANSWER: \${ex.a}\` },
      ],
    }),
  });
  return JSON.parse((await res.json()).choices[0].message.content);
};
return { dev_size: ctx.state.DEV.length, test_size: ctx.state.TEST.length };
`,
    },

    // ───────── 1. binary judge
    {
      id: "md-1",
      kind: "markdown",
      source: `## Step 2 · A single-purpose binary judge

One failure mode, one judge, **binary** verdict. No rating scales — rating scales hide disagreement and make calibration impossible.

> **Rule:** if you can't write a one-sentence definition of what PASS means, your judge will be noisy.`,
    },
    {
      id: "judge",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { runJudge, DEV } = ctx.state;

const JUDGE_PROMPT = \`You are a factual-grounding evaluator.

PASS if the ANSWER is factually correct.
FAIL if the ANSWER contains any factual error, wrong date, wrong name, or invented detail.

Reply ONLY JSON: { "verdict": "PASS" | "FAIL", "why": "<=15 words" }\`;

const dev_verdicts = [];
for (const ex of DEV) {
  const v = await runJudge(JUDGE_PROMPT, ex);
  dev_verdicts.push({ q: ex.q, a: ex.a, human: ex.human, judge: v.verdict, why: v.why,
                      agree: v.verdict === ex.human });
}
ctx.state.JUDGE_PROMPT = JUDGE_PROMPT;
ctx.state.dev_verdicts = dev_verdicts;
return dev_verdicts;
`,
    },

    // ───────── 2. TPR / TNR
    {
      id: "md-2",
      kind: "markdown",
      source: `## Step 3 · TPR & TNR — quantifying judge accuracy

Treat the judge as a classifier estimating *"is this answer factually correct?"* against the human ground truth.

- **TPR (True Positive Rate)** — of human-labeled PASS examples, how many did the judge correctly call PASS?
- **TNR (True Negative Rate)** — of human-labeled FAIL examples, how many did the judge correctly call FAIL?

A useful judge needs **both** high. A judge with TPR=100%, TNR=20% just always says PASS — it isn't measuring anything.`,
    },
    {
      id: "tpr-tnr",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { runJudge, JUDGE_PROMPT, TEST } = ctx.state;

const verdicts = [];
for (const ex of TEST) {
  const v = await runJudge(JUDGE_PROMPT, ex);
  verdicts.push({ ...ex, judge: v.verdict });
}

const positives = verdicts.filter((v) => v.human === "PASS");
const negatives = verdicts.filter((v) => v.human === "FAIL");
const tp = positives.filter((v) => v.judge === "PASS").length;
const tn = negatives.filter((v) => v.judge === "FAIL").length;

const TPR = +(tp / positives.length).toFixed(2);
const TNR = +(tn / negatives.length).toFixed(2);
const acc = +((tp + tn) / verdicts.length).toFixed(2);

ctx.state.tprTnr = { TPR, TNR, accuracy: acc };
return { verdicts, TPR, TNR, accuracy: acc };
`,
    },
    {
      id: "md-2x",
      kind: "markdown",
      source: `**Production rule of thumb:** ship a judge only when TPR ≥ 0.85 and TNR ≥ 0.85 on a held-out test set of ≥100 examples. The dataset here is too small to draw real conclusions — it's a demonstration of the workflow.`,
    },

    // ───────── 3. repeatability
    {
      id: "md-3",
      kind: "markdown",
      source: `## Step 4 · Repeatability — does the judge flip?

Even at \`temperature: 0\`, real APIs sometimes return slightly different completions. We run the *same* borderline example 5 times. If verdicts flip, the judge is unstable on this example and the rubric needs sharpening.`,
    },
    {
      id: "repeat",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { runJudge, JUDGE_PROMPT } = ctx.state;

const tricky = { q: "Boiling point of water at sea level?", a: "Roughly 100 degrees, give or take.", human: "PASS" };
const RUNS = 5;
const verdicts = [];
for (let i = 0; i < RUNS; i++) {
  const v = await runJudge(JUDGE_PROMPT, tricky);
  verdicts.push(v.verdict);
}
const unique = [...new Set(verdicts)];
return { runs: verdicts, stable: unique.length === 1, unique };
`,
    },

    // ───────── 4. length bias
    {
      id: "md-4",
      kind: "markdown",
      source: `## Step 5 · Length-bias check

Classic judge failure: it grades the *length* of an answer, not its *correctness*. We feed two answers — one short and correct, one long and verbose-but-correct — and check whether the judge rates them equally.

If a longer-but-equivalent answer scores higher, you have length bias. Counter by either (a) constraining answer length before judging, or (b) adding a rule to the rubric: *"length alone does not affect the score."*`,
    },
    {
      id: "bias",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { runJudge } = ctx.state;

const PROMPT = \`Score this answer on a 1–5 scale for correctness ONLY.
Length, prose style, and formatting should NOT affect the score.
Reply JSON: { "score": n }\`;

const short = { q: "Boiling point of water at sea level?", a: "100°C." };
const long  = { q: "Boiling point of water at sea level?",
                a: "At standard atmospheric pressure (1 atm, sea level), pure water boils at exactly 100 degrees Celsius, equivalent to 212 degrees Fahrenheit or 373.15 Kelvin. This is one of the defining points of the Celsius scale." };

const s1 = await runJudge(PROMPT, short);
const s2 = await runJudge(PROMPT, long);
return { short_score: s1.score, long_score: s2.score, bias_detected: s2.score > s1.score };
`,
    },

    // ───────── scorecard
    {
      id: "md-sc",
      kind: "markdown",
      source: `## Final · Judge scorecard

Roll everything into one verdict. This is what you ship in a PR when you propose a new judge.`,
    },
    {
      id: "scorecard",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { tprTnr } = ctx.state;
const ship = tprTnr.TPR >= 0.85 && tprTnr.TNR >= 0.85;

return {
  judge_name: "factual-grounding-v1",
  test_set_size: 4,    // toy — real benchmarks: 100+
  TPR: tprTnr.TPR,
  TNR: tprTnr.TNR,
  accuracy: tprTnr.accuracy,
  recommendation: ship
    ? "✅ Ship — meets TPR ≥ 0.85 and TNR ≥ 0.85"
    : "⛔ Iterate — sharpen rubric or add few-shot examples",
};
`,
    },
    {
      id: "md-end",
      kind: "markdown",
      source: `### Two production lessons

1. **Treat the judge as code.** Version it, test it, gate changes on benchmark numbers.
2. **The benchmark is the moat.** Building 100 well-labeled examples per failure mode is the unglamorous work that separates teams who *think* their agent is good from teams who *know*.

### Up next
Notebook 5: the **RAG Evaluation Triad** — Context Relevance, Faithfulness, Answer Relevance.`,
    },
  ],
};
