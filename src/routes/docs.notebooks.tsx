import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/notebooks")({
  head: () => ({
    meta: [
      { title: "Notebooks — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "67 runnable TypeScript notebooks in the browser: LangChain, LlamaIndex, OpenAI Agents SDK, Vercel AI SDK, Google ADK, evals, multi-agent systems, and failure modes.",
      },
      { property: "og:title", content: "Notebooks — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "67 runnable TypeScript notebooks in the browser — frameworks, evals, multi-agent systems, and failure modes.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/notebooks" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Notebooks — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "67 runnable TypeScript notebooks in the browser — frameworks, evals, multi-agent systems, and failure modes.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/notebooks" }],
  }),
  component: NotebooksDoc,
});

function NotebooksDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Notebooks"
        description="The notebook lab at /notebooks holds 67 runnable TypeScript notebooks. Cells execute in your browser against real models and real framework packages — there is nothing to install."
      />

      <H2 id="tracks">The tracks</H2>
      <P>Notebooks are organized into curated tracks in the left sidebar:</P>
      <UL>
        <li>
          <strong>Framework tracks</strong> — LangChain (and LangGraph), LlamaIndex.ts, OpenAI
          Agents SDK, Vercel AI SDK, Google ADK, and Multi-Agent Systems with LangGraph.js. Each
          track teaches the framework's own primitives (agents, tools, handoffs, state machines) in
          its idiomatic style.
        </li>
        <li>
          <strong>Foundations Lab</strong> — prompt engineering and multimodal work built on raw{" "}
          <code>fetch</code>, so you see the wire format before any framework hides it.
        </li>
        <li>
          <strong>Agentic Evals</strong> — eight notebooks from deterministic checks through
          LLM-as-judge, juries, the RAG triad, trajectory grading, red-teaming, and operational
          metrics.
        </li>
        <li>
          <strong>Failure Modes Lab</strong> — one long notebook that reproduces twelve real
          production failures (runaway loops, prompt injection, RAG poisoning, context rot, cost
          blow-ups) and ships the fix for each.
        </li>
        <li>
          <strong>Standalone Agents, Enterprise Ops &amp; Safety, Real-world Examples</strong> —
          applied patterns: cost routing, semantic chunking, MCP servers, and end-to-end builds.
        </li>
      </UL>

      <H2 id="how-cells-run">How cells run</H2>
      <UL>
        <li>
          Each code cell is a real editor (CodeMirror) — edit the code, then run it with the play
          button or <strong>Shift+Enter</strong>. Output, errors, and run duration appear under the
          cell.
        </li>
        <li>
          Cells execute <strong>in your browser</strong>. Framework packages (LangChain, LlamaIndex,
          and the rest) are loaded as version-pinned ES modules from a CDN at run time.
        </li>
        <li>
          Model calls go through an authenticated, OpenAI-compatible proxy scoped to the notebook (
          <code>/api/notebooks/…/ai/v1</code> with chat, embeddings, and image endpoints), so
          notebooks work without putting an API key in the browser.
        </li>
        <li>
          A <em>Reset</em> control restores every cell to its original source and clears outputs —
          experiments are free.
        </li>
      </UL>

      <Note>
        Notebooks are TypeScript, not Python, on purpose: the same language the platform's exports
        use, runnable with zero environment setup. The reasoning is written up in{" "}
        <DocLink to="/blog/why-we-built-typescript-notebooks-for-agentic-ai">
          the blog post on why we built TypeScript notebooks
        </DocLink>
        .
      </Note>

      <H2 id="where-they-fit">Where notebooks fit</H2>
      <P>
        Notebooks teach the <em>code-level</em> view of the same patterns the rest of the platform
        teaches visually. A typical loop: meet a pattern in the{" "}
        <DocLink to="/learn">lessons</DocLink>, run it as a graph on the{" "}
        <DocLink to="/docs/swarms">Swarm Canvas</DocLink>, then open the matching notebook to build
        the same thing in framework code you could ship anywhere.
      </P>

      <NextPrev current="/docs/notebooks" />
    </>
  );
}
