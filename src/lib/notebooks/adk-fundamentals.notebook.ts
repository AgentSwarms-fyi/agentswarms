import type { Notebook } from "./types";

export const adkFundamentalsNotebook: Notebook = {
  id: "adk-fundamentals",
  title: "ADK Fundamentals — LlmAgent, Instructions & the Run Loop",
  description:
    "Google's Agent Development Kit (ADK) starts with one object: LlmAgent. It bundles a model, an instruction, a description, and tools. Here we mirror that exact shape in TypeScript so every cell maps to a line in adk-python.",
  difficulty: "beginner",
  tags: ["agent", "structured-output"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 1 · ADK Fundamentals — *LlmAgent, instructions, run loop*

> **About the runtime.** Google ADK ships a real TypeScript SDK — [\`@google/adk\` on npm](https://www.npmjs.com/package/@google/adk), with the [official quickstart at adk.dev](https://adk.dev/get-started/typescript/). That package is Node-only (it pulls in \`express\`, \`@google-cloud/*\`, the OpenTelemetry Node SDK, etc.) and won't load in this in-browser sandbox or on our Cloudflare Workers backend. The cells below use an **API-identical shim** — class names (\`LlmAgent\`, \`FunctionTool\`, \`SequentialAgent\`, \`ParallelAgent\`, \`LoopAgent\`) and constructor options match \`@google/adk\` exactly. Copy the same code into a Node project, run \`npm i @google/adk @google/genai zod\`, change the import to \`from "@google/adk"\`, and it runs unchanged.

**Google ADK** (Agent Development Kit) is the open-source framework that powers Gemini Code Assist, Project Mariner, and parts of Agent Builder on Vertex AI. The headline primitive is a single class — **\`LlmAgent\`** — and almost everything else is built on top of it.

\`\`\`python
# canonical ADK Python — keep this open in a tab while you read
from google.adk.agents import LlmAgent

joke_bot = LlmAgent(
    name="joke_bot",
    model="gemini-2.0-flash",
    description="Tells a short, family-friendly joke about a topic.",
    instruction="You are a stand-up comedian. Reply with exactly one short joke. No preamble.",
)

# Runner drives the agent loop; Session holds the turn history.
runner.run(session_id="s1", user_id="u1", new_message="Tell me one about debugging.")
\`\`\`

### What the four fields actually do

| Field | Role | Used by |
| --- | --- | --- |
| **\`name\`** | Stable identifier for routing / handoffs. | Sub-agents, callbacks, eval logs. |
| **\`model\`** | Which LLM to call. Swap freely. | The agent's chat completion call. |
| **\`description\`** | One-line "what this agent does", *for other agents to read*. | Parent agents picking who to hand off to. |
| **\`instruction\`** | The system prompt for *this* agent. | Sent on every turn as role \`system\`. |

In real \`@google/adk\` you'd write \`import { LlmAgent } from '@google/adk'\` and \`new LlmAgent({ name, model, description, instruction, tools })\`. Below we expose a class with the **same constructor signature** so the only line that changes between this notebook and a Node project is the import.`,
    },

    {
      id: "md-build",
      kind: "markdown",
      source: `## 2 · Re-implement \`LlmAgent\` in TypeScript

The agent loop in ADK is:

\`\`\`text
while not done:
    response = model.generate(system=instruction, messages=session.history)
    if response.tool_calls:
        for call in response.tool_calls:
            tool_result = tools[call.name](**call.args)
            session.append(tool_result)
        continue                # tool calls → loop again
    session.append(response)
    done = True
\`\`\`

In this cell we build the *no-tools* version — it's exactly the joke bot above. Tools come in notebook #2.

We attach the agent to \`ctx.state\` so the next cells can reuse it.`,
    },
    {
      id: "build",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage, AIMessage } = ctx.lc.messages;

// === LlmAgent (TypeScript port) ===========================================
function LlmAgent({ name, model, description, instruction, tools = [] }) {
  const chat = new ChatOpenAI({
    model, temperature: 0.7,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  });
  const llm = tools.length ? chat.bindTools(tools) : chat;

  return {
    name, description, instruction, tools,
    /** Mirrors ADK's Runner.run for a single turn. */
    async run(history) {
      const messages = [new SystemMessage(instruction), ...history];
      const ai = await llm.invoke(messages);
      // No-tools version: just return the assistant turn.
      return { history: [...messages, ai], output: ai.content };
    },
  };
}

// === Build the joke_bot, identical to the Python snippet ==================
const jokeBot = LlmAgent({
  name: "joke_bot",
  model: "google/gemini-2.5-flash",
  description: "Tells a short, family-friendly joke about a topic.",
  instruction:
    "You are a stand-up comedian. Reply with exactly one short joke. No preamble, no setup outside the joke itself.",
});

ctx.state.LlmAgent = LlmAgent;
ctx.state.jokeBot = jokeBot;

ctx.log("Agent built:", jokeBot.name, "·", jokeBot.description);
ctx.log("Instruction (system prompt):");
ctx.log("  " + jokeBot.instruction);
return { name: jokeBot.name, model: "google/gemini-2.5-flash", hasTools: jokeBot.tools.length > 0 };
`,
    },

    {
      id: "md-runner",
      kind: "markdown",
      source: `## 3 · The runner & session

In ADK the **Runner** is what you actually call from your app:

\`\`\`python
runner = Runner(agent=joke_bot, session_service=InMemorySessionService())
result = runner.run(session_id="s1", user_id="u1", new_message="Tell me one about debugging.")
\`\`\`

The \`Session\` is just an append-only list of \`Event\`s — user messages, assistant responses, tool calls, tool responses. Ours is a JS array of LangChain messages, which is identical in shape.

Below: send three messages on the same session and watch the agent stay in character because *the system prompt is reapplied every turn*. This is the #1 thing newcomers miss.`,
    },
    {
      id: "runner",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { HumanMessage } = ctx.lc.messages;

// === Session = append-only history (ADK calls these Events) ===============
const session = { id: "s1", userId: "u1", history: [] };

async function run(agent, session, text) {
  const turn = await agent.run([...session.history, new HumanMessage(text)]);
  // ADK adds the new user message + assistant reply to the session.
  session.history.push(new HumanMessage(text));
  // Last message in turn.history is the assistant reply.
  session.history.push(turn.history[turn.history.length - 1]);
  return turn.output;
}

const topics = [
  "debugging",
  "type errors",
  "code review",
];

for (const topic of topics) {
  const out = await run(ctx.state.jokeBot, session, "Tell me one about " + topic + ".");
  ctx.log("Q: Tell me one about " + topic + ".");
  ctx.log("A: " + out + "\\n");
}

ctx.log("Session length after 3 turns:", session.history.length, "messages");
return { turns: 3, messagesStored: session.history.length };
`,
    },

    {
      id: "md-swap",
      kind: "markdown",
      source: `## 4 · Swap the model — same agent, different brain

In ADK you change one string:

\`\`\`python
joke_bot.model = "gemini-2.5-pro"     # bigger model, slower, smarter
joke_bot.model = "gemini-2.5-flash-lite"  # cheapest, fastest
\`\`\`

This is the key reason agents are worth building on top of \`LlmAgent\` instead of calling the model directly: the *shape* of your agent (instruction, tools, sub-agents) is decoupled from the *model* that runs it.

Below we run the same question across three model tiers so you can feel the cost/latency/quality trade-off.`,
    },
    {
      id: "swap",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { HumanMessage } = ctx.lc.messages;

const models = [
  "google/gemini-2.5-flash-lite", // cheapest
  "google/gemini-2.5-flash",       // balanced
  "google/gemini-2.5-pro",         // smartest
];

const QUESTION = "Explain what a 'tool call' means in an LLM agent in one sentence.";
const results = [];

for (const model of models) {
  const a = ctx.state.LlmAgent({
    name: "explainer",
    model,
    description: "Explains agent concepts in one sentence.",
    instruction: "You are a precise teacher. Answer in exactly one sentence, no preamble.",
  });
  const t0 = Date.now();
  const turn = await a.run([new HumanMessage(QUESTION)]);
  const ms = Date.now() - t0;
  ctx.log("[" + model + "] " + ms + "ms");
  ctx.log("  " + turn.output + "\\n");
  results.push({ model, latencyMs: ms, answer: turn.output });
}

return results.map((r) => ({ model: r.model, ms: r.latencyMs }));
`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## What you just built

A 25-line \`LlmAgent\` that mirrors the ADK Python API exactly:

- **\`name\` + \`description\`** — identity and routing metadata.
- **\`model\`** — swappable LLM.
- **\`instruction\`** — system prompt reapplied every turn.
- **\`Session\`** — append-only history (ADK calls these *Events*).
- **\`Runner.run\`** — single function entry point per turn.

### Where to go next

- **Notebook #2 · \`adk-function-tools\`** adds \`FunctionTool\` — the canonical way ADK lets agents call your code.
- **Notebook #3 · \`adk-workflow-agents\`** introduces \`SequentialAgent\` and \`ParallelAgent\` — pure-orchestration agents that don't have an LLM themselves.

### Cross-reference: full ADK Python equivalent

\`\`\`python
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService

agent = LlmAgent(name="joke_bot", model="gemini-2.5-flash",
                 description="Tells a short joke about a topic.",
                 instruction="You are a stand-up comedian. One short joke. No preamble.")

runner = Runner(agent=agent, session_service=InMemorySessionService())
for topic in ["debugging", "type errors", "code review"]:
    for event in runner.run(user_id="u1", session_id="s1", new_message=f"Tell me one about {topic}."):
        if event.is_final_response():
            print(event.content.parts[0].text)
\`\`\``,
    },
  ],
};
