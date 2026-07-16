import type { Notebook } from "./types";

export const masPlanExecuteNotebook: Notebook = {
  id: "mas-plan-execute",
  title: "Plan & Execute Crew (ReAct Loop)",
  description:
    "A classic two-agent setup. The Planner breaks a request into a numbered to-do list, the Executor walks the list one step at a time using a calculator tool — all wired through a LangGraph StateGraph.",
  difficulty: "intermediate",
  tags: ["langgraph", "multi-agent", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Plan & Execute Crew

Two agents, one graph:

\`\`\`
            ┌─────────┐      ┌──────────┐
START ───▶  │ Planner │ ───▶ │ Executor │ ──▶ END
            └─────────┘      └────▲─────┘
                                   │ (loops over each step)
\`\`\`

- **Planner** sees the user request once and produces a numbered list of steps.
- **Executor** pops one step at a time, calls a tool if it needs to, then loops back to itself until the list is empty.

**Try this:**
1. Run cells in order.
2. In the last cell, tweak \`REQUEST\` from something simple ("multiply 6 by 7") to something messier ("find the area of a rectangle 13 by 17, then subtract 40 and divide by 3").
3. Watch the trace log — the Planner's list gets longer and the Executor takes more turns.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · The shared state\n\nLangGraph state is a typed object. Each node returns a partial state that gets merged in. We need: the original request, the plan (a list of strings), the completed steps, and a final answer.` },
    {
      id: "state", kind: "code", language: "js", runtime: "browser",
      source: `const { Annotation } = ctx.lc.langgraph;

// Define the state schema. Each field has a reducer that says how to merge updates.
const PlanState = Annotation.Root({
  request: Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  plan:    Annotation({ reducer: (_a, b) => b ?? _a, default: () => [] }),
  done:    Annotation({ reducer: (a, b) => [...(a ?? []), ...(b ?? [])], default: () => [] }),
  answer:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
});

ctx.state.PlanState = PlanState;
return { fields: Object.keys(PlanState.spec) };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · A tiny calculator tool\n\nThe Executor needs something real to do, otherwise the loop is theatre. We give it a single \`calc\` tool that evaluates a basic arithmetic expression.` },
    {
      id: "tool", kind: "code", language: "js", runtime: "browser",
      source: `const { tool } = ctx.lc.tools;
const { z } = ctx.lc;

const calc = tool(
  async ({ expression }) => {
    // Allow digits, whitespace, parentheses, decimal points, and + - * /
    if (!/^[-+*/().\\d\\s]+$/.test(expression)) {
      return JSON.stringify({ error: "Only basic arithmetic allowed." });
    }
    try {
      // eslint-disable-next-line no-new-func
      const value = Function('"use strict";return (' + expression + ")")();
      return JSON.stringify({ expression, value });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  },
  {
    name: "calc",
    description: "Evaluate a basic arithmetic expression like '13 * 17' or '(120 - 40) / 3'.",
    schema: z.object({ expression: z.string() }),
  },
);

ctx.state.tools = [calc];
return { registered: calc.name };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · The Planner node\n\nThe Planner is a single LLM call that returns a JSON array of short imperative steps. We force structured output by asking for JSON and parsing it defensively — if parsing fails, we fall back to splitting on newlines.` },
    {
      id: "planner", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const PLANNER_PROMPT = \`You are a Planner. Break the user's request into 2-5 short imperative steps.
Return ONLY a JSON array of strings, no prose. Example: ["Compute 12 * 5", "Subtract 7 from the result"].\`;

async function plannerNode(state) {
  const res = await llm.invoke([
    new SystemMessage(PLANNER_PROMPT),
    new HumanMessage(state.request),
  ]);
  let plan = [];
  const text = String(res.content).trim();
  try {
    const m = text.match(/\\[[\\s\\S]*\\]/);
    plan = JSON.parse(m ? m[0] : text);
  } catch {
    plan = text.split("\\n").map((s) => s.replace(/^[\\d.\\-\\s)]+/, "").trim()).filter(Boolean);
  }
  ctx.log("🧭 plan:", plan);
  return { plan };
}

ctx.state.plannerNode = plannerNode;
return { ok: true };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · The Executor node\n\nEach time the Executor runs it takes the **next pending step** (\`plan[done.length]\`), feeds it to an LLM with the calc tool bound, and runs any \`tool_calls\` once. The result gets pushed onto \`done\`.` },
    {
      id: "executor", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage, ToolMessage } = ctx.lc.messages;

const llmWithTools = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(ctx.state.tools);

const toolsByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));

async function executorNode(state) {
  const i = state.done.length;
  const step = state.plan[i];
  const history = state.done.map((d, k) => "Step " + (k + 1) + ": " + d.step + " → " + d.result).join("\\n");

  const msgs = [
    new SystemMessage("You execute one step at a time. Use the calc tool for arithmetic. Reply with a one-sentence result."),
    new HumanMessage("Original request: " + state.request + "\\nDone so far:\\n" + history + "\\n\\nNow do step " + (i + 1) + ": " + step),
  ];
  const ai = await llmWithTools.invoke(msgs);
  msgs.push(ai);
  for (const c of ai.tool_calls ?? []) {
    const out = await toolsByName[c.name].invoke(c.args);
    msgs.push(new ToolMessage({ content: String(out), tool_call_id: c.id }));
    ctx.log("🛠️  " + c.name + "(" + JSON.stringify(c.args) + ") → " + out);
  }
  const final = (ai.tool_calls ?? []).length ? await llmWithTools.invoke(msgs) : ai;
  ctx.log("✅ step " + (i + 1) + ":", String(final.content).slice(0, 200));

  const answer = i + 1 === state.plan.length ? String(final.content) : state.answer;
  return { done: [{ step, result: String(final.content) }], answer };
}

ctx.state.executorNode = executorNode;
return { ok: true };
`,
    },

    { id: "md-5", kind: "markdown", source: `## 5 · Wire the graph and run it\n\nThe conditional edge \`shouldContinue\` is the heart of the loop: after every Executor turn we ask "are there more steps?". If yes, loop back; if no, END.` },
    {
      id: "graph", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, START, END } = ctx.lc.langgraph;

const shouldContinue = (s) => (s.done.length < s.plan.length ? "executor" : END);

const graph = new StateGraph(ctx.state.PlanState)
  .addNode("planner",  ctx.state.plannerNode)
  .addNode("executor", ctx.state.executorNode)
  .addEdge(START, "planner")
  .addEdge("planner", "executor")
  .addConditionalEdges("executor", shouldContinue, { executor: "executor", [END]: END })
  .compile();

// 👇 Try changing this request — simple vs messy
const REQUEST = "Find the area of a rectangle 13 by 17, then subtract 40, then divide by 3.";

const result = await graph.invoke({ request: REQUEST });
return {
  request: REQUEST,
  plan: result.plan,
  steps: result.done,
  answer: result.answer,
};
`,
    },

    { id: "md-6", kind: "markdown", source: `**Things to try:**\n\n- Set \`REQUEST\` to something the Planner can solve in one step ("what is 6 × 7?"). The graph still runs — the Executor just loops once.\n- Make it messier: *"What is 5! (factorial)? Then add 23, then halve it."* — the Planner has to decompose factorial into multiplications.\n- Edit \`PLANNER_PROMPT\` to say "produce AT LEAST 6 steps". Watch the Executor patiently grind through them.` },
  ],
};
