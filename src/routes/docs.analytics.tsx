import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  Table,
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
        Spend caps and alerts live in <DocLink to="/docs/budgets">Budgets</DocLink>; per-run detail
        lives in <DocLink to="/docs/debugging">traces</DocLink>.
      </P>
      <Callout kind="info" title="These are estimates, and they can be undercounts">
        Cost is computed per call from token counts and a stored price for that model — not read
        back from your provider's invoice, so it will not tie out exactly against a bill that
        applies its own rounding, discounts and minimums. Use these charts to find the expensive
        agent; use the invoice to settle the amount.
        <br />
        <br />
        The sharper caveat: a model the price table does not know is recorded at{" "}
        <strong>zero</strong>, and zero is indistinguishable from cheap once it reaches a chart.
        Those calls are marked <C>pricing_missing</C> on the trace, and calls whose token counts
        were estimated rather than reported by the provider are marked <C>tokens_estimated</C> — so
        a total that looks too low can be checked rather than guessed at. See{" "}
        <DocLink to="/docs/budgets#how-cost-is-computed">how cost is computed</DocLink>.
      </Callout>

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

      <H2 id="monitoring">Service monitoring</H2>
      <P>
        <strong>Observability → Monitoring</strong> answers the operator&rsquo;s question rather
        than the analyst&rsquo;s: is every piece of this deployment actually running, and what is
        the machine doing right now? It is superadmin-only, because it reports hostnames, container
        limits and which internal services exist.
      </P>
      <Table
        headers={["Panel", "What it shows"]}
        rows={[
          [
            "CPU",
            "Utilisation sampled across all cores, with the core count, the container's CPU quota when one is set, and the 1/5/15-minute load averages.",
          ],
          [
            "Memory",
            "Used against the total — and it says which total: a container's cgroup LIMIT when there is one, otherwise host RAM. Showing 3 GB of 64 GB while the container dies at 4 GB would be worse than showing nothing.",
          ],
          [
            "Disk",
            "Usage of the filesystem the app is installed on, where the platform reports it.",
          ],
          [
            "App process",
            "Resident memory, heap used against heap total, and how long this process has been up.",
          ],
          [
            "Services",
            "One row per service — the app, Supabase, and every optional container — with its status, response time and the address that answered.",
          ],
        ]}
      />
      <Callout kind="info">
        <strong>Optional services are not incidents.</strong> A profile you never started reads
        &ldquo;Not running&rdquo; in grey, with the command that would start it — not a red
        &ldquo;Down&rdquo;. Only a required service failing, or any service answering badly, is
        counted in &ldquo;needing attention&rdquo;. A status page that cries wolf is one people stop
        opening.
      </Callout>
      <P>
        The view refreshes every 15 seconds while open (toggleable), and each probe reports what the
        service itself says — the document renderer&rsquo;s LibreOffice availability, for instance,
        appears alongside its status rather than being assumed from the fact that it answered.
      </P>

      <H2 id="audit-timeline">The audit timeline</H2>
      <P>
        The timeline merges <strong>three</strong> sources at read time, which is why an action can
        appear here without a matching row in any single table:
      </P>
      <Table
        headers={["Source", "Contributes"]}
        rows={[
          [
            <C key="a">audit_events</C>,
            "User and admin activities — sign-ins, publishes, grants, deletes, agent chats",
          ],
          [
            <C key="b">execution_traces</C>,
            <>
              Model calls, surfaced as the <C key="m">model.call</C> action
            </>,
          ],
          [
            <C key="c">swarm_runs</C>,
            <>
              Swarm executions, surfaced as <C key="s">swarm.run</C>
            </>,
          ],
        ]}
      />
      <P>
        Non-administrators see only their own rows — the scoping is done by row-level security, not
        by the query — while a superadmin sees the whole workspace.
      </P>

      <H2 id="retention">Retention</H2>
      <Table
        headers={["Setting", "Default", "Range", "Notes"]}
        rows={[
          [
            <C key="a">audit_retention_days</C>,
            "365",
            "1 – 365",
            "How long audit events are kept before the scheduled purge.",
          ],
          [
            <C key="b">trace_retention_days</C>,
            "0 (keep forever)",
            "0 – 3650",
            "Zero means no trace purge at all. Set it deliberately — traces can hold prompt bodies.",
          ],
          [
            <C key="c">AUDIT_ARCHIVE_ON_PURGE</C>,
            "off",
            "env var",
            "Archive events on purge instead of dropping them.",
          ],
        ]}
      />
      <Callout kind="warn" title="Traces are kept forever by default">
        <C>trace_retention_days</C> ships at 0, meaning nothing is ever purged. Combined with{" "}
        <C>PERSIST_PROMPT_BODIES</C>, that can mean full prompts and responses accumulating
        indefinitely — and on a busy instance <C>execution_traces</C> and <C>swarm_runs</C> are the
        fastest-growing tables you have. Set a window in{" "}
        <strong>Admin → IAM → Settings → Trace retention</strong>. The purge has always run on the
        scheduled maintenance pass; until that field is non-zero it simply has nothing to do. See
        also <DocLink to="/docs/budgets">Budgets &amp; cost</DocLink>.
      </Callout>

      <H2 id="export">Export</H2>
      <P>
        The audit log exports as NDJSON — one JSON object per line — which streams into most log
        pipelines without transformation and stays readable when the file is large.
      </P>

      <NextPrev current="/docs/analytics" />
    </>
  );
}
