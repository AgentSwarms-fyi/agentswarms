import type { Notebook } from "./types";

export const mstToolsNotebook: Notebook = {
  id: "mst-tools",
  title: "Tools — createTool, Zod schemas & multi-tool agent loops",
  description:
    "Mastra's typed tool model. Define createTool() with Zod input/output schemas, attach a map of tools to an Agent, and watch the model orchestrate them across a multi-step loop with real fetch-driven side effects.",
  difficulty: "beginner",
  tags: ["agent", "structured-output"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · Tools — \`createTool\` + Zod + the Agent loop

In Mastra, every tool is a typed object built with \`createTool()\` from \`@mastra/core/tools\`. Tools have:

| Field | Purpose |
| --- | --- |
| \`id\` | Stable name. Shown in traces; the model calls the tool by this name. |
| \`description\` | The single most important field — the model reads this to decide when to call the tool. |
| \`inputSchema\` (Zod) | Strict argument shape — invalid calls are rejected before \`execute\` runs. |
| \`outputSchema\` (Zod) | Optional. If set, the return value is validated too. |
| \`execute(input, ctx?)\` | Async function that does the real work. Can fetch APIs, query DBs, call other agents. |

\`\`\`ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const weatherTool = createTool({
  id: "get-weather",
  description: "Fetch the current weather for a city. Use whenever the user asks about temperature, rain, or forecasts.",
  inputSchema:  z.object({ city: z.string() }),
  outputSchema: z.object({ tempC: z.number(), summary: z.string() }),
  execute: async ({ city }) => {
    const r = await fetch(\`https://wttr.in/\${city}?format=j1\`).then(r => r.json());
    return { tempC: Number(r.current_condition[0].temp_C), summary: r.current_condition[0].weatherDesc[0].value };
  },
});
\`\`\`

### Attaching tools to an agent

You hand the agent an **object** of tools — the keys become the tool names the model sees:

\`\`\`ts
const agent = new Agent({
  id: "travel-agent",
  name: "Travel Agent",
  instructions: "Help users plan day trips. Always check the weather first.",
  model: "openai/gpt-5",
  tools: { weather: weatherTool, currency: currencyTool, attractions: attractionsTool },
});

await agent.generate("Should I visit Edinburgh today?");
// → the agent autonomously calls weather → currency → attractions → answers
\`\`\`

The loop is **automatic and bounded**. Mastra runs the standard tool-calling cycle (model → tool → model → …) until the model stops requesting tools, hits the step cap, or a stop condition fires. You don't write the while-loop.

> If you've used the OpenAI Agents SDK or the Vercel AI SDK's \`Agent\` class, the shape is intentionally familiar — Mastra wraps the same primitives under a typed, registry-friendly skin.

Below we build three real tools (lookup + calculator + finalize) and watch the model orchestrate them.`,
    },

    {
      id: "md-loop", kind: "markdown",
      source: `## 1 · Three tools, one agent, one loop

We give the agent:
- \`lookupOrder\` — fake order DB
- \`calculateRefund\` — strict arithmetic the model is bad at
- \`submitDecision\` — sentinel tool; calling it ends the loop with a typed payload

The pattern (lookup workers + a sentinel finalizer) is the **idiomatic Mastra ReAct shape**.`,
    },
    {
      id: "md-setup", kind: "markdown",
      source: `### 1.1 · Setup and Utilities
First, we define a lightweight \`createTool\` helper and a utility to convert Zod schemas to JSON Schema. We also define a mock database of orders.`,
    },
    {
      id: "setup", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;

// ─── createTool — mirrors @mastra/core/tools ───────────────────────────
function createTool({ id, description, inputSchema, outputSchema, execute }) {
  return { id, description, inputSchema, outputSchema, execute };
}

// Convert the simple Zod object schemas in this notebook → OpenAI tool JSON Schema.
// Zod/CDN builds differ internally, so avoid relying on one private _def shape.
function zodToJson(schema) {
  const rawShape = schema?._def?.shape ?? schema?.shape;
  const shape = typeof rawShape === "function" ? rawShape() : rawShape;
  if (shape && typeof shape === "object") {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(shape)) {
      required.push(key);
      properties[key] = zodToJson(value);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  const def = schema?._def ?? {};
  const type = def.type ?? def.typeName;
  if (type === "number" || type === "ZodNumber") return { type: "number" };
  if (type === "boolean" || type === "ZodBoolean") return { type: "boolean" };
  if (type === "enum" || type === "ZodEnum") return { type: "string", enum: Object.values(def.entries ?? def.values ?? {}) };
  if (type === "array" || type === "ZodArray") return { type: "array", items: zodToJson(def.element ?? def.type) };
  return { type: "string" };
}

// ─── Three real tools ──────────────────────────────────────────────────
const ORDERS = {
  "A-1042": { item: "Lumos e-bike",       paidUSD: 1899, status: "delivered", shippedDaysAgo: 9 },
  "A-1043": { item: "Replacement battery", paidUSD: 349,  status: "delivered", shippedDaysAgo: 35 },
};

ctx.state.createTool = createTool;
ctx.state.zodToJson = zodToJson;
ctx.state.ORDERS = ORDERS;`,
    },
    {
      id: "md-tools-definitions", kind: "markdown",
      source: `### 1.2 · Defining the Tools
We define three tools: one to look up orders, one to calculate refunds based on business logic, and a final "sentinel" tool to submit the decision.`,
    },
    {
      id: "tools-definitions", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;
const { createTool, ORDERS } = ctx.state;

const lookupOrder = createTool({
  id: "lookupOrder",
  description: "Look up an order in the orders database by its ID (format: A-####). Returns price, status, and age.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ORDERS[orderId] ?? { error: "Order not found." },
});

const calculateRefund = createTool({
  id: "calculateRefund",
  description: "Compute the refund amount in USD. Returns 100% within 14 days, 50% within 30 days, 0% beyond. Never compute this in your head.",
  inputSchema: z.object({ paidUSD: z.number(), shippedDaysAgo: z.number() }),
  execute: async ({ paidUSD, shippedDaysAgo }) => {
    const pct = shippedDaysAgo <= 14 ? 1.0 : shippedDaysAgo <= 30 ? 0.5 : 0;
    return { refundUSD: Math.round(paidUSD * pct * 100) / 100, policyApplied: \`\${pct * 100}%\` };
  },
});

const submitDecision = createTool({
  id: "submitDecision",
  description: "Call this exactly once when you are ready to give the final refund decision to the customer.",
  inputSchema: z.object({
    orderId: z.string(),
    decision: z.enum(["approve", "decline", "escalate"]),
    refundUSD: z.number(),
    reason: z.string(),
  }),
  execute: async (args) => ({ accepted: true, ...args }),
});

ctx.state.tools = { lookupOrder, calculateRefund, submitDecision };`,
    },
    {
      id: "md-agent-class", kind: "markdown",
      source: `### 1.3 · The Agent Engine
Mastra agents automate the "Reasoning + Acting" (ReAct) loop. Here is a simplified version of the core loop that handles tool calling.`,
    },
    {
      id: "agent-class", kind: "code", language: "js", runtime: "browser",
      source: `const { zodToJson } = ctx.state;

// ─── Tiny Mastra-shaped Agent with the standard tool loop ──────────────
class Agent {
  constructor({ id, name, instructions, model, tools, maxSteps = 8 }) {
    Object.assign(this, { id, name, instructions, model, tools, maxSteps });
  }
  async generate(prompt) {
    const messages = [{ role: "system", content: this.instructions }, { role: "user", content: prompt }];
    const toolSpecs = Object.values(this.tools).map((t) => ({
      type: "function",
      function: { name: t.id, description: t.description, parameters: zodToJson(t.inputSchema) },
    }));
    const trace = [];
    let finalPayload = null;

    for (let step = 1; step <= this.maxSteps; step++) {
      const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
        body: JSON.stringify({ model: this.model, messages, tools: toolSpecs, tool_choice: "auto" }),
      });
      if (!res.ok) throw new Error("AI call failed: " + res.status + " " + await res.text());
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("AI response did not include a message: " + JSON.stringify(data).slice(0, 200));
      messages.push(msg);

      const calls = msg.tool_calls ?? [];
      if (!calls.length) {
        trace.push({ step, finalText: msg.content });
        return { text: msg.content, trace, finalPayload };
      }

      for (const call of calls) {
        const tool = Object.values(this.tools).find((t) => t.id === call.function.name);
        if (!tool) throw new Error("Unknown tool requested: " + call.function.name);
        const args = JSON.parse(call.function.arguments || "{}");
        const parsed = tool.inputSchema.safeParse(args);
        const input = parsed.success ? parsed.data : args;
        const out = await tool.execute(input);
        trace.push({ step, tool: tool.id, args: input, out });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
        if (tool.id === "submitDecision") finalPayload = input;
      }
      if (finalPayload) return { text: "decision submitted", trace, finalPayload };
    }
    return { text: "max steps reached", trace, finalPayload };
  }
}

ctx.state.Agent = Agent;`,
    },
    {
      id: "md-agent-run", kind: "markdown",
      source: `### 1.4 · Running the Agent
Now we instantiate our agent with the tools and give it a customer request. The agent will orchestrate the tools to reach a decision.`,
    },
    {
      id: "agent-run", kind: "code", language: "js", runtime: "browser",
      source: `const { Agent, tools } = ctx.state;\nif (!Agent || !tools) throw new Error("Please run the setup cells first.");

const refundAgent = new Agent({
  id: "refundAgent",
  name: "Refund Agent",
  instructions:
    "You are a refund-handling agent. " +
    "STEP 1: lookupOrder using the customer's order ID. " +
    "STEP 2: calculateRefund using paidUSD and shippedDaysAgo from the lookup. " +
    "STEP 3: submitDecision with decision='approve' if refundUSD > 0, else 'decline'. " +
    "Never compute refunds in your head — always call calculateRefund.",
  model: "google/gemini-3-flash-preview",
  tools,
});

const result = await refundAgent.generate(
  "Hi — order A-1043 arrived damaged, I want a refund please."
);

ctx.state.result = result;`,
    },
    {
      id: "md-agent-results", kind: "markdown",
      source: `### 1.5 · Observing the Trace
Finally, we can inspect the step-by-step trace of how the agent called the tools and see the structured data returned by the final tool.`,
    },
    {
      id: "agent-results", kind: "code", language: "js", runtime: "browser",
      source: `if (!ctx.state.result) throw new Error("Please run the Agent cell first.");\nconst { trace, finalPayload } = ctx.state.result;

ctx.log("─── tool trace ───");
for (const t of trace) {
  if (t.tool) ctx.log(\`step \${t.step}  → \${t.tool}(\${JSON.stringify(t.args)})\`);
  if (t.tool) ctx.log(\`           ← \${JSON.stringify(t.out)}\\n\`);
}
ctx.log("─── final structured decision ───\\n" + JSON.stringify(finalPayload, null, 2));
return { steps: trace.length, finalPayload };`,
    },

    {
      id: "md-context", kind: "markdown",
      source: `## 2 · The second \`execute\` argument — \`requestContext\` and friends

Real Mastra passes a second parameter to every \`execute\`:

\`\`\`ts
execute: async (input, { requestContext, tracingContext, abortSignal, agent, workflow }) => { ... }
\`\`\`

| Field | Use it for |
| --- | --- |
| \`requestContext\` | Per-request data the caller attached: \`userId\`, \`locale\`, \`tenantId\`. Lets a tool be multi-tenant without leaking globals. |
| \`tracingContext\` | The current OTel span — add custom attributes for observability. |
| \`abortSignal\` | Propagated AbortSignal — forward it to \`fetch\` so long requests cancel cleanly. |
| \`agent\` | The agent that triggered this call (when invoked from an agent). |
| \`workflow\` | Workflow state, including \`suspend()\` for human-in-the-loop pauses (covered in notebook 3). |

Cell below shows the \`requestContext\` pattern — the same tool returns different data per user, with no global state.`,
    },
    {
      id: "context", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;

// Per-user fake DB.
const ACCOUNTS = {
  "user-1": { name: "Asha",   tier: "free",    creditsLeft: 5 },
  "user-2": { name: "Marco",  tier: "pro",     creditsLeft: 250 },
  "user-3": { name: "Tomoko", tier: "enterprise", creditsLeft: Infinity },
};

const checkBalance = {
  id: "checkBalance",
  description: "Return the calling user's plan and remaining credits.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const acct = ACCOUNTS[requestContext.userId];
    return acct ? { plan: acct.tier, creditsLeft: acct.creditsLeft } : { error: "unknown user" };
  },
};

// Direct tool invocations — bypass the LLM to show the contract.
for (const userId of ["user-1", "user-2", "user-3"]) {
  const result = await checkBalance.execute({}, { requestContext: { userId } });
  ctx.log(\`userId=\${userId} →\`, JSON.stringify(result));
}

return { ok: true };`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

- **\`createTool\`** is the only way to define a tool in Mastra. Zod schemas are mandatory — they're how tools stay typed end-to-end (from the model's tool-call JSON, through your \`execute\`, into the agent's reply).
- Agents accept a **tool map** (\`{ name: tool }\`) — the key becomes the tool name the model sees.
- The multi-step loop is automatic. Stop conditions are \`maxSteps\`, no more tool calls, or a sentinel tool you provide (like \`submitDecision\`).
- Every \`execute\` gets a second context arg with \`requestContext\`, \`abortSignal\`, \`tracingContext\` — the seams that make Mastra tools production-grade.

> **Where this scales:** when one agent's tool set grows past ~10 tools, swap individual tools for a Workflow (next notebook) or a **sub-agent** (\`agents: { researcher, summarizer }\` on the parent). Mastra exposes sub-agents to the parent as auto-generated \`agent-<id>\` tools — same loop, more structure.`,
    },
  ],
};
