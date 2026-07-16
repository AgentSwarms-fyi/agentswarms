import type { Notebook } from "./types";

export const adkWorkflowAgentsNotebook: Notebook = {
  id: "adk-workflow-agents",
  title: "Workflow Agents — Sequential & Parallel",
  description:
    "ADK ships pure-orchestration agents that don't call an LLM themselves — SequentialAgent runs children in order, ParallelAgent fans them out. Build a writer → editor pipeline and a multi-critic review board, then measure the speed-up.",
  difficulty: "intermediate",
  tags: ["agent", "multi-agent"],
  subgroup: "Multi-Agent",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 3 · Workflow Agents — *Sequential & Parallel*

> **About the runtime.** Google ADK ships a real TypeScript SDK — [\`@google/adk\` on npm](https://www.npmjs.com/package/@google/adk), [official quickstart](https://adk.dev/get-started/typescript/). The package is Node-only and won't load in this in-browser sandbox. The cells below use an **API-identical shim**: \`new SequentialAgent({ name, subAgents })\` and \`new ParallelAgent({ name, subAgents })\` match \`@google/adk\` 1:1. Drop the same code into a Node project, run \`npm i @google/adk\`, change the import, and it runs unchanged.

Real ADK pipelines almost never have just one \`LlmAgent\`. The standard library ships **workflow agents** that compose other agents on a fixed control-flow graph:

| Workflow agent | What it does | Best for |
| --- | --- | --- |
| \`SequentialAgent(sub_agents=[a, b, c])\` | Runs \`a\`, feeds output to \`b\`, then to \`c\`. | Pipelines: draft → edit → fact-check. |
| \`ParallelAgent(sub_agents=[a, b, c])\` | Runs all three concurrently on the *same* input. | Multi-judge review, multi-search fan-out. |
| \`LoopAgent(sub_agents=[a], max_iterations=5)\` | Runs \`a\` repeatedly until an exit condition. | Self-critique, retry-until-valid. |

Notice these workflow agents have **no LLM and no instruction**. They're orchestration only. That separation — *agent shape* vs. *control flow* — is one of ADK's strongest design choices.

\`\`\`python
# canonical ADK Python
from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent

writer  = LlmAgent(name="writer",  model="gemini-2.5-flash", instruction="Write a 2-sentence headline.")
editor  = LlmAgent(name="editor",  model="gemini-2.5-flash", instruction="Tighten the headline. Make it punchier.")
pipeline = SequentialAgent(name="headline_pipeline", sub_agents=[writer, editor])
\`\`\`

We'll build both the SequentialAgent and the ParallelAgent in this notebook. \`LoopAgent\` is the focus of notebook #4.`,
    },

    {
      id: "md-sequential",
      kind: "markdown",
      source: `## 1 · SequentialAgent — writer → editor → fact-checker

A 3-stage pipeline. Each stage is a real \`LlmAgent\`; the workflow is just a function that pipes outputs.

Two production wins this pattern unlocks:

- **Different models per stage.** Use a smart model to draft, a cheap model to compress, a strong model to fact-check.
- **Separable evals.** You can A/B test the editor without touching the writer's prompt — exactly how ADK encourages you to ship.`,
    },
    {
      id: "sequential",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

function llmAgent({ name, model, instruction }) {
  const llm = new ChatOpenAI({
    model, temperature: 0.4,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  });
  return {
    name,
    async run(input) {
      const ai = await llm.invoke([new SystemMessage(instruction), new HumanMessage(input)]);
      return ai.content;
    },
  };
}

function SequentialAgent({ name, subAgents }) {
  return {
    name,
    async run(input) {
      let current = input;
      const trace = [{ stage: "input", text: current }];
      for (const child of subAgents) {
        const t0 = Date.now();
        current = await child.run(current);
        trace.push({ stage: child.name, text: current, ms: Date.now() - t0 });
        ctx.log(\`[\${child.name}] (\${Date.now() - t0}ms):\\n  \${String(current).slice(0, 200)}\\n\`);
      }
      return { output: current, trace };
    },
  };
}

const writer = llmAgent({
  name: "writer",
  model: "google/gemini-2.5-flash",
  instruction:
    "You write rough draft headlines for tech news articles. Given a topic, write ONE 2-sentence headline+subhead. Be neutral.",
});

const editor = llmAgent({
  name: "editor",
  model: "google/gemini-2.5-flash",
  instruction:
    "You are a ruthless newsroom editor. Rewrite the headline+subhead so the headline is under 80 chars, " +
    "active voice, and the subhead adds new info (no restating). Reply with ONLY the edited version.",
});

const factChecker = llmAgent({
  name: "fact_checker",
  model: "google/gemini-2.5-flash",
  instruction:
    "You are a careful fact-checker. Read the headline+subhead and add a one-line 'Risk:' note flagging any " +
    "claim that would need verification before publishing. Keep the headline as-is, append the Risk line.",
});

const pipeline = SequentialAgent({ name: "headline_pipeline", subAgents: [writer, editor, factChecker] });
ctx.state.pipeline = pipeline;

const result = await pipeline.run("Anthropic releases Claude 4.5 with a 1M-token context window.");
ctx.log("\\nFINAL:\\n" + result.output);
return result.trace.map((s) => ({ stage: s.stage, preview: String(s.text).slice(0, 120) }));
`,
    },

    {
      id: "md-parallel",
      kind: "markdown",
      source: `## 2 · ParallelAgent — three critics, one fan-out

For tasks where multiple specialists evaluate the *same* input, sequential is wasteful. ADK's \`ParallelAgent\` runs sub-agents concurrently and aggregates their outputs.

We'll build a **multi-critic review board** for the headline pipeline above:

- **Legal Critic** — flags anything that could be defamatory or unverified.
- **SEO Critic** — checks the headline for keywords and length.
- **Tone Critic** — flags clickbait, hype, or off-brand language.

The orchestrator gathers all three reviews and produces a verdict.`,
    },
    {
      id: "parallel",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

function llmAgent({ name, model, instruction }) {
  const llm = new ChatOpenAI({
    model, temperature: 0.2,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  });
  return {
    name,
    async run(input) {
      const ai = await llm.invoke([new SystemMessage(instruction), new HumanMessage(input)]);
      return ai.content;
    },
  };
}

function ParallelAgent({ name, subAgents }) {
  return {
    name,
    async run(input) {
      const t0 = Date.now();
      const results = await Promise.all(
        subAgents.map(async (a) => {
          const ts = Date.now();
          const out = await a.run(input);
          return { name: a.name, output: out, ms: Date.now() - ts };
        }),
      );
      return { totalMs: Date.now() - t0, results };
    },
  };
}

const legal = llmAgent({
  name: "legal_critic",
  model: "google/gemini-2.5-flash",
  instruction: "You are a media lawyer. Reply in ONE line starting 'LEGAL:'. Flag defamation, " +
    "unverified claims, or trademark issues. If clean, reply 'LEGAL: OK.'",
});
const seo = llmAgent({
  name: "seo_critic",
  model: "google/gemini-2.5-flash",
  instruction: "You are an SEO editor. Reply in ONE line starting 'SEO:'. Score the headline 1-10 on " +
    "search intent + keyword density, then a one-clause justification.",
});
const tone = llmAgent({
  name: "tone_critic",
  model: "google/gemini-2.5-flash",
  instruction: "You are a brand editor at a serious tech publication. Reply in ONE line starting 'TONE:'. " +
    "Flag clickbait, hype, or off-brand wording. If acceptable, reply 'TONE: OK.'",
});

const reviewBoard = ParallelAgent({ name: "review_board", subAgents: [legal, seo, tone] });

const headline =
  "Anthropic releases Claude 4.5 with a 1M-token context window. Risk: vendor-reported context length not yet independently benchmarked.";

ctx.log("Running 3 critics in parallel...\\n");
const result = await reviewBoard.run(headline);

for (const r of result.results) {
  ctx.log(\`[\${r.name}] (\${r.ms}ms) \${r.output}\`);
}
ctx.log(\`\\nTotal wall time: \${result.totalMs}ms (vs sum-of-children \${result.results.reduce((s, r) => s + r.ms, 0)}ms)\`);
return { wallMs: result.totalMs, sumChildrenMs: result.results.reduce((s, r) => s + r.ms, 0) };
`,
    },

    {
      id: "md-compose",
      kind: "markdown",
      source: `## 3 · Compose them — pipeline + review board

Workflow agents are themselves agents, so they nest. Here we build:

\`\`\`text
SequentialAgent(
  writer,
  editor,
  fact_checker,
  ParallelAgent(legal_critic, seo_critic, tone_critic),  ← runs all three on the fact-checked draft
  llm_summarizer                                          ← reads the three reviews and verdicts
)
\`\`\`

This is the moment "agents" stops being a marketing word and starts being a *programming model*.`,
    },
    {
      id: "compose",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

function llmAgent({ name, model, instruction }) {
  const llm = new ChatOpenAI({
    model, temperature: 0.3,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  });
  return {
    name,
    async run(input) {
      const ai = await llm.invoke([new SystemMessage(instruction), new HumanMessage(input)]);
      return ai.content;
    },
  };
}
function SequentialAgent({ name, subAgents }) {
  return {
    name,
    async run(input) {
      let cur = input;
      for (const child of subAgents) cur = await child.run(cur);
      return cur;
    },
  };
}
function ParallelAgent({ name, subAgents }) {
  return {
    name,
    async run(input) {
      const r = await Promise.all(subAgents.map((a) => a.run(input)));
      // ParallelAgent in ADK returns a list — we serialise so the next stage can read it.
      return r.join("\\n");
    },
  };
}

// Re-use the agents defined above. We'll declare them again here so the cell is standalone.
const writer = llmAgent({ name: "writer", model: "google/gemini-2.5-flash",
  instruction: "Write ONE 2-sentence headline+subhead for a tech news article. Neutral tone." });
const editor = llmAgent({ name: "editor", model: "google/gemini-2.5-flash",
  instruction: "Rewrite for clarity, under 80 chars headline, active voice. Reply ONLY with the rewrite." });
const factChecker = llmAgent({ name: "fact_checker", model: "google/gemini-2.5-flash",
  instruction: "Append one 'Risk:' line flagging unverified claims. Keep headline. Nothing else." });

const legal = llmAgent({ name: "legal", model: "google/gemini-2.5-flash",
  instruction: "Reply 'LEGAL: ...' one line." });
const seo = llmAgent({ name: "seo", model: "google/gemini-2.5-flash",
  instruction: "Reply 'SEO: ...' one line with a 1-10 score." });
const tone = llmAgent({ name: "tone", model: "google/gemini-2.5-flash",
  instruction: "Reply 'TONE: ...' one line." });
const board = ParallelAgent({ name: "review_board", subAgents: [legal, seo, tone] });

const summarizer = llmAgent({ name: "summarizer", model: "google/gemini-2.5-flash",
  instruction: "You receive three critic notes (LEGAL, SEO, TONE). Reply with a SHIP / REVISE verdict " +
    "and one sentence of actionable feedback." });

const full = SequentialAgent({
  name: "full_pipeline",
  subAgents: [writer, editor, factChecker, board, summarizer],
});

const t0 = Date.now();
const out = await full.run("Google ships ADK 2.0 with native MCP and multi-agent eval.");
ctx.log("\\nFINAL VERDICT:\\n" + out);
ctx.log(\`\\nTotal pipeline time: \${Date.now() - t0}ms\`);
return { output: out };
`,
    },

    {
      id: "outro",
      kind: "markdown",
      source: `## What you just built

A nested workflow agent — sequential pipeline with a parallel review board in the middle — using ADK's two foundational workflow primitives.

### Why this pattern wins in production

- **Latency stays bounded** even as you add more critics: the \`ParallelAgent\` is governed by the slowest sub-agent, not the sum.
- **Each agent is independently testable.** Run \`editor\` on a fixture suite; the rest of the pipeline doesn't matter.
- **Model choice becomes a per-stage decision.** Run the writer on Pro, the critics on Flash-Lite, the summarizer on Flash.

### Next

Notebook #4 — \`adk-loop-agent\` — adds the third workflow primitive, **\`LoopAgent\`**, and shows the canonical self-critique pattern: keep regenerating until a checker agent says "ok".`,
    },
  ],
};
