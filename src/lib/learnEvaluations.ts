// Curriculum module: Evaluations for agentic systems.
//
// Teaches the four canonical eval patterns (LLM-as-a-judge, pairwise
// comparison, reference-free RAG metrics, rubric scoring), why they
// matter in production, and how to run a real one in AgentSwarms via
// the bundled "RAG Evaluation Harness" swarm template.

export const evalsIntro = {
  child:
    "Imagine two robots both try to answer the same question. How do you know which robot is better — or whether either one is even right? You ask a third, smarter robot to read both answers with a checklist (Did they use facts from the book? Did they actually answer the question? Were they clear?) and grade them. That checklist is called an evaluation, or 'eval' for short.",
  engineer:
    "Evals are how you turn vibes into numbers. An eval is a repeatable, scored test of an agent's output against a written rubric — usually executed by a stronger LLM acting as judge. Industry-standard frameworks (OpenAI Evals, RAGAS, DeepEval, Promptfoo, LangSmith) all converge on the same primitives: define a rubric, run candidate(s), have a judge score each axis, aggregate, gate on thresholds. Without evals you cannot detect regressions when you swap a model, prove a prompt change is an improvement, or give stakeholders a number instead of an opinion.",
  whyItMatters: [
    "Detect regressions when you swap models — Gemini Pro → Flash, GPT-5 → GPT-5-mini, Claude Sonnet → Haiku.",
    "Compare two prompts or two RAG retrievers objectively, not by eyeballing 5 examples.",
    "Catch hallucinations and ungrounded answers before they reach a customer.",
    "Give stakeholders a single number ('87% faithful, 92% answer-relevancy') so launches stop being political.",
    "Wire evals into CI so a PR that drops faithfulness below 0.8 fails the build, the same way unit tests do.",
  ],
};

export type EvalPattern = {
  id: string;
  name: string;
  oneLiner: string;
  whenToUse: string;
  realWorld: { org: string; label: string; url: string };
};

export const evalPatterns: EvalPattern[] = [
  {
    id: "llm-judge",
    name: "LLM-as-a-Judge",
    oneLiner:
      "A stronger model grades a weaker model's output against a written rubric and returns a structured score (usually JSON).",
    whenToUse:
      "You have a candidate answer and a rubric (faithfulness, helpfulness, tone, format). Use this for offline regression suites and CI gates.",
    realWorld: {
      org: "OpenAI Evals",
      label:
        "OpenAI's open-source Evals framework popularized 'model-graded evals' — the entire library is built around LLM judges following written rubrics.",
      url: "https://github.com/openai/evals",
    },
  },
  {
    id: "pairwise",
    name: "Pairwise / Bake-off",
    oneLiner:
      "Run the same input through two candidates (e.g. Pro vs Flash, Prompt v1 vs v2), have a judge pick a winner with a justification.",
    whenToUse:
      "Choosing between two models, prompts, or retrievers. Pairwise judgements correlate with human preference ≈ 80% (Zheng et al., NeurIPS 2023).",
    realWorld: {
      org: "LMSYS Chatbot Arena",
      label:
        "Chatbot Arena's millions-strong leaderboard is built on pairwise human + LLM judgements — same primitive, scaled to a global benchmark.",
      url: "https://lmarena.ai/",
    },
  },
  {
    id: "reference-free-rag",
    name: "Reference-free RAG metrics",
    oneLiner:
      "Score a RAG answer without ground truth: faithfulness (uses only retrieved context?), answer-relevancy (actually answers the question?), context-precision (top results actually relevant?).",
    whenToUse:
      "You don't have hand-labeled golden answers (you almost never do). RAGAS-style metrics give you a number from just (question, answer, retrieved-docs).",
    realWorld: {
      org: "RAGAS (Es et al., EACL 2024)",
      label:
        "Open-source library and paper that defined reference-free metrics for RAG. Faithfulness and answer-relevancy from RAGAS are now industry standard.",
      url: "https://arxiv.org/abs/2309.15217",
    },
  },
  {
    id: "rubric-scoring",
    name: "Rubric scoring with structured output",
    oneLiner:
      "Force the judge to return strict JSON ({faithfulness: 0.8, relevancy: 0.9, winner: 'A', reason: '...'}) so scores can be aggregated, charted, and gated on.",
    whenToUse:
      "Always. Free-text 'this seems good' is useless at scale — you cannot average it, alert on it, or block a deploy with it.",
    realWorld: {
      org: "Anthropic Constitutional AI",
      label:
        "CAI showed that a model self-critiquing against an explicit written rubric (the 'constitution') reliably improves output quality. Same idea, applied to evaluation instead of generation.",
      url: "https://arxiv.org/abs/2212.08073",
    },
  },
];

export type EvalMetric = {
  name: string;
  formula: string;
  what: string;
  passingBar: string;
};

export const evalMetrics: EvalMetric[] = [
  {
    name: "Faithfulness",
    formula:
      "(# claims in answer that are supported by retrieved context) / (# total claims in answer)",
    what:
      "How much of the answer is actually grounded in what was retrieved, vs. hallucinated. The single most important RAG metric.",
    passingBar:
      "≥ 0.85 for production-grade RAG. Below 0.7 means the model is making things up.",
  },
  {
    name: "Answer Relevancy",
    formula:
      "Reverse-engineer the question from the answer; cosine-similarity to the original question (RAGAS). Or LLM-judged 0–1.",
    what:
      "Does the answer actually address what was asked, or is it tangential? Catches the 'beautiful but off-topic' failure mode.",
    passingBar: "≥ 0.8. Below 0.6 the agent is wandering.",
  },
  {
    name: "Context Precision",
    formula:
      "(# relevant docs in top-k retrieved) / k, optionally weighted by rank position.",
    what:
      "Measures the retriever, not the generator. If precision is low, fix your chunks or your embeddings — not your prompt.",
    passingBar: "≥ 0.7 at k=5 is healthy. Lower means your retriever needs work.",
  },
  {
    name: "Completeness",
    formula:
      "LLM-judged 0–1: does the answer cover all parts of a multi-part question?",
    what:
      "Catches the 'partial answer' failure mode — common when models truncate to stay concise.",
    passingBar: "≥ 0.8 for support / research; ≥ 0.95 for compliance / legal.",
  },
];

export const evalWhenToRun = [
  {
    title: "Offline regression suite",
    body:
      "Run nightly (or on every PR) against a frozen set of 50–500 representative questions. Block merges if average faithfulness drops > 5% vs. main.",
  },
  {
    title: "Pre-deploy bake-off",
    body:
      "Before swapping a model in production, run a pairwise eval (old vs new) over your suite. Ship only if the new model wins ≥ 55% with non-trivial margin.",
  },
  {
    title: "Online sampling",
    body:
      "In production, sample ~1% of real traffic and run a judge async. Alert if faithfulness rolling-average drops below threshold — your canary for a silent regression.",
  },
  {
    title: "Adversarial / red-team",
    body:
      "A separate suite of jailbreaks, prompt-injection attempts, PII fishing, and out-of-scope questions. Faithfulness here should be 'refuses correctly', not 'answers helpfully'.",
  },
];

export const evalPitfalls = [
  {
    title: "Judging with the same model you're testing",
    body:
      "If candidate and judge are both GPT-5, the judge has a known self-preference bias (~10% boost). Always judge with a different family, or with a stronger model.",
  },
  {
    title: "Free-text scores",
    body:
      "'Looks good' is unaggregatable. Force JSON: {faithfulness: 0.0–1.0, reason: '...'} via tool-calling or strict prompting.",
  },
  {
    title: "Tiny eval sets",
    body:
      "10 questions is anecdote, not data. You need ≥ 50 to detect a 10% delta with any confidence. ≥ 200 for a 5% delta.",
  },
  {
    title: "Eval drift",
    body:
      "Refresh the suite quarterly. Models that ace last year's eval often do so because the questions leaked into training data.",
  },
  {
    title: "Optimizing for the judge, not the user",
    body:
      "If you only iterate on what the judge scores high, you'll Goodhart your way into answers that please GPT-5 and bore humans. Keep a small human-rated holdout set.",
  },
];

export const evalsInAgentSwarms = {
  template: {
    id: "eval-judge-rag",
    title: "RAG Evaluation Harness — LLM as a Judge",
    summary:
      "A 6-node swarm that asks two RAG candidates (Gemini Flash and Gemini Pro) the same question against the AgentSwarms How-To knowledge base, then has GPT-5 score both on faithfulness, answer-relevancy, and completeness — returning a structured JSON verdict that a tiny formatter renders as a markdown scorecard.",
    youWillSee: [
      "Two candidate answers stream side-by-side from the same KB.",
      "A strict-JSON judge verdict with per-axis 0–1 scores and a one-line justification.",
      "A human-readable scorecard with the winner, the per-metric scores, and which candidate to ship.",
    ],
    tryThisNext: [
      "Open the judge node and swap GPT-5 for Gemini Pro — watch how the verdict shifts (judge choice IS an eval lesson).",
      "Edit the rubric in the judge's system prompt to add a 'tone' axis. Re-run.",
      "Change the input question to one that's NOT in the KB. The faithful candidate should refuse; the score should reflect that.",
    ],
  },
  furtherReading: [
    {
      label: "OpenAI Evals (GitHub)",
      href: "https://github.com/openai/evals",
      note: "The canonical model-graded eval framework — read the rubric examples in evals/registry/.",
    },
    {
      label: "RAGAS — Es et al., EACL 2024",
      href: "https://arxiv.org/abs/2309.15217",
      note: "Reference-free metrics for RAG. The faithfulness formula our template uses comes straight from this paper.",
    },
    {
      label: "MT-Bench / Chatbot Arena — Zheng et al., NeurIPS 2023",
      href: "https://arxiv.org/abs/2306.05685",
      note: "Established that LLM judges agree with human preference ~80% of the time — the empirical foundation for LLM-as-a-judge.",
    },
    {
      label: "Anthropic — Constitutional AI",
      href: "https://arxiv.org/abs/2212.08073",
      note: "Self-critique against a written rubric. Same primitive that powers structured-rubric judges today.",
    },
    {
      label: "Promptfoo (open-source eval CLI)",
      href: "https://www.promptfoo.dev/",
      note: "Practical CLI for running prompt/model bake-offs locally and in CI. Great for regression suites.",
    },
  ],
};
