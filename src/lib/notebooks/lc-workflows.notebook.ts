import type { Notebook } from "./types";

export const lcWorkflowsNotebook: Notebook = {
  id: "lc-workflows",
  title: "Memory, Human-in-the-Loop & Structured Output",
  description:
    "LangGraph state machines: persistent memory with MemorySaver checkpoints, human-in-the-loop interrupts, complex multi-step workflows, and structured outputs.",
  difficulty: "advanced",
  tags: ["langchain", "langgraph", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 4 · Memory, Human-in-the-Loop, Structured Outputs

Real agents need state that survives across turns and approval gates for
risky actions. That's exactly what **LangGraph** adds on top of LangChain.

We'll cover:

1. **Structured outputs** with \`withStructuredOutput\` (the one-line way)
2. A **simple StateGraph** workflow
3. **Memory & checkpointing** with \`MemorySaver\` + \`thread_id\`
4. **Human-in-the-loop** using \`interruptBefore\``,
    },

    // 1 — Structured outputs
    { id: "md-1", kind: "markdown", source: `## 1 · Structured outputs (Zod = Pydantic)\n\nThe cleanest way to get typed JSON back. LangChain wires Zod → tool spec → parsed object for you.` },
    {
      id: "structured", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

const Movie = z.object({
  title: z.string(),
  year: z.number().int(),
  genres: z.array(z.string()).max(5),
  rating_out_of_10: z.number().min(0).max(10),
});

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(Movie, { name: "movie" });

return await llm.invoke("Give me a movie recommendation similar to Blade Runner.");
`,
    },

    // 2 — LangGraph StateGraph workflow
    { id: "md-2", kind: "markdown", source: `## 2 · A simple LangGraph \`StateGraph\`\n\nA \`StateGraph\` is a typed state machine. You define **nodes** (functions that mutate state) and **edges** (which node runs next). \`MessagesAnnotation\` gives you the standard "list of LangChain messages" state.` },
    {
      id: "stategraph", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, MessagesAnnotation, START, END } = ctx.lc.langgraph;
const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

// One node: call the model on the running message list.
async function chat(state) {
  const ai = await llm.invoke(state.messages);
  return { messages: [ai] };   // appended into state.messages
}

const graph = new StateGraph(MessagesAnnotation)
  .addNode("chat", chat)
  .addEdge(START, "chat")
  .addEdge("chat", END)
  .compile();

const out = await graph.invoke({
  messages: [new HumanMessage("In one sentence, what is a StateGraph?")],
});
return out.messages.at(-1).content;
`,
    },
    { id: "md-2x", kind: "markdown", source: `A graph with one node is overkill — but it scales. Add more nodes and \`addConditionalEdges\` and you have a full agent (tool-using, branching, looping) with **observable state at every step**.` },

    // 3 — Memory + checkpointing
    { id: "md-3", kind: "markdown", source: `## 3 · Memory with checkpointing\n\nAttach a **checkpointer** (here, \`MemorySaver\` — RAM-only; production uses Postgres/Redis variants). Pass a \`thread_id\` in \`configurable\` and every \`.invoke()\` resumes that conversation automatically.` },
    {
      id: "checkpointing", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, MessagesAnnotation, START, END, MemorySaver } = ctx.lc.langgraph;
const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const graph = new StateGraph(MessagesAnnotation)
  .addNode("chat", async (s) => ({ messages: [await llm.invoke(s.messages)] }))
  .addEdge(START, "chat")
  .addEdge("chat", END)
  .compile({ checkpointer: new MemorySaver() });

const cfg = { configurable: { thread_id: "user-42" } };

await graph.invoke({ messages: [new HumanMessage("My name is Priya.")] }, cfg);
const r2 = await graph.invoke({ messages: [new HumanMessage("What's my name?")] }, cfg);

// State persists per thread_id:
const snapshot = await graph.getState(cfg);
return {
  answer: r2.messages.at(-1).content,
  messages_in_thread: snapshot.values.messages.length,
};
`,
    },
    { id: "md-3x", kind: "markdown", source: `The second turn recalls "Priya" — because the checkpointer auto-loaded the previous \`messages\` for \`thread_id: "user-42"\`. Change the \`thread_id\` and you get a fresh conversation. **\`getState\`** lets you inspect or even rewind the timeline.` },

    // 4 — Human-in-the-loop
    { id: "md-4", kind: "markdown", source: `## 4 · Human-in-the-loop with \`interruptBefore\`\n\nFor risky actions (sending money, deleting data) we want a human to approve. LangGraph **pauses** before a named node and the caller decides whether to resume.` },
    {
      id: "hitl", kind: "code", language: "js", runtime: "browser",
      source: `const { StateGraph, MessagesAnnotation, START, END, MemorySaver } = ctx.lc.langgraph;
const { AIMessage, HumanMessage } = ctx.lc.messages;

// Two nodes: "draft" writes a proposed email; "send" pretends to send it.
const draft = async (s) => ({
  messages: [new AIMessage("DRAFT: Hi Bob, your invoice is overdue. — Acme")],
});
const send = async (s) => {
  ctx.log("📨 sent email:", s.messages.at(-1).content);
  return { messages: [new AIMessage("Email sent ✅")] };
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode("draft", draft)
  .addNode("send", send)
  .addEdge(START, "draft")
  .addEdge("draft", "send")
  .addEdge("send", END)
  .compile({
    checkpointer: new MemorySaver(),
    interruptBefore: ["send"],          // 🚦 stop before sending
  });

const cfg = { configurable: { thread_id: "approve-1" } };

// Run until the interrupt
await graph.invoke({ messages: [new HumanMessage("Draft a polite overdue-invoice email.")] }, cfg);
let snap = await graph.getState(cfg);
ctx.log("paused at:", snap.next);     // ["send"]
ctx.log("proposed:", snap.values.messages.at(-1).content);

// 👀 Imagine a human reviews snap.values here. Approve → resume.
const final = await graph.invoke(null, cfg);    // null input = continue from checkpoint
return final.messages.map((m) => m.content);
`,
    },
    { id: "md-4x", kind: "markdown", source: `That's the whole pattern:\n\n1. \`interruptBefore: ["send"]\` halts the graph and saves a checkpoint.\n2. Your UI inspects \`graph.getState(cfg).values\` and shows it to a human.\n3. To approve, call \`graph.invoke(null, cfg)\` — \`null\` means "resume from where you stopped". To **reject and rewrite**, you can patch state with \`graph.updateState(cfg, {...})\` before resuming.\n\nNext notebook: **embeddings & RAG**.` },
  ],
};
