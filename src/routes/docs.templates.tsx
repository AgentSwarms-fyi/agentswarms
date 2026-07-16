import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/templates")({
  head: () => ({
    meta: [
      { title: "Templates — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "AgentSwarms templates: 20 standalone agents and 30+ multi-agent swarms with pre-wired knowledge bases, tools, and guided tours.",
      },
      { property: "og:title", content: "Templates — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "20 standalone agents and 30+ multi-agent swarms with pre-wired knowledge bases, tools, and guided tours.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/templates" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Templates — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "20 standalone agents and 30+ multi-agent swarms with pre-wired knowledge bases, tools, and guided tours.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/templates" }],
  }),
  component: TemplatesDoc,
});

function TemplatesDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Templates"
        description="The template gallery at /templates is the fastest way to get something real running. Every template arrives complete — agent configuration, knowledge bases with sample documents, tools, and guardrails — and most open with a step-by-step guided tour."
      />

      <H2 id="two-kinds">Two kinds of templates</H2>
      <UL>
        <li>
          <strong>Standalone agents</strong> (20) — single agents you chat with in the{" "}
          <DocLink to="/docs/playground">Playground</DocLink>. Searchable by name, use case, or
          domain, and grouped by category: Customer Support, Research &amp; Analysis, Sales &amp;
          Marketing, Engineering, Data Processing, Web Research, Developer Productivity, Content
          &amp; Marketing, Support &amp; Operations, and Knowledge Q&amp;A.
        </li>
        <li>
          <strong>Multi-agent swarms</strong> (30+) — complete graphs that open on the{" "}
          <DocLink to="/docs/swarms">Swarm Canvas</DocLink>, grouped by industry. Loading one starts
          a guided tour that walks the graph node by node.
        </li>
      </UL>

      <H2 id="standalone-examples">Representative standalone agents</H2>
      <UL>
        <li>
          <strong>Product Support Assistant</strong> — grounded RAG over a sample help-center
          knowledge base (returns policy, warranty, shipping, troubleshooting docs), with citations,
          refusals for out-of-scope questions, and a human-approval gate on high-impact actions.
        </li>
        <li>
          <strong>Research Q&amp;A on AI Papers</strong> — cited answers over summaries of
          foundational papers (Attention Is All You Need, LoRA, RAG).
        </li>
        <li>
          <strong>Code Review Assistant</strong>, <strong>Python Traceback Fixer</strong>,{" "}
          <strong>Regex Generator</strong>, <strong>SQL Dialect Translator</strong> —
          developer-productivity agents that need no knowledge base at all.
        </li>
        <li>
          <strong>CRM Data Cleanser</strong> and <strong>Invoice Parser</strong> — strict
          structured-output agents that coerce messy text into validated JSON.
        </li>
        <li>
          <strong>Firecrawl Web Summarizer</strong>, <strong>Competitor Feature Tracker</strong>,{" "}
          <strong>GitHub Repo Explainer</strong> — live web-research agents built on the URL-fetch
          tool.
        </li>
        <li>
          <strong>Graph RAG Explorer</strong> — multi-hop questions over a pre-built entity-relation
          knowledge graph.
        </li>
      </UL>

      <H2 id="provisioning">What provisioning does</H2>
      <P>
        Clicking <em>Add to workspace</em> copies the template into your account: the agent (or
        swarm), its knowledge bases and documents, its tools, and its prompts all become yours to
        edit. Nothing is shared or read-only after provisioning — breaking your copy is the point.
        Templates that require a specific provider (for example, the Long-Context Document Analyst
        needs an Anthropic key) say so on the card and stay disabled until that provider is
        connected in <DocLink to="/docs/integrations">Integrations</DocLink>.
      </P>

      <H2 id="tours">Guided tours</H2>
      <P>
        Most templates ship with a tour — a sequence of steps that fires the suggested prompt,
        points at what is happening (the streaming response, the cited sources, the paused
        approval), and explains why the template is built the way it is. Swarm templates open with{" "}
        <em>Open with guided tour</em> on the canvas, where the tour follows the run from node to
        node.
      </P>

      <Note>
        Templates double as worked answers to the curriculum: when a lesson introduces a pattern
        (RAG with citations, approval gates, parallel review), there is a template that implements
        it. The <DocLink to="/curriculum">curriculum overview</DocLink> lists which templates pair
        with which track.
      </Note>

      <NextPrev current="/docs/templates" />
    </>
  );
}
