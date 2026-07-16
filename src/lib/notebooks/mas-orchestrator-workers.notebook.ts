import type { Notebook } from "./types";

export const masOrchestratorWorkersNotebook: Notebook = {
  id: "mas-orchestrator-workers",
  title: "The Orchestrator & Workers Pattern",
  description:
    "A lead Orchestrator splits a complex task into independent subtasks, fans them out to multiple Worker agents in parallel using LangGraph's Send API, and a Synthesizer composes the final answer from all worker outputs.",
  difficulty: "advanced",
  tags: ["langgraph", "multi-agent", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Orchestrator & Workers

\`\`\`
                       ┌──────────────┐
                       │ Orchestrator │
                       └──────┬───────┘
                              │  Send([t1, t2, t3])
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         ┌────────┐      ┌────────┐      ┌────────┐
         │ Worker │      │ Worker │      │ Worker │   (parallel)
         └────┬───┘      └────┬───┘      └────┬───┘
              └───────────────┼───────────────┘
                              ▼
                       ┌──────────────┐
                       │ Synthesizer  │
                       └──────┬───────┘
                              ▼
                             END
\`\`\`

This is the canonical "research-and-write" pattern. The Orchestrator never produces the final answer — it just decides what subtasks need to be done. Each Worker runs **in parallel** (real concurrency, real wall-clock savings on slow LLM calls), and the Synthesizer composes their outputs into one coherent response.

In LangGraph the magic is the **\`Send\`** API: when a conditional edge returns an array of \`Send\` objects, the runtime spawns one node invocation per Send, each with its own slice of state. The state reducer then merges results back as each worker finishes.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · State with a merging reducer\n\nThe \`reports\` field uses a concatenating reducer — every Worker appends its report independently and LangGraph merges them safely. This is the only field that has to be array-merge; \`subtasks\` is set once by the Orchestrator and never written again.` },
    {
      id: "state", kind: "code", language: "js", runtime: "browser",
      source: `const { Annotation } = ctx.lc.langgraph;

const ResearchState = Annotation.Root({
  topic:     Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  subtasks:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => [] }),
  reports:   Annotation({ reducer: (a, b) => [...(a ?? []), ...(b ?? [])], default: () => [] }),
  final:     Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
});

ctx.state.ResearchState = ResearchState;
return { fields: Object.keys(ResearchState.spec) };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · The Orchestrator\n\nThe Orchestrator's only job is to read the topic and produce a list of 3 distinct angles for parallel research. We force structured output so we can iterate over the result deterministically.` },
    {
      id: "orchestrator", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.4,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const Subtasks = z.object({
  subtasks: z.array(z.object({
    angle: z.string().describe("Short angle name, e.g. 'historical context'."),
    question: z.string().describe("Concrete question the worker should answer."),
  })).length(3),
});

async function orchestratorNode(state) {
  const out = await llm.withStructuredOutput(Subtasks).invoke([
    new SystemMessage("Break the topic into EXACTLY 3 non-overlapping research angles. Each must be independent — a worker should be able to answer it without seeing the others."),
    new HumanMessage("Topic: " + state.topic),
  ]);
  ctx.log("🧭 orchestrator produced " + out.subtasks.length + " subtasks");
  for (const s of out.subtasks) ctx.log("   • " + s.angle + " — " + s.question);
  return { subtasks: out.subtasks };
}

ctx.state.orchestratorNode = orchestratorNode;
return { ok: true };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · The Worker (one invocation per subtask)\n\nEach worker receives state shaped \`{ angle, question }\` — that's what the orchestrator's \`Send\` will inject. The worker writes one short report and appends it to the shared \`reports\` array.` },
    {
      id: "worker", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

const workerLLM = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.3,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

// Worker signature receives the slice of state attached to its Send.
async function workerNode(slice) {
  const start = Date.now();
  const res = await workerLLM.invoke([
    new SystemMessage("You are a research worker. Write a tight 4-sentence briefing answering the question. Stay strictly within the named angle."),
    new HumanMessage("Angle: " + slice.angle + "\\nQuestion: " + slice.question),
  ]);
  ctx.log("⚡ worker '" + slice.angle + "' finished in " + (Date.now() - start) + "ms");
  return { reports: [{ angle: slice.angle, content: String(res.content) }] };
}

ctx.state.workerNode = workerNode;
return { ok: true };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · The Synthesizer\n\nAfter every worker has returned, the Synthesizer sees \`state.reports\` populated with all 3 briefings and weaves them into one essay.` },
    {
      id: "synth", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

const synthLLM = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.4,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

async function synthesizerNode(state) {
  const bundled = state.reports
    .map((r, i) => "## Briefing " + (i + 1) + " — " + r.angle + "\\n" + r.content)
    .join("\\n\\n");

  const res = await synthLLM.invoke([
    new SystemMessage("You are a senior editor. Weave the three worker briefings below into ONE coherent essay (≈250 words) about the topic. Keep the angles distinct in the structure. Do not invent facts beyond the briefings."),
    new HumanMessage("Topic: " + state.topic + "\\n\\n" + bundled),
  ]);
  return { final: String(res.content) };
}

ctx.state.synthesizerNode = synthesizerNode;
return { ok: true };
`,
    },

    { id: "md-5", kind: "markdown", source: `## 5 · Wire the fan-out with \`Send\`\n\nThe conditional edge \`orchestrator → ?\` returns an **array** of \`Send\` objects — one per subtask. LangGraph fans them out in parallel, runs each worker concurrently, and waits for all of them before continuing to the synthesizer.` },
    {
      id: "graph", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, START, END, Send } = ctx.lc.langgraph;

const fanOut = (state) =>
  state.subtasks.map((s) => new Send("worker", { angle: s.angle, question: s.question }));

const graph = new StateGraph(ctx.state.ResearchState)
  .addNode("orchestrator", ctx.state.orchestratorNode)
  .addNode("worker",       ctx.state.workerNode)
  .addNode("synthesizer",  ctx.state.synthesizerNode)
  .addEdge(START, "orchestrator")
  .addConditionalEdges("orchestrator", fanOut, ["worker"])
  .addEdge("worker", "synthesizer")
  .addEdge("synthesizer", END)
  .compile();

// 👇 Try a topic that benefits from multi-angle research
const TOPIC = "Why did the Concorde supersonic airliner fail commercially?";

const wallStart = Date.now();
const result = await graph.invoke({ topic: TOPIC });
const wallMs = Date.now() - wallStart;

return {
  topic: TOPIC,
  total_wall_ms: wallMs,
  subtasks: result.subtasks.map((s) => s.angle),
  reports_collected: result.reports.length,
  final_essay: result.final,
};
`,
    },

    { id: "md-6", kind: "markdown", source: `**Things to try:**\n\n- Compare wall-clock time to a sequential version: replace the fan-out with three \`.addEdge(...)\` chains and watch the runtime ≈ triple. Parallelism via \`Send\` is the whole point of this pattern.\n- Bump the \`.length(3)\` constraint to \`.min(2).max(6)\` and let the Orchestrator decide how many angles a topic deserves. Big topics get 6 workers, narrow ones get 2.\n- Add a **critic** node between worker and synthesizer that rejects shallow reports and loops bad ones back to a fresh worker via another \`Send\`. That's the production "research swarm" architecture.` },
  ],
};
