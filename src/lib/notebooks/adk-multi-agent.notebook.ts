import type { Notebook } from "./types";

export const adkMultiAgentNotebook: Notebook = {
  id: "adk-multi-agent",
  title: "Multi-Agent with sub_agents & transfer_to_agent",
  description:
    "ADK's multi-agent pattern: a root LlmAgent picks one of its named sub_agents to handle the user turn. We build a customer-support routing tree (billing / technical / refunds / human) and watch the model emit transfer decisions.",
  difficulty: "intermediate",
  tags: ["agent", "multi-agent", "routing"],
  subgroup: "Multi-Agent",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 5 · Multi-agent — *sub_agents + transfer_to_agent*

> **About the runtime.** Google ADK ships a real TypeScript SDK — [\`@google/adk\` on npm](https://www.npmjs.com/package/@google/adk), [official quickstart](https://adk.dev/get-started/typescript/). The package is Node-only and won't load in this in-browser sandbox. The cells below use an **API-identical shim**: \`new LlmAgent({ name, model, description, instruction, subAgents })\` and the synthetic \`transfer_to_agent\` tool call match \`@google/adk\` 1:1. Drop the same code into a Node project, run \`npm i @google/adk\`, change the import, and it runs unchanged.

The canonical ADK multi-agent shape is a **rooted tree**: one parent \`LlmAgent\` exposes its children via the \`sub_agents\` argument; the model picks which child should handle the next turn by emitting a special tool call called \`transfer_to_agent\`.

\`\`\`python
billing   = LlmAgent(name="billing",  description="Handles invoice and pricing questions.")
technical = LlmAgent(name="technical", description="Debugs product errors and integration issues.")
refunds   = LlmAgent(name="refunds",  description="Processes refund requests.")
human     = LlmAgent(name="human_escalation", description="Hands off to a human when the user is angry or the request is high-stakes.")

router = LlmAgent(
    name="support_root",
    model="gemini-2.5-flash",
    instruction="You are a customer support router. Read the user message, then transfer to the most "
                "relevant sub-agent. Never answer directly.",
    sub_agents=[billing, technical, refunds, human],
)
\`\`\`

Why this beats prompt-engineering one big agent:

| Property | One big agent | sub_agents tree |
| --- | --- | --- |
| Instructions length | Grows linearly with capabilities. | Each specialist has its own tight prompt. |
| Evaluations | Hard — every regression touches the whole prompt. | Per-agent test suite. |
| Cost | Always pays for the biggest prompt. | Router can be Flash-Lite; specialists pick per task. |
| Skills addition | Risky merge into the mega-prompt. | Add a new \`sub_agent\`. |

We'll re-implement the routing decision as a single \`transfer_to_agent\` tool call — this is exactly what ADK generates under the hood.`,
    },

    {
      id: "md-specialists",
      kind: "markdown",
      source: `## 1 · Build the specialists

Four \`LlmAgent\`s, each with a tight instruction and a clear \`description\`. The **description is the routing signal** — the router sees only the descriptions, not the instructions.`,
    },
    {
      id: "specialists",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

function llmAgent({ name, model, description, instruction }) {
  const llm = new ChatOpenAI({
    model, temperature: 0.3,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  });
  return {
    name, description, instruction,
    async run(userMessage) {
      const ai = await llm.invoke([new SystemMessage(instruction), new HumanMessage(userMessage)]);
      return ai.content;
    },
  };
}

const billing = llmAgent({
  name: "billing",
  model: "google/gemini-2.5-flash",
  description: "Handles invoice questions, plan upgrades, pricing tiers, and payment failures.",
  instruction:
    "You are the Billing specialist. Be concise and accurate. If the user asks for a refund, " +
    "say you'll route them to the Refunds team. Always close with the invoice/account #s involved.",
});

const technical = llmAgent({
  name: "technical",
  model: "google/gemini-2.5-flash",
  description: "Debugs product errors, integration issues, and 'why does X return Y' bugs.",
  instruction:
    "You are the Technical Support specialist. Ask for the exact error message and one repro step. " +
    "Suggest one specific debug action.",
});

const refunds = llmAgent({
  name: "refunds",
  model: "google/gemini-2.5-flash",
  description: "Processes refund requests, partial credits, and chargeback prevention.",
  instruction:
    "You are the Refunds specialist. Confirm the order ID and refund reason. State the refund policy " +
    "in one sentence and the next step.",
});

const human = llmAgent({
  name: "human_escalation",
  model: "google/gemini-2.5-flash",
  description:
    "Escalates to a human agent when the user is angry, legally aggressive, or the request is high-stakes " +
    "(loss of data, security incident, compliance question).",
  instruction:
    "You acknowledge that a human will follow up within 15 minutes. Keep it brief and empathetic. " +
    "Do NOT promise outcomes.",
});

ctx.state.specialists = { billing, technical, refunds, human };
ctx.log("Specialists ready:");
for (const a of Object.values(ctx.state.specialists)) ctx.log(\`  · \${a.name} — \${a.description}\`);
return Object.keys(ctx.state.specialists);
`,
    },

    {
      id: "md-router",
      kind: "markdown",
      source: `## 2 · The router — \`transfer_to_agent\` as a structured tool call

ADK's routing happens via a synthetic tool the framework injects:

\`\`\`python
# generated under the hood by the framework
transfer_to_agent(agent_name: Literal["billing", "technical", "refunds", "human_escalation"])
\`\`\`

We model the same shape with Zod structured output. One model call → one routing decision. This is intentionally **a cheap model (Flash-Lite is fine)** because the entire job is classification.

The router NEVER answers the user directly — it only picks a specialist. That's why its instruction prohibits direct answers.`,
    },
    {
      id: "router",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

const specialistList = Object.values(ctx.state.specialists);
const names = specialistList.map((a) => a.name);

const routerLlm = new ChatOpenAI({
  model: "google/gemini-2.5-flash-lite", // cheap classification
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(z.object({
  agent_name: z.enum(names),
  reason: z.string().describe("One short sentence explaining the routing decision."),
}));

const ROUTER_INSTRUCTION =
  "You are the customer support router. Read the user message, then call transfer_to_agent with the " +
  "agent_name of the most relevant sub-agent. NEVER answer the user directly.\\n\\n" +
  "Available sub-agents:\\n" +
  specialistList.map((a) => "  - " + a.name + ": " + a.description).join("\\n");

async function route(userMessage) {
  return await routerLlm.invoke([
    new SystemMessage(ROUTER_INSTRUCTION),
    new HumanMessage(userMessage),
  ]);
}

ctx.state.route = route;

// Quick probe.
const probe = await route("My invoice for last month is wrong — I was charged twice.");
ctx.log("Probe:", probe);
return probe;
`,
    },

    {
      id: "md-end-to-end",
      kind: "markdown",
      source: `## 3 · End-to-end: route → handoff → reply

The full flow per turn:

1. **Router** picks the specialist.
2. **Specialist** answers the user.
3. The orchestrator logs the **handoff decision** alongside the reply (this is what you'd push to your tracing system in production — ADK's eval tooling expects exactly this shape).

We run six diverse user messages so you can see the router fanning across all four specialists, including the tricky ones (angry user → human, "I want my money back" → refunds).`,
    },
    {
      id: "endToEnd",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const messages = [
  "My invoice last month shows $99 but I'm on the $49 plan. Help!",
  "I keep getting Error 502 when I call /v1/embeddings. What's going on?",
  "Please refund order #A-4421, it never arrived.",
  "This is the third time I'm asking. I want to speak to a human NOW.",
  "How do I upgrade to the Pro plan?",
  "Your API returns the wrong embedding dimension — I expected 1536 but got 768. Fix this!",
];

const trace = [];
for (const m of messages) {
  const decision = await ctx.state.route(m);
  const specialist = ctx.state.specialists[decision.agent_name];
  const reply = await specialist.run(m);
  trace.push({ user: m, agent: decision.agent_name, reason: decision.reason, reply });

  ctx.log("\\n──────────────────────────────");
  ctx.log("USER: " + m);
  ctx.log(\`ROUTER → \${decision.agent_name} (\${decision.reason})\`);
  ctx.log(\`[\${decision.agent_name}] \${String(reply).slice(0, 240)}\`);
}

return trace.map((t) => ({ user: t.user.slice(0, 40) + "…", routedTo: t.agent }));
`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## What you just built

A faithful re-implementation of ADK's multi-agent routing tree:

- **Specialists** with tight instructions and descriptive metadata.
- **A cheap router** doing pure classification via structured output.
- **\`transfer_to_agent\`** as a structured tool call — exactly the shape ADK generates.

### Production checklist (carries over to Python ADK)

- **Descriptions decide routing.** Treat them as code, not docs — version them, eval them.
- **Add a \`human_escalation\` agent early.** It's the safety valve when the router is unsure.
- **Don't let specialists hand off back to the router.** That creates loops. ADK's default tree is acyclic — keep it that way unless you have a specific reason.
- **Log every routing decision.** They're cheap, structured, and the most useful signal for improving prompts.

### Next

Notebook #6 — \`adk-callbacks-safety\` — wires up ADK's lifecycle callbacks (\`before_model_callback\`, \`before_tool_callback\`, \`after_model_callback\`) to add input filters, output filters, and a hard-stop budget guardrail.`,
    },
  ],
};
