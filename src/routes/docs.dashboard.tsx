import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  Steps,
  Table,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The AgentSwarms dashboard: quick actions, featured swarms, workspace stats, 24-hour activity, model mix, and recent runs.",
      },
      { property: "og:title", content: "Dashboard — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The AgentSwarms dashboard: quick actions, featured swarms, workspace stats, activity, and recent runs.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/dashboard" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Dashboard — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "The AgentSwarms dashboard: quick actions, featured swarms, workspace stats, activity, and recent runs.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/dashboard" }],
  }),
  component: DashboardDoc,
});

function DashboardDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Dashboard"
        description="The dashboard at /dashboard is the screen you land on after signing in. It answers two questions: what is the fastest next thing to do, and what has been happening in your workspace."
      />

      <H2 id="quick-actions">Quick actions</H2>
      <P>Four tiles at the top cover the main entry points into the platform:</P>
      <FieldList
        items={[
          {
            name: "Open the Playground",
            body: (
              <>
                Opens the <DocLink to="/docs/playground">Chat Playground</DocLink> to chat with any
                model and prototype an agent instantly.
              </>
            ),
          },
          {
            name: "Build a Standalone Agent",
            body: (
              <>
                Opens the <DocLink to="/docs/agents">Agent Builder</DocLink> with the new-agent form
                ready.
              </>
            ),
          },
          {
            name: "Design a Swarm",
            body: (
              <>
                Opens a blank <DocLink to="/docs/swarms">Swarm Canvas</DocLink> to wire agents
                together into a multi-agent graph.
              </>
            ),
          },
          {
            name: "Open BI Workspace",
            body: <>Opens the BI Workspace, where AI builds dashboards over your connected data.</>,
          },
        ]}
      />

      <H2 id="featured-swarms">Featured swarms</H2>
      <P>
        A curated row of four multi-agent templates that open directly on the canvas. They are
        chosen for being graphs worth reading — routing, parallel fan-out, retrieval and approval
        gates — and they need no setup, because their retrieval nodes point at the sample knowledge
        base bundled with the platform.
      </P>
      <Table
        headers={["Template", "What it demonstrates"]}
        rows={[
          [
            <strong key="a">Support Copilot</strong>,
            "Router → KB retrieval with reranking → grounded answer → LLM judge → human approval. The most complete of the four.",
          ],
          [
            <strong key="b">Revenue Ops Analyst</strong>,
            "Querying your own data and turning the result into an answer.",
          ],
          [
            <strong key="c">Market Research Desk</strong>,
            "Parallel fan-out across sources, then a synthesis step.",
          ],
          [
            <strong key="d">Incident Response Triage</strong>,
            "Classification and branching, where the branch decides what happens next.",
          ],
        ]}
      />
      <P>
        There are more in the full template gallery on the{" "}
        <DocLink to="/docs/swarms">Swarm Canvas</DocLink> — these four are simply the ones surfaced
        on the dashboard.
      </P>

      <H2 id="stats">Workspace stats</H2>
      <P>
        Five tiles count what you own — <strong>Agents</strong>, <strong>Swarms</strong>,{" "}
        <strong>Chats</strong>, <strong>Tools</strong>, and <strong>Knowledge</strong> bases. Each
        tile links to the corresponding library page.
      </P>

      <H2 id="spend">Spend &amp; usage — by person, team or organisation</H2>
      <P>
        The <strong>Spend &amp; usage</strong> panel attributes model cost, so it can be charged
        back rather than only totalled. Two pickers control it.
      </P>
      <Table
        headers={["Scope", "Who can pick it", "What it covers"]}
        rows={[
          ["Just me", "Everyone", "Your own runs. The default."],
          [
            "My teams",
            "Anyone in at least one IAM group",
            "Everyone in the groups you belong to — resolved from your membership, not chosen by you.",
          ],
          [
            "Whole organisation",
            "Superadmins only",
            "Every user. Also the only scope that shows people outside your teams.",
          ],
        ]}
      />
      <P>
        The picker offers <strong>only the scopes you may actually use</strong>. If you are in no
        team, &ldquo;My teams&rdquo; is absent rather than present-and-broken — and a scope you are
        not entitled to is <em>refused</em>, never quietly answered with your own numbers under
        someone else&rsquo;s label.
      </P>
      <P>
        The time range covers the last 24 hours through year to date. Windows are half-open and in
        UTC, so a run landing exactly on a boundary is counted once and the same dashboard reads the
        same from any timezone.
      </P>
      <Callout kind="why" title="Team totals overlap on purpose">
        Someone in two teams contributes their spend to <em>both</em>, so the team rows do not add
        up to the total. That is the right answer to &ldquo;what did this team cost&rdquo; — the
        alternative is splitting one person's spend arbitrarily between teams, which is a worse lie
        than an overlap you can see.
      </Callout>
      <P>
        Cost comes from the same column the <DocLink to="/docs/budgets">budget caps</DocLink> read,
        so a figure here and a budget alert can never disagree about what someone spent.
      </P>

      <H2 id="activity">Activity and model mix</H2>
      <P>
        The <strong>Activity</strong> panel charts hourly run volume across all your agents and
        swarms for the last 24 hours, with three summary figures underneath: success rate, average
        latency, and spend. The <strong>Model mix</strong> panel next to it breaks recent runs down
        by model, so you can see at a glance where your tokens went.
      </P>

      <H2 id="recent-runs">Recent runs</H2>
      <P>
        The last six executions across your workspace, each with the agent name, model, latency,
        cost, and a success/error indicator. <em>View all</em> opens the full run history at{" "}
        <DocLink to="/traces">/traces</DocLink>, where every run can be expanded into its complete
        trace — see <DocLink to="/docs/debugging">Logs &amp; traces</DocLink> for how to read one.
      </P>

      <Note>
        A <strong>learning side panel</strong> ("Welcome — start here") rides along on the right of
        the dashboard with a short map of how the platform teaches agentic AI. Most authenticated
        screens have one of these panels, scoped to the screen you are on.
      </Note>

      <H2 id="first-run">What to do on a new workspace</H2>
      <Steps
        items={[
          {
            title: "Connect a model provider",
            body: (
              <>
                <strong>Integrations</strong>. Until you do, calls run on the operator's shared
                fallback key — fine for a first look, wrong for anything real. See{" "}
                <DocLink to="/docs/models">Models &amp; providers</DocLink>.
              </>
            ),
          },
          {
            title: "Add data or documents",
            body: (
              <>
                <DocLink to="/docs/data">Data Catalog</DocLink> for rows,{" "}
                <DocLink to="/docs/knowledge">Knowledge Base</DocLink> for prose. An agent with
                neither is just a chatbot.
              </>
            ),
          },
          {
            title: "Build one agent",
            body: (
              <>
                <DocLink to="/docs/agents">Agent Builder</DocLink> — name, prompt, model, one or two
                tools.
              </>
            ),
          },
          {
            title: "Run it and read the trace",
            body: (
              <>
                <DocLink to="/docs/debugging">Logs &amp; traces</DocLink>. This is the habit worth
                forming early.
              </>
            ),
          },
          {
            title: "Before anyone else joins",
            body: (
              <>
                Turn off public signup and set budget caps —{" "}
                <DocLink to="/docs/iam">Access control</DocLink> and{" "}
                <DocLink to="/docs/budgets">Budgets</DocLink>.
              </>
            ),
          },
        ]}
      />

      <NextPrev current="/docs/dashboard" />
    </>
  );
}
