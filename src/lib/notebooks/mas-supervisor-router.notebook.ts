import type { Notebook } from "./types";

export const masSupervisorRouterNotebook: Notebook = {
  id: "mas-supervisor-router",
  title: "Multi-Agent Supervisor Router",
  description:
    "A Lead Orchestrator routes each incoming task to either the Math Specialist or the Creative Writer. Throw ambiguous prompts at it and rewrite the Orchestrator's system prompt to force better delegation.",
  difficulty: "intermediate",
  tags: ["langgraph", "multi-agent", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Supervisor Router

\`\`\`
                  ┌──────────────┐
                  │  Supervisor  │
                  └──┬────────┬──┘
            "math" ▼          ▼ "writer"
              ┌────────┐  ┌─────────┐
              │  Math  │  │ Writer  │
              └────┬───┘  └────┬────┘
                   └────┬──────┘
                        ▼
                       END
\`\`\`

The **Supervisor** is the only agent that sees the user prompt. It returns a single token — \`math\` or \`writer\` — and a conditional edge fans out to the matching specialist. Each specialist responds and the graph ends.

This is the smallest useful "team of agents" pattern. Production supervisors do the same thing, just with more specialists and often a loop back through the supervisor after each turn.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · State\n\nWe carry the user request, the routing decision, and the specialist's answer.` },
    {
      id: "state", kind: "code", language: "js", runtime: "browser",
      source: `const { Annotation } = ctx.lc.langgraph;

const RouterState = Annotation.Root({
  request: Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  route:   Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
  answer:  Annotation({ reducer: (_a, b) => b ?? _a, default: () => "" }),
});

ctx.state.RouterState = RouterState;
return { fields: Object.keys(RouterState.spec) };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · The Supervisor node\n\nWe use \`withStructuredOutput\` so the LLM is forced to return one of exactly two strings. No prose, no maybes. If structured output ever returns something off-spec, the graph would crash — which is the desired behaviour for a routing decision.` },
    {
      id: "supervisor", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

// 👇 EDIT THIS — the most important prompt in the whole graph.
const SUPERVISOR_PROMPT = \`You are a routing supervisor. You manage two specialists:
- "math": handles arithmetic, equations, word problems, units, statistics.
- "writer": handles stories, poems, marketing copy, taglines, rewriting.
Pick the single best route for the user's request.\`;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const Decision = z.object({ route: z.enum(["math", "writer"]) });

async function supervisorNode(state) {
  const out = await llm.withStructuredOutput(Decision).invoke([
    new SystemMessage(SUPERVISOR_PROMPT),
    new HumanMessage(state.request),
  ]);
  ctx.log("🧭 routed to:", out.route);
  return { route: out.route };
}

ctx.state.supervisorNode = supervisorNode;
return { ok: true };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · The two specialists\n\nDifferent system prompts, same underlying model. In a real app these could be different models entirely — a cheap fast model for the writer, a stronger one for math.` },
    {
      id: "specialists", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { SystemMessage, HumanMessage } = ctx.lc.messages;

const mathLLM = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});
const writerLLM = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.9,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

async function mathNode(state) {
  const res = await mathLLM.invoke([
    new SystemMessage("You are a careful math tutor. Show your work step by step, then give the final answer on its own line prefixed 'Answer:'."),
    new HumanMessage(state.request),
  ]);
  return { answer: String(res.content) };
}

async function writerNode(state) {
  const res = await writerLLM.invoke([
    new SystemMessage("You are a punchy copywriter. Deliver vivid, concrete prose. No throat-clearing."),
    new HumanMessage(state.request),
  ]);
  return { answer: String(res.content) };
}

ctx.state.mathNode = mathNode;
ctx.state.writerNode = writerNode;
return { ok: true };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · Wire and run\n\nThe \`route\` field is the routing key. \`addConditionalEdges\` reads it and jumps to the matching node — that's the entire fan-out.` },
    {
      id: "graph", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, START, END } = ctx.lc.langgraph;

const graph = new StateGraph(ctx.state.RouterState)
  .addNode("supervisor", ctx.state.supervisorNode)
  .addNode("math",       ctx.state.mathNode)
  .addNode("writer",     ctx.state.writerNode)
  .addEdge(START, "supervisor")
  .addConditionalEdges("supervisor", (s) => s.route, { math: "math", writer: "writer" })
  .addEdge("math",   END)
  .addEdge("writer", END)
  .compile();

// 👇 Try ambiguous prompts:
//   "Write a poem about the number 17"     — math or writer?
//   "Estimate the value of a haiku"        — almost certainly writer
//   "How many syllables in 'serendipity'?" — counting, but linguistic
const REQUEST = "Write a short rhyming poem that explains why 0! equals 1.";

const result = await graph.invoke({ request: REQUEST });
return { request: REQUEST, route: result.route, answer: result.answer };
`,
    },

    { id: "md-5", kind: "markdown", source: `**Things to try:**\n\n- Run the graph 4 times with the same ambiguous request and a slightly reworded \`SUPERVISOR_PROMPT\` each time. Pay attention to how *one extra sentence* in the prompt can flip the routing decision consistently.\n- Try: *"What's the standard deviation of the lengths of the words in 'the quick brown fox'?"* — it's math wearing a writer's coat.\n- Add a third specialist (e.g. \`"code"\`) and update the supervisor's enum + the conditional edges map. Routing gets harder fast as you add specialists.` },
  ],
};
