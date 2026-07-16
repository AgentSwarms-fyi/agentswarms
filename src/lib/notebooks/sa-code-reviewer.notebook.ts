import type { Notebook } from "./types";

export const saCodeReviewerNotebook: Notebook = {
  id: "sa-code-reviewer",
  title: "Code Reviewer (Prompt Chaining)",
  description:
    "Two-step chain: step one finds bugs, step two rewrites the code with comments explaining the fix. Paste your own buggy code and adjust the tone.",
  difficulty: "intermediate",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 14 · Code Reviewer — Prompt Chaining

A two-step LCEL chain:

1. **Analyse** — find bugs as structured findings
2. **Rewrite** — produce fixed code with inline comments referencing each finding

The findings from step 1 are passed as context into step 2. This is the
canonical "decompose into smaller LLM calls" pattern.

**Experiments:**
- Paste your own buggy TypeScript.
- Change \`TONE\` to "brutally honest senior staff engineer" vs "encouraging junior mentor".`,
    },

    {
      id: "review-chain", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;
const { z } = ctx.lc;

// 👇 Tweak the persona.
const TONE = "thorough but kind staff engineer";

// 👇 Paste any buggy code.
const CODE = \`function average(nums) {
  let total = 0;
  for (let i = 0; i <= nums.length; i++) {
    total += nums[i];
  }
  return total / nums.length;
}

async function loadUser(id) {
  const res = fetch("/api/users/" + id);
  return res.json();
}\`;

// Step 1: structured analysis
const analyseSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "bug", "critical"]),
    line_hint: z.string(),
    description: z.string(),
    suggestion: z.string(),
  })),
});

const analyser = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(analyseSchema, { name: "analyse_code" });

const findings = await analyser.invoke([
  ["system", "You are a " + TONE + ". Find correctness, async, and edge-case bugs."],
  ["human", "Review this code:\\n\\n" + CODE],
]);
ctx.log("findings:", findings.findings.length);

// Step 2: rewrite using findings
const rewritePrompt = ChatPromptTemplate.fromMessages([
  ["system", "You rewrite code applying the provided findings. Add a // FIX: comment above each change explaining the original bug."],
  ["human", "Findings (JSON):\\n{findings}\\n\\nOriginal code:\\n{code}\\n\\nReturn ONLY the fixed code."],
]);

const writer = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.2,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const chain = rewritePrompt.pipe(writer).pipe(new StringOutputParser());
const fixed = await chain.invoke({ findings: JSON.stringify(findings.findings, null, 2), code: CODE });

return { findings: findings.findings, fixed_code: fixed };
`,
    },
    { id: "md-x", kind: "markdown", source: `**Why chain instead of one prompt?** Step 1's structured output forces the model to *enumerate* problems before fixing them. Without that, single-prompt rewrites often silently skip bugs because the model "looks good enough" at first glance.` },
  ],
};
