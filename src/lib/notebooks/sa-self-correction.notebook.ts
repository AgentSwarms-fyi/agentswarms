import type { Notebook } from "./types";

export const saSelfCorrectionNotebook: Notebook = {
  id: "sa-self-correction",
  title: "Self-Correction Loop (Basic Reflection)",
  description:
    "Generator → Critic → Rewriter loop. Make the rubric strict and watch the agent iterate until it passes its own grade.",
  difficulty: "intermediate",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 16 · Self-Correction Loop

A.k.a. **Reflection**: the same model generates an answer, then critiques
its own output against a rubric, then rewrites. Loop until pass or
\`maxIters\`.

**Experiments:**
- Make \`RUBRIC\` cruelly strict ("must include at least 3 cited statistics with year").
- Lower \`maxIters\` to 1 and see how often the first draft passes.`,
    },

    {
      id: "reflect", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

// 👇 Edit the task and the grading rubric.
const TASK = "Write a 3-sentence pitch for a new AI-powered note-taking app aimed at researchers.";
const RUBRIC = \`The pitch must:
1. Be exactly 3 sentences (no more, no fewer).
2. Mention a concrete pain point for researchers.
3. Name one specific feature (not generic words like 'powerful' or 'smart').
4. Avoid the words 'revolutionary', 'leverage', and 'seamless'.\`;
const MAX_ITERS = 4;

const writer = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.7,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const critic = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(
  z.object({
    passes: z.boolean(),
    score: z.number().min(0).max(10),
    failures: z.array(z.string()).describe("Specific rubric items that failed, with reasons."),
  }),
  { name: "grade" },
);

// First draft
let draft = (await writer.invoke([["human", TASK]])).content;
ctx.log("draft 1:", draft);

for (let i = 1; i <= MAX_ITERS; i++) {
  const grade = await critic.invoke([
    ["system", "You are a strict editor. Grade the draft against the rubric. passes=true only if EVERY rubric item is satisfied."],
    ["human", "Task: " + TASK + "\\n\\nRubric:\\n" + RUBRIC + "\\n\\nDraft:\\n" + draft],
  ]);
  ctx.log("iter " + i + " score:", grade.score, "passes:", grade.passes, "failures:", grade.failures);

  if (grade.passes) return { final: draft, iterations: i, score: grade.score };

  // Rewrite using the critic's feedback
  draft = (await writer.invoke([
    ["system", "Rewrite the draft to fix every failure listed. Keep what already works."],
    ["human", "Task: " + TASK + "\\n\\nRubric:\\n" + RUBRIC + "\\n\\nPrevious draft:\\n" + draft + "\\n\\nFailures to fix:\\n" + grade.failures.map((f) => "- " + f).join("\\n")],
  ])).content;
  ctx.log("draft " + (i + 1) + ":", draft);
}

return { final: draft, iterations: MAX_ITERS, score: "max iterations reached without passing" };
`,
    },
    { id: "md-x", kind: "markdown", source: `Reflection trades latency for quality. It's most useful for tasks with **objective rubrics** (does the code compile? does the JSON match the schema?). For pure-taste tasks the critic can loop forever chasing its own preferences — always cap \`maxIters\`.` },
  ],
};
