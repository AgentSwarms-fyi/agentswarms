import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/notebooks")({
  head: () => ({
    meta: [
      { title: "Python Lab — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Create your own Python notebooks that run in the browser (Pyodide): experiment with code and frameworks, and call your connected models straight from Python.",
      },
      { property: "og:title", content: "Python Lab — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "User-authored Python notebooks in the browser — with a built-in helper for calling your connected models.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Python Lab — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "User-authored Python notebooks in the browser — with a built-in helper for calling your connected models.",
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
        title="Python Lab"
        description="Create your own Python notebooks at /notebooks. Cells execute in your browser — real CPython via Pyodide, nothing to install — and can call models through your connected providers."
      />

      <H2 id="creating">Creating a notebook</H2>
      <P>
        Open <DocLink to="/notebooks">/notebooks</DocLink> and hit{" "}
        <strong>New Python notebook</strong>. Every new notebook starts from a template: a notes
        cell explaining how to call models, a runnable chat sample, a structured-JSON sample, and a
        pure-Python experiment. Notebooks are private to your account and autosave as you type.
      </P>

      <H2 id="how-cells-run">How cells run</H2>
      <UL>
        <li>
          Each code cell is a real editor (CodeMirror) — edit the code, then run it with the play
          button or <strong>Shift+Enter</strong>. stdout, the last expression's value, errors, and
          run duration appear under the cell.
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

      <H2 id="models">Calling models</H2>
      <P>
        The injected <code>agentswarms</code> module routes model calls through your account — pick
        the provider yourself:
      </P>
      <UL>
        <li>
          <code>
            reply = await agentswarms.chat("…", provider="openrouter", model="openai/gpt-4o-mini")
          </code>
        </li>
        <li>
          <strong>provider</strong> — any OpenAI-compatible provider you've connected under{" "}
          <DocLink to="/integrations">Integrations</DocLink> (openrouter, openai, gemini, groq,
          grok, qwen, ollama, vllm, nvidia). If the instance has a default OpenRouter key,{" "}
          <code>"openrouter"</code> works with zero setup.
        </li>
        <li>
          <strong>model</strong> — that provider's model id. Browse ids in the{" "}
          <DocLink to="/model-registry">Model Registry</DocLink>.
        </li>
        <li>
          Calls respect your administrator's IAM model rules, are logged in{" "}
          <DocLink to="/traces">Traces</DocLink>, and count toward your budget.
        </li>
      </UL>

      <Note>
        The runtime is sandboxed in the browser: no filesystem beyond Pyodide's virtual FS, no
        native extensions outside the bundled scientific stack, and network access only via HTTP
        from your session.
      </Note>

      <H2 id="where-they-fit">Where the lab fits</H2>
      <P>
        The Python Lab is the free-form counterpart to the rest of the platform: meet a pattern in
        the <DocLink to="/learn">lessons</DocLink>, run it as a graph on the{" "}
        <DocLink to="/docs/swarms">Swarm Canvas</DocLink>, then prototype your own variation in
        Python with real model calls.
      </P>

      <NextPrev current="/docs/notebooks" />
    </>
  );
}
