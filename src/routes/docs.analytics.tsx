import { createFileRoute } from "@tanstack/react-router";
import {
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "AgentSwarms analytics: spend over time, cost by provider and agent, and the swarm observability view with canvas replay, execution timeline, and data flow.",
      },
      { property: "og:title", content: "Analytics — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Spend analytics and swarm observability: canvas replay, execution timeline, data flow.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/analytics" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Analytics — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "Spend analytics and swarm observability: canvas replay, execution timeline, data flow.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/analytics" }],
  }),
  component: AnalyticsDoc,
});

function AnalyticsDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Run & observe"
        title="Analytics"
        description="Two views built on the same telemetry: workspace-level cost analytics at /analytics, and per-run swarm observability that replays a swarm execution node by node."
      />

      <H2 id="overview">Cost analytics</H2>
      <P>
        The analytics page leads with four numbers — month-to-date spend, total tokens, average
        latency, and active agents — followed by:
      </P>
      <UL>
        <li>
          <strong>Spend over time</strong> — your daily spend charted over the selected window.
          Spikes are worth chasing the same day; they are usually one experiment, one loop, or one
          oversized context.
        </li>
        <li>
          <strong>Cost by provider</strong> — where the money goes across AgentSwarms AI, OpenAI,
          Anthropic, and any bring-your-own-key providers you've connected.
        </li>
        <li>
          <strong>Cost by agent</strong> — almost always the chart with the surprise in it: one
          agent on one expensive model tends to dominate.
        </li>
      </UL>
      <P>
        Spend caps and alerts live at <DocLink to="/docs/account">/budgets</DocLink>; per-run detail
        lives in <DocLink to="/docs/debugging">traces</DocLink>.
      </P>

      <H2 id="swarm-observability">Swarm observability</H2>
      <P>
        Swarm runs get their own deep-inspection view at{" "}
        <DocLink to="/analytics">Analytics → Swarm Observability</DocLink>. Opening a run shows
        three tabs:
      </P>
      <FieldList
        items={[
          {
            name: "Canvas",
            body: "The swarm graph as it was at run time, so you can see the shape of what executed — including for runs of swarms you've since edited.",
          },
          {
            name: "Timeline",
            body: "The execution order, node by node, with each step's kind and model. Clicking a step opens its detail: input, output, thinking, and tool calls.",
          },
          {
            name: "Data flow",
            body: "Every message that crossed an edge — which node produced it, which node consumed it. This is where context-window problems become visible: you can see exactly how much text was handed to each node.",
          },
        ]}
      />

      <Note>
        The workflow that pays off: after any interesting swarm run, open its timeline and find the
        slowest and the most expensive step. Those two nodes are nearly always the next thing worth
        optimizing — a cheaper model, a tighter prompt, or a parallel branch.
      </Note>

      <NextPrev current="/docs/analytics" />
    </>
  );
}
