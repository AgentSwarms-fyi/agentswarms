import type { Notebook } from "./types";

export const masCoderReviewerNotebook: Notebook = {
  id: "mas-coder-reviewer",
  title: "Coder, Reviewer & Tester Loop (Cyclic Graph)",
  description:
    "Three agents in a true cycle. The Coder writes code, the Reviewer critiques, the Tester runs it in a sandbox. The graph loops back to the Coder on failure and only exits when the Reviewer approves — or when the iteration cap saves you from burning tokens forever.",
  difficulty: "advanced",
  tags: ["langgraph", "multi-agent", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Coder / Reviewer / Tester Loop

\`\`\`
              ┌────────┐    ┌──────────┐    ┌────────┐
START ─▶ │ Coder  │ ─▶ │ Reviewer │ ─▶ │ Tester │
              └────▲───┘    └──────────┘    └───┬────┘
                   │           pass?              │
                   └────────── fail ──────────────┘
                              │ pass
                              ▼
                             END
\`\`\`

A cyclic LangGraph. The Reviewer's verdict drives a conditional edge that either continues to the Tester (which actually runs the code) or loops back to the Coder with the critique.

**Safety nets** every cyclic agent graph needs:
1. An **iteration cap** (\`MAX_ITERS\`) — prevents runaway token spend.
2. The **history** is fed back so the Coder doesn't repeat the same wrong code.
3. The Tester runs in an isolated \`Function\` scope, not in the same closure as your notebook.

Give the Coder an *impossibly hard* task in the last cell and watch how many times it loops before \`MAX_ITERS\` cuts it off.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · State — the loop's memory\n\nThe key fields are \`iter\` (so we can cap it) and \`history\` (so each agent sees what's come before). \`verdict\` is the routing key.` },
    {
      id: "state", kind: "code", language: "js", runtime: "browser",
      source: `const { Annotation } = ctx.lc.langgraph;

const CodeState = Annotation.Root({
  task:     Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  code:     Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  verdict:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),   // "pass" | "fail"
  critique: Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  testLog:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  iter:     Annotation({ reducer: (_a, b) => b ?? _a, default: () => 0 }),
  history:  Annotation({ reducer: (a, b) => [...(a ?? []), ...(b ?? [])], default: () => [] }),
});

ctx.state.CodeState = CodeState;
return { fields: Object.keys(CodeState.spec) };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · The three agent nodes\n\nThe Coder takes the task plus any critique from the previous round. The Reviewer reads the code and the critique history and returns a strict \`pass\`/\`fail\`. The Tester is non-LLM — it actually executes the code against a hidden test case.` },
    {
      id: "nodes", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.2,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

function stripFences(s) {
  return String(s).replace(/^[\\s\\S]*?\`\`\`(?:js|javascript)?\\n?/, "").replace(/\`\`\`[\\s\\S]*$/, "").trim();
}

async function coderNode(state) {
  const lastCritique = state.critique || "(no prior feedback)";
  const res = await llm.invoke([
    new SystemMessage("You are a JavaScript coder. Return ONE function declaration named 'solve'. No prose, no surrounding text, no markdown fences. The function signature must match the task."),
    new HumanMessage("Task: " + state.task + "\\n\\nPrior critique to address:\\n" + lastCritique + "\\n\\nWrite or rewrite the function now."),
  ]);
  const code = stripFences(res.content);
  ctx.log("✍️  coder wrote " + code.length + " chars");
  return { code, iter: state.iter + 1, history: [{ role: "coder", code }] };
}

const Review = z.object({
  verdict: z.enum(["pass", "fail"]),
  critique: z.string().describe("Concrete actionable feedback. If pass, say what's good."),
});

async function reviewerNode(state) {
  const out = await llm.withStructuredOutput(Review).invoke([
    new SystemMessage("You are a strict senior code reviewer. Reject the code if it's missing edge cases, has obvious bugs, or doesn't match the task. Otherwise approve."),
    new HumanMessage("Task: " + state.task + "\\n\\nCode under review:\\n" + state.code + "\\n\\nTest log from last run (if any):\\n" + state.testLog),
  ]);
  ctx.log("🔍 reviewer: " + out.verdict.toUpperCase() + " — " + out.critique.slice(0, 120));
  return { verdict: out.verdict, critique: out.critique, history: [{ role: "reviewer", ...out }] };
}

// Non-LLM tester. Runs the code in an isolated Function scope.
async function testerNode(state) {
  try {
    const factory = new Function(state.code + "\\nreturn solve;");
    const solve = factory();
    // Generic smoke tests — just prove it runs without throwing.
    const sample = solve(3, 4) ?? solve(3) ?? solve("hello") ?? solve([1, 2, 3]) ?? solve();
    const log = "✓ solve(...) returned: " + JSON.stringify(sample);
    ctx.log("🧪 " + log);
    return { testLog: log };
  } catch (e) {
    const log = "✗ runtime error: " + (e instanceof Error ? e.message : String(e));
    ctx.log("🧪 " + log);
    // A runtime error force-fails the next reviewer round
    return { testLog: log, verdict: "fail", critique: "Code threw at runtime: " + log };
  }
}

ctx.state.coderNode = coderNode;
ctx.state.reviewerNode = reviewerNode;
ctx.state.testerNode = testerNode;
return { ok: true };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · Compile the cyclic graph\n\nThe edge \`Reviewer → ?\` is where the cycle lives. \`pass\` continues to Tester, \`fail\` loops to Coder, and \`MAX_ITERS\` is a guard that forces an exit if we never reach \`pass\`.` },
    {
      id: "graph", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, START, END } = ctx.lc.langgraph;

const MAX_ITERS = 4;

const route = (s) => {
  if (s.iter >= MAX_ITERS) return "tester";          // give up reviewing, just run it
  if (s.verdict === "pass") return "tester";
  return "coder";
};

const graph = new StateGraph(ctx.state.CodeState)
  .addNode("coder",    ctx.state.coderNode)
  .addNode("reviewer", ctx.state.reviewerNode)
  .addNode("tester",   ctx.state.testerNode)
  .addEdge(START, "coder")
  .addEdge("coder", "reviewer")
  .addConditionalEdges("reviewer", route, { coder: "coder", tester: "tester" })
  .addEdge("tester", END)
  .compile();

ctx.state.codeGraph = graph;
ctx.state.MAX_ITERS = MAX_ITERS;
return { compiled: true, cap: MAX_ITERS };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · Run it on an easy task\n\nThis one should pass on the first or second iteration. Use it as a baseline before you throw something harder at the loop.` },
    {
      id: "easy", kind: "code", language: "js", runtime: "browser",
      source: `const TASK = "Write a function 'solve(a, b)' that returns the greatest common divisor of two positive integers using Euclid's algorithm.";

const result = await ctx.state.codeGraph.invoke({ task: TASK });
return {
  iterations: result.iter,
  verdict: result.verdict,
  test_log: result.testLog,
  final_code: result.code,
};
`,
    },

    { id: "md-5", kind: "markdown", source: `## 5 · Now break it\n\nGive the Coder a task that's hostile to the test harness or ambiguous on purpose. Watch \`iter\` climb toward \`MAX_ITERS\`. In a real production loop you'd stream the trace to a UI with a "Stop graph" button — \`MAX_ITERS\` is your safety net when nobody's watching.` },
    {
      id: "hard", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 Try replacing this with something genuinely impossible, e.g.
//   "Write 'solve()' that returns next week's lottery numbers."
//   "Write 'solve(n)' that returns a provably-shorter compressed form of any input."
const TASK = "Write a function 'solve(graph)' that returns the optimal solution to the Travelling Salesman Problem in polynomial time. The Reviewer should reject anything that uses brute force or heuristics.";

const result = await ctx.state.codeGraph.invoke({ task: TASK });
return {
  iterations: result.iter,
  hit_cap: result.iter >= ctx.state.MAX_ITERS,
  last_verdict: result.verdict,
  last_critique: result.critique,
  test_log: result.testLog,
};
`,
    },

    { id: "md-6", kind: "markdown", source: `**Things to try:**\n\n- Raise \`MAX_ITERS\` to 8 in cell 3 and rerun the impossible task. The cost per run goes up linearly — this is exactly how production agent loops blow through budgets.\n- Loosen the Reviewer's prompt to "be encouraging" and watch it approve garbage code on iteration 1. Strict reviewers are the whole reason this pattern works.\n- Replace the Tester's smoke tests with real assertions for a specific task (e.g. \`solve(48, 18) === 6\` for GCD). The graph becomes a tiny TDD loop.` },
  ],
};
