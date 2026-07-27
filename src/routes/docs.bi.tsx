import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/bi")({
  head: () => ({
    meta: [
      { title: "BI Workspace — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Build dashboards: charts, filters, cross-filtering, drill-through, AI insights, alerts, scheduled reports, sharing and embedding.",
      },
      { property: "og:title", content: "BI Workspace — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Dashboards over the same data your agents use.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/bi" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/bi" }],
  }),
  component: BiPage,
});

function BiPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="BI Workspace"
        description="Dashboards built on the same catalog, prepared tables and metrics your agents use — so a chart and an agent answering about it cannot disagree."
      />

      <P>
        Open <strong>Data → BI Workspace</strong>. Dashboards live in workspaces and folders; each
        is a grid of resizable widgets you drag into place.
      </P>

      <H2 id="build">Building a dashboard</H2>
      <Steps
        items={[
          {
            title: "Create a dashboard",
            body: "Give it a home folder — folders are how you keep dev and production content apart.",
          },
          {
            title: "Add a visual",
            body: "The right-hand builder pane takes your source (table, prepared table, or a governed metric), the fields to plot, and the chart type.",
          },
          {
            title: "Or describe it",
            body: "The AI tab writes a whole dashboard, or a single visual, from a sentence. Read the generated query before trusting the chart.",
          },
          {
            title: "Arrange and publish",
            body: "Drag and resize, then publish to make it visible to the people you've shared it with.",
          },
        ]}
      />
      <P>
        You can also send a chart straight from the SQL workbench with{" "}
        <strong>Add to dashboard</strong> once a query returns something worth keeping.
      </P>

      <H2 id="charts">Chart types</H2>
      <Table
        headers={["Family", "Types", "Best for"]}
        rows={[
          ["Comparison", "Column, bar, grouped, stacked", "Ranking and comparing categories"],
          ["Trend", "Line, area, combo", "Change over time"],
          ["Composition", "Pie, doughnut, treemap, funnel", "Parts of a whole (keep slices few)"],
          ["Distribution", "Scatter, heatmap, histogram", "Relationships and spread"],
          ["Single value", "KPI card, gauge", "One number that matters, with a delta"],
          ["Detail", "Table, pivot matrix", "Exact figures people will read row by row"],
          [
            "Other",
            "Map, word cloud, ontology graph, image, text",
            "Geography, text frequency, relationships, annotation",
          ],
        ]}
      />
      <Callout kind="why">
        Pick the chart from the question, not the other way round. "Which region is biggest" is a
        bar chart; "is it growing" is a line. A pie chart with eleven slices answers neither — if
        you can't name the question a visual answers, it's decoration.
      </Callout>

      <H3 id="formatting">Formatting</H3>
      <P>
        Numbers, currency and percentages honour locale formatting, so a revenue axis reads{" "}
        <em>1,240,000</em> or <em>$1.24M</em> rather than raw digits. Multi-series charts can be
        grouped or stacked, and trend/reference lines can be added to give a value context.
      </P>

      <H2 id="interactive">Making it interactive</H2>
      <FieldList
        items={[
          {
            name: "Global filters",
            body: "Dashboard-level controls — value pickers, numeric ranges and relative-date presets (last 7 days, this quarter). Save defaults so the dashboard opens on the right view.",
          },
          {
            name: "Cross-filtering",
            body: 'Click a bar and every other widget filters to it. The fastest way to answer "what\'s driving that spike" without building anything.',
          },
          {
            name: "Drill hierarchies",
            body: "Define year → quarter → month, or region → country → city, and let readers descend a level at a time.",
          },
          {
            name: "Drill-through",
            body: 'Open the underlying rows behind any data point — the answer to "is this number real?" and the fastest way to spot a broken join.',
          },
          {
            name: "Ask AI",
            body: "Readers can ask a follow-up question of the dashboard's data in natural language, including a drill-down on what they clicked.",
          },
        ]}
      />

      <H2 id="insights">AI insights</H2>
      <P>
        Each visual can generate a written reading of what it shows — the notable movement, the
        outlier, the thing a person would say out loud. There is also a dashboard-level digest
        summarising the whole page.
      </P>
      <Callout kind="warn">
        Insights are generated from the data actually in the chart, but they are still model output:
        useful as a first pass, not as a substitute for looking. Treat them as a colleague's first
        impression.
      </Callout>

      <H2 id="alerts">Alerts and scheduled reports</H2>
      <UL>
        <li>
          <strong>Alerts</strong> — watch a metric against a threshold and notify when it crosses.
          Delivered in-app and by email.
        </li>
        <li>
          <strong>Scheduled refresh</strong> — rebuild imported data on a cadence so the dashboard
          isn't stale.
        </li>
        <li>
          <strong>Scheduled reports</strong> — email a digest of the dashboard on a schedule.
        </li>
      </UL>
      <P>
        On a self-hosted deployment these need the scheduler running — see{" "}
        <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink>.
      </P>

      <H2 id="sharing">Sharing, export and embedding</H2>
      <Table
        headers={["Method", "Who can see it", "Notes"]}
        rows={[
          [
            "Group share",
            "Named users or IAM groups",
            "Read-only; respects the underlying data grants",
          ],
          ["Public link", "Anyone with the URL", "No sign-in — treat the URL as the secret"],
          ["Embed key", "Any site you allow", "Domain-restricted; see Web embedding"],
          ["Export", "Whoever you send the file to", "PDF for the page, Excel/CSV for the data"],
        ]}
      />
      <Callout kind="warn" title="Check before publishing">
        A public link removes every access check. Widgets on shared and embedded dashboards are
        sanitised so their underlying queries aren't exposed, but the data on the page is visible to
        anyone holding the URL. Publish deliberately.
      </Callout>

      <H2 id="lifecycle">Versioning and promotion</H2>
      <UL>
        <li>
          <strong>Version history</strong> — dashboards keep prior versions you can compare and
          restore.
        </li>
        <li>
          <strong>Dev → prod promotion</strong> — build in a development folder and promote a
          reviewed version into production, instead of editing what people are watching.
        </li>
        <li>
          <strong>Git export</strong> — export dashboard and model definitions as files for review
          in your own repository.
        </li>
      </UL>

      <H3 id="performance">If a dashboard is slow</H3>
      <UL>
        <li>
          Switch heavy widgets from direct query to imported snapshots with a refresh schedule.
        </li>
        <li>
          Aggregate in a <DocLink to="/docs/data-prep">prepared table</DocLink> rather than charting
          millions of raw rows.
        </li>
        <li>Reduce the number of widgets on one page — each is a query.</li>
        <li>Apply a default date filter so the dashboard doesn't open on all history.</li>
      </UL>

      <NextPrev current="/docs/bi" />
    </>
  );
}
