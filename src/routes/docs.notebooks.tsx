import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  Note,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/notebooks")({
  head: () => ({
    meta: [
      { title: "Developer workspace — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Python notebooks on sandboxed server kernels: build with real LangChain, LangGraph and LlamaIndex, call your governed models, and retrieve from your knowledge base.",
      },
      { property: "og:title", content: "Developer workspace — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Real-framework sample notebooks plus your own, running on sandboxed server kernels with governed model and knowledge-base access.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Developer workspace — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "Real-framework sample notebooks plus your own, running on sandboxed server kernels with governed model and knowledge-base access.",
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
        description="Python notebooks at /notebooks that execute on sandboxed server kernels — real CPython with pip and the agentic frameworks pre-installed. Start from read-only framework samples, or write your own and call models and knowledge bases through your account."
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
        Every cell is real framework code — actual <code>langchain</code>, <code>langgraph</code>{" "}
        and <code>llama_index</code> imports executing on a container kernel. Model calls go through{" "}
        <code>agentswarms.chat_model()</code>, a genuine LangChain <code>BaseChatModel</code> that
        routes via the platform, so your IAM model rules, budgets and Traces apply and{" "}
        <strong>no provider key ever exists inside the sandbox</strong>. All four samples are
        executed end-to-end in CI-style verification before release.
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
          Cells execute on a <strong>sandboxed container kernel</strong> — non-root, read-only root
          filesystem, capabilities dropped, network egress restricted to an allowlist. The kernel
          starts on your first run and is reaped when idle.
        </li>
        <li>
          All cells share one interpreter, Jupyter-style: variables defined in one cell are visible
          in the next, and top-level <code>await</code> is supported.
        </li>
        <li>
          LangChain, LangGraph, LlamaIndex, pandas and numpy are pre-installed; anything else is a{" "}
          <code>!pip install</code> away (writes land in a per-session writable layer).
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
          <DocLink to="/integrations">Integrations</DocLink> (openrouter, openai, gemini, groq,
          grok, qwen, ollama, vllm, nvidia).
        </li>
        <li>
          <code>hits = await agentswarms.kb_search("refund policy", top_k=5)</code> — hybrid (vector
          + keyword) retrieval over your <DocLink to="/knowledge">Knowledge Base</DocLink>. Access
          is enforced by the same rules as everywhere else: you only search KBs you own, were
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
        <li>
          <code>llm = agentswarms.chat_model(model="openai/gpt-4o-mini")</code> — a real LangChain{" "}
          <code>BaseChatModel</code>. Use it anywhere a LangChain model is accepted:{" "}
          <code>chain = prompt | llm | StrOutputParser()</code>, LangGraph nodes, and so on. It
          supports tool-calling via <code>llm.bind_tools([...])</code>, so LangGraph's{" "}
          <code>create_react_agent</code> and <code>ToolNode</code> work too.
        </li>
        <li>
          <code>agentswarms.llama_llm(...)</code> and <code>agentswarms.kb_retriever(top_k=4)</code>{" "}
          — a LlamaIndex LLM and a retriever over your Knowledge Base (managed hybrid search, no
          embedding model to configure).
        </li>
      </UL>

      <Note>
        Each session gets its own container: non-root, read-only root filesystem, all Linux
        capabilities dropped, no-new-privileges, CPU/memory/PID limits, and outbound network
        restricted to an operator-managed allowlist. Kernels are ephemeral — files written during a
        session are discarded on teardown; notebooks themselves live in the database. Operators
        enable and tune all of this under <strong>Admin → Developer runtime</strong>.
      </Note>

      <H2 id="where-they-fit">Where the workspace fits</H2>
      <P>
        The Developer workspace is the free-form counterpart to the rest of the platform: sketch a
        pattern here in Python with real model calls and retrieval, then rebuild it as a durable,
        deployable system on the <DocLink to="/docs/swarms">Swarm Canvas</DocLink> and in{" "}
        <DocLink to="/agents">Agent Builder</DocLink>.
      </P>

      <H2 id="runtimes">There is one runtime, and it is off by default</H2>
      <P>
        Notebook cells execute on real container kernels — full CPython, working <C>pip install</C>,
        and the actual agentic frameworks. There is <strong>no in-browser fallback</strong>: until
        an administrator enables the server runtime, opening a notebook shows a "runtime required"
        panel with the command to run rather than a half-working editor.
      </P>
      <Code lang="bash">{`docker compose --profile notebooks up -d --build`}</Code>
      <P>
        Then turn it on under <strong>Admin → Developer runtime</strong>. Enabling it mints the
        signing secret automatically.
      </P>

      <H3 id="libraries">Installing libraries</H3>
      <P>
        The kernel image ships <C>build-essential</C> and sets <C>PIP_USER=1</C> against a writable
        per-session <C>~/.local</C>, so packages with C extensions compile and install fine:
      </P>
      <Code lang="python">{`!pip install polars duckdb scikit-learn`}</Code>
      <Callout kind="warn" title="Installs only reach hosts on the egress allow-list">
        Kernels have no direct internet — their only route out is a default-deny proxy. PyPI is
        always permitted, so ordinary installs work. Anything that fetches from somewhere else —{" "}
        <C>pip install git+https://github.com/…</C>, a model download from Hugging Face, a private
        index — fails until an administrator adds that host under{" "}
        <strong>Admin → Developer runtime → Egress allow-list</strong>. Saving there now writes the
        list and restarts the proxy, and the UI tells you if either step didn't happen.
      </Callout>

      <Table
        headers={["Env var", "Values", "Purpose"]}
        rows={[
          [<C key="a">NOTEBOOK_RUNTIME_ENABLED</C>, "on / off", "Master switch"],
          [
            <C key="b">NOTEBOOK_RUNTIME_BACKEND</C>,
            "docker | k8s | e2b",
            "Where kernels are launched",
          ],
          [<C key="c">NOTEBOOK_RUNTIME_IMAGE</C>, "image ref", "Kernel image"],
          [<C key="d">NOTEBOOK_GATEWAY_URL</C>, "url", "Websocket gateway the browser connects to"],
          [
            <C key="e">NOTEBOOK_RUNTIME_SECRET</C>,
            "secret",
            "Session-token signing key; generated if omitted",
          ],
          [
            <C key="f">NOTEBOOK_CRON_TOKEN</C>,
            "token",
            "Presented by the external cron that reaps idle sessions",
          ],
        ]}
      />
      <Callout kind="warn" title="The docker backend is single-host">
        It launches kernel containers on the machine the app runs on. To spread kernels across
        nodes, use the k8s backend.
      </Callout>

      <H2 id="egress">Kernel network isolation</H2>
      <P>
        Kernels sit on an internal network with <strong>no direct internet access</strong>. Their
        only route out is a default-deny egress proxy with an allow-list, so a notebook cannot
        exfiltrate data to an arbitrary host — and a pip install only works for hosts you permit.
      </P>

      <H3 id="run-agent">Calling your deployed agents and swarms</H3>
      <P>
        The helper also reaches the things you have already built, so a notebook can orchestrate
        them rather than re-implement them:
      </P>
      <Table
        headers={["Call", "Returns"]}
        rows={[
          [<C key="a">await agentswarms.chat(prompt, model=…)</C>, "A raw model completion"],
          [<C key="b">await agentswarms.kb_search(query)</C>, "Knowledge base hits"],
          [<C key="c">await agentswarms.list_knowledge_bases()</C>, "Collections you can read"],
          [
            <C key="e">await agentswarms.run_swarm(swarm_id, input)</C>,
            "A saved swarm's final output",
          ],
          [<C key="f">await agentswarms.list_agents()</C>, "Your agents and swarms, with ids"],
          [
            <C key="d">await agentswarms.run_agent(agent_id, prompt)</C>,
            <>
              <strong key="x">Not available</strong> — returns 501. See below.
            </>,
          ],
        ]}
      />
      <Code lang="python">{`import agentswarms

catalog = await agentswarms.list_agents()
swarm_id = catalog["swarms"][0]["id"]

result = await agentswarms.run_swarm(swarm_id, "Summarise ticket 48213")
print(result)`}</Code>
      <Callout kind="why">
        <C>run_swarm</C> is not <C>chat</C> with extra steps. It runs what you built exactly as
        configured, so a notebook gets the same behaviour as the canvas instead of a Python
        re-implementation that drifts from it. Provider keys never enter the sandbox — the call is
        brokered by the platform and stays governed by IAM model rules, budgets and traces.
      </Callout>
      <Callout kind="warn" title="run_agent returns 501, and always has">
        The kernel authenticates with a runtime session token; the chat route accepts only a user
        JWT or the internal-run secret, so this call has never succeeded from a notebook. It is
        listed here because the function exists in the helper and you will find it — not because it
        works.
        <br />
        <br />
        <strong>
          To run one saved agent from a notebook, wrap it in a single-node swarm.
        </strong>{" "}
        Importing an agent onto a swarm node copies its prompt, model, tools and knowledge base onto
        that node, so the run is faithful to the agent. The one difference worth knowing: the copy
        is a <em>snapshot</em>, so later edits to the agent do not reach a swarm built from it —
        re-import the node to pick them up.
      </Callout>
      <Callout kind="warn" title="Approval nodes are rejected, not awaited">
        A notebook cell is unattended, so a swarm that reaches a human approval gate fails fast
        rather than hanging until the run timeout.
      </Callout>
      <Callout kind="info">
        Sample notebooks ship read-only. Fork one to get an editable copy — that way the originals
        stay a working reference no matter what you do to your copy.
      </Callout>

      <H2 id="publish">Publishing a notebook as an API</H2>
      <P>
        A notebook can be called by your own systems. Open it and click <strong>Publish</strong> to
        mint an API key; anything that can send an HTTP request can then run it.
      </P>
      <UL>
        <li>
          <strong>Key name</strong> — how you will recognise it later. Mint one per caller so you
          can revoke a single integration without breaking the others.
        </li>
        <li>
          <strong>Entrypoint function</strong> — the function called with the request body, defaults
          to <C>entrypoint</C>. Leave it empty to run the notebook top to bottom and return the last
          expression instead.
        </li>
      </UL>
      <P>
        Define the entrypoint in any cell. It receives the JSON you post under <C>inputs</C> and its
        return value becomes the response:
      </P>
      <Code lang="python">{`async def entrypoint(inputs):
    date = inputs.get("date")
    hits = await agentswarms.kb_search(f"incidents on {date}", top_k=5)
    summary = await agentswarms.chat(
        f"Summarise these incidents:\\n{agentswarms.format_context(hits)}"
    )
    return {"date": date, "summary": summary}`}</Code>
      <Code lang="bash">{`curl -X POST https://your-instance/api/notebook/run \\
  -H "Authorization: Bearer nbk_…" \\
  -H "Content-Type: application/json" \\
  -d '{"inputs": {"date": "2026-07-28"}}'`}</Code>
      <Table
        headers={["Field", "Type", "Meaning"]}
        rows={[
          [<C key="a">inputs</C>, "object", "Passed to the entrypoint. Optional — omit for none."],
          [
            <C key="b">async</C>,
            "boolean",
            "true returns 202 with a runId immediately instead of waiting",
          ],
        ]}
      />
      <P>
        A synchronous call waits up to <strong>110 seconds</strong>. If the run is still going it
        returns <C>202</C> with a <C>runId</C> rather than holding the connection open — poll it the
        same way an <C>async</C> run is polled:
      </P>
      <Code lang="bash">{`curl -X POST https://your-instance/api/notebook/run/status \\
  -H "Authorization: Bearer nbk_…" \\
  -H "Content-Type: application/json" \\
  -d '{"runId": "…"}'`}</Code>
      <P>
        Status is <C>queued</C>, <C>running</C>, <C>succeeded</C> (with <C>result</C>) or{" "}
        <C>error</C> (with <C>error</C>).
      </P>
      <Callout kind="why">
        The endpoint runs the notebook on the same governed batch kernel a manual run uses — the
        same sandbox, egress allow-list, IAM model rules, budgets and traces. Publishing changes who
        can trigger a notebook, not what it is allowed to do.
      </Callout>
      <Callout kind="warn" title="The key is shown once">
        Keys are stored as a SHA-256 hash, so the plaintext cannot be recovered — copy it when the
        dialog shows it. Lost one? Mint a replacement and revoke the old key. Revoking keeps the row
        (and its last-used timestamp and run count) as an audit trail rather than deleting it, and
        every run is attributed to the key that started it.
      </Callout>

      <H2 id="versioning">Version control (Git)</H2>
      <P>
        Click <strong>Version</strong> in a notebook to commit it to your GitHub or GitLab
        repository. It is written as a plain Python file in the widely used percent format — the
        same <C>{`# %%`}</C> cell markers Jupytext, VS Code and PyCharm understand:
      </P>
      <Code lang="python">{`# %% [markdown]
# ## Load yesterday's incidents

# %%
hits = await agentswarms.kb_search("incidents", top_k=5)`}</Code>
      <UL>
        <li>
          <strong>Commit</strong> writes the notebook plus a small <C>.json</C> manifest recording
          how it is published — the entrypoint and the key prefixes, never a key itself.
        </li>
        <li>
          <strong>History</strong> lists every commit with a link to it, and the header says{" "}
          <em>Uncommitted changes</em> or <em>Up to date</em> so you can tell at a glance whether
          the repo matches what is running.
        </li>
        <li>
          <strong>Restore</strong> reads the file back at that commit and replaces the notebook's
          cells. Anything not committed is lost, so it asks first.
        </li>
      </UL>
      <Callout kind="why">
        A JSON blob of cells is technically versionable and practically useless — a one-word edit
        rewrites the whole line and no reviewer can read the diff. Committing real Python means a
        pull request on a published notebook looks like a pull request on any other code, which is
        the only reason to put it in git in the first place.
      </Callout>
      <Callout kind="info">
        The repository is the same per-user connection <DocLink to="/docs/bi">BI</DocLink> uses for
        dashboards and semantic models — connect it from either place. Published notebooks are also
        included in the bulk <strong>Export now</strong> sync there. The token is stored encrypted
        and never read back.
      </Callout>

      <NextPrev current="/docs/notebooks" />
    </>
  );
}
