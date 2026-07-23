import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Introduction — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "What AgentSwarms is, how the platform fits together, and where to start: templates, the Agent Builder, the Swarm Canvas, notebooks, and traces.",
      },
      { property: "og:title", content: "Introduction — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "What AgentSwarms is, how the platform fits together, and where to start.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Introduction — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content: "What AgentSwarms is, how the platform fits together, and where to start.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs" }],
  }),
  component: IntroductionPage,
});

const surfaces: { name: string; path: string; docs: string; what: string }[] = [
  {
    name: "Dashboard",
    path: "/dashboard",
    docs: "/docs/dashboard",
    what: "Workspace overview: quick actions, featured swarms, activity, recent runs.",
  },
  {
    name: "Templates",
    path: "/templates",
    docs: "/docs/templates",
    what: "20 standalone agents and 30+ multi-agent swarms you can provision in one click.",
  },
  {
    name: "Agent Builder",
    path: "/agents",
    docs: "/docs/agents",
    what: "Configure agents: model, prompt, tools, knowledge, guardrails, memory, export.",
  },
  {
    name: "Swarm Canvas",
    path: "/swarms",
    docs: "/docs/swarms",
    what: "Visual editor for multi-agent graphs — wire agents, routers, loops, approvals.",
  },
  {
    name: "Developer workspace",
    path: "/notebooks",
    docs: "/docs/notebooks",
    what: "In-browser Python notebooks — framework samples, model calls, and KB retrieval built in.",
  },
  {
    name: "Playground",
    path: "/playground",
    docs: "/docs/playground",
    what: "Chat with any of your agents, with per-session overrides and trace links.",
  },
  {
    name: "Traces & analytics",
    path: "/traces",
    docs: "/docs/debugging",
    what: "Every run recorded: model calls, tool calls, tokens, cost, latency.",
  },
];

function IntroductionPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Introduction"
        description="AgentSwarms is a learning and prototyping platform for agentic AI. You build real agents and multi-agent swarms, run them against real models, and study the traces — all in the browser."
      />

      <P>
        The platform pairs a structured curriculum with a working lab. Every concept taught in the{" "}
        <DocLink to="/learn">lessons</DocLink> maps to something you can open and run: a provisioned
        template, a swarm on the canvas, or a notebook. It is a learning and proof-of-concept
        environment, not a production runtime — the patterns transfer (everything exports to
        LangChain, LangGraph, CrewAI, Strands, and OpenAI Agents SDK code), the hosting does not.
      </P>

      <H2 id="platform-map">Platform map</H2>
      <P>Each screen has a matching page in these docs:</P>
      <div className="mt-5 overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-card/40 text-left">
              <th className="px-4 py-2.5 font-semibold text-foreground">Surface</th>
              <th className="px-4 py-2.5 font-semibold text-foreground">What it does</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {surfaces.map((s) => (
              <tr key={s.name}>
                <td className="whitespace-nowrap px-4 py-2.5 align-top">
                  <DocLink to={s.docs}>{s.name}</DocLink>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{s.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H2 id="first-ten-minutes">Your first ten minutes</H2>
      <UL>
        <li>
          <strong>Sign in</strong> — free, no card. New accounts can run models through the built-in
          AgentSwarms AI provider immediately, with no API key.
        </li>
        <li>
          <strong>Provision a template</strong> from{" "}
          <DocLink to="/docs/templates">Templates</DocLink> — try <em>Product Support Assistant</em>{" "}
          (RAG with citations and an approval gate). It arrives with its knowledge base and tools
          pre-wired, plus a guided tour.
        </li>
        <li>
          <strong>Run it</strong> in the <DocLink to="/docs/playground">Playground</DocLink> and ask
          it something its knowledge base covers.
        </li>
        <li>
          <strong>Open the trace</strong> (<DocLink to="/docs/debugging">Logs &amp; traces</DocLink>
          ) and read what actually happened: the resolved prompt, each tool call, tokens, and cost.
          Reading traces is the core skill this platform teaches.
        </li>
        <li>
          <strong>Then break it</strong> — edit the agent in the{" "}
          <DocLink to="/docs/agents">Agent Builder</DocLink>, or open a multi-agent template on the{" "}
          <DocLink to="/docs/swarms">Swarm Canvas</DocLink> and change the graph.
        </li>
      </UL>

      <H2 id="how-docs-are-organized">How these docs are organized</H2>
      <P>
        <strong>Getting started</strong> covers the workspace itself. <strong>Build</strong> covers
        the surfaces where you create things — templates, agents, swarms, skills, notebooks.{" "}
        <strong>Run &amp; observe</strong> covers executing and debugging. <strong>Platform</strong>{" "}
        covers certification and provider integrations. Pages link to the live screen they describe,
        so the fastest way to read them is with the app open in another tab.
      </P>
      <Note>
        For the learning material itself — lessons, tracks, quizzes, the certification syllabus —
        see the <DocLink to="/curriculum">curriculum overview</DocLink> and{" "}
        <DocLink to="/learn">the lessons</DocLink>. These docs document the product; the curriculum
        teaches the field.
      </Note>

      <NextPrev current="/docs" />
    </>
  );
}
