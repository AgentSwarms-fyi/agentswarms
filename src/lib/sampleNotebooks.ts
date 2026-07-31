// Read-only sample notebooks shipped with the repo. They render in the
// Developer workspace (/notebooks) and can be run cell-by-cell, but not edited
// — use "Fork to my notebooks" to get an editable copy in your account.
//
// These run on the SERVER runtime (a real container kernel), so every cell is
// genuine framework code: actual langchain / langgraph / llama_index imports,
// executed for real. Model calls go through `agentswarms.chat_model()` /
// `llama_llm()`, which are real LangChain/LlamaIndex objects that route through
// the platform — so IAM model rules, budgets and Traces still apply and no
// provider key ever exists inside the sandbox.

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

/** Shown at the top of every sample. */
const INTRO_NOTE = `> These cells run on a **real server kernel** — genuine \`langchain\`, \`langgraph\` and \`llama_index\` imports, not a simulation. Model calls go through \`agentswarms.chat_model()\`, a real LangChain \`BaseChatModel\` that routes via the platform: your IAM model rules, budgets and Traces apply, and no API key exists inside the sandbox. Run cells with ▶ or **Shift+Enter**; the kernel starts on your first run and keeps state between cells.`;

// ─────────────────────────────────────────────────────────────────────────────
// 1) LangChain
// ─────────────────────────────────────────────────────────────────────────────
const langchain: SampleNotebook = {
  slug: "langchain",
  title: "LangChain fundamentals",
  framework: "LangChain",
  description:
    "Models, prompt templates, output parsers, LCEL chains, tools, memory and RAG — real LangChain code running on a server kernel.",
  tag: "Models, prompts, LCEL, tools, memory, RAG",
  cells: build("langchain", [
    [
      "md",
      `# LangChain fundamentals

LangChain composes LLM apps from **models**, **prompt templates**, **output parsers**, **chains (LCEL)**, **tools**, **memory** and **retrieval**. This notebook walks each one with real \`langchain\` code.

${INTRO_NOTE}`,
    ],
    [
      "code",
      `import langchain, langchain_core
from agentswarms import chat_model

# A real LangChain BaseChatModel that routes through AgentSwarms.
llm = chat_model(model="openai/gpt-4o-mini", temperature=0.3)

print("langchain", langchain.__version__)
print("model class:", type(llm).__name__, "| is BaseChatModel:",
      isinstance(llm, langchain_core.language_models.chat_models.BaseChatModel))`,
    ],
    [
      "md",
      `## 1 · Models

A chat model takes messages and returns a message. Invoke it directly:`,
    ],
    [
      "code",
      `from langchain_core.messages import HumanMessage, SystemMessage

reply = llm.invoke([
    SystemMessage(content="You are a terse staff engineer."),
    HumanMessage(content="Name three properties of a good abstraction, one line each."),
])
print(reply.content)`,
    ],
    [
      "md",
      `## 2 · Prompt templates

Templates separate reusable structure from runtime inputs.`,
    ],
    [
      "code",
      `from langchain_core.prompts import ChatPromptTemplate

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a terse {persona}."),
    ("human", "Explain {topic} to a {audience}. Two sentences max."),
])

print(prompt.format_messages(persona="SRE", topic="idempotency", audience="new grad"))`,
    ],
    [
      "md",
      `## 3 · Chains (LCEL)

LangChain Expression Language pipes components with \`|\`. Each step feeds the next — this is the core abstraction you'll use everywhere.`,
    ],
    [
      "code",
      `from langchain_core.output_parsers import StrOutputParser

chain = prompt | llm | StrOutputParser()
print(chain.invoke({"persona": "SRE", "topic": "backpressure", "audience": "PM"}))`,
    ],
    [
      "md",
      `## 4 · Output parsers (structured output)

Agents need typed data, not prose. \`JsonOutputParser\` gives the model format instructions and parses the reply.`,
    ],
    [
      "code",
      `from langchain_core.output_parsers import JsonOutputParser
from pydantic import BaseModel, Field

class Ticket(BaseModel):
    priority: str = Field(description="one of low, medium, high, urgent")
    tags: list[str] = Field(description="short topic tags")

parser = JsonOutputParser(pydantic_object=Ticket)
triage = (
    ChatPromptTemplate.from_template(
        "Classify the support ticket.\\n{format_instructions}\\n\\nTicket: {ticket}"
    ).partial(format_instructions=parser.get_format_instructions())
    | llm
    | parser
)

result = triage.invoke({"ticket": "Checkout 500s for all EU customers since the deploy."})
print(result)`,
    ],
    [
      "md",
      `## 5 · Tools & tool-calling

A tool is a typed function an agent can call. Define them with the \`@tool\` decorator — they carry a name, description and args schema.`,
    ],
    [
      "code",
      `from langchain_core.tools import tool

@tool
def multiply(a: int, b: int) -> int:
    """Multiply two integers."""
    return a * b

@tool
def word_count(text: str) -> int:
    """Count the words in a string."""
    return len(text.split())

TOOLS = {t.name: t for t in [multiply, word_count]}
print({name: t.description for name, t in TOOLS.items()})
print("direct call:", multiply.invoke({"a": 23, "b": 19}))`,
    ],
    [
      "md",
      `\`llm.bind_tools([...])\` hands the schemas to the model, which then **decides** whether to call a tool and with what arguments — returning structured \`tool_calls\` instead of prose. You run the calls, feed the results back as \`ToolMessage\`s, and the model answers. This is the exact loop \`create_react_agent\` runs for you; \`chat_model()\` routes it through the platform, so tool-calling stays governed like every other call.`,
    ],
    [
      "code",
      `from langchain_core.messages import HumanMessage, ToolMessage

llm_with_tools = llm.bind_tools([multiply, word_count])

messages = [HumanMessage("What is 23 times 19?")]
ai = llm_with_tools.invoke(messages)          # the model returns tool_calls, not text
print("tool_calls:", ai.tool_calls)

# Execute each requested tool and hand the results back.
messages.append(ai)
for call in ai.tool_calls:
    result = TOOLS[call["name"]].invoke(call["args"])
    messages.append(ToolMessage(str(result), tool_call_id=call["id"]))

answer = llm_with_tools.invoke(messages)      # now it answers using the tool result
print("answer:", answer.content)`,
    ],
    [
      "md",
      `## 6 · Memory

"Memory" is carrying prior turns forward. \`RunnableWithMessageHistory\` wraps any chain with per-session history.

> Running this prints a deprecation warning: LangChain now steers you to **LangGraph persistence** (checkpointers) for production memory — see the LangGraph sample. The wrapper still works and remains the clearest way to see the idea.`,
    ],
    [
      "code",
      `from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.prompts import MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory

store = {}
def history_for(session_id: str):
    return store.setdefault(session_id, InMemoryChatMessageHistory())

conv_prompt = ChatPromptTemplate.from_messages([
    ("system", "You are helpful. Answer in one sentence."),
    MessagesPlaceholder("history"),
    ("human", "{input}"),
])
conversation = RunnableWithMessageHistory(
    conv_prompt | llm | StrOutputParser(),
    history_for,
    input_messages_key="input",
    history_messages_key="history",
)

cfg = {"configurable": {"session_id": "demo"}}
print("A:", conversation.invoke({"input": "My name is Dana, I work on payments."}, cfg))
print("B:", conversation.invoke({"input": "Which team did I say I work on?"}, cfg))`,
    ],
    [
      "md",
      `## 7 · Retrieval (RAG)

Your **Knowledge Base** is the managed vector store — ingest under **Knowledge Base**, then retrieve with \`agentswarms.kb_retriever()\`, which is a real LlamaIndex-style retriever usable from LangChain too. Here we wire retrieval into an LCEL chain.`,
    ],
    [
      "code",
      `from agentswarms import kb_retriever
from langchain_core.runnables import RunnablePassthrough

retriever = kb_retriever(top_k=4)

def as_context(question: str) -> str:
    nodes = retriever.retrieve(question)
    if not nodes:
        return "(no knowledge bases matched — add documents under Knowledge Base)"
    return "\\n".join(f"[{i}] {n.node.text}" for i, n in enumerate(nodes, 1))

rag = (
    {"context": RunnablePassthrough() | as_context, "question": RunnablePassthrough()}
    | ChatPromptTemplate.from_template(
        "Answer using ONLY the context. Cite like [1].\\n\\nContext:\\n{context}\\n\\nQuestion: {question}"
    )
    | llm
    | StrOutputParser()
)

print(rag.invoke("What is the refund policy?"))`,
    ],
    [
      "md",
      `## Where next

- **Fork** this notebook (top right) to edit and extend it.
- \`pip install\` anything you need — the kernel is a full Python environment.
- Next: *LangGraph fundamentals* for stateful multi-agent graphs, and *LlamaIndex fundamentals* for retrieval-first RAG.`,
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
    "State, nodes, edges, conditional routing, cycles, checkpointing and multi-agent supervision — real LangGraph running on a server kernel.",
  tag: "State, nodes, edges, cycles, checkpoints, multi-agent",
  cells: build("langgraph", [
    [
      "md",
      `# LangGraph fundamentals

LangGraph models an agent as a **state machine**: a shared **state** flows through **nodes**, wired by **edges** — including **conditional edges** (routing) and **cycles** (loops). That's what makes durable multi-step, multi-agent systems tractable.

${INTRO_NOTE}`,
    ],
    [
      "code",
      `import langgraph
from typing import TypedDict, Annotated
from operator import add
from langgraph.graph import StateGraph, START, END
from agentswarms import chat_model

llm = chat_model(model="openai/gpt-4o-mini", temperature=0)
print("langgraph ready")`,
    ],
    [
      "md",
      `## 1 · State, nodes and edges

State is a \`TypedDict\`. Each node returns only the keys it changed; LangGraph merges them. Annotated reducers (like \`add\`) control how values combine.`,
    ],
    [
      "code",
      `class HelloState(TypedDict):
    name: str
    greeting: str

def greet(state: HelloState):
    return {"greeting": f"Hello, {state['name']}!"}

def shout(state: HelloState):
    return {"greeting": state["greeting"].upper()}

g = StateGraph(HelloState)
g.add_node("greet", greet)
g.add_node("shout", shout)
g.add_edge(START, "greet")
g.add_edge("greet", "shout")
g.add_edge("shout", END)
app = g.compile()

print(app.invoke({"name": "Ada"}))`,
    ],
    [
      "md",
      `## 2 · Conditional edges (routing)

A router function inspects state and returns the next node's name.`,
    ],
    [
      "code",
      `class TriageState(TypedDict):
    question: str
    intent: str
    answer: str

def classify(state: TriageState):
    q = state["question"].lower()
    billing = any(w in q for w in ("refund", "charge", "invoice", "billing"))
    return {"intent": "billing" if billing else "general"}

def route(state: TriageState) -> str:
    return "billing" if state["intent"] == "billing" else "general"

def billing(state: TriageState):
    return {"answer": "Routed to the BILLING specialist."}

def general(state: TriageState):
    return {"answer": "Routed to the GENERAL assistant."}

g = StateGraph(TriageState)
g.add_node("classify", classify); g.add_node("billing", billing); g.add_node("general", general)
g.add_edge(START, "classify")
g.add_conditional_edges("classify", route, {"billing": "billing", "general": "general"})
g.add_edge("billing", END); g.add_edge("general", END)
triage = g.compile()

print(triage.invoke({"question": "I want a refund on my invoice"})["answer"])
print(triage.invoke({"question": "How do I rename a project?"})["answer"])`,
    ],
    [
      "md",
      `## 3 · Cycles — the agent loop

The superpower of graphs is **loops**: an \`agent\` node decides, a \`tools\` node acts, and a conditional edge loops back until done. Annotated \`add\` accumulates the scratchpad across iterations.`,
    ],
    [
      "code",
      `import json

class LoopState(TypedDict):
    question: str
    scratch: Annotated[list, add]
    answer: str

FACTS = {"capital of france": "Paris", "speed of light": "299,792 km/s"}

def agent(state: LoopState):
    history = "\\n".join(state["scratch"])
    raw = llm.invoke(
        'Decide the next step as ONE JSON object.\\n'
        'Use a tool: {"action":"lookup","query":"..."}  or finish: {"action":"final","answer":"..."}\\n'
        f"Question: {state['question']}\\nHistory:\\n{history}"
    ).content
    move = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    if move.get("action") == "final":
        return {"answer": move.get("answer", ""), "scratch": ["final"]}
    return {"scratch": [f"lookup:{move.get('query','')}"]}

def tools(state: LoopState):
    q = state["scratch"][-1].split("lookup:", 1)[-1]
    return {"scratch": [f"observation: {FACTS.get(q.strip().lower(), 'no result')}"]}

def should_continue(state: LoopState) -> str:
    return END if state.get("answer") else "tools"

g = StateGraph(LoopState)
g.add_node("agent", agent); g.add_node("tools", tools)
g.add_edge(START, "agent")
g.add_conditional_edges("agent", should_continue, {END: END, "tools": "tools"})
g.add_edge("tools", "agent")
loop = g.compile()

print(loop.invoke({"question": "What is the capital of France?", "scratch": []})["answer"])`,
    ],
    [
      "md",
      `## 4 · Checkpointing & human-in-the-loop

A **checkpointer** persists state per thread, so a graph can pause for approval and resume later. \`interrupt_before\` stops execution before a risky node.`,
    ],
    [
      "code",
      `from langgraph.checkpoint.memory import MemorySaver

class ApprovalState(TypedDict):
    n: int
    proposed: str
    result: str

def plan(state: ApprovalState):
    return {"proposed": f"DELETE {state['n']} stale records"}

def apply_change(state: ApprovalState):
    return {"result": f"Deleted {state['n']} records"}

g = StateGraph(ApprovalState)
g.add_node("plan", plan); g.add_node("apply", apply_change)
g.add_edge(START, "plan"); g.add_edge("plan", "apply"); g.add_edge("apply", END)
approval = g.compile(checkpointer=MemorySaver(), interrupt_before=["apply"])

cfg = {"configurable": {"thread_id": "job-1"}}
paused = approval.invoke({"n": 42}, cfg)
print("paused before apply →", paused["proposed"])
print("state next:", approval.get_state(cfg).next)

# A human approves; resume by invoking with None.
print("resumed →", approval.invoke(None, cfg)["result"])`,
    ],
    [
      "md",
      `## 5 · Multi-agent (supervisor)

A **supervisor** routes work to specialist workers and decides when the job is done — the backbone of multi-agent systems.`,
    ],
    [
      "code",
      `class TeamState(TypedDict):
    topic: str
    research: str
    draft: str

def supervisor(state: TeamState):
    return {}

def sup_route(state: TeamState) -> str:
    if not state.get("research"):
        return "researcher"
    if not state.get("draft"):
        return "writer"
    return END

def researcher(state: TeamState):
    return {"research": llm.invoke(f"List 3 crisp bullet facts about {state['topic']}.").content}

def writer(state: TeamState):
    return {"draft": llm.invoke(
        f"Write a 2-sentence summary of {state['topic']} using these notes:\\n{state['research']}"
    ).content}

g = StateGraph(TeamState)
g.add_node("supervisor", supervisor); g.add_node("researcher", researcher); g.add_node("writer", writer)
g.add_edge(START, "supervisor")
g.add_conditional_edges("supervisor", sup_route,
                        {"researcher": "researcher", "writer": "writer", END: END})
g.add_edge("researcher", "supervisor"); g.add_edge("writer", "supervisor")
team = g.compile()

out = team.invoke({"topic": "vector databases"})
print("RESEARCH:\\n", out["research"], "\\n\\nDRAFT:\\n", out["draft"])`,
    ],
    [
      "md",
      `## Map it to AgentSwarms

Every primitive here is also a no-code building block: **nodes/edges** → the visual **Swarm Canvas**, **conditional edges** → router nodes, **interrupts** → approval nodes, **supervisor/workers** → a coordinator swarm. Prototype in Python here, then rebuild visually for durability, tracing and one-click deploy.`,
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
    "Documents, nodes, retrievers, query engines and response synthesis — real LlamaIndex, with your Knowledge Base as the managed index.",
  tag: "Documents, nodes, retrievers, query engines",
  cells: build("llamaindex", [
    [
      "md",
      `# LlamaIndex fundamentals

LlamaIndex is retrieval-first: **Documents** → **Nodes** → an **Index** → a **Retriever** → a **Query Engine** that retrieves-then-synthesises.

The big idea here: **your AgentSwarms Knowledge Base is the managed index.** Ingest under **Knowledge Base** and \`agentswarms.kb_retriever()\` gives you a real LlamaIndex retriever over it — hybrid search, no embedding model to configure, access scoped to what you may read.

${INTRO_NOTE}`,
    ],
    [
      "code",
      `import llama_index.core
from llama_index.core import Document, Settings
from agentswarms import llama_llm, kb_retriever

Settings.llm = llama_llm(model="openai/gpt-4o-mini")
print("llama_index ready; LLM:", type(Settings.llm).__name__)`,
    ],
    [
      "md",
      `## 1 · Documents → Nodes (chunking)

A \`Document\` is raw text + metadata; a \`Node\` is a chunk. Chunking drives retrieval quality.`,
    ],
    [
      "code",
      `from llama_index.core.node_parser import SentenceSplitter

doc = Document(text=(
    "AgentSwarms is a self-hosted agentic AI platform. "
    "It bundles an Agent Builder, a visual Swarm Canvas and a BI workspace. "
    "Knowledge Bases provide managed retrieval over your documents. "
    "Every model call is governed by IAM rules and logged in Traces. "
    "Agents call tools, use skills, apply guardrails and reach MCP servers."
), metadata={"source": "overview"})

nodes = SentenceSplitter(chunk_size=120, chunk_overlap=20).get_nodes_from_documents([doc])
for i, n in enumerate(nodes):
    print(f"[node {i}] {n.text[:90]}…")`,
    ],
    [
      "md",
      `## 2 · Retrievers

A retriever returns the top-k nodes for a query. \`kb_retriever()\` is a real \`BaseRetriever\` over your managed Knowledge Base.`,
    ],
    [
      "code",
      `retriever = kb_retriever(top_k=3)
hits = retriever.retrieve("What is the refund policy?")
print("retrieved", len(hits), "nodes")
for h in hits:
    print("-", h.node.metadata.get("knowledge_base"), "/", h.node.metadata.get("document"))
    print(" ", h.node.text[:110], "…")`,
    ],
    [
      "md",
      `## 3 · Query engine (retrieve → synthesise)

\`RetrieverQueryEngine\` combines a retriever with a response synthesiser: it fetches nodes and asks the LLM to answer *from them*.`,
    ],
    [
      "code",
      `from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core import get_response_synthesizer

engine = RetrieverQueryEngine(
    retriever=retriever,
    response_synthesizer=get_response_synthesizer(response_mode="compact"),
)

response = engine.query("What is the refund policy?")
print(response)
print("\\nsources:", len(response.source_nodes))`,
    ],
    [
      "md",
      `## 4 · Response synthesis modes

\`compact\` packs as much context as fits; \`refine\` walks chunk-by-chunk improving the answer; \`tree_summarize\` merges hierarchically. Swap the mode and compare.`,
    ],
    [
      "code",
      `for mode in ["compact", "refine", "tree_summarize"]:
    eng = RetrieverQueryEngine(
        retriever=retriever,
        response_synthesizer=get_response_synthesizer(response_mode=mode),
    )
    print(f"--- {mode} ---")
    print(str(eng.query("Summarise the refund policy in one sentence."))[:200], "\\n")`,
    ],
    [
      "md",
      `## 5 · Querying a document directly

You can also build an index over documents you hold in memory. A \`SummaryIndex\` needs no embeddings, so it works with the platform-routed LLM out of the box.`,
    ],
    [
      "code",
      `from llama_index.core import SummaryIndex

index = SummaryIndex(nodes)
print(index.as_query_engine().query("What does the platform govern, and where is it logged?"))`,
    ],
    [
      "md",
      `## Point it at your real data

- **Managed (recommended):** ingest under **Knowledge Base** (files, URLs, GitHub, object storage), then \`kb_retriever()\` — chunking, embeddings, hybrid search and re-ranking are handled for you.
- **Your own index:** \`pip install\` any vector store and embedding model in this kernel and build a \`VectorStoreIndex\` directly.
- **No-code:** attach a Knowledge Base to an agent in **Agent Builder** and it does RAG automatically.`,
    ],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// 4) Mix / capstone — the agentic stack
// ─────────────────────────────────────────────────────────────────────────────
const agenticStack: SampleNotebook = {
  slug: "agentic-stack",
  title: "Mix of all — the agentic stack",
  framework: "Agentic stack",
  description:
    "Combine LangChain, LangGraph and LlamaIndex on AgentSwarms: knowledge base, tools, skills, guardrails, MCP and a multi-agent RAG service.",
  tag: "KB · tools · skills · guardrails · MCP · multi-agent",
  cells: build("agentic-stack", [
    [
      "md",
      `# Mix of all — the agentic stack

The other samples teach the frameworks. This one combines them **on AgentSwarms** and shows how to use the platform's building blocks from Python: your **knowledge base**, **tools**, **skills**, **guardrails** and **MCP** — ending in a small multi-agent RAG service.

| Framework idea | AgentSwarms building block |
|---|---|
| Retriever / index | **Knowledge Base** — \`agentswarms.kb_retriever()\` |
| LLM | **Governed models** — \`agentswarms.chat_model()\` |
| Tools | **Tools** (built-in per agent + your own functions) |
| Reusable prompt modules | **Skills** (\`/skills\`) |
| Output validators | **Guardrails** (+ IAM model rules & budgets) |
| External tool servers | **MCP servers** (\`/mcp\`) |
| Graph / supervisor | **Swarm Canvas** |

${INTRO_NOTE}`,
    ],
    [
      "code",
      `from agentswarms import chat_model, kb_retriever, list_knowledge_bases
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

llm = chat_model(model="openai/gpt-4o-mini", temperature=0)
retriever = kb_retriever(top_k=4)
print("ready")`,
    ],
    [
      "md",
      `## 1 · Use your existing Knowledge Base

Ingest documents under **Knowledge Base** and the platform chunks, embeds, stores and hybrid-searches them. Access is enforced by the same rules as everywhere else — you only see KBs you own, were granted, or that are public samples.`,
    ],
    [
      "code",
      `import asyncio
kbs = asyncio.run(list_knowledge_bases())
print("readable knowledge bases:", [k["name"] for k in kbs][:8] or "(none yet)")

nodes = retriever.retrieve("refund policy")
print("retrieved:", len(nodes), "nodes")`,
    ],
    [
      "md",
      `## 2 · Build tools

A **tool** is a function the model can call. Agents get built-in tools (KB search, SQL, web, code) toggled per agent in **Agent Builder**; here you define your own with LangChain's \`@tool\`.`,
    ],
    [
      "code",
      `from langchain_core.tools import tool

@tool
def kb_lookup(query: str) -> str:
    """Search the knowledge base and return matching passages."""
    found = retriever.retrieve(query)
    return "\\n".join(f"[{i}] {n.node.text}" for i, n in enumerate(found, 1)) or "no matches"

@tool
def calculator(expression: str) -> str:
    """Evaluate a basic arithmetic expression."""
    allowed = set("0123456789+-*/(). ")
    expr = "".join(c for c in expression if c in allowed)
    return str(eval(expr))  # demo only — never eval untrusted input in production

TOOLS = {t.name: t for t in [kb_lookup, calculator]}
print(list(TOOLS), "|", calculator.invoke({"expression": "12 * (3 + 4)"}))`,
    ],
    [
      "md",
      `## 3 · Compose skills

A **skill** (see \`/skills\`) is a reusable, named block of instructions you attach to an agent — "support triager", "SQL analyst", "brand voice". Rather than rewriting system prompts, you compose them.`,
    ],
    [
      "code",
      `SKILLS = {
    "concise": "Answer in at most two sentences. No filler.",
    "cite_sources": "Always cite retrieved facts inline like [1], [2].",
    "brand_voice": "Warm, professional, first-person plural ('we').",
}

def system_prompt(*names, base="You are a customer support agent."):
    return base + "".join(f"\\n- {SKILLS[n]}" for n in names)

print(system_prompt("concise", "cite_sources", "brand_voice"))`,
    ],
    [
      "md",
      `## 4 · Apply guardrails

Two layers work together:

- **Platform governance (already on):** every model call is checked against your admin's **IAM model rules** and your **budgets**, and recorded in **Traces**. You get that for free — it's why no API key lives in this kernel.
- **Your own guardrails:** validate input (block disallowed requests) and output (enforce a schema, retry on violation).`,
    ],
    [
      "code",
      `from langchain_core.output_parsers import JsonOutputParser
from pydantic import BaseModel, Field

BLOCKLIST = ("password", "credit card", "ssn")

def input_guard(text: str) -> str:
    hit = next((w for w in BLOCKLIST if w in text.lower()), None)
    if hit:
        raise ValueError(f"Blocked by guardrail: request mentions '{hit}'.")
    return text

class Summary(BaseModel):
    summary: str = Field(description="one sentence")
    priority: str = Field(description="low, medium, high or urgent")

guarded = JsonOutputParser(pydantic_object=Summary)
chain = (ChatPromptTemplate.from_template("{fmt}\\n\\nTicket: {ticket}")
         .partial(fmt=guarded.get_format_instructions()) | llm | guarded)

try:
    input_guard("please reset my password and read my ssn")
except ValueError as e:
    print("INPUT:", e)

print("OUTPUT:", chain.invoke({"ticket": "Checkout is down for EU customers since 09:00."}))`,
    ],
    [
      "md",
      `## 5 · Reach MCP servers

**MCP** (Model Context Protocol) lets agents use tools hosted by *external* servers — GitHub, a database, an internal API — without hand-coding each integration. Register them under **MCP Servers** (\`/mcp\`); an agent then sees those tools beside its built-ins and the platform brokers the calls (auth, schemas, tracing).

This kernel has \`pip\` and network access through the egress allowlist, so you can also drive MCP directly:

\`\`\`python
!pip install mcp
from mcp import ClientSession
from mcp.client.stdio import stdio_client
async with stdio_client(server_params) as (read, write):
    async with ClientSession(read, write) as session:
        tools = (await session.list_tools()).tools
\`\`\`

For production, prefer registering the server under \`/mcp\` so calls are governed and traced like everything else.`,
    ],
    [
      "md",
      `## 6 · Put it together — a multi-agent RAG service

A LangGraph **supervisor** over a LangChain **retrieval chain** and a **tool worker**, with the guardrail on the way in. This is the whole stack in one graph.`,
    ],
    [
      "code",
      `import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

class SvcState(TypedDict):
    question: str
    route: str
    answer: str

def triage(state: SvcState):
    q = state["question"].lower()
    return {"route": "math" if any(c.isdigit() for c in q) and "*" in q or "calculate" in q else "docs"}

def docs_agent(state: SvcState):
    ctx = kb_lookup.invoke({"query": state["question"]})
    answer = (ChatPromptTemplate.from_messages([
        ("system", system_prompt("concise", "cite_sources")),
        ("human", "Context:\\n{ctx}\\n\\nQuestion: {q}"),
    ]) | llm | StrOutputParser()).invoke({"ctx": ctx, "q": state["question"]})
    return {"answer": answer}

def math_agent(state: SvcState):
    expr = (ChatPromptTemplate.from_template(
        "Extract ONLY the arithmetic expression from: {q}"
    ) | llm | StrOutputParser()).invoke({"q": state["question"]})
    return {"answer": f"= {calculator.invoke({'expression': expr})}"}

g = StateGraph(SvcState)
g.add_node("triage", triage); g.add_node("docs", docs_agent); g.add_node("math", math_agent)
g.add_edge(START, "triage")
g.add_conditional_edges("triage", lambda s: s["route"], {"docs": "docs", "math": "math"})
g.add_edge("docs", END); g.add_edge("math", END)
service = g.compile()

def ask(q):
    input_guard(q)
    return service.invoke({"question": q})["answer"]

print("Q1:", ask("What is the refund policy?"))
print("Q2:", ask("Please calculate 30 * 12"))`,
    ],
    [
      "md",
      `## Deploy it

You've built an agentic service in Python. To run it outside the notebook:

- **Rebuild it visually** in **Agent Builder / Swarm Canvas** — those already deploy as APIs, run on schedules, and stream to embeds.
- **Or keep the code**: fork this notebook, \`pip install\` what you need, and the same kernel image runs it as a **batch job** (headless, resource-capped) — see \`docs/DEVELOPER_WORKSPACE_RUNTIME.md\`.

Either way, model and knowledge access stays governed by IAM, capped by budgets, and visible in Traces.`,
    ],
  ]),
};

export const SAMPLE_NOTEBOOKS: SampleNotebook[] = [langchain, langgraph, llamaindex, agenticStack];

export function getSampleNotebook(slug: string): SampleNotebook | undefined {
  return SAMPLE_NOTEBOOKS.find((n) => n.slug === slug);
}
