import type { Notebook } from "./types";

export const oaiFundamentalsNotebook: Notebook = {
  id: "oai-fundamentals",
  title: "Agents, Instructions & the Run Loop",
  description:
    "The core mental model of the OpenAI Agents SDK: an Agent (instructions + model + tools), a Runner that drives the loop, and tools defined with Zod. Hand-rolled here so every step of the loop is visible.",
  difficulty: "beginner",
  tags: ["agent", "structured-output"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 1 · The OpenAI Agents SDK — Core Mental Model

The **OpenAI Agents SDK** (\`@openai/agents\` for TS, \`openai-agents\` for Python) is OpenAI's official, minimal framework for building agents. It is intentionally tiny — three primitives do almost all of the work:

| Primitive | What it is | Example |
| --- | --- | --- |
| **\`Agent\`** | A name + instructions + model + tools + (optional) handoffs + (optional) output type. | \`new Agent({ name: "Support", instructions: "...", model: "gpt-5", tools: [refundTool] })\` |
| **\`Runner.run(agent, input)\`** | Drives the **agent loop**: call model → if tool calls, execute them → feed results back → repeat → return final output. | \`await run(agent, "Refund order 123")\` |
| **\`tool(...)\`** | Wraps a typed function (Zod schema) into a callable the model can invoke. | \`tool({ name, parameters: z.object({...}), execute: async ({...}) => "..." })\` |

That's the whole framework. Everything else (handoffs, guardrails, sessions, tracing) sits on top of this loop.

### The agent loop, in pseudocode

\`\`\`text
while true:
  response = model.chat(messages + tool_specs)
  if response.has_tool_calls:
    for call in response.tool_calls:
      result = tools[call.name].execute(call.args)
      messages.append(tool_result(result))
    continue          # ← loop again so the model can react to the tool output
  if agent.output_type:
    return parse(response, agent.output_type)  # validated structured output
  return response.text                          # plain text final answer
\`\`\`

> In this notebook we **hand-roll that exact loop** against an OpenAI-compatible endpoint. Everything you build later in this track (handoffs, guardrails, sessions, streaming) just plugs into this same loop.

### What the real SDK call looks like (for reference)

\`\`\`ts
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

const weather = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => \`Sunny, 24°C in \${city}\`,
});

const agent = new Agent({
  name: "Concierge",
  instructions: "You are a helpful concierge. Use tools to answer factually.",
  model: "gpt-5",
  tools: [weather],
});

const result = await run(agent, "What's the weather in Tokyo?");
console.log(result.finalOutput);
\`\`\`

The version below uses the same shapes — tool spec, agent spec, run loop — so you can substitute the SDK calls one-for-one once you install the package.`,
    },

    {
      id: "md-agent", kind: "markdown",
      source: `## 1 · Define an "Agent" — instructions, model, tools

We mirror the \`new Agent({ ... })\` constructor with a plain object. The key insight: **the agent is just configuration**. It has no state, makes no calls. The \`Runner\` is what brings it to life.`,
    },
    {
      id: "agent", kind: "code", language: "js", runtime: "browser",
      source: `// The Agent — exactly the shape \`new Agent({...})\` takes in @openai/agents.
const agent = {
  name: "Concierge",
  instructions:
    "You are a helpful concierge. " +
    "When asked about weather or time in a city, ALWAYS call the appropriate tool. " +
    "Be concise and friendly.",
  model: "google/gemini-3-flash-preview",
  tools: [
    {
      // tool({ name, description, parameters: z.object(...), execute }) in the SDK.
      name: "get_weather",
      description: "Get the current weather for a given city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name, e.g. 'Tokyo'" } },
        required: ["city"],
        additionalProperties: false,
      },
      execute: async ({ city }) => {
        // In real life: fetch a weather API. Here: a stub so the loop is the focus.
        const temps = { Tokyo: 24, London: 12, "New York": 18, Paris: 15 };
        const t = temps[city] ?? 20;
        return { city, condition: "Sunny", temperatureC: t };
      },
    },
    {
      name: "get_time",
      description: "Get the current local time in a given city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      execute: async ({ city }) => ({ city, localTime: new Date().toISOString() }),
    },
  ],
};

ctx.state.agent = agent;
ctx.log("Agent defined ✓");
ctx.log("  name :", agent.name);
ctx.log("  model:", agent.model);
ctx.log("  tools:", agent.tools.map((t) => t.name).join(", "));
return { agent: agent.name, tools: agent.tools.map((t) => t.name) };
`,
    },

    {
      id: "md-loop", kind: "markdown",
      source: `## 2 · The Run Loop — exactly what \`Runner.run()\` does

This is the heart of the SDK. We:

1. Build the \`messages\` array (system = instructions, then the user turn).
2. Call the model with our **tool specs** advertised.
3. If the model returned **tool_calls**, execute each one and append a \`tool\` message with the result.
4. Loop back to step 2 so the model can read the tool output and either call more tools OR produce a final answer.
5. If the model returned **content** with no tool calls, we're done.

We also cap the loop at a max-turns budget — the real SDK has \`maxTurns\` for the same reason.

> 🎯 **Watch the log.** You'll see each turn: model response → tool calls → tool results → next model response. This is what tracing shows you visually in the real SDK.`,
    },
    {
      id: "loop", kind: "code", language: "js", runtime: "browser",
      source: `async function run(agent, input, { maxTurns = 6 } = {}) {
  const toolSpecs = agent.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolMap = Object.fromEntries(agent.tools.map((t) => [t.name, t]));

  const messages = [
    { role: "system", content: agent.instructions },
    { role: "user", content: input },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    ctx.log("─── turn", turn, "───");
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({ model: agent.model, messages, tools: toolSpecs, tool_choice: "auto" }),
    });
    const data = await res.json();
    const msg = data.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls?.length) {
      ctx.log("  model requested", msg.tool_calls.length, "tool call(s)");
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        ctx.log("    →", call.function.name, args);
        const result = await toolMap[call.function.name].execute(args);
        ctx.log("    ✓", JSON.stringify(result));
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue; // loop back so the model can react to tool output
    }

    ctx.log("  final answer:", msg.content?.slice(0, 200));
    return { finalOutput: msg.content, turns: turn, messages };
  }
  throw new Error("Max turns reached");
}

// 👇 Try editing the input — ask about multiple cities to see chained tool calls.
const result = await run(ctx.state.agent, "What's the weather AND local time in Tokyo?");
return { finalOutput: result.finalOutput, turns: result.turns };
`,
    },

    {
      id: "md-recap", kind: "markdown",
      source: `## Recap & what comes next

You just built a working agent loop. In the real SDK that whole loop is one line:

\`\`\`ts
const result = await run(agent, "What's the weather in Tokyo?");
\`\`\`

But **conceptually nothing is hidden** — the SDK only does what you just did, with nicer ergonomics (Zod parsing, automatic OpenTelemetry tracing, type-safe outputs).

### Other knobs on \`Agent\` you'll meet later in this track

| Field | What it does | Where we cover it |
| --- | --- | --- |
| \`handoffs\` | List of other agents this one can delegate to. | Notebook 2 (Handoffs) |
| \`input_guardrails\` / \`output_guardrails\` | Validators that fire before/after the loop and can trip the run. | Notebook 3 (Guardrails) |
| \`outputType\` | A Zod schema — final answer is validated and parsed. | Notebook 4 (Structured Output) |
| \`modelSettings\` | temperature, top_p, max tokens. | (Pass via run options.) |
| \`tool_use_behavior\` | "run_llm_again" (default) or "stop_on_first_tool" — short-circuits the loop. | Advanced |

### Sessions, streaming, tracing

- **Sessions** (memory across runs) — Notebook 5.
- **Streaming** (\`Runner.run_streamed\`) and **lifecycle hooks** — Notebook 6.

You now have the only mental model you need. Everything else is a feature on this loop.`,
    },
  ],
};
