import type { Notebook } from "./types";

export const oaiHandoffsNotebook: Notebook = {
  id: "oai-handoffs",
  title: "Handoffs & the Triage Pattern",
  description:
    "Multi-agent routing the OpenAI way: a triage agent decides which specialist (Billing, Tech, Sales) should answer, then hands control off. Implemented as a tool call under the hood — visible step by step.",
  difficulty: "intermediate",
  tags: ["agent", "multi-agent", "routing"],
  subgroup: "Multi-Agent",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · Handoffs — The OpenAI Agents SDK's Routing Primitive

A **handoff** is the SDK's word for "this agent gives up control and lets another agent take over." It is the building block for the classic **triage pattern**: one router agent reads the user request and routes to a specialist.

### How it actually works under the hood

The SDK exposes each handoff as a **synthetic tool** called \`transfer_to_<agent_name>\`. When the triage model calls that tool, the runner:

1. Stops running the triage agent.
2. Starts running the target agent with the same conversation history.
3. Returns the target agent's output as the run's final output.

There is no magic — it's just a special tool call that the runner intercepts. That's why handoffs compose perfectly with everything else (tools, guardrails, sessions).

### Real SDK shape

\`\`\`ts
import { Agent, run } from "@openai/agents";

const billing = new Agent({ name: "Billing", instructions: "Help with invoices, refunds, payment methods." });
const tech    = new Agent({ name: "Tech",    instructions: "Help with bugs, errors, integrations." });
const sales   = new Agent({ name: "Sales",   instructions: "Help with pricing, upgrades, demos." });

const triage = new Agent({
  name: "Triage",
  instructions:
    "You route the conversation to the right specialist. " +
    "Read the user's question and hand off to Billing, Tech, or Sales. " +
    "Do not try to answer yourself.",
  handoffs: [billing, tech, sales],
});

const result = await run(triage, "My latest invoice double-charged me.");
console.log(result.lastAgent.name, "→", result.finalOutput);  // "Billing → ..."
\`\`\`

Below we hand-roll the same pattern so you can see the transfer tool fire.`,
    },

    {
      id: "md-specialists", kind: "markdown",
      source: `## 1 · Define three specialist agents

Each one is the same \`Agent\` config from Notebook 1 — instructions + model + (optionally) tools. No special "specialist" type. Specialisation is just the instruction text.`,
    },
    {
      id: "specialists", kind: "code", language: "js", runtime: "browser",
      source: `const billing = {
  name: "Billing",
  instructions:
    "You are the Billing specialist. Handle invoices, refunds, payment methods, double-charges. " +
    "Be empathetic. End your reply with 'Filed a ticket for finance review.'",
  model: "google/gemini-3-flash-preview",
};

const tech = {
  name: "Tech",
  instructions:
    "You are the Technical Support specialist. Handle errors, bugs, API integration issues. " +
    "Ask for a reproduction step if not provided. Reply in plain text, no markdown.",
  model: "google/gemini-3-flash-preview",
};

const sales = {
  name: "Sales",
  instructions:
    "You are the Sales specialist. Handle pricing, plan upgrades, demos, discounts. " +
    "Always offer to schedule a 30-min discovery call.",
  model: "google/gemini-3-flash-preview",
};

ctx.state.specialists = { billing, tech, sales };
ctx.log("Specialists ready: Billing, Tech, Sales");
return Object.keys(ctx.state.specialists);
`,
    },

    {
      id: "md-triage", kind: "markdown",
      source: `## 2 · The Triage agent + the transfer tool pattern

We register one \`transfer_to_<Name>\` tool per specialist. The triage agent's job is purely to **pick one** by calling the matching tool. The runner detects that call and re-enters the loop with the chosen specialist.

> Notice that the user's full message gets passed forward — the specialist sees the original question, not a summary.`,
    },
    {
      id: "triage", kind: "code", language: "js", runtime: "browser",
      source: `const { specialists } = ctx.state;
const targets = [specialists.billing, specialists.tech, specialists.sales];

const transferTools = targets.map((agent) => ({
  type: "function",
  function: {
    name: \`transfer_to_\${agent.name}\`,
    description: \`Hand off the conversation to the \${agent.name} specialist agent.\`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
}));

const triage = {
  name: "Triage",
  instructions:
    "You route the conversation to the right specialist. " +
    "Read the user's question and call EXACTLY ONE of the transfer_to_* tools. " +
    "- transfer_to_Billing → invoices, refunds, payments, money problems. " +
    "- transfer_to_Tech → errors, bugs, API integration. " +
    "- transfer_to_Sales → pricing, upgrades, demos, discounts. " +
    "Never try to answer yourself.",
  model: "google/gemini-3-flash-preview",
};

async function runWithHandoffs(input) {
  const messages = [
    { role: "system", content: triage.instructions },
    { role: "user", content: input },
  ];

  ctx.log("→ Triage receives:", input);
  const r1 = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: triage.model, messages, tools: transferTools, tool_choice: "required" }),
  });
  const choice = (await r1.json()).choices[0].message;
  const transfer = choice.tool_calls?.[0]?.function?.name;
  if (!transfer?.startsWith("transfer_to_")) {
    return { agent: triage.name, output: choice.content };
  }
  const targetName = transfer.replace("transfer_to_", "");
  const target = targets.find((a) => a.name === targetName);
  ctx.log("🔀 HANDOFF →", targetName);

  // Re-enter the loop as the chosen specialist with the user's original message.
  const specMessages = [
    { role: "system", content: target.instructions },
    { role: "user", content: input },
  ];
  const r2 = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({ model: target.model, messages: specMessages }),
  });
  const finalOutput = (await r2.json()).choices[0].message.content;
  ctx.log("✓", targetName, "answered.");
  return { lastAgent: targetName, finalOutput };
}

// 👇 Try editing any of these — watch the triage route change.
const cases = [
  "My latest invoice double-charged me, can you refund the duplicate?",
  "I'm getting a 429 from your /v1/embeddings endpoint. What's the rate limit?",
  "We have 50 seats — can we get a discount on annual billing?",
];

const out = [];
for (const c of cases) {
  ctx.log("\\n========================================");
  const r = await runWithHandoffs(c);
  ctx.log("📨", r.lastAgent, "answer:\\n", r.finalOutput);
  out.push({ q: c, routedTo: r.lastAgent });
}
return out;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

- A **handoff** = a synthetic tool the model calls to give control to another agent.
- The triage pattern is just: *one routing agent + N specialists in \`handoffs\`*.
- The specialist gets the same conversation history — no information is lost.
- You can chain handoffs (Specialist → Sub-specialist) and even bounce back.

### Advanced handoff features you can layer in (real SDK)

| Feature | What it does |
| --- | --- |
| \`handoff(agent, { input_filter })\` | Strip or transform the messages the target agent receives (e.g. redact PII). |
| \`handoff(agent, { on_handoff })\` | Lifecycle hook — log, trace, or kick off side effects when a handoff fires. |
| \`handoff(agent, { input_type: z.object({...}) })\` | The triage model must produce structured arguments when handing off (e.g. "include the order_id"). |
| Recommended prompt prefix | The SDK ships \`RECOMMENDED_PROMPT_PREFIX\` you can prepend to specialists so they know they were handed off. |

These are all *extra knobs on the same synthetic tool call* — once you've internalised the basic transfer-tool pattern, the rest is configuration.`,
    },
  ],
};
