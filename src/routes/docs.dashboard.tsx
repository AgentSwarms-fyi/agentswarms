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
          "The AgentSwarms dashboard: platform status, the four figures that matter, 24-hour activity, what this deployment is running, spend by person or team, and recent runs.",
      },
      { property: "og:title", content: "Dashboard — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The AgentSwarms dashboard: platform status, key figures, activity, what you are running, and recent runs.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/dashboard" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Dashboard — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "The AgentSwarms dashboard: platform status, key figures, activity, what you are running, and recent runs.",
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
        description="The dashboard at /dashboard is the screen you land on after signing in. It answers one question first — is this deployment healthy, and what is it costing — and then shows what you are running and what has happened in the last day."
      />

      <H2 id="status">Platform status</H2>
      <P>
        The first thing on the page is a single sentence: <strong>Everything is running</strong>, or
        the number of things that need attention with a chip for each one. Every status behind it
        was already being recorded somewhere — by the SaaS sync, the warehouse connection test, the
        swarm scheduler, the pipeline run, the data monitor — and each chip links to the page that
        can fix it.
      </P>
      <Table
        headers={["Chip", "Where it comes from", "Where it takes you"]}
        rows={[
          [
            "sources not syncing",
            "A SaaS connection whose last sync errored or was partial",
            "Integrations",
          ],
          [
            "warehouses unreachable",
            "A warehouse whose last connection test failed",
            "Integrations",
          ],
          ["schedules failing", "A swarm schedule whose last run errored", "Swarms"],
          [
            "pipeline runs failed today",
            "An ETL run that failed in the last 24 hours",
            "ETL Pipelines",
          ],
          [
            "open data incidents",
            "A data monitor that raised an incident nobody has closed",
            "Data monitors",
          ],
          ["workflows failed", "A workflow whose last run failed", "Workflows"],
          ["SQL models failing", "A SQL model whose last build errored", "SQL models"],
          [
            "of the monthly budget used",
            "Month-to-date spend at 80% of the cap or above",
            "Budgets",
          ],
        ]}
      />
      <Callout kind="why" title="It says so when nothing is wrong">
        A band that appears only on failure teaches nobody that it exists, and its absence then
        reads as &ldquo;not loaded yet&rdquo; rather than &ldquo;nothing to report&rdquo;. It also
        carries the time it checked, because a dashboard with no timestamp cannot be told apart from
        a stale tab left open overnight.
      </Callout>

      <H2 id="figures">The four figures</H2>
      <P>
        Below the band are the numbers that change a decision, each measured against something
        rather than standing alone.
      </P>
      <FieldList
        items={[
          {
            name: "Runs (24h)",
            body: (
              <>
                Model calls in the last 24 hours. Shown as <strong>&ge;n</strong> when the read hit
                its limit, so a busy day reports a floor rather than describing a prefix as if it
                were the whole day.
              </>
            ),
          },
          {
            name: "Spend (month to date)",
            body: (
              <>
                Against your monthly cap, with a bar that turns amber at 80% and red past 100%. The
                figure is the same one <DocLink to="/docs/budgets">budget caps</DocLink> enforce, so
                the two can never disagree. With no cap set it falls back to the 24-hour total and
                says so.
              </>
            ),
          },
          {
            name: "Success rate (24h)",
            body: (
              <>
                Of runs that reached a verdict. Cancelled runs leave the denominator entirely — a
                person pressing Stop is not a failure. With nothing decided it reads
                &ldquo;&mdash;&rdquo; rather than congratulating you on 100%.
              </>
            ),
          },
          {
            name: "Avg latency (24h)",
            body: "Mean wall-clock time per model call, over the runs that recorded one.",
          },
        ]}
      />

      <H2 id="activity">Activity and model mix</H2>
      <P>
        <strong>Activity</strong> charts hourly run volume for the last 24 hours across every agent
        and swarm. <strong>Model mix</strong> beside it ranks models by tokens, so you can see where
        the spend went before opening anything.
      </P>

      <H2 id="running">What you&rsquo;re running</H2>
      <P>
        A grid counted from this deployment&rsquo;s own tables, covering both halves of the
        platform: agents, swarms and knowledge bases on one side; ETL pipelines, the lakehouse, SQL
        models, ML models, dashboards, workflows, data monitors, metrics and integrations on the
        other. A capability with something in it shows the count and, when relevant, what is wrong
        with it — &ldquo;5 watching &middot; 1 open&rdquo;. A capability with nothing in it says so
        and offers the way in, rather than showing a zero.
      </P>
      <Callout kind="why" title="Counted, not advertised">
        This replaced a grid of twelve static feature tiles that read the same whether you had one
        agent or a thousand pipelines. The sidebar already lists every feature; what a dashboard can
        say that the sidebar cannot is which ones <em>you</em> are using and whether they are
        working.
      </Callout>

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

      <H2 id="recent-runs">Recent runs</H2>
      <P>
        The last six executions across your workspace, each with the agent name, model, latency,
        cost, and a success/error indicator. <em>View all</em> opens the full run history at{" "}
        <DocLink to="/traces">/traces</DocLink>, where every run can be expanded into its complete
        trace — see <DocLink to="/docs/debugging">Logs &amp; traces</DocLink> for how to read one.
      </P>

      <H2 id="first-run">What to do on a new workspace</H2>
      <P>
        A deployment with nothing built and nothing run gets a different page: an ordered checklist
        instead of a console full of zeroes, with each step ticked from real state rather than from
        a flag. Only the next unfinished step carries a button. The order below is the same one, and
        it is dependency order rather than feature order.
      </P>
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
