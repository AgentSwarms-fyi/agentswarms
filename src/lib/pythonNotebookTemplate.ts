// Cell model + starter template for user-authored Python notebooks.
// Every new notebook opens with a short orientation and runnable cells that
// exercise the server kernel: a governed LangChain model, knowledge-base
// retrieval, and plain Python.

export type PyCell = {
  id: string;
  type: "markdown" | "code";
  source: string;
};

function cell(type: PyCell["type"], source: string): PyCell {
  return { id: crypto.randomUUID(), type, source };
}

export function newPythonNotebookCells(): PyCell[] {
  return [
    cell(
      "markdown",
      `# Your Python notebook

This runs on a **sandboxed server kernel** — real CPython with \`pip install\` and the agentic frameworks pre-installed (LangChain, LangGraph, LlamaIndex). The kernel starts on your first run and keeps state between cells, so variables and imports carry forward. Top-level \`await\` works.

## Calling models

\`agentswarms.chat_model()\` returns a **real LangChain \`BaseChatModel\`** that routes through your account. Use it anywhere a LangChain model is accepted — LCEL chains, LangGraph nodes, agents:

\`\`\`python
from agentswarms import chat_model
llm = chat_model(model="openai/gpt-4o-mini")
\`\`\`

Your administrator's model rules apply, calls count toward your budget, and every one shows up in **Traces**. No provider API key exists inside this sandbox.

## Installing packages

\`\`\`python
!pip install <anything>
\`\`\`
`,
    ),
    cell(
      "code",
      `from agentswarms import chat_model
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

# Point this at any model your account may use.
llm = chat_model(model="openai/gpt-4o-mini", temperature=0.3)

chain = ChatPromptTemplate.from_template(
    "In two sentences: {question}"
) | llm | StrOutputParser()

print(chain.invoke({"question": "why are multi-agent systems harder to debug than single agents?"}))
`,
    ),
    cell(
      "markdown",
      `## Retrieval from your Knowledge Base

\`kb_retriever()\` is a real retriever over your managed Knowledge Base — hybrid search, no embedding model to configure, and scoped to what your account may read.`,
    ),
    cell(
      "code",
      `from agentswarms import kb_retriever

retriever = kb_retriever(top_k=3)
nodes = retriever.retrieve("What is our refund policy?")

if not nodes:
    print("No matches — add documents under Knowledge Base first.")
for i, n in enumerate(nodes, 1):
    print(f"[{i}] {n.node.metadata.get('document')}: {n.node.text[:120]}…")
`,
    ),
    cell(
      "markdown",
      `## Plain Python

Anything CPython can do, this kernel can do. The last expression in a cell is displayed as its result, like Jupyter.`,
    ),
    cell(
      "code",
      `import statistics

latencies_ms = [220, 340, 180, 950, 310, 290, 1450, 260]
print("mean:", round(statistics.mean(latencies_ms), 1), "ms")
print("p50 :", statistics.median(latencies_ms), "ms")

slow = [x for x in latencies_ms if x > 500]
f"{len(slow)} slow calls out of {len(latencies_ms)}"
`,
    ),
  ];
}
