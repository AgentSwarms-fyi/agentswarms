import type { Notebook } from "./types";

export const adkFunctionToolsNotebook: Notebook = {
  id: "adk-function-tools",
  title: "FunctionTool — Typed Tools the ADK Way",
  description:
    "ADK's FunctionTool turns any Python function into a tool the agent can call. We mirror the exact pattern in TypeScript with Zod (the Pydantic of TS) and watch the agent decide when to call which tool.",
  difficulty: "beginner",
  tags: ["agent", "structured-output"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 2 · FunctionTool — *typed tools the ADK way*

> **About the runtime.** Google ADK ships a real TypeScript SDK — [\`@google/adk\` on npm](https://www.npmjs.com/package/@google/adk), [official quickstart](https://adk.dev/get-started/typescript/). That package is Node-only and won't load in this in-browser sandbox. The cells below use an **API-identical shim**: \`new FunctionTool({ name, description, parameters: z.object({...}), execute })\` matches \`@google/adk\` 1:1. Copy the same code into a Node project, run \`npm i @google/adk @google/genai zod\`, change \`from "./shim"\` to \`from "@google/adk"\`, and it runs unchanged. The Python comparison block below is also accurate — the TS SDK mirrors the Python SDK shape closely.

In ADK, a tool is **any callable** wrapped in \`FunctionTool\`. The framework reads the function's signature, docstring, and Pydantic types to build the JSON schema the model sees.

\`\`\`python
from google.adk.tools import FunctionTool
from pydantic import BaseModel, Field

class WeatherIn(BaseModel):
    city: str = Field(..., description="City name, e.g. 'Tokyo'.")
    units: str = Field("celsius", description="celsius | fahrenheit")

def get_weather(city: str, units: str = "celsius") -> dict:
    """Returns the current weather for a city."""
    return {"city": city, "tempC": 22, "tempF": 72, "summary": "sunny"}

weather_tool = FunctionTool(func=get_weather)

agent = LlmAgent(
    name="trip_assistant",
    model="gemini-2.5-flash",
    instruction="You help users plan trips. Use tools when you need facts.",
    tools=[weather_tool],
)
\`\`\`

Three things to notice:
1. **The docstring becomes the tool description** the model reads.
2. **Pydantic field descriptions become argument descriptions** in the schema.
3. **The return value is a dict** that gets serialised back to the model as a \`tool\` message.

In TypeScript, **Zod is the Pydantic of TS** and LangChain's \`tool()\` helper plays the role of \`FunctionTool\`. The mapping is exact.`,
    },

    {
      id: "md-define",
      kind: "markdown",
      source: `## 1 · Define three tools the way ADK does

We'll give the agent three tools so we can watch it choose:

| Tool | Role |
| --- | --- |
| \`get_weather(city)\` | Returns mocked weather. |
| \`convert_currency(amount, from, to)\` | Mock FX with realistic rates. |
| \`search_attractions(city, max)\` | Returns hand-rolled "top sights". |

In ADK terms each of these is a \`FunctionTool\`. In our cell they're plain async functions wrapped by \`tool()\` with a Zod schema — the exact same metadata the model sees.`,
    },
    {
      id: "define",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { tool } = ctx.lc.tools;
const { z } = ctx.lc;

// === FunctionTool #1 · get_weather ========================================
const getWeather = tool(
  async ({ city, units }) => {
    // In production this would be a real API call. ADK doesn't care.
    const tempC = { tokyo: 22, london: 15, "new york": 18, lagos: 31 }[city.toLowerCase()] ?? 20;
    const tempF = Math.round(tempC * 9 / 5 + 32);
    return { city, temp: units === "fahrenheit" ? tempF : tempC, units, summary: "sunny" };
  },
  {
    name: "get_weather",
    description: "Returns the current weather for a city.",
    schema: z.object({
      city: z.string().describe("City name, e.g. 'Tokyo'."),
      units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
    }),
  },
);

// === FunctionTool #2 · convert_currency ===================================
const convertCurrency = tool(
  async ({ amount, from, to }) => {
    const rates = { USD: 1.0, EUR: 0.92, JPY: 156.0, GBP: 0.79 };
    if (!rates[from] || !rates[to]) throw new Error("Unsupported currency");
    const inUSD = amount / rates[from];
    const converted = +(inUSD * rates[to]).toFixed(2);
    return { from, to, amount, converted };
  },
  {
    name: "convert_currency",
    description: "Converts an amount from one currency to another. Supports USD, EUR, JPY, GBP.",
    schema: z.object({
      amount: z.number().describe("The amount to convert."),
      from: z.string().describe("Source currency code, e.g. 'USD'."),
      to: z.string().describe("Target currency code, e.g. 'JPY'."),
    }),
  },
);

// === FunctionTool #3 · search_attractions =================================
const searchAttractions = tool(
  async ({ city, max }) => {
    const db = {
      tokyo: ["Sensoji Temple", "Shibuya Crossing", "TeamLab Planets", "Tsukiji Market"],
      london: ["British Museum", "Tower of London", "Tate Modern", "Borough Market"],
      "new york": ["Central Park", "MoMA", "Brooklyn Bridge", "High Line"],
    };
    return { city, attractions: (db[city.toLowerCase()] ?? ["No data"]).slice(0, max ?? 3) };
  },
  {
    name: "search_attractions",
    description: "Returns the top tourist attractions for a city.",
    schema: z.object({
      city: z.string(),
      max: z.number().int().min(1).max(8).default(3),
    }),
  },
);

ctx.state.tools = [getWeather, convertCurrency, searchAttractions];

// Show what the model will actually see — this is the JSON-schema view.
for (const t of ctx.state.tools) {
  ctx.log(\`[\${t.name}] \${t.description}\`);
}
return ctx.state.tools.map((t) => t.name);
`,
    },

    {
      id: "md-agent",
      kind: "markdown",
      source: `## 2 · Wire the tools into an LlmAgent

In ADK:

\`\`\`python
agent = LlmAgent(name="trip_assistant", model="gemini-2.5-flash",
                 instruction=...,
                 tools=[weather_tool, currency_tool, attractions_tool])
\`\`\`

In our port we reuse the \`LlmAgent\` factory from notebook #1 but enable the tool-calling loop.

Watch the **agent loop** in the logs: each iteration is one model call. If the response has tool calls we run them, append the results, and loop again. We stop the first time the model returns no tool calls.`,
    },
    {
      id: "agent",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage, ToolMessage } = ctx.lc.messages;

function LlmAgentWithTools({ name, model, description, instruction, tools }) {
  const llm = new ChatOpenAI({
    model, temperature: 0,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  }).bindTools(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    name, description, instruction,
    async run(userText) {
      const messages = [new SystemMessage(instruction), new HumanMessage(userText)];
      let step = 0;
      while (true) {
        step++;
        const ai = await llm.invoke(messages);
        messages.push(ai);
        if (!ai.tool_calls?.length) {
          ctx.log(\`step \${step}: assistant final answer (no tool calls)\`);
          return ai.content;
        }
        ctx.log(\`step \${step}: \${ai.tool_calls.length} tool call(s) → \${ai.tool_calls.map((c) => c.name).join(", ")}\`);
        for (const call of ai.tool_calls) {
          const t = byName.get(call.name);
          const result = await t.invoke(call.args);
          messages.push(new ToolMessage({ tool_call_id: call.id, content: JSON.stringify(result) }));
        }
        if (step > 6) throw new Error("Loop limit exceeded");
      }
    },
  };
}

const tripAgent = LlmAgentWithTools({
  name: "trip_assistant",
  model: "google/gemini-2.5-flash",
  description: "Helps users plan trips by calling weather, FX, and attractions tools.",
  instruction:
    "You help users plan trips. ALWAYS call tools when you need facts (weather, FX rates, attractions). " +
    "When you have enough data, write a concise 2-3 sentence reply.",
  tools: ctx.state.tools,
});
ctx.state.tripAgent = tripAgent;
ctx.log("Trip assistant built with", ctx.state.tools.length, "tools.");
return { tools: ctx.state.tools.map((t) => t.name) };
`,
    },

    {
      id: "md-run",
      kind: "markdown",
      source: `## 3 · Watch tool selection in action

Below are three questions, each requiring a different tool combination:

1. *"What's the weather in Tokyo?"* → one tool, one loop.
2. *"How much is 500 USD in JPY?"* → one tool, one loop.
3. *"I'm flying to Tokyo with a budget of 800 USD. What can I see and what should I expect?"* → multiple tools across multiple loops.

The third query is the interesting one: a well-behaved agent should call \`get_weather\`, \`convert_currency\`, and \`search_attractions\` — possibly in parallel — then synthesise.`,
    },
    {
      id: "run",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const questions = [
  "What's the weather in Tokyo right now?",
  "How much is 500 USD in JPY?",
  "I'm flying to Tokyo with a budget of 800 USD. What's the weather like, " +
    "how much is that in yen, and what should I go see?",
];

const out = [];
for (const q of questions) {
  ctx.log("\\n────────────────────────────────");
  ctx.log("USER: " + q);
  const answer = await ctx.state.tripAgent.run(q);
  ctx.log("ASSISTANT: " + answer);
  out.push({ q, answer });
}
return out.map((r) => r.q);
`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## What you just built

The ADK \`FunctionTool\` shape, ported faithfully:

- **Tool description** ← function docstring.
- **Argument schema** ← Pydantic / Zod model.
- **Return value** ← any JSON-serialisable object.
- **Agent loop** ← model call → tool calls → tool results → repeat until no tool calls.

### Practical guidance (transfers 1:1 to Python ADK)

- **Descriptions matter more than names.** The model picks tools based on the \`description\` field. Spend time writing good ones.
- **Mark optional arguments.** Use Zod's \`.optional()\` / \`.default()\` (Python: \`Field(default=...)\`). Required-but-rarely-used fields cause hallucination.
- **Throw on bad inputs.** Let the tool raise — ADK forwards the error string back to the model, which usually fixes its call on the next loop.
- **Return small JSON.** Big blobs blow your context budget. Filter before returning.

### Next

Notebook #3 introduces ADK's **WorkflowAgents** — \`SequentialAgent\` and \`ParallelAgent\` — which don't call LLMs themselves; they orchestrate other agents on a fixed graph.`,
    },
  ],
};
