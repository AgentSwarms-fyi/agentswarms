import type { Notebook } from "./types";

export const lcToolsAgentsNotebook: Notebook = {
  id: "lc-tools-agents",
  title: "Tools, Agents & Multi-Tool Orchestration",
  description:
    "Define tools with Zod (the Pydantic of TS), build a real agent loop, orchestrate multiple tools, handle parallel tool calls, and prevent infinite loops.",
  difficulty: "intermediate",
  tags: ["langchain", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 3 · Tools & Agents

By the end of this notebook you'll have:

1. Defined tools with **Zod** (TypeScript's Pydantic)
2. Run a real \`bindTools\` agent loop
3. Watched the model call **multiple tools in one turn**
4. Orchestrated several tools in a single agent
5. Added a **max-steps guard** to prevent infinite loops

All real \`@langchain/openai\` + \`@langchain/core\` classes.`,
    },

    // 1 — Define tools with Zod
    { id: "md-1", kind: "markdown", source: `## 1 · Define tools with type-safe Zod schemas\n\nPython LangChain uses Pydantic \`BaseModel\`. JS uses **Zod** — same idea, full TypeScript inference. Each \`z.\` field gets a \`.describe()\` so the model knows what to put in it.` },
    {
      id: "define-tools", kind: "code", language: "js", runtime: "browser",
      source: `const { tool } = ctx.lc.tools;
const { z } = ctx.lc;

const addNumbers = tool(
  async ({ a, b }) => String(a + b),
  {
    name: "add_numbers",
    description: "Add two numbers and return the sum.",
    schema: z.object({
      a: z.number().describe("first addend"),
      b: z.number().describe("second addend"),
    }),
  },
);

const getWeather = tool(
  async ({ city }) => {
    // Real API would go here. We return a deterministic stub so the demo runs offline-friendly.
    const t = { paris: 14, tokyo: 22, "new york": 9 }[city.toLowerCase()] ?? 18;
    return JSON.stringify({ city, temp_c: t, sky: "sunny" });
  },
  {
    name: "get_weather",
    description: "Return current weather for a city.",
    schema: z.object({ city: z.string().describe("City name") }),
  },
);

const wordCount = tool(
  async ({ text }) => String(text.trim().split(/\\s+/).length),
  {
    name: "word_count",
    description: "Count words in a string.",
    schema: z.object({ text: z.string() }),
  },
);

ctx.state.tools = [addNumbers, getWeather, wordCount];
return ctx.state.tools.map((t) => t.name);
`,
    },
    { id: "md-1x", kind: "markdown", source: `Each Zod schema becomes a JSON Schema sent to the model. \`.describe(...)\` text shows up in the function spec — write it like a docstring for the model.` },

    // 2 — Multiple tool calls in one turn
    { id: "md-2", kind: "markdown", source: `## 2 · Multiple tool calls in a single turn\n\nModern tool-calling models can request **several tools at once**. Watch \`tool_calls.length\` in the output.` },
    {
      id: "multi-call", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(ctx.state.tools);

const ai = await llm.invoke([
  new HumanMessage("What's the weather in Paris AND Tokyo, and what is 12 + 30?"),
]);
return { content: ai.content, tool_calls: ai.tool_calls };
`,
    },
    { id: "md-2x", kind: "markdown", source: `You'll usually see \`tool_calls.length === 3\` — one per requested tool. Each has a unique \`id\` you'll use as \`tool_call_id\` when you reply.` },

    // 3 — Full agent loop with max-steps guard
    { id: "md-3", kind: "markdown", source: `## 3 · Agent loop with infinite-loop prevention\n\nThe canonical loop: \`invoke → for each tool_call: run tool, append ToolMessage → invoke again\`. We add **\`maxSteps\`** so a misbehaving model can't loop forever.` },
    {
      id: "agent-loop", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(ctx.state.tools);

const toolsByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));

async function runAgent(userMsg, { maxSteps = 5 } = {}) {
  const msgs = [
    new SystemMessage("Use tools when helpful. Answer concisely when done."),
    new HumanMessage(userMsg),
  ];
  for (let step = 1; step <= maxSteps; step++) {
    ctx.log("step", step);
    const ai = await llm.invoke(msgs);
    msgs.push(ai);
    const calls = ai.tool_calls ?? [];
    if (!calls.length) return { answer: ai.content, steps: step };
    // Run all requested tools (could be parallel; sequential is clearer)
    for (const c of calls) {
      ctx.log("  →", c.name, JSON.stringify(c.args));
      let out;
      try { out = await toolsByName[c.name].invoke(c.args); }
      catch (e) { out = "ERROR: " + e.message; }   // handle tool failure
      msgs.push(new ToolMessage({ content: String(out), tool_call_id: c.id }));
    }
  }
  return { answer: "(max steps reached — possible loop)", steps: maxSteps };
}

return await runAgent(
  "How many words are in 'the quick brown fox jumps over the lazy dog'? Also weather in Tokyo.",
);
`,
    },
    { id: "md-3x", kind: "markdown", source: `Three production-critical patterns in one cell:\n\n- **\`maxSteps\` guard** — bounds the loop. Mandatory. Without it a model can wedge in a tool-call spiral.\n- **Per-tool try/catch** — if a tool throws, we feed the error back as a \`ToolMessage\` so the model can recover or give up. *Never* let a tool exception kill the loop.\n- **Run every requested tool** — don't cherry-pick. Skipping one leaves a dangling \`tool_call_id\` and the next \`invoke\` will throw "tool call without response".` },

    // 4 — Orchestrate a real multi-tool task
    { id: "md-4", kind: "markdown", source: `## 4 · Multi-tool orchestration in the wild\n\nGive the agent a goal that requires combining tools in sequence. The model decides the order — that's the whole point.` },
    {
      id: "orchestrate", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(ctx.state.tools);
const toolsByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));

const msgs = [
  new SystemMessage("You plan multi-step tasks using tools. Show your reasoning briefly."),
  new HumanMessage(
    "Build a one-line travel brief: get weather for Paris and New York, count the words in 'pack umbrella and sunglasses', and combine the temperatures (sum)."
  ),
];

for (let i = 0; i < 6; i++) {
  const ai = await llm.invoke(msgs);
  msgs.push(ai);
  const calls = ai.tool_calls ?? [];
  if (!calls.length) return ai.content;
  ctx.log("turn", i + 1, "→", calls.map((c) => c.name).join(", "));
  for (const c of calls) {
    const out = await toolsByName[c.name].invoke(c.args);
    msgs.push(new ToolMessage({ content: String(out), tool_call_id: c.id }));
  }
}
return "(stopped at safeguard)";
`,
    },
    { id: "md-4x", kind: "markdown", source: `Typical trace: weather×2 → word_count → add_numbers → final answer. The model **plans** which tool to call when. You'll see that planning explicitly in the per-step logs.\n\nNext notebook: **memory checkpointing & human-in-the-loop** with LangGraph.` },
  ],
};
