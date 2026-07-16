import type { Notebook } from "./types";

export const adkLoopAgentNotebook: Notebook = {
  id: "adk-loop-agent",
  title: "LoopAgent & Shared State — Self-Critique Until It's Good",
  description:
    "ADK's LoopAgent runs a sub-agent (or sub-pipeline) repeatedly until an exit condition is met. We build the canonical generator → critic loop and use a shared state object — exactly like ADK's session.state — to escalate the prompt each iteration.",
  difficulty: "intermediate",
  tags: ["agent", "multi-agent", "evaluation"],
  subgroup: "Multi-Agent",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 4 · LoopAgent + shared state — *self-critique until it's good*

> **About the runtime.** Google ADK ships a real TypeScript SDK — [\`@google/adk\` on npm](https://www.npmjs.com/package/@google/adk), [official quickstart](https://adk.dev/get-started/typescript/). The package is Node-only and won't load in this in-browser sandbox. The cells below use an **API-identical shim**: \`new LoopAgent({ name, subAgents, maxIterations })\` and the shared \`session.state\` dict match \`@google/adk\` 1:1. Drop the same code into a Node project, run \`npm i @google/adk\`, change the import, and it runs unchanged.

\`\`\`python
from google.adk.agents import LoopAgent, SequentialAgent, LlmAgent

generator = LlmAgent(name="generator", instruction="Draft a product tagline.")
critic    = LlmAgent(name="critic",    instruction="Score the tagline 1-10. If <8 reply 'REVISE'. Else 'OK'.")

loop = LoopAgent(
    name="self_critique",
    sub_agents=[SequentialAgent(name="iter", sub_agents=[generator, critic])],
    max_iterations=4,
)
\`\`\`

Three things to internalise:

1. **\`LoopAgent\` doesn't decide what to do** — it just re-runs its sub-agent until a child sets an exit flag or \`max_iterations\` is hit.
2. **State is shared** through ADK's \`session.state\` dict. The generator writes its draft to \`state["draft"]\`; the critic reads it, writes a score, and sets \`state["done"] = True\` when satisfied.
3. **This is the pattern behind every "self-correcting" agent demo you've ever seen** — and the foundation of CodeAct, Reflexion, and the OpenAI o-series internal scratchpad.

We'll re-implement the loop, the session.state dict, and the exit flag in one cell.`,
    },

    {
      id: "md-state",
      kind: "markdown",
      source: `## 1 · Shared state — ADK's \`session.state\` as a dict

ADK's \`session.state\` is just a key/value store every sub-agent can read and write. We model it as a plain object on \`ctx.state.session\`.

Conventions worth keeping (they transfer verbatim to ADK):

- Prefix internal keys with \`_\` (e.g. \`_done\`) — ADK auto-filters those when serialising for evals.
- Append-only history goes under a list key (\`history\`), not by overwriting.
- The exit flag is a boolean any sub-agent can flip.`,
    },
    {
      id: "state",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Initialise session.state — every loop iteration starts here.
ctx.state.session = {
  topic: "an open-source TypeScript framework for building AI agent swarms",
  draft: null,        // generator writes here
  history: [],        // append-only log of [draft, criticNote, score]
  _done: false,       // critic flips when ready
  _iter: 0,           // bookkeeping
};
ctx.log("Initial session.state:", ctx.state.session);
return ctx.state.session;
`,
    },

    {
      id: "md-agents",
      kind: "markdown",
      source: `## 2 · The generator and the critic

Both are plain \`LlmAgent\`s. The trick: each one *reads from* and *writes to* the shared state, exactly the way ADK sub-agents do.

The critic is the interesting one. It returns structured output: a score and a verdict. When the score crosses the threshold it sets \`state._done = true\` — that's how it tells the \`LoopAgent\` to stop.`,
    },
    {
      id: "agents",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

const chat = (model, temp = 0.4) => new ChatOpenAI({
  model, temperature: temp,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

// === Generator ============================================================
async function generator(state) {
  const prior = state.history.length
    ? "PRIOR ATTEMPTS (improve, don't repeat):\\n" +
      state.history
        .map((h, i) => \`  Attempt \${i + 1}: "\${h.draft}" — critic: \${h.note}\`)
        .join("\\n")
    : "First attempt — no prior history.";

  const sys = "You write punchy product taglines. Output ONLY the tagline. 8 words max.";
  const user = "TOPIC: " + state.topic + "\\n\\n" + prior;
  const ai = await chat("google/gemini-2.5-flash", 0.7).invoke([
    new SystemMessage(sys), new HumanMessage(user),
  ]);
  state.draft = String(ai.content).replace(/^["']|["']$/g, "").trim();
  ctx.log(\`[iter \${state._iter + 1}] generator → "\${state.draft}"\`);
}

// === Critic — structured output, sets state._done =========================
const criticLlm = chat("google/gemini-2.5-flash", 0).withStructuredOutput(z.object({
  score: z.number().int().min(1).max(10).describe("1=garbage, 10=ship it"),
  note: z.string().describe("One short sentence."),
}));

async function critic(state) {
  const sys = "You are a senior brand strategist. Score the tagline 1-10 on punchiness, " +
    "memorability, and clarity. Threshold for ship is >= 8.";
  const user = \`TOPIC: \${state.topic}\\nTAGLINE: "\${state.draft}"\`;
  const out = await criticLlm.invoke([new SystemMessage(sys), new HumanMessage(user)]);
  state.history.push({ draft: state.draft, note: out.note, score: out.score });
  ctx.log(\`[iter \${state._iter + 1}] critic    → score \${out.score}/10 — \${out.note}\`);
  if (out.score >= 8) state._done = true;
}

ctx.state.generator = generator;
ctx.state.critic = critic;
ctx.log("Generator + critic ready.");
return { ready: true };
`,
    },

    {
      id: "md-loop",
      kind: "markdown",
      source: `## 3 · The LoopAgent

The loop is mechanical: run the inner pipeline, check the exit flag, stop when set or when the iteration cap is hit. Reading ADK's \`google/adk/agents/loop_agent.py\`, this is essentially the production implementation.

What you'll see:

- **Iteration 1** usually gets a 5-7. The critic explains why.
- **Iteration 2** is dramatically better — the generator now sees the critic's note in \`PRIOR ATTEMPTS\` and rewrites to address it.
- **By iteration 3 or 4** the score is usually ≥ 8 and the loop terminates early.`,
    },
    {
      id: "loop",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `async function LoopAgent({ name, subAgents, maxIterations }, state) {
  for (let i = 0; i < maxIterations; i++) {
    state._iter = i;
    for (const child of subAgents) {
      await child(state);
      if (state._done) {
        ctx.log(\`[\${name}] exit flag set after iteration \${i + 1}\`);
        return state;
      }
    }
  }
  ctx.log(\`[\${name}] hit maxIterations=\${maxIterations} without exit flag\`);
  return state;
}

// SequentialAgent(generator, critic) as the inner step — exactly mirrors the
// Python snippet at the top of the notebook.
const innerStep = async (s) => {
  await ctx.state.generator(s);
  await ctx.state.critic(s);
};

const result = await LoopAgent(
  { name: "self_critique", subAgents: [innerStep], maxIterations: 4 },
  ctx.state.session,
);

ctx.log("\\n══════════════════════════════");
ctx.log("FINAL DRAFT: " + result.draft);
ctx.log("FINAL SCORE: " + result.history[result.history.length - 1].score + "/10");
ctx.log("ITERATIONS:  " + result.history.length);
return result.history;
`,
    },

    {
      id: "md-experiment",
      kind: "markdown",
      source: `## 4 · Experiment: what happens if you raise the bar?

Edit \`state.topic\` to something harder or change the critic's threshold to \`9\` (in the previous cell). You'll see:

- The loop runs to \`maxIterations\` and the score plateaus around 7-8. This is the **critic ceiling** — at some point the model can't tell the difference between an 8 and a 9.
- Run a second loop with a *different model* as critic. The ceiling moves.

This is exactly the lesson behind ADK's evaluation guidance: **use a stronger model as judge than as generator**, and never set the bar above what the judge can reliably distinguish.`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## What you just built

A faithful port of \`LoopAgent\` + \`session.state\` — the trio of primitives behind every "self-correcting agent" pattern shipping today:

- **\`LoopAgent\`** — bounded retry with an exit flag.
- **Shared state** — sub-agents read each other's outputs without prompt threading.
- **Structured critic** — the score is enforced by schema, not "the model said so".

### Production tips that transfer 1:1

- Cap \`max_iterations\` low (3-5). The 4th attempt rarely beats the 3rd.
- Include the **critic's note** in the prior-attempts context, not the previous draft alone. The model learns from feedback, not from its own past output.
- Use a **different and stronger model** as the critic. A weaker critic is a noise generator.

### Next

Notebook #5 introduces ADK's **\`sub_agents\` + \`transfer_to_agent\`** pattern — multi-agent routing where one agent decides which other agent should handle the next turn.`,
    },
  ],
};
