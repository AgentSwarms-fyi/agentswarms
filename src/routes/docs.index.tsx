import { createFileRoute } from "@tanstack/react-router";
import {
  CardGrid,
  Callout,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Documentation — AgentSwarms" },
      {
        name: "description",
        content:
          "The AgentSwarms handbook: build agents and swarms, connect data and knowledge, ship dashboards and embeds, and govern the whole thing.",
      },
      { property: "og:title", content: "AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Everything about AgentSwarms — build, run, integrate and govern agentic AI.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content: "Build, run, integrate and govern agentic AI.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs" }],
  }),
  component: IntroductionPage,
});

function IntroductionPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Documentation"
        description="AgentSwarms is a platform for building agentic AI on your own data — agents and multi-agent swarms, the knowledge and tables they work from, the dashboards beside them, and the controls that make all of it safe to hand to other people."
      />

      <Callout kind="info" title="New here?">
        Read <DocLink to="/docs/quickstart">Quickstart</DocLink> with the app open in another tab —
        thirty minutes, and you'll have an agent answering from your own data. Then{" "}
        <DocLink to="/docs/concepts">Core concepts</DocLink> for the vocabulary.
      </Callout>

      <H2 id="start-here">Start here</H2>
      <CardGrid
        items={[
          {
            to: "/docs/quickstart",
            title: "Quickstart",
            body: "Build your first agent, give it data and tools, run it, and read the trace.",
          },
          {
            to: "/docs/concepts",
            title: "Core concepts",
            body: "Agents, tools, retrieval, swarms, memory and BYOK — what each really means.",
          },
          {
            to: "/docs/agents",
            title: "Agent Builder",
            body: "Every field on an agent, and what changing it actually does.",
          },
          {
            to: "/docs/self-hosting",
            title: "Install & deploy",
            body: "Run the whole platform on your own infrastructure.",
          },
        ]}
      />

      <H2 id="by-job">Find it by what you're doing</H2>

      <H3 id="build">Build something</H3>
      <Table
        headers={["Page", "Covers"]}
        rows={[
          [
            <DocLink key="a" to="/docs/agents">
              Agent Builder
            </DocLink>,
            "Prompt, model, tools, knowledge, memory, guardrails, versions and export.",
          ],
          [
            <DocLink key="b" to="/docs/playground">
              Agent Chat
            </DocLink>,
            "Run agents, visual BI answers, PowerPoint/Word/Excel generation, sources.",
          ],
          [
            <DocLink key="c" to="/docs/swarms">
              Swarm Canvas
            </DocLink>,
            "Multi-agent graphs: routers, loops, parallel work, approval gates, framework export.",
          ],
          [
            <DocLink key="d" to="/docs/skills">
              Skills & Prompt Library
            </DocLink>,
            "Reusable capabilities and prompts.",
          ],
          [
            <DocLink key="e" to="/docs/notebooks">
              Developer workspace
            </DocLink>,
            "Python notebooks with real kernels, model access and KB retrieval.",
          ],
        ]}
      />

      <H3 id="data">Work with data</H3>
      <Table
        headers={["Page", "Covers"]}
        rows={[
          [
            <DocLink key="a" to="/docs/data">
              Data Catalog & SQL
            </DocLink>,
            "Uploads, warehouse connectors, catalog, profiling, lineage, the SQL workbench.",
          ],
          [
            <DocLink key="b" to="/docs/data-prep">
              Data preparation
            </DocLink>,
            "Visual joins and transformations saved as repeatable, schedulable flows.",
          ],
          [
            <DocLink key="c" to="/docs/knowledge">
              Knowledge Base
            </DocLink>,
            "Ingestion, chunking, embeddings, graph search, and debugging bad answers.",
          ],
          [
            <DocLink key="d" to="/docs/semantics">
              Semantic Layer
            </DocLink>,
            "Governed metrics so one question has one answer.",
          ],
          [
            <DocLink key="e" to="/docs/bi">
              BI Workspace
            </DocLink>,
            "Dashboards, filters, drill-through, alerts, sharing and embedding.",
          ],
        ]}
      />

      <H3 id="ship">Ship and integrate</H3>
      <Table
        headers={["Page", "Covers"]}
        rows={[
          [
            <DocLink key="a" to="/docs/integrations">
              Integrations
            </DocLink>,
            "Connect providers, search, automation and data sources.",
          ],
          [
            <DocLink key="b" to="/docs/models">
              Models & providers
            </DocLink>,
            "BYOK, the model registry, and choosing the right model per job.",
          ],
          [
            <DocLink key="c" to="/docs/mcp">
              MCP servers
            </DocLink>,
            "Give agents tools owned by other systems.",
          ],
          [
            <DocLink key="d" to="/docs/embedding">
              Web embedding
            </DocLink>,
            "Put an agent or dashboard on your own site, safely.",
          ],
          [
            <DocLink key="e" to="/docs/api">
              API & webhooks
            </DocLink>,
            "Run swarms from your code: scopes, idempotency, signed callbacks.",
          ],
          [
            <DocLink key="f" to="/docs/secrets">
              Secrets
            </DocLink>,
            "Store credentials once and reference them everywhere.",
          ],
        ]}
      />

      <H3 id="govern">Govern and operate</H3>
      <Table
        headers={["Page", "Covers"]}
        rows={[
          [
            <DocLink key="a" to="/docs/iam">
              Access control
            </DocLink>,
            "Users, groups, model rules, read-only sharing, invite-only signup and SSO.",
          ],
          [
            <DocLink key="b" to="/docs/guardrails">
              Guardrails & PII
            </DocLink>,
            "Input/output controls and personal-data detection or redaction.",
          ],
          [
            <DocLink key="c" to="/docs/budgets">
              Budgets & cost
            </DocLink>,
            "Spend caps per user, group, embed or API key — plus retention windows.",
          ],
          [
            <DocLink key="d" to="/docs/debugging">
              Logs & traces
            </DocLink>,
            "Read what an agent actually did, rather than what it says it did.",
          ],
          [
            <DocLink key="e" to="/docs/analytics">
              Analytics & audit
            </DocLink>,
            "Usage, spend attribution and the audit log.",
          ],
        ]}
      />

      <H2 id="principles">Three things worth knowing up front</H2>
      <P>
        <strong>Prose and numbers are different problems.</strong> Documents go in the{" "}
        <DocLink to="/docs/knowledge">Knowledge Base</DocLink> to be quoted; rows go in the{" "}
        <DocLink to="/docs/data">Data Catalog</DocLink> to be counted. Models are poor at arithmetic
        and excellent at sounding certain, so putting a number where only prose retrieval can reach
        it is the most common way to get a confident wrong answer.
      </P>
      <P>
        <strong>The trace is the truth.</strong> An agent's explanation of its own reasoning is
        generated text and can be wrong. The <DocLink to="/docs/debugging">trace</DocLink> is a
        record. Debug in that order.
      </P>
      <P>
        <strong>Your keys, your data.</strong> Connect your own model providers and calls run under
        your account and your agreement with that vendor. See{" "}
        <DocLink to="/docs/models">Models &amp; providers</DocLink>.
      </P>

      <NextPrev current="/docs" />
    </>
  );
}
