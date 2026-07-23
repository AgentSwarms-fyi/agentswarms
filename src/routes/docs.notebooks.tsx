import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/notebooks")({
  head: () => ({
    meta: [
      { title: "Developer workspace — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "In-browser Python notebooks (Pyodide): learn LangChain, LangGraph and LlamaIndex from runnable samples, call your connected models, and retrieve from your knowledge base.",
      },
      { property: "og:title", content: "Developer workspace — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Read-only framework samples plus your own Python notebooks in the browser — with helpers for calling models and searching your knowledge base.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Developer workspace — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "Read-only framework samples plus your own Python notebooks in the browser — with helpers for calling models and searching your knowledge base.",
      },
    ],
  }),
  component: NotebooksDoc,
});

function NotebooksDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Developer workspace"
        description="Python notebooks at /notebooks that execute in your browser — real CPython via Pyodide, nothing to install. Start from read-only framework samples, or write your own and call models and knowledge bases through your account."
      />

      <H2 id="samples">Framework samples</H2>
      <P>
        The workspace ships with four read-only sample notebooks under{" "}
        <strong>Learn by example</strong>:
      </P>
      <UL>
        <li>
          <strong>LangChain fundamentals</strong> — models, prompt templates, output parsers, LCEL
          chains, tools/agents, memory, and RAG.
        </li>
        <li>
          <strong>LangGraph fundamentals</strong> — state, nodes, edges, conditional routing,
          cycles, human-in-the-loop, and multi-agent supervisors.
        </li>
        <li>
          <strong>LlamaIndex fundamentals</strong> — documents, nodes, indexes, retrievers, and
          query engines.
        </li>
        <li>
          <strong>Mix of all — the agentic stack</strong> — using your knowledge base, building
          tools, composing skills, applying guardrails, reaching MCP servers, and wiring a small
          multi-agent RAG service.
        </li>
      </UL>
      <Note>
        Pyodide can't <code>pip install</code> the real LangChain / LangGraph / LlamaIndex packages
        (native dependencies and blocked sockets). So each sample teaches the framework twice: a{" "}
        <strong>reference block</strong> shows the framework's actual API (copy it into a full Python
        environment), and a <strong>runnable cell</strong> reproduces the same idea live using the
        built-in <code>agentswarms</code> helper. You get correct framework syntax to learn from and
        a working demo you can run without leaving the browser.
      </Note>

      <H2 id="fork">Read-only &amp; fork</H2>
      <P>
        Samples can be <strong>run</strong> cell-by-cell but not edited. Click{" "}
        <strong>Fork to my notebooks</strong> to copy a sample into an editable notebook owned by
        your account — then change anything and it autosaves. Your own notebooks live under{" "}
        <strong>My notebooks</strong> and are private to you.
      </P>

      <H2 id="how-cells-run">How cells run</H2>
      <UL>
        <li>
          Each code cell is a real editor (CodeMirror) — run it with the play button or{" "}
          <strong>Shift+Enter</strong>. stdout, the last expression's value, errors, and run
          duration appear under the cell.
        </li>
        <li>
          Cells execute <strong>in your browser</strong> on Pyodide (CPython compiled to
          WebAssembly). The first run downloads the runtime (~10&nbsp;MB); after that it's cached.
        </li>
        <li>
          All cells share one interpreter, Jupyter-style: variables defined in one cell are visible
          in the next, and top-level <code>await</code> is supported.
        </li>
        <li>
          Packages bundled with Pyodide (numpy, pandas, scipy, scikit-learn, …) load automatically
          on import. Pure-Python packages from PyPI install with{" "}
          <code>import micropip; await micropip.install("…")</code>.
        </li>
      </UL>

      <H2 id="helper">The agentswarms helper</H2>
      <P>
        An <code>agentswarms</code> module is injected into every notebook. It routes calls through
        your account — your provider keys, your IAM model rules, your budgets, logged in{" "}
        <DocLink to="/traces">Traces</DocLink>:
      </P>
      <UL>
        <li>
          <code>
            reply = await agentswarms.chat("…", provider="openrouter", model="openai/gpt-4o-mini")
          </code>{" "}
          — a chat completion through any OpenAI-compatible provider you've connected under{" "}
          <DocLink to="/integrations">Integrations</DocLink> (openrouter, openai, gemini, groq, grok,
          qwen, ollama, vllm, nvidia).
        </li>
        <li>
          <code>hits = await agentswarms.kb_search("refund policy", top_k=5)</code> — hybrid
          (vector + keyword) retrieval over your <DocLink to="/knowledge">Knowledge Base</DocLink>.
          Access is enforced by the same rules as everywhere else: you only search KBs you own, were
          granted, or that are public samples.
        </li>
        <li>
          <code>kbs = await agentswarms.list_knowledge_bases()</code> — the knowledge bases your
          account can read.
        </li>
        <li>
          <code>agentswarms.format_context(hits)</code> — turn retrieval results into a numbered
          context block for a prompt.
        </li>
      </UL>

      <Note>
        The runtime is sandboxed in the browser: no filesystem beyond Pyodide's virtual FS, no
        native extensions outside the bundled scientific stack, and network access only via HTTP
        from your session.
      </Note>

      <H2 id="where-they-fit">Where the workspace fits</H2>
      <P>
        The Developer workspace is the free-form counterpart to the rest of the platform: meet a
        pattern in the <DocLink to="/learn">lessons</DocLink>, prototype it here in Python with real
        model calls and retrieval, then rebuild it as a durable, deployable system on the{" "}
        <DocLink to="/docs/swarms">Swarm Canvas</DocLink> and in{" "}
        <DocLink to="/agents">Agent Builder</DocLink>.
      </P>

      <NextPrev current="/docs/notebooks" />
    </>
  );
}
