import type { Notebook } from "./types";

export const voltToolsNotebook: Notebook = {
  id: "volt-tools",
  title: "Tools — createTool, Zod schemas & multi-tool agent loops",
  description:
    "VoltAgent's typed tool model: createTool() with Zod parameters, attach a map of tools to an Agent, watch the model orchestrate them across a multi-step loop with real fetch-driven side effects.",
  difficulty: "beginner",
  tags: ["agent", "structured-output"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · Tools — \`createTool\` + Zod + the Agent loop

In VoltAgent every tool is a typed object built with \`createTool()\` from \`@voltagent/core\`. Tools have:

| Field | Purpose |
| --- | --- |
| \`name\` | Stable identifier. Shown in traces; the model calls the tool by this name. |
| \`description\` | The single most important field — the model reads this to decide when to call the tool. |
| \`parameters\` (Zod) | Strict argument shape — invalid calls are rejected before \`execute\` runs. |
| \`execute(args, ctx?)\` | Async function that does the real work. Can fetch APIs, query DBs, call other agents. |

\`\`\`ts
import { createTool } from "@voltagent/core";
import { z } from "zod";

export const weatherTool = createTool({
  name: "get_weather",
  description: "Fetch the current weather for a city. Use whenever the user asks about temperature, rain, or forecasts.",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    const r = await fetch(\`https://wttr.in/\${city}?format=j1\`).then(r => r.json());
    return { tempC: Number(r.current_condition[0].temp_C), summary: r.current_condition[0].weatherDesc[0].value };
  },
});

const travelAgent = new Agent({
  name: "travel-agent",
  instructions: "Plan day trips. Check the weather first.",
  model: openai("gpt-4o-mini"),
  tools: [weatherTool, currencyTool, attractionsTool],
});

await travelAgent.generateText("Should I visit Edinburgh today?");
// → the agent autonomously calls weather → currency → attractions → answers
\`\`\`

The loop is **automatic and bounded** by \`maxSteps\` (default 5). VoltAgent runs the standard tool-calling cycle (model → tool → model → …) until the model stops requesting tools, hits the cap, or a sentinel tool fires. You don't write the while-loop.

Below we wire three real tools to a model that drives the loop end-to-end.`,
    },

    {
      id: "md-loop", kind: "markdown",
      source: `## 1 · Three tools, one agent, one loop

We give the agent:
- \`lookup_order\` — fake order DB
- \`calculate_refund\` — strict arithmetic the model is bad at
- \`submit_decision\` — sentinel tool; calling it ends the loop with a typed payload

The pattern (lookup workers + a sentinel finalizer) is the **idiomatic VoltAgent ReAct shape**.`,
    },
    {
      id: "helpers-md", kind: "markdown",
      source: `### Helpers
We define \`createTool\` to standardize our tool objects and \`zodToJson\` to convert Zod schemas into the JSON Schema format expected by the LLM.`,
    },
    {
      id: "helpers-code", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;
ctx.state.z = z;

ctx.state.createTool = ({ name, description, parameters, execute }) => ({
  name, description, parameters, execute
});

ctx.state.zodToJson = (schema) => {
  const rawShape = schema._def.shape ?? schema.shape;
  const shape = typeof rawShape === "function" ? rawShape() : rawShape;
  const props = {}, required = [];
  for (const [k, v] of Object.entries(shape)) {
    const t = v._def.typeName === "ZodNumber" ? "number" : "string";
    props[k] = { type: t }; required.push(k);
  }
  return { type: "object", properties: props, required, additionalProperties: false };
};`,
    },
    {
      id: "lookup-md", kind: "markdown",
      source: `### Tool: lookup_order
The \`lookup_order\` tool acts as our interface to the order database. It takes an \`orderId\` and returns the item details if found.`,
    },
    {
      id: "lookup-code", kind: "code", language: "js", runtime: "browser",
      source: `const { createTool, z } = ctx.state;
const ORDERS = {
  "A-101": { item: "E-bike battery", price: 480, daysAgo: 12, status: "delivered" },
  "A-102": { item: "Helmet",         price:  79, daysAgo: 40, status: "delivered" },
};

ctx.state.lookupOrder = createTool({
  name: "lookup_order",
  description: "Look up an order by its ID. Returns item, price, daysAgo, status.",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ORDERS[orderId] ?? { error: "not found" },
});`,
    },
    {
      id: "refund-md", kind: "markdown",
      source: `### Tool: calculate_refund
Models often struggle with precise arithmetic. We delegate the refund calculation—including business rules like the 30-day window—to this specialized tool.`,
    },
    {
      id: "refund-code", kind: "code", language: "js", runtime: "browser",
      source: `const { createTool, z } = ctx.state;

ctx.state.calculateRefund = createTool({
  name: "calculate_refund",
  description: "Compute the refund. Full refund if delivered within 30 days, else 50%.",
  parameters: z.object({ price: z.number(), daysAgo: z.number() }),
  execute: async ({ price, daysAgo }) => ({ refundUSD: daysAgo <= 30 ? price : price * 0.5 }),
});`,
    },
    {
      id: "sentinel-md", kind: "markdown",
      source: `### Sentinel: submit_decision
A 'sentinel' tool is a special tool that, when called, provides the final structured output and tells the agent loop to stop.`,
    },
    {
      id: "sentinel-code", kind: "code", language: "js", runtime: "browser",
      source: `const { createTool, z } = ctx.state;
ctx.state.DECISION = null;

ctx.state.submitDecision = createTool({
  name: "submit_decision",
  description: "Submit the final refund decision. Call this exactly once, last.",
  parameters: z.object({ orderId: z.string(), refundUSD: z.number(), reason: z.string() }),
  execute: async (p) => { ctx.state.DECISION = p; return { ok: true }; },
});`,
    },
    {
      id: "chat-md", kind: "markdown",
      source: `### Chat Helper
We create a \`chat()\` helper that sends our tool definitions and messages to the LLM, and we collect our tools into a single array.`,
    },
    {
      id: "chat-code", kind: "code", language: "js", runtime: "browser",
      source: `const { lookupOrder, calculateRefund, submitDecision, zodToJson } = ctx.state;

ctx.state.chat = async (messages, tools) => {
  const toolDefs = tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: zodToJson(t.parameters) },
  }));
  const r = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages, tools: toolDefs }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message;
};

ctx.state.TOOLS = [lookupOrder, calculateRefund, submitDecision];`,
    },
    {
      id: "react-md", kind: "markdown",
      source: `### The ReAct Loop
This loop mirrors VoltAgent's internal logic: the model requests a tool, we execute it, feed the result back, and repeat until \`submit_decision\` is called.`,
    },
    {
      id: "react-code", kind: "code", language: "js", runtime: "browser",
      source: `const { chat, TOOLS } = ctx.state;
const messages = [
  { role: "system", content: "You are a refund agent. Look up the order, compute the refund, then call submit_decision." },
  { role: "user",   content: "I want a refund for order A-101. It just feels weak." },
];

for (let step = 0; step < 6; step++) {
  const msg = await chat(messages, TOOLS);
  messages.push(msg);
  if (!msg.tool_calls?.length) { ctx.log("model done:", msg.content); break; }
  for (const call of msg.tool_calls) {
    const tool = TOOLS.find(t => t.name === call.function.name);
    const args = JSON.parse(call.function.arguments || "{}");
    const out  = await tool.execute(args);
    ctx.log(\`▶ \${tool.name}(\${JSON.stringify(args)}) → \${JSON.stringify(out)}\`);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
  }
  if (ctx.state.DECISION) { ctx.log("✅ decision:", JSON.stringify(ctx.state.DECISION)); break; }
}

return { decision: ctx.state.DECISION, steps: messages.length };`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

You just saw the full VoltAgent tool shape: **typed Zod schema in, typed object out, sentinel tool to end the loop**. Real \`@voltagent/core\` adds:

- \`Toolkit\` for bundling related tools and toggling \`addInstructions\` (so the agent learns the toolkit's usage rules)
- \`maxSteps\` per call to cap runaway loops
- Tool-level \`onError\` hooks for graceful degradation
- Auto-tracing — every \`execute()\` call shows up in VoltOps Console with timing, inputs, outputs

Next up: **Memory**, where the agent remembers what happened across these turns.`,
    },
  ],
};
