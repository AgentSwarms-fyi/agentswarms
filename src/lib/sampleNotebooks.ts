// Read-only sample notebooks shipped with the repo. They render in the
// Developer workspace (/notebooks) and can be run cell-by-cell, but not edited
// — use "Fork to my notebooks" to get an editable copy in your account.
//
// Honest runtime note (kept front-and-centre in every notebook too): cells run
// in the browser on Pyodide, which cannot install the real LangChain /
// LangGraph / LlamaIndex packages (native deps + blocked sockets). So each
// notebook teaches the framework's real fundamentals in two layers:
//   • reference blocks show the framework's actual API — copy them into a full
//     Python environment (or a forked notebook you run locally) as-is; and
//   • runnable cells reproduce the exact same pattern live using the built-in
//     `agentswarms` helper (real model calls + real KB retrieval through your
//     account) so you can see the idea work without leaving the browser.

import type { PyCell } from "@/lib/pythonNotebookTemplate";

export type SampleNotebook = {
  slug: string;
  title: string;
  framework: "LangChain" | "LangGraph" | "LlamaIndex" | "Agentic stack";
  description: string;
  /** ~1-line tag shown on the card. */
  tag: string;
  cells: PyCell[];
};

type Src = ["md" | "code", string];

function build(slug: string, rows: Src[]): PyCell[] {
  return rows.map(([t, source], i) => ({
    id: `${slug}-${i + 1}`,
    type: t === "md" ? "markdown" : "code",
    source,
  }));
}

// Shared setup cell used by every notebook.
const SETUP: Src = [
  "code",
  `import agentswarms, json, inspect

# Point these at any provider/model your account can use.
# "openrouter" works out of the box when this instance has a default key;
# connect more providers under Integrations to use them here.
PROVIDER = "openrouter"
MODEL = "openai/gpt-4o-mini"

print("Ready. agentswarms helpers:", [n for n in dir(agentswarms) if not n.startswith("_")])
`,
];

// A tiny JSON extractor reused across the model-output cells.
const EXTRACT_JSON: Src = [
  "code",
  `def extract_json(text):
    """Pull the first JSON object/array out of a model reply (handles code fences)."""
    t = text.strip()
    if t.startswith("\`\`\`"):
        t = t.split("\`\`\`", 2)[1]
        if t.lstrip().lower().startswith("json"):
            t = t.lstrip()[4:]
    start = min([i for i in (t.find("{"), t.find("[")) if i != -1], default=-1)
    end = max(t.rfind("}"), t.rfind("]"))
    if start == -1 or end == -1:
        raise ValueError("No JSON found in:\\n" + text)
    return json.loads(t[start:end + 1])

print("extract_json() ready")
`,
];

// ─────────────────────────────────────────────────────────────────────────────
// 1) LangChain
// ─────────────────────────────────────────────────────────────────────────────
const langchain: SampleNotebook = {
  slug: "langchain",
  title: "LangChain fundamentals",
  framework: "LangChain",
  description:
    "Models, prompt templates, output parsers, LCEL chains, tools, memory and RAG — the LangChain fundamentals with runnable in-browser demos.",
  tag: "Models, prompts, LCEL chains, tools, memory, RAG",
  cells: build("langchain", [
    [
      "md",
      `# LangChain fundamentals

LangChain gives you composable building blocks for LLM apps: **models**, **prompt templates**, **output parsers**, **chains** (LCEL), **tools/agents**, **memory**, and **retrieval (RAG)**. This notebook walks through each one.

## How to read this notebook

This runs in your browser on **Pyodide**, which can't \`pip install\` the real \`langchain\` package (it needs native builds and raw sockets). So every concept appears twice:

- **Reference block** — the *actual* LangChain code. Copy it into any Python environment where you've run \`pip install langchain langchain-openai\`. Fork this notebook (top-right) to keep an editable copy.
- **Runnable cell** — the *same idea*, implemented with the built-in \`agentswarms\` helper so it runs live here: real model calls through your connected providers, governed by your IAM rules and logged in Traces.

Run the setup cell first (▶ or **Shift+Enter**). Cells share one interpreter, so later cells reuse earlier variables.`,
    ],
    SETUP,
    [
      "md",
      `## 1 · Models

A chat model takes a list of messages and returns a message. In LangChain:

\`\`\`python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.3)
resp = llm.invoke("Name three properties of a good abstraction.")
print(resp.content)
\`\`\`

Here, \`agentswarms.chat()\` is your model. It's OpenAI-compatible under the hood, so the mental model is identical — you just pass \`provider\`/\`model\` and get text back.`,
    ],
    [
      "code",
      `reply = await agentswarms.chat(
    "Name three properties of a good abstraction. One line each.",
    provider=PROVIDER, model=MODEL, temperature=0.3,
)
print(reply)
`,
    ],
    [
      "md",
      `## 2 · Prompt templates

Templates separate the *reusable* prompt structure from the *runtime* inputs.

\`\`\`python
from langchain_core.prompts import ChatPromptTemplate

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a terse {persona}."),
    ("human", "Explain {topic} to a {audience}."),
])
messages = prompt.format_messages(persona="staff engineer", topic="idempotency",
                                  audience="new grad")
\`\`\`

The runnable version builds the messages list ourselves and sends it — same shape LangChain produces.`,
    ],
    [
      "code",
      `SYSTEM_TMPL = "You are a terse {persona}."
HUMAN_TMPL = "Explain {topic} to a {audience}. Two sentences max."

def format_messages(**vars):
    return [
        {"role": "system", "content": SYSTEM_TMPL.format(**vars)},
        {"role": "user", "content": HUMAN_TMPL.format(**vars)},
    ]

msgs = format_messages(persona="staff engineer", topic="idempotency", audience="new grad")
reply = await agentswarms.chat(messages=msgs, provider=PROVIDER, model=MODEL)
print(reply)
`,
    ],
    [
      "md",
      `## 3 · Output parsers (structured output)

Agents need typed data, not prose. LangChain uses output parsers / \`with_structured_output\`:

\`\`\`python
from pydantic import BaseModel

class Ticket(BaseModel):
    priority: str
    tags: list[str]

structured = llm.with_structured_output(Ticket)
ticket = structured.invoke("The login page 500s for all users since the deploy.")
\`\`\`

Runnable version: ask for JSON, then parse (with a repair retry — the everyday reality of structured output).`,
    ],
    EXTRACT_JSON,
    [
      "code",
      `async def classify_ticket(text):
    instruction = (
        "Classify the support ticket. Return ONLY JSON with keys "
        '"priority" (one of low|medium|high|urgent) and "tags" (array of short strings).'
    )
    for attempt in range(2):
        raw = await agentswarms.chat(
            instruction + "\\n\\nTicket: " + text,
            provider=PROVIDER, model=MODEL, temperature=0,
        )
        try:
            return extract_json(raw)
        except ValueError:
            instruction = "Return VALID JSON only, no prose. " + instruction
    raise RuntimeError("Model did not return valid JSON")

ticket = await classify_ticket("The login page 500s for all users since the deploy.")
print("priority:", ticket["priority"])
print("tags:", ticket["tags"])
`,
    ],
    [
      "md",
      `## 4 · Chains (LCEL)

LangChain Expression Language pipes components with \`|\`: \`prompt | model | parser\`. Each step's output feeds the next.

\`\`\`python
chain = prompt | llm | StrOutputParser()
chain.invoke({"topic": "backpressure", "audience": "PM"})
\`\`\`

We can reproduce the \`|\` operator in a few lines — this is genuinely all LCEL is: composable async callables.`,
    ],
    [
      "code",
      `class Runnable:
    """Minimal LCEL-style component: an async callable you can pipe with |."""
    def __init__(self, fn):
        self.fn = fn

    async def invoke(self, x):
        r = self.fn(x)
        return await r if inspect.isawaitable(r) else r

    def __or__(self, other):
        nxt = other if isinstance(other, Runnable) else Runnable(other)
        async def piped(x):
            return await nxt.invoke(await self.invoke(x))
        return Runnable(piped)

# prompt | model | parser
prompt = Runnable(lambda v: format_messages(**v))
model = Runnable(lambda msgs: agentswarms.chat(messages=msgs, provider=PROVIDER, model=MODEL))
parser = Runnable(lambda text: text.strip().upper())

chain = prompt | model | parser
out = await chain.invoke({"persona": "SRE", "topic": "backpressure", "audience": "PM"})
print(out)
`,
    ],
    [
      "md",
      `## 5 · Tools & agents

An **agent** lets the model decide *which tool to call* and *with what arguments*, then loops on the result. LangChain:

\`\`\`python
from langchain_core.tools import tool

@tool
def multiply(a: int, b: int) -> int:
    "Multiply two integers."
    return a * b

agent = create_react_agent(llm, tools=[multiply])
agent.invoke({"messages": [("user", "What is 23 * 19?")]})
\`\`\`

The runnable version below is a complete ReAct loop: we describe the tools, the model emits a JSON action, we execute it, feed back the observation, and repeat until it answers.`,
    ],
    [
      "code",
      `# A tiny tool registry. Each tool is a plain Python function.
def multiply(a, b): return a * b
def word_count(text): return len(str(text).split())

TOOLS = {
    "multiply":  {"fn": lambda args: multiply(args["a"], args["b"]),
                  "desc": 'multiply two numbers. args: {"a": number, "b": number}'},
    "word_count":{"fn": lambda args: word_count(args["text"]),
                  "desc": 'count words. args: {"text": string}'},
}

async def run_agent(question, max_steps=4):
    tool_docs = "\\n".join(f"- {name}: {t['desc']}" for name, t in TOOLS.items())
    system = (
        "You are a tool-using agent. Reply with ONE JSON object per turn.\\n"
        "To call a tool: {\\"action\\": \\"<name>\\", \\"args\\": {...}}\\n"
        "When you can answer: {\\"action\\": \\"final\\", \\"answer\\": \\"...\\"}\\n"
        "Available tools:\\n" + tool_docs
    )
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": question}]
    for step in range(max_steps):
        raw = await agentswarms.chat(messages=messages, provider=PROVIDER, model=MODEL, temperature=0)
        move = extract_json(raw)
        if move.get("action") == "final":
            return move.get("answer")
        tool = TOOLS.get(move.get("action"))
        obs = tool["fn"](move.get("args", {})) if tool else f"unknown tool {move.get('action')}"
        print(f"  step {step+1}: {move.get('action')}({move.get('args')}) -> {obs}")
        messages.append({"role": "assistant", "content": raw})
        messages.append({"role": "user", "content": f"Observation: {obs}"})
    return "(stopped: max steps reached)"

print(await run_agent("What is 23 * 19, and how many words are in the question I just asked?"))
`,
    ],
    [
      "md",
      `## 6 · Memory

"Memory" is just carrying prior turns forward. LangChain wraps this in \`RunnableWithMessageHistory\`; underneath it's a growing messages list keyed by session.`,
    ],
    [
      "code",
      `class ConversationMemory:
    def __init__(self, system=None):
        self.messages = [{"role": "system", "content": system}] if system else []

    async def say(self, text):
        self.messages.append({"role": "user", "content": text})
        reply = await agentswarms.chat(messages=self.messages, provider=PROVIDER, model=MODEL)
        self.messages.append({"role": "assistant", "content": reply})
        return reply

chat = ConversationMemory(system="You are a helpful assistant. Keep answers to one sentence.")
print("A:", await chat.say("My name is Dana and I work on payments."))
print("B:", await chat.say("What team did I say I work on?"))   # remembers 'payments'
`,
    ],
    [
      "md",
      `## 7 · Retrieval (RAG)

A retriever fetches relevant text; you stuff it into the prompt so the model answers from *your* data. LangChain:

\`\`\`python
retriever = vectorstore.as_retriever(search_kwargs={"k": 4})
docs = retriever.invoke("what's our refund window?")
\`\`\`

On AgentSwarms your **Knowledge Base** *is* the managed vector store — ingest docs under **Knowledge Base**, then retrieve with \`agentswarms.kb_search()\`. The cell below tries your real KB and falls back to a tiny in-notebook corpus so it always runs.`,
    ],
    [
      "code",
      `LOCAL_CORPUS = [
    "Refunds are available within 30 days of purchase for annual plans.",
    "Monthly plans can be cancelled anytime; access lasts until the period ends.",
    "Enterprise contracts are billed yearly and renew automatically unless cancelled 60 days prior.",
]

def local_search(query, k=3):
    terms = set(query.lower().split())
    scored = [(len(terms & set(d.lower().split())), d) for d in LOCAL_CORPUS]
    return [{"snippet": d, "document": "local", "knowledge_base": "demo"}
            for s, d in sorted(scored, reverse=True)[:k] if s]

async def answer_from_kb(question):
    hits = await agentswarms.kb_search(question, top_k=4)     # your real knowledge bases
    source = "your Knowledge Base"
    if not hits:
        hits, source = local_search(question), "the demo corpus"
    context = agentswarms.format_context(hits)
    reply = await agentswarms.chat(
        f"Answer using ONLY the context. Cite sources like [1].\\n\\nContext:\\n{context}\\n\\nQuestion: {question}",
        provider=PROVIDER, model=MODEL, temperature=0,
    )
    return f"(retrieved from {source})\\n{reply}"

print(await answer_from_kb("What is the refund window?"))
`,
    ],
    [
      "md",
      `## Where to go next

- **Run real LangChain:** fork this notebook, then paste the reference blocks into a local Python env with \`pip install langchain langchain-openai\`. Set \`OPENAI_API_KEY\` (or point \`ChatOpenAI(base_url=...)\` at any OpenAI-compatible endpoint).
- **Ship it on the platform:** the patterns here (prompt → model → tools → retrieval) map directly to the visual **Agent Builder** and **Swarm Canvas** — no code required.
- **Next samples:** *LangGraph fundamentals* (stateful graphs & multi-agent) and *LlamaIndex fundamentals* (retrieval-first RAG).`,
    ],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// 2) LangGraph
// ─────────────────────────────────────────────────────────────────────────────
const langgraph: SampleNotebook = {
  slug: "langgraph",
  title: "LangGraph fundamentals",
  framework: "LangGraph",
  description:
    "Stateful agent graphs: state, nodes, edges, conditional routing, cycles, human-in-the-loop and multi-agent supervisors — LangGraph fundamentals, runnable.",
  tag: "State, nodes, edges, cycles, interrupts, multi-agent",
  cells: build("langgraph", [
    [
      "md",
      `# LangGraph fundamentals

LangGraph models an agent as a **state machine**: a shared **state** object flows through **nodes** (functions) connected by **edges**, including **conditional edges** (routing) and **cycles** (loops). That's what makes durable, multi-step, multi-agent systems tractable.

## How to read this notebook

Pyodide can't install \`langgraph\`, so we build a ~20-line \`StateGraph\` runtime that behaves like the real one — then every concept is shown as **runnable** local code plus a **reference block** of the actual LangGraph API. Fork the notebook to run the reference code in a full Python env (\`pip install langgraph langchain-openai\`).

Run setup, then the "mini-runtime" cell, before the rest.`,
    ],
    SETUP,
    EXTRACT_JSON,
    [
      "md",
      `## The mini-runtime

Real LangGraph:

\`\`\`python
from langgraph.graph import StateGraph, END

g = StateGraph(MyState)
g.add_node("greet", greet)
g.add_edge("greet", END)
g.set_entry_point("greet")
app = g.compile()
app.invoke({"name": "Ada"})
\`\`\`

Nodes return a **partial** state dict that gets merged in. Our runtime does exactly that.`,
    ],
    [
      "code",
      `END = "__end__"

class StateGraph:
    def __init__(self):
        self.nodes, self.edges, self.cond, self.entry = {}, {}, {}, None
    def add_node(self, name, fn): self.nodes[name] = fn; return self
    def add_edge(self, a, b): self.edges[a] = b; return self
    def add_conditional_edges(self, a, router): self.cond[a] = router; return self
    def set_entry_point(self, name): self.entry = name; return self

    async def invoke(self, state, max_steps=25):
        node = self.entry
        steps = 0
        while node and node != END:
            if steps >= max_steps:
                raise RuntimeError("max steps — is an edge missing END?")
            steps += 1
            result = self.nodes[node](state)
            if inspect.isawaitable(result):
                result = await result
            if result:
                state.update(result)          # merge partial state (a 'reducer')
            if node in self.cond:
                nxt = self.cond[node](state)
                node = await nxt if inspect.isawaitable(nxt) else nxt
            else:
                node = self.edges.get(node, END)
        return state

print("StateGraph runtime ready")
`,
    ],
    [
      "md",
      `## 1 · State, nodes & a linear edge

State is a dict (LangGraph uses a \`TypedDict\`). Each node reads state and returns the keys it changed.`,
    ],
    [
      "code",
      `def greet(state):
    return {"greeting": f"Hello, {state['name']}!"}

def shout(state):
    return {"greeting": state["greeting"].upper()}

g = StateGraph()
g.add_node("greet", greet).add_node("shout", shout)
g.set_entry_point("greet")
g.add_edge("greet", "shout").add_edge("shout", END)

print(await g.invoke({"name": "Ada"}))
`,
    ],
    [
      "md",
      `## 2 · Conditional edges (routing)

A router function inspects the state and returns the name of the next node — this is how LangGraph branches.

\`\`\`python
g.add_conditional_edges("classify", lambda s: "refund" if s["intent"]=="refund" else "generic")
\`\`\``,
    ],
    [
      "code",
      `def classify(state):
    q = state["question"].lower()
    intent = "billing" if any(w in q for w in ("refund", "charge", "invoice")) else "generic"
    return {"intent": intent}

def route(state):
    return "billing_node" if state["intent"] == "billing" else "generic_node"

def billing_node(state):  return {"answer": "Routed to BILLING specialist."}
def generic_node(state):  return {"answer": "Routed to the GENERIC assistant."}

g = StateGraph()
g.add_node("classify", classify).add_node("billing_node", billing_node).add_node("generic_node", generic_node)
g.set_entry_point("classify")
g.add_conditional_edges("classify", route)
g.add_edge("billing_node", END).add_edge("generic_node", END)

r1 = await g.invoke({"question": "I want a refund on my invoice"})
print(r1["answer"])
r2 = await g.invoke({"question": "How do I rename a project?"})
print(r2["answer"])
`,
    ],
    [
      "md",
      `## 3 · Cycles — the agent loop

The superpower of graphs is **loops**: an \`agent\` node decides to act, a \`tools\` node runs the action, and a conditional edge loops back until the agent is done. This is the ReAct pattern as a graph.`,
    ],
    [
      "code",
      `def kb_lookup(q):  # a stand-in "tool"
    facts = {"capital of france": "Paris", "speed of light": "299,792 km/s"}
    return facts.get(q.strip().lower(), "no result")

async def agent_node(state):
    system = (
        "Decide the next step as ONE JSON object.\\n"
        'Use a tool: {"action": "lookup", "query": "..."}\\n'
        'Or finish:  {"action": "final", "answer": "..."}\\n'
        "Tool 'lookup' answers simple facts."
    )
    msgs = [{"role": "system", "content": system}] + state["scratch"]
    raw = await agentswarms.chat(messages=msgs, provider=PROVIDER, model=MODEL, temperature=0)
    move = extract_json(raw)
    return {"move": move, "scratch": state["scratch"] + [{"role": "assistant", "content": raw}]}

def tools_node(state):
    obs = kb_lookup(state["move"]["query"])
    return {"scratch": state["scratch"] + [{"role": "user", "content": f"Observation: {obs}"}]}

def should_continue(state):
    return END if state["move"].get("action") == "final" else "tools"

g = StateGraph()
g.add_node("agent", agent_node).add_node("tools", tools_node)
g.set_entry_point("agent")
g.add_conditional_edges("agent", should_continue)
g.add_edge("tools", "agent")

final = await g.invoke({"scratch": [{"role": "user", "content": "What is the capital of France?"}]})
print("Answer:", final["move"].get("answer"))
`,
    ],
    [
      "md",
      `## 4 · Human-in-the-loop & checkpointing

Long-running agents need to **pause** for approval and **resume** later. LangGraph does this with a checkpointer + \`interrupt\`:

\`\`\`python
from langgraph.checkpoint.memory import MemorySaver
app = g.compile(checkpointer=MemorySaver(), interrupt_before=["tools"])
# invoke() stops before 'tools'; inspect state, then resume with app.invoke(None, config)
\`\`\`

The pattern is: persist state at a breakpoint, return control, then continue from the saved state. Here's the essence — run to a breakpoint, approve, resume.`,
    ],
    [
      "code",
      `def plan(state):
    return {"proposed": f"DELETE {state['n']} stale records", "status": "awaiting_approval"}

def apply_change(state):
    return {"status": "done", "result": f"Deleted {state['n']} records"}

# Phase 1: run up to the breakpoint (before the risky node).
checkpoint = plan({"n": 42})
print("Proposed:", checkpoint["proposed"], "| status:", checkpoint["status"])

# Phase 2: a human approves, then we resume from the saved checkpoint.
approved = True
resumed = {**checkpoint, "n": 42}
print("Resumed:", apply_change(resumed) if approved else {"status": "rejected"})
`,
    ],
    [
      "md",
      `## 5 · Multi-agent (supervisor)

A **supervisor** node routes work to specialist worker nodes and decides when the job is done — the backbone of multi-agent systems. Each worker is just another node with its own prompt/role.`,
    ],
    [
      "code",
      `async def supervisor(state):
    done = "draft" in state and "research" in state
    if done:
        return {"next": "END"}
    return {"next": "researcher" if "research" not in state else "writer"}

async def researcher(state):
    notes = await agentswarms.chat(
        f"List 3 crisp bullet facts about: {state['topic']}",
        provider=PROVIDER, model=MODEL, temperature=0.3)
    return {"research": notes}

async def writer(state):
    draft = await agentswarms.chat(
        f"Write a 2-sentence summary of {state['topic']} using these notes:\\n{state['research']}",
        provider=PROVIDER, model=MODEL, temperature=0.4)
    return {"draft": draft}

def sup_route(state):
    return END if state["next"] == "END" else state["next"]

g = StateGraph()
g.add_node("supervisor", supervisor).add_node("researcher", researcher).add_node("writer", writer)
g.set_entry_point("supervisor")
g.add_conditional_edges("supervisor", sup_route)
g.add_edge("researcher", "supervisor").add_edge("writer", "supervisor")

out = await g.invoke({"topic": "vector databases"})
print("RESEARCH:\\n", out["research"], "\\n\\nDRAFT:\\n", out["draft"])
`,
    ],
    [
      "md",
      `## Map it to AgentSwarms

Everything above is a first-class, no-code primitive on the platform:

- **Nodes & edges** → the visual **Swarm Canvas** (agents, routers, loops, approvals).
- **Conditional edges** → router nodes.
- **Human-in-the-loop** → approval nodes.
- **Supervisor / workers** → a swarm with a coordinator agent.

Prototype the logic here, then rebuild it visually on the canvas to get durability, tracing, budgets, and one-click deploy. **Fork** this notebook to experiment, or open the *Agentic stack* sample to see KB, tools, skills, guardrails and MCP wired together.`,
    ],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// 3) LlamaIndex
// ─────────────────────────────────────────────────────────────────────────────
const llamaindex: SampleNotebook = {
  slug: "llamaindex",
  title: "LlamaIndex fundamentals",
  framework: "LlamaIndex",
  description:
    "Documents, nodes, indexes, retrievers and query engines — LlamaIndex fundamentals, with your AgentSwarms Knowledge Base as the managed index.",
  tag: "Documents, nodes, indexes, retrievers, query engines",
  cells: build("llamaindex", [
    [
      "md",
      `# LlamaIndex fundamentals

LlamaIndex is retrieval-first: turn **Documents** into **Nodes** (chunks), build an **Index**, get a **Retriever**, and wrap it in a **Query Engine** that retrieves-then-synthesizes. On top sit **routers**, **sub-question** engines, and **agents**.

## How to read this notebook

Pyodide can't install \`llama-index\`, so the runnable cells implement each stage in plain Python (plus your real Knowledge Base as the managed index), while **reference blocks** show the true LlamaIndex API. The big idea to remember: **your AgentSwarms Knowledge Base *is* a managed \`VectorStoreIndex\`** — ingest under **Knowledge Base**, retrieve with \`agentswarms.kb_search()\`.

Fork to run the reference code locally (\`pip install llama-index\`).`,
    ],
    SETUP,
    [
      "md",
      `## 1 · Documents → Nodes (chunking)

A Document is raw text + metadata; a Node is a chunk of it. Chunking controls retrieval quality.

\`\`\`python
from llama_index.core import Document
from llama_index.core.node_parser import SentenceSplitter

nodes = SentenceSplitter(chunk_size=200, chunk_overlap=20).get_nodes_from_documents(
    [Document(text=long_text)])
\`\`\``,
    ],
    [
      "code",
      `import re

DOC = (
    "AgentSwarms is a self-hosted agentic AI platform. "
    "It bundles an Agent Builder, a visual Swarm Canvas, and a BI workspace. "
    "Knowledge Bases provide managed retrieval over your documents. "
    "Every model call is governed by IAM rules and logged in Traces. "
    "Agents can call tools, use skills, apply guardrails, and reach MCP servers."
)

def split_sentences(text, per_chunk=2):
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\\s+", text) if s.strip()]
    return [" ".join(sents[i:i+per_chunk]) for i in range(0, len(sents), per_chunk)]

nodes = split_sentences(DOC)
for i, n in enumerate(nodes):
    print(f"[node {i}] {n}")
`,
    ],
    [
      "md",
      `## 2 · Index & embeddings

An index makes nodes searchable. LlamaIndex embeds each node into a vector store:

\`\`\`python
from llama_index.core import VectorStoreIndex
index = VectorStoreIndex(nodes)               # embeds + stores
\`\`\`

On the platform you don't manage embeddings by hand — the **Knowledge Base** does it (chunk, embed, store, hybrid-search). List the ones your account can read:`,
    ],
    [
      "code",
      `kbs = await agentswarms.list_knowledge_bases()
if kbs:
    for kb in kbs:
        print(("[sample] " if kb["sample"] else "[yours]  ") + kb["name"])
else:
    print("No knowledge bases yet — create one under Knowledge Base to use managed retrieval.")

# For the runnable demo below we also build a trivial local index over 'nodes'.
def build_local_index(nodes):
    return [{"id": i, "text": t, "terms": set(t.lower().split())} for i, t in enumerate(nodes)]

local_index = build_local_index(nodes)
print("\\nLocal index built:", len(local_index), "nodes")
`,
    ],
    [
      "md",
      `## 3 · Retriever

A retriever returns the top-k nodes for a query.

\`\`\`python
retriever = index.as_retriever(similarity_top_k=3)
retriever.retrieve("How are model calls governed?")
\`\`\``,
    ],
    [
      "code",
      `def local_retrieve(query, k=2):
    terms = set(query.lower().split())
    scored = [(len(terms & n["terms"]), n["text"]) for n in local_index]
    return [t for s, t in sorted(scored, key=lambda x: -x[0])[:k] if s]

async def kb_retrieve(query, k=3):
    hits = await agentswarms.kb_search(query, top_k=k)   # real managed retrieval
    return [h["snippet"] for h in hits]

print("Local:", local_retrieve("How are model calls governed?"))
kb_hits = await kb_retrieve("How are model calls governed?")
print("KB:", kb_hits or "(no KB match — ingest docs under Knowledge Base)")
`,
    ],
    [
      "md",
      `## 4 · Query engine (retrieve → synthesize)

The query engine retrieves nodes and asks the model to answer *from them*, with citations.

\`\`\`python
qe = index.as_query_engine(similarity_top_k=3)
print(qe.query("What governs model calls?"))
\`\`\``,
    ],
    [
      "code",
      `async def query_engine(question, k=3):
    ctx = local_retrieve(question, k) or [DOC]
    numbered = "\\n".join(f"[{i+1}] {c}" for i, c in enumerate(ctx))
    answer = await agentswarms.chat(
        f"Answer the question using ONLY the sources. Cite like [1].\\n\\n"
        f"Sources:\\n{numbered}\\n\\nQuestion: {question}",
        provider=PROVIDER, model=MODEL, temperature=0)
    return answer

print(await query_engine("What governs model calls, and where are they logged?"))
`,
    ],
    [
      "md",
      `## 5 · Response synthesis modes (refine)

When context is large, LlamaIndex synthesizes across chunks — \`compact\`, \`refine\`, \`tree_summarize\`. \`refine\` builds an answer chunk-by-chunk, improving it each step.`,
    ],
    [
      "code",
      `async def refine_answer(question, chunks):
    answer = None
    for i, chunk in enumerate(chunks):
        if answer is None:
            answer = await agentswarms.chat(
                f"Question: {question}\\nContext: {chunk}\\nGive a first answer.",
                provider=PROVIDER, model=MODEL, temperature=0)
        else:
            answer = await agentswarms.chat(
                f"Question: {question}\\nExisting answer: {answer}\\n"
                f"New context: {chunk}\\nRefine the answer if the new context helps; else keep it.",
                provider=PROVIDER, model=MODEL, temperature=0)
    return answer

print(await refine_answer("What can agents do on the platform?", nodes))
`,
    ],
    [
      "md",
      `## 6 · Routing & agents

Route a query to the right engine, or let an **agent** pick tools (each tool can be its own query engine).

\`\`\`python
from llama_index.core.agent import ReActAgent
agent = ReActAgent.from_tools([search_tool, math_tool], llm=llm)
agent.chat("Summarize the refund policy, then compute 3 * 30.")
\`\`\`

Runnable router: classify the query, then dispatch to the matching engine.`,
    ],
    [
      "code",
      `async def router(query):
    kind = await agentswarms.chat(
        'Reply with ONE word: "docs" if the question is about the product, '
        '"math" if it is arithmetic.\\n\\nQuestion: ' + query,
        provider=PROVIDER, model=MODEL, temperature=0)
    kind = kind.strip().lower()
    if "math" in kind:
        expr = "".join(c for c in query if c in "0123456789+-*/(). ")
        return f"[math engine] {expr.strip()} = {eval(expr)}"       # demo only; never eval untrusted input
    return "[docs engine] " + await query_engine(query)

print(await router("What governs model calls?"))
print(await router("What is 3 * 30 + 12?"))
`,
    ],
    [
      "md",
      `## Point LlamaIndex at your real data

- **Managed path (recommended):** ingest under **Knowledge Base** (files, URLs, GitHub), then retrieve with \`agentswarms.kb_search()\` — chunking, embeddings, hybrid search and re-ranking are handled for you.
- **Framework path:** fork this notebook and run the reference blocks locally with \`pip install llama-index\`, pointing the LLM/embeddings at any OpenAI-compatible endpoint.
- **No-code path:** attach a Knowledge Base to an agent in **Agent Builder** and it does RAG automatically.

Next, open the *Agentic stack* sample to combine retrieval with tools, skills, guardrails and MCP.`,
    ],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// 4) Mix / capstone — the AgentSwarms agentic stack
// ─────────────────────────────────────────────────────────────────────────────
const agenticStack: SampleNotebook = {
  slug: "agentic-stack",
  title: "Mix of all — the agentic stack",
  framework: "Agentic stack",
  description:
    "Combine the frameworks on AgentSwarms: your knowledge base, tools, skills, guardrails, MCP and a small multi-agent RAG service — all runnable.",
  tag: "KB · tools · skills · guardrails · MCP · multi-agent",
  cells: build("agentic-stack", [
    [
      "md",
      `# Mix of all — the agentic stack

The other three samples teach the frameworks. This one shows how their ideas come together **on AgentSwarms**, and how to use the platform's building blocks from Python: your **knowledge base**, **tools**, **skills**, **guardrails**, and **MCP** — finishing with a small multi-agent RAG service.

| Framework idea | AgentSwarms building block |
|---|---|
| LangChain retriever / LlamaIndex index | **Knowledge Base** (managed RAG) — \`agentswarms.kb_search()\` |
| LangChain tools / LlamaIndex tools | **Tools** (built-in + your own functions) |
| Reusable prompt modules | **Skills** (\`/skills\`) |
| Output/guard validators | **Guardrails** (+ IAM model rules & budgets) |
| External tool servers | **MCP servers** (\`/mcp\`) |
| LangGraph graph / supervisor | **Swarm Canvas** (visual multi-agent) |

Runnable cells run here; reference blocks + platform pointers show the production path. Run setup first.`,
    ],
    SETUP,
    EXTRACT_JSON,
    [
      "md",
      `## 1 · Use your existing Knowledge Base

Your Knowledge Base is managed RAG: ingest documents under **Knowledge Base** (files, URLs, GitHub, object storage), and the platform chunks, embeds, stores and hybrid-searches them. From a notebook you retrieve with one call — governed by the same IAM access rules as everywhere else, so you only ever see KBs you own, were granted, or that are public samples.`,
    ],
    [
      "code",
      `kbs = await agentswarms.list_knowledge_bases()
print("Knowledge bases you can read:", [k["name"] for k in kbs] or "(none yet)")

DEMO = [
    {"snippet": "Support SLA: urgent tickets are answered within 1 hour, 24/7.",
     "document": "sla.md", "knowledge_base": "demo"},
    {"snippet": "Refunds: annual plans are refundable within 30 days of purchase.",
     "document": "billing.md", "knowledge_base": "demo"},
]

async def retrieve(query, k=4):
    hits = await agentswarms.kb_search(query, top_k=k)
    return hits or [h for h in DEMO if set(query.lower().split()) & set(h["snippet"].lower().split())]

hits = await retrieve("What is the refund window?")
print(agentswarms.format_context(hits))
`,
    ],
    [
      "md",
      `## 2 · Build tools

A **tool** is a function the model can call. On the platform, agents get **built-in tools** (KB search, SQL query, web fetch, code, image, and more — toggled per agent in **Agent Builder**) and you can add **your own**. The contract is always the same: a name, a description, a typed args schema, and a function. Below we register two tools and let the model call them.`,
    ],
    [
      "code",
      `def tool(name, description, schema):
    def wrap(fn):
        REGISTRY[name] = {"fn": fn, "description": description, "schema": schema}
        return fn
    return wrap

REGISTRY = {}

@tool("kb_search", "Search the knowledge base for facts.", {"query": "string"})
async def _kb(args):
    hits = await retrieve(args["query"], k=3)
    return agentswarms.format_context(hits)

@tool("calculator", "Evaluate a basic arithmetic expression.", {"expr": "string"})
def _calc(args):
    allowed = set("0123456789+-*/(). ")
    expr = "".join(c for c in args["expr"] if c in allowed)
    return str(eval(expr))          # demo only — never eval untrusted input in production

async def call_tool(name, args):
    t = REGISTRY[name]
    r = t["fn"](args)
    return await r if inspect.isawaitable(r) else r

print("Registered tools:", list(REGISTRY))
print("calculator ->", await call_tool("calculator", {"expr": "12 * (3 + 4)"}))
`,
    ],
    [
      "md",
      `## 3 · Use skills

A **skill** (see the **Skill Library**, \`/skills\`) is a reusable, named block of instructions/behaviour you attach to an agent — a "support triager", a "SQL analyst", a "brand voice". Instead of re-writing a system prompt every time, you compose skills. Here we model a skill as a reusable instruction module and stack two of them.`,
    ],
    [
      "code",
      `SKILLS = {
    "concise": "Answer in at most 2 sentences. No filler.",
    "cite_sources": "Always cite retrieved facts inline like [1], [2].",
    "brand_voice": "Warm, professional, first-person plural ('we').",
}

def compose_system(*skill_names, base="You are a customer support agent."):
    lines = [base] + [SKILLS[n] for n in skill_names]
    return lines[0] + ("" if len(lines) == 1 else "\\n- " + "\\n- ".join(lines[1:]))

system = compose_system("concise", "cite_sources", "brand_voice")
print(system, "\\n---")

hits = await retrieve("refund window")
answer = await agentswarms.chat(
    messages=[{"role": "system", "content": system},
              {"role": "user", "content": f"Context:\\n{agentswarms.format_context(hits)}\\n\\nWhat is the refund window?"}],
    provider=PROVIDER, model=MODEL, temperature=0.2)
print(answer)
`,
    ],
    [
      "md",
      `## 4 · Apply guardrails

Guardrails keep agents safe and on-spec. Two layers work together:

- **Platform governance (already on):** every \`agentswarms.chat()\` call is checked against your admin's **IAM model rules** (which providers/models you may use) and your **budgets**, and is recorded in **Traces**. You get this for free.
- **Your own guardrails:** validate *input* (block disallowed requests, strip PII) and *output* (enforce a JSON schema, retry on violation). Below is an input guard + an output guard with a repair loop.`,
    ],
    [
      "code",
      `BLOCKLIST = ("password", "credit card", "ssn")

def input_guard(text):
    lowered = text.lower()
    hit = next((w for w in BLOCKLIST if w in lowered), None)
    if hit:
        raise ValueError(f"Blocked by guardrail: request mentions '{hit}'.")
    return text

async def guarded_json(prompt, required_keys, max_tries=2):
    for _ in range(max_tries):
        raw = await agentswarms.chat(prompt, provider=PROVIDER, model=MODEL, temperature=0)
        try:
            data = extract_json(raw)
            missing = [k for k in required_keys if k not in data]
            if missing:
                raise ValueError(f"missing keys: {missing}")
            return data                                   # passed the output guard
        except ValueError:
            prompt = f"Return VALID JSON with keys {required_keys} only. " + prompt
    raise RuntimeError("Output failed schema guard after retries")

try:
    input_guard("please reset my password and read my ssn")
except ValueError as e:
    print("INPUT:", e)

print("OUTPUT:", await guarded_json(
    'Summarize this ticket as JSON {"summary": str, "priority": str}: '
    '"Checkout is down for EU customers since 09:00."',
    required_keys=["summary", "priority"]))
`,
    ],
    [
      "md",
      `## 5 · Reach MCP servers

**MCP** (Model Context Protocol) lets agents use tools hosted by *external* servers — a GitHub server, a database server, an internal API — without you hand-coding each integration. On AgentSwarms you register these under **MCP Servers** (\`/mcp\`); an agent then sees the server's tools alongside its built-ins, and the platform brokers the calls (auth, schemas, tracing).

From a browser notebook you don't speak the MCP wire protocol directly — you let the platform broker it (attach the MCP server to an agent, or call an agent that has it). The cell below shows the **shape** of an MCP tool so the mental model is clear; the reference block shows a real client.

\`\`\`python
# Real MCP client (run in a full Python env):
from mcp import ClientSession
from mcp.client.stdio import stdio_client
async with stdio_client(server_params) as (read, write):
    async with ClientSession(read, write) as session:
        tools = (await session.list_tools()).tools
        result = await session.call_tool("search_issues", {"repo": "acme/app", "q": "flaky"})
\`\`\``,
    ],
    [
      "code",
      `# Illustrative mock of how an MCP server advertises tools and answers calls.
# In production this lives behind /mcp and is invoked by your deployed agents.
class MockMCPServer:
    name = "github"
    def list_tools(self):
        return [{"name": "search_issues",
                 "description": "Search issues in a repo.",
                 "schema": {"repo": "string", "q": "string"}}]
    def call_tool(self, name, args):
        if name == "search_issues":
            return [{"id": 4213, "title": f"[{args['q']}] intermittent failure in {args['repo']}"}]
        raise ValueError(f"unknown tool {name}")

mcp = MockMCPServer()
print("MCP tools:", [t["name"] for t in mcp.list_tools()])
print("Result:", mcp.call_tool("search_issues", {"repo": "acme/app", "q": "flaky"}))
print("\\nConfigure real servers under /mcp; agents then call these tools automatically.")
`,
    ],
    [
      "md",
      `## 6 · Put it together — a mini multi-agent RAG service

Now combine everything: a **supervisor** routes a request to a **retriever+tool worker** (KB search / calculator), applies the **input guard**, composes **skills** into the system prompt, and returns a **schema-guarded** answer. This is a LangGraph-style supervisor over LlamaIndex-style retrieval with LangChain-style tools — the whole agentic stack in ~30 lines.`,
    ],
    [
      "code",
      `async def worker(question):
    # ReAct-style: let the model pick a tool, run it, then answer.
    tool_docs = "\\n".join(f"- {n}: {t['description']} args={t['schema']}" for n, t in REGISTRY.items())
    system = ("You are a support worker. Reply with ONE JSON object.\\n"
              'Call a tool: {"action": "<tool>", "args": {...}}  or finish: {"action": "final", "answer": "..."}\\n'
              + tool_docs)
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": question}]
    for _ in range(4):
        raw = await agentswarms.chat(messages=msgs, provider=PROVIDER, model=MODEL, temperature=0)
        move = extract_json(raw)
        if move.get("action") == "final":
            return move["answer"]
        obs = await call_tool(move["action"], move.get("args", {}))
        msgs += [{"role": "assistant", "content": raw}, {"role": "user", "content": f"Observation: {obs}"}]
    return "(max steps)"

async def supervisor(request):
    input_guard(request)                                  # guardrail
    answer = await worker(request)                        # retriever + tools
    return answer

print(await supervisor("What is our refund window, and what is 30 * 12?"))
`,
    ],
    [
      "md",
      `## 7 · Deploy it — from notebook to executable job

You've built an agent in Python. The natural next step is to **expose it as an API** and **run it on a schedule** — the way Spark notebooks graduate into jobs.

That capability is designed but not yet shipped in this build. The intended shape mirrors how **swarms** already deploy on AgentSwarms:

- **Deploy as API** — mint a notebook API key; \`POST /api/notebook/run\` executes a chosen \`entrypoint(inputs)\` function server-side and returns its result as JSON.
- **Schedule as a job** — cron-driven runs (like swarm schedules), with each run recorded in Traces.
- **Governed** — runs execute as the key owner, under the same IAM model rules and budgets enforced on \`agentswarms.chat()\` here.

Until then: rebuild the logic visually in **Agent Builder / Swarm Canvas** (which already deploy as APIs and run on schedules), or **fork** this notebook and run it from your own service with the reference code.`,
    ],
  ]),
};

export const SAMPLE_NOTEBOOKS: SampleNotebook[] = [
  langchain,
  langgraph,
  llamaindex,
  agenticStack,
];

export function getSampleNotebook(slug: string): SampleNotebook | undefined {
  return SAMPLE_NOTEBOOKS.find((n) => n.slug === slug);
}
