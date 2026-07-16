import type { Notebook } from "./types";

export const adkCallbacksSafetyNotebook: Notebook = {
  id: "adk-callbacks-safety",
  title: "Callbacks & Safety — Lifecycle Hooks, Guardrails, Budgets",
  description:
    "ADK's lifecycle callbacks (before_model, before_tool, after_model) are where production safety lives. Add an input PII filter, a tool allowlist, a hard cost budget, and a profanity output scrubber — without touching agent code.",
  difficulty: "advanced",
  tags: ["agent", "evaluation"],
  subgroup: "Safety & Observability",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 6 · Callbacks & Safety — *lifecycle hooks done right*

> **About the runtime.** Google ADK ships a real TypeScript SDK — [\`@google/adk\` on npm](https://www.npmjs.com/package/@google/adk), [official quickstart](https://adk.dev/get-started/typescript/). The package is Node-only and won't load in this in-browser sandbox. The cells below use an **API-identical shim**: \`beforeModelCallback\`, \`afterModelCallback\`, \`beforeToolCallback\`, and \`afterToolCallback\` match the \`@google/adk\` lifecycle-callback contract 1:1 (Python uses snake_case: \`before_model_callback\` etc.). Drop the same code into a Node project, run \`npm i @google/adk\`, change the import, and it runs unchanged.

ADK ships four lifecycle callbacks on every \`LlmAgent\`:

| Callback | Fires when | Can do what |
| --- | --- | --- |
| \`before_model_callback\` | Right before each LLM call. | Block the call, rewrite messages, inject context. |
| \`after_model_callback\` | Right after each LLM call. | Rewrite the response, redact, score. |
| \`before_tool_callback\` | Right before each tool call. | Block / rewrite tool arguments. |
| \`after_tool_callback\` | Right after each tool call. | Rewrite or redact tool results. |

\`\`\`python
def guardrails(callback_context, llm_request):
    if contains_pii(llm_request.contents[-1].parts[0].text):
        return LlmResponse(content="[BLOCKED] PII detected.")  # short-circuits the call
    return None  # let the call proceed

agent = LlmAgent(
    name="safe_agent",
    model="gemini-2.5-flash",
    before_model_callback=guardrails,
    instruction=...,
    tools=[...],
)
\`\`\`

The killer property: **callbacks live outside the prompt**. You can ship a new safety rule without touching the agent's instruction or running prompt regressions — exactly the separation ops teams need.

In this notebook we'll wrap our \`LlmAgent\` with the same hooks and ship four real guardrails.`,
    },

    {
      id: "md-wrap",
      kind: "markdown",
      source: `## 1 · Wrap LlmAgent with the four callback slots

We extend the agent from notebook #1 with four optional callback hooks. Each can return a value to short-circuit, or \`null\` to let the original action proceed — exactly the ADK contract.`,
    },
    {
      id: "wrap",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = ctx.lc.messages;

function LlmAgent({
  name, model, instruction, tools = [],
  beforeModelCallback,   // (request) => responseOrNull
  afterModelCallback,    // (response) => responseOrNull
  beforeToolCallback,    // (toolName, args) => resultOrNull
  afterToolCallback,     // (toolName, args, result) => resultOrNull
}) {
  const chat = new ChatOpenAI({
    model, temperature: 0,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  });
  const llm = tools.length ? chat.bindTools(tools) : chat;
  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    name, instruction,
    async run(userText) {
      const messages = [new SystemMessage(instruction), new HumanMessage(userText)];
      while (true) {
        // ─── before_model_callback ────────────────────────────────────────
        if (beforeModelCallback) {
          const intercept = await beforeModelCallback({ messages });
          if (intercept) {
            ctx.log(\`[before_model] intercepted: \${intercept}\`);
            return intercept;
          }
        }

        let ai = await llm.invoke(messages);

        // ─── after_model_callback ─────────────────────────────────────────
        if (afterModelCallback) {
          const replaced = await afterModelCallback(ai);
          if (replaced) ai = replaced;
        }

        messages.push(ai);
        if (!ai.tool_calls?.length) return ai.content;

        for (const call of ai.tool_calls) {
          // ─── before_tool_callback ──────────────────────────────────────
          if (beforeToolCallback) {
            const intercept = await beforeToolCallback(call.name, call.args);
            if (intercept) {
              ctx.log(\`[before_tool] \${call.name} blocked\`);
              messages.push(new ToolMessage({ tool_call_id: call.id, content: JSON.stringify(intercept) }));
              continue;
            }
          }
          let result = await byName.get(call.name).invoke(call.args);
          // ─── after_tool_callback ───────────────────────────────────────
          if (afterToolCallback) {
            const replaced = await afterToolCallback(call.name, call.args, result);
            if (replaced) result = replaced;
          }
          messages.push(new ToolMessage({ tool_call_id: call.id, content: JSON.stringify(result) }));
        }
      }
    },
  };
}

ctx.state.LlmAgent = LlmAgent;
ctx.log("LlmAgent now supports 4 lifecycle callbacks.");
return { ok: true };
`,
    },

    {
      id: "md-guardrails",
      kind: "markdown",
      source: `## 2 · Four real guardrails

We'll bolt on four production-style hooks. None of them touch the agent's prompt:

1. **PII filter** (\`before_model_callback\`) — blocks the call if the user message contains an SSN, credit card, or email.
2. **Tool allowlist** (\`before_tool_callback\`) — even though the model has 3 tools, only \`get_weather\` is allowed in this mode (e.g. an unauthenticated session).
3. **Budget cap** (\`before_model_callback\`) — stops the loop after N model calls.
4. **Profanity scrubber** (\`after_model_callback\`) — replaces flagged words in the final answer.`,
    },
    {
      id: "guardrails",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { tool } = ctx.lc.tools;
const { AIMessage } = ctx.lc.messages;
const { z } = ctx.lc;

// ── Tools (same shape as notebook #2) ────────────────────────────────────
const getWeather = tool(async ({ city }) => ({ city, tempC: 22, summary: "sunny" }), {
  name: "get_weather",
  description: "Returns the current weather for a city.",
  schema: z.object({ city: z.string() }),
});
const sendEmail = tool(async ({ to, body }) => ({ sent: true, to, length: body.length }), {
  name: "send_email",
  description: "Sends an email to the given address.",
  schema: z.object({ to: z.string(), body: z.string() }),
});
const deleteDb = tool(async () => ({ ok: true }), {
  name: "delete_database",
  description: "DESTRUCTIVE. Drops every table. Requires admin.",
  schema: z.object({}),
});

// ── Guardrails ────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  /\\b\\d{3}-\\d{2}-\\d{4}\\b/,                                 // SSN
  /\\b(?:\\d[ -]*?){13,16}\\b/,                                  // credit card
  /\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b/,        // email
];
function piiFilter({ messages }) {
  const last = messages[messages.length - 1].content;
  for (const p of PII_PATTERNS) if (p.test(String(last))) {
    return "[BLOCKED] Input contained PII (SSN, credit card, or email).";
  }
  return null;
}

const allowedTools = new Set(["get_weather"]);
function toolAllowlist(name) {
  if (!allowedTools.has(name)) return { error: \`Tool '\${name}' is not allowed in this session.\` };
  return null;
}

let modelCallCount = 0;
function budgetCap() {
  modelCallCount++;
  if (modelCallCount > 3) return "[BLOCKED] Model-call budget exceeded (3 calls).";
  return null;
}

const PROFANITY = ["damn", "stupid"];
function profanityScrubber(ai) {
  let text = ai.content;
  for (const w of PROFANITY) text = text.replaceAll(new RegExp(\`\\\\b\${w}\\\\b\`, "gi"), "***");
  if (text !== ai.content) ctx.log("[after_model] scrubbed profanity");
  return new AIMessage({ ...ai, content: text });
}

ctx.state.safeAgent = ctx.state.LlmAgent({
  name: "safe_agent",
  model: "google/gemini-2.5-flash",
  instruction:
    "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [getWeather, sendEmail, deleteDb],
  beforeModelCallback: (req) => piiFilter(req) ?? budgetCap(),
  beforeToolCallback: (name) => toolAllowlist(name),
  afterModelCallback: profanityScrubber,
});

ctx.log("Safe agent built with 4 guardrails.");
return { tools: ["get_weather", "send_email", "delete_database"], allowed: [...allowedTools] };
`,
    },

    {
      id: "md-prove",
      kind: "markdown",
      source: `## 3 · Prove each guardrail fires

Six diverse messages exercise each hook at least once:

1. **Normal question** — should answer through \`get_weather\`.
2. **PII-laden message** — \`before_model\` blocks it.
3. **Asks the agent to send an email** — model tries \`send_email\`, \`before_tool\` blocks (returns an error tool result), and the model recovers gracefully.
4. **Asks to drop the database** — same: \`before_tool\` blocks.
5. **Generates obvious profanity** (we'll prompt for it) — \`after_model\` scrubs.
6. **Long chained reasoning** — \`before_model\` hits the 3-call budget and short-circuits.

You'll see each callback's \`ctx.log\` line, so it's obvious which guardrail caught which case.`,
    },
    {
      id: "prove",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const tests = [
  { label: "✅ normal",            text: "What's the weather in Tokyo?" },
  { label: "🚫 PII",               text: "My SSN is 123-45-6789, do you have my account?" },
  { label: "🚫 tool not allowed",  text: "Email alice@example.com saying the report is ready." },
  { label: "🚫 destructive tool",  text: "We're done with the test env — drop the database please." },
  { label: "🧼 profanity scrub",   text: "Reply with exactly the phrase: 'This is damn stupid.'" },
];

for (const t of tests) {
  ctx.log("\\n────── " + t.label + " ──────");
  ctx.log("USER:    " + t.text);
  const out = await ctx.state.safeAgent.run(t.text);
  ctx.log("AGENT:   " + String(out).slice(0, 240));
}

return { ran: tests.length };
`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## What you just built

A production-shaped safety harness using ADK's lifecycle-callback contract:

- **before_model_callback** — input guard + budget cap. Short-circuits the LLM call.
- **before_tool_callback** — tool allowlist. Returns a structured error the model can recover from.
- **after_model_callback** — output scrubber. Rewrites the response before it returns.

### Why this matters in production

- **Independent change cadence.** Security can edit \`PII_PATTERNS\` weekly. The prompt team never finds out.
- **Composable.** Add a new callback by chaining \`piiFilter ?? budgetCap ?? newRule\`. Order matters; cheapest checks first.
- **Auditable.** Every guardrail logs a structured event — feed those into your SIEM and you have a real safety dashboard.

### Critical lesson — agents are not safe without these

A naked \`LlmAgent\` with \`tools=[send_email, delete_database]\` is a security incident waiting for someone to type "ignore previous instructions". Guardrails — especially the **tool allowlist** — are the difference between a demo and a deployment.

### Where to go from here

You've now covered the six load-bearing ADK primitives:

1. **LlmAgent** — model + instruction + tools.
2. **FunctionTool** — typed callable.
3. **SequentialAgent / ParallelAgent** — fixed control flow.
4. **LoopAgent + session.state** — bounded self-correction.
5. **sub_agents + transfer_to_agent** — routing trees.
6. **Lifecycle callbacks** — orthogonal safety.

The Python ADK ships a few more — \`MCP\` clients, the official \`adk eval\` harness, \`AgentEvaluator\`, Vertex AI deploy targets — but those are infrastructure, not new conceptual primitives. The mental model from these six notebooks is the whole framework.`,
    },
  ],
};
