import type { Notebook } from "./types";

export const vaiToolsNotebook: Notebook = {
  id: "vai-tools",
  title: "Tools — tool() + execute + Multi-Step",
  description:
    "Define typed tools with the Vercel SDK's tool() helper, then let the model call them in a multi-step loop driven by stopWhen / stepCountIs.",
  difficulty: "intermediate",
  tags: ["agent"],
  subgroup: "Tools & Agents",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 3 · Tools — \`tool()\`, \`execute\`, and the Multi-Step Loop

The Vercel AI SDK's tool primitive is one helper:

\`\`\`ts
import { tool } from "ai";
import { z } from "zod";

const weather = tool({
  description: "Get the current weather for a city.",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ tempC: 24, condition: "Sunny" }),
});
\`\`\`

Pass it into \`generateText\` / \`streamText\`:

\`\`\`ts
const result = await generateText({
  model:    openai("gpt-5"),
  tools:    { weather },
  prompt:   "What's the weather in Tokyo and London?",
  stopWhen: stepCountIs(5),   // ← multi-step agent loop, cap at 5 calls
});

result.steps;        // every model call + tool result in order
result.toolCalls;    // typed: { toolName: "weather", args: { city: "..." }, result: {...} }[]
result.text;         // final assistant text
\`\`\`

### Why the SDK's tool API is special

1. **\`parameters\`** is a Zod schema. The SDK auto-derives JSON Schema, and the tool input you receive in \`execute\` is **already validated & typed**.
2. The \`tools\` object's keys become the tool names — TypeScript infers them, so \`result.toolCalls[0].toolName\` is a union type, not \`string\`.
3. **\`execute\` is optional**. Omit it and the model "calls" the tool — but execution is left to *you* (great for HITL approvals, client-side tool execution, or tools that need to fire on the browser).
4. **\`stopWhen\`** controls the agent loop without you writing one. Defaults: \`stepCountIs(1)\` — single step. Pass \`stepCountIs(N)\` or your own predicate for true agentic behaviour.

### Other tool flags you'll meet

| Flag | Meaning |
| --- | --- |
| \`toolChoice: "auto" | "required" | "none" | { type: "tool", toolName: "..." }\` | Force, forbid, or pin a tool. |
| \`maxSteps\` (legacy) → \`stopWhen: stepCountIs(N)\` | Loop cap. |
| \`onStepFinish\` callback | Per-step lifecycle hook — log, persist, stream to UI. |
| \`prepareStep\` callback | Mutate the messages or tool list right before each call (e.g. inject memory). |

Below we hand-roll \`tools: { ... }\` + multi-step loop against the proxy.`,
    },

    {
      id: "md-tools", kind: "markdown",
      source: `## 1 · Define a toolbox + the loop

We give the agent three tools: \`getWeather\`, \`getTime\`, and \`addToCalendar\`. The prompt deliberately needs at least two of them, so you see the loop iterate.`,
    },
    {
      id: "tools", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;

// SDK shape: tool({ description, parameters, execute })
function tool(spec) { return spec; } // pass-through; we use the shape directly

const tools = {
  getWeather: tool({
    description: "Get current weather for a city.",
    parameters: z.object({ city: z.string() }),
    schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"], additionalProperties: false,
    },
    execute: async ({ city }) => ({ city, tempC: { Tokyo: 24, London: 12, NYC: 18 }[city] ?? 20, condition: "Sunny" }),
  }),
  getTime: tool({
    description: "Get current local time in a city.",
    parameters: z.object({ city: z.string() }),
    schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
    execute: async ({ city }) => ({ city, localTime: new Date().toISOString() }),
  }),
  addToCalendar: tool({
    description: "Add an event to the user's calendar.",
    parameters: z.object({ title: z.string(), iso_datetime: z.string() }),
    schema: {
      type: "object",
      properties: { title: { type: "string" }, iso_datetime: { type: "string" } },
      required: ["title", "iso_datetime"], additionalProperties: false,
    },
    execute: async ({ title, iso_datetime }) => ({ event_id: "evt_" + Math.random().toString(36).slice(2, 8), title, at: iso_datetime }),
  }),
};

// stepCountIs(N) → a predicate the loop calls each step.
const stepCountIs = (n) => (steps) => steps.length >= n;

async function generateTextWithTools({ model, system, prompt, tools, stopWhen, onStepFinish }) {
  const toolSpecs = Object.entries(tools).map(([name, t]) => ({
    type: "function",
    function: { name, description: t.description, parameters: t.schema },
  }));
  const messages = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  const steps = [];

  while (!stopWhen(steps)) {
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model, messages, tools: toolSpecs, tool_choice: "auto" }),
    });
    const msg = (await res.json()).choices[0].message;
    messages.push(msg);

    const step = { text: msg.content ?? "", toolCalls: [] };
    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        const validated = tools[call.function.name].parameters.parse(args);
        const result = await tools[call.function.name].execute(validated);
        step.toolCalls.push({ toolName: call.function.name, args: validated, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    steps.push(step);
    onStepFinish?.(step, steps.length);

    if (!msg.tool_calls?.length) {
      return { text: msg.content ?? "", steps, toolCalls: steps.flatMap((s) => s.toolCalls) };
    }
  }
  return { text: messages.at(-1)?.content ?? "", steps, toolCalls: steps.flatMap((s) => s.toolCalls), stoppedBy: "stopWhen" };
}

const result = await generateTextWithTools({
  model: "google/gemini-3-flash-preview",
  system: "You have access to tools. Use them aggressively rather than guessing.",
  prompt: "What's the weather and time in Tokyo right now? If it's a nice day, schedule a 'sunset walk' for me at 18:00 today.",
  tools,
  stopWhen: stepCountIs(5),
  onStepFinish: (step, n) => {
    ctx.log(\`─── step \${n} ───\`);
    step.toolCalls.forEach((c) => ctx.log(\`  tool: \${c.toolName} \${JSON.stringify(c.args)} → \${JSON.stringify(c.result)}\`));
    if (step.text) ctx.log(\`  text: \${step.text.slice(0, 100)}\`);
  },
});

ctx.log("\\n✓ FINAL TEXT:\\n" + result.text);
ctx.log("\\ntool calls (typed):");
result.toolCalls.forEach((c) => ctx.log("  •", c.toolName, JSON.stringify(c.args)));
return { steps: result.steps.length, tools_called: result.toolCalls.map((c) => c.toolName), text: result.text };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

- **\`tool({ description, parameters, execute })\`** is the only tool primitive — Zod parameters mean inputs are typed and validated for free.
- The \`tools\` *object's keys* become the tool names — TypeScript infers everything.
- \`stopWhen: stepCountIs(N)\` turns a single call into a multi-step agent loop.
- \`onStepFinish\` is your hook for logging, streaming to a UI, or persisting state.

### Patterns

| Pattern | How |
| --- | --- |
| HITL approval | Omit \`execute\` on a tool — the model "calls" it; you intercept on the client and prompt the user before resolving. |
| Forced tool use | \`toolChoice: { type: "tool", toolName: "search" }\` — model must call \`search\` first. |
| Cheap-first → escalate | In \`prepareStep\`, swap to a stronger model when step count is high. |
| Tool with side effects | Let \`execute\` write to your DB / hit a 3rd-party API. Combine with \`onStepFinish\` for audit logs. |

This is the most powerful 50 lines in the Vercel AI SDK. Next notebook: the \`Agent\` class, which wraps this same loop with configuration ergonomics.`,
    },
  ],
};
