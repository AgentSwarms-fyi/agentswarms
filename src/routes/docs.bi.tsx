import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
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

      <H2 id="data-mode">How a widget gets its data</H2>
      <P>
        Every chart widget stores the SQL it ran and a <strong>snapshot</strong> of the rows that
        came back. Which of those a viewer sees depends on the widget's data mode, and the
        difference decides freshness, cost, and — in one case worth reading carefully — whether the
        number is right.
      </P>
      <Table
        headers={["Mode", "What happens at view time", "Use it when"]}
        rows={[
          [
            <>
              <strong key="i">Import</strong> (default)
            </>,
            "The stored snapshot renders. No query runs, nothing touches your warehouse, load is instant.",
            "Almost always. Pair it with a refresh schedule.",
          ],
          [
            <strong key="d">Direct</strong>,
            "The widget's SQL re-runs against the warehouse on every view, for the current truth.",
            "A number that must be live, on a dashboard few people open.",
          ],
        ]}
      />
      <Callout kind="info" title="Published and embedded dashboards always render the snapshot">
        Direct mode applies to the editor and to signed-in viewers. A{" "}
        <DocLink to="/docs/embedding">public share or embed</DocLink> renders the stored snapshot
        whatever the widget's mode says — otherwise every anonymous visitor would be a live query
        against your warehouse. So on a published dashboard, the refresh schedule <em>is</em> the
        freshness, and each widget shows when it was last computed.
      </Callout>

      <H3 id="row-cap">The row cap, and the totals it can quietly break</H3>
      <P>
        A snapshot holds at most <strong>500 rows</strong>. That is fine for a chart of twelve
        months or twenty regions, and it is a problem for a chart built over raw rows — because the
        browser is what sums duplicate categories together.
      </P>
      <Callout kind="warn" title="A capped snapshot sums a subset and calls it the total">
        Chart <C>sum(amount)</C> by region over a 50,000-row table and the snapshot keeps the first
        500. The renderer then adds up the regions <em>it can see</em>, and draws a bar chart that
        looks entirely normal and is wrong — no error, just a smaller number. Widgets in this state
        carry a <strong>Partial</strong> badge, and the fix is the next section.
      </Callout>

      <H3 id="pushdown">Aggregate in SQL</H3>
      <P>
        Turning on <strong>Aggregate in SQL</strong> compiles the chart into a <C>GROUP BY</C> and
        makes the database do the adding. One row comes back per category instead of thousands of
        raw rows, so the totals are complete and the cap stops mattering:
      </P>
      <Code lang="sql">{`-- what the widget stores
SELECT region, amount FROM sales

-- what actually runs with "Aggregate in SQL" on
SELECT region, SUM(amount) AS amount
FROM (SELECT region, amount FROM sales) AS _dq
GROUP BY region`}</Code>
      <P>
        Supported aggregates are <C>sum</C> (the default), <C>avg</C>, <C>min</C>, <C>max</C>,{" "}
        <C>count</C> and <C>count_distinct</C>. Wrapping SQL that already aggregates is harmless —
        grouping rows whose key is already unique returns them unchanged.
      </P>
      <Callout kind="why" title="Why it isn't just switched on everywhere">
        New widgets get it by default. Existing ones deliberately do <strong>not</strong>, because
        switching it on can change a number someone is already reporting — the old number was a
        partial sum, and correcting it silently would be its own kind of dishonesty. They surface
        the <strong>Partial</strong> badge instead, so the owner sees the problem and makes the
        change themselves.
      </Callout>

      <H3 id="incremental">Incremental refresh</H3>
      <P>
        For a large table where only recent rows change, a widget can re-query just a recent window
        on a chosen date column and keep the previous snapshot's older rows. A refresh then reads a
        week instead of three years. Bind it in the builder: pick the date column, then{" "}
        <strong>Full re-query</strong> or a window of <strong>7</strong>, <strong>30</strong>,{" "}
        <strong>90</strong> or <strong>365</strong> days.
      </P>
      <Callout kind="warn" title="It assumes history does not change">
        Whole time buckets are recomputed rather than partial aggregates merged — which is what
        keeps <C>avg</C> and <C>count_distinct</C> correct, since those cannot be combined from
        partials. The trade you are accepting is the usual one:{" "}
        <strong>
          a late-arriving edit to a row outside the window will not appear until a full refresh.
        </strong>{" "}
        If your source back-dates corrections, either widen the window past your correction lag or
        leave incremental off.
      </Callout>

      <H2 id="charts">Chart types — all 26, with required fields</H2>
      <P>
        Each chart declares which fields it needs. The builder only offers types your selected
        columns can satisfy, so a chart missing a required field cannot be created.
      </P>

      <H3 id="ch-basic">Comparison and trend</H3>
      <Table
        headers={["Type", "Required fields", "Optional", "Use for"]}
        rows={[
          [
            <C key="a">bar</C>,
            "xField, yField",
            "seriesField, stacked",
            "Vertical columns; ranking and comparison",
          ],
          [<C key="b">hbar</C>, "xField, yField", "—", "Horizontal bars; long category names"],
          [<C key="c">line</C>, "xField, yField", "seriesField", "Change over time"],
          [<C key="d">area</C>, "xField, yField", "seriesField", "Trend with volume emphasis"],
          [<C key="e">scolumn</C>, "xField, yField, seriesField", "—", "Stacked vertical columns"],
          [<C key="f">shbar</C>, "xField, yField, seriesField", "—", "Stacked horizontal bars"],
          [
            <C key="g">combo</C>,
            "xField, barField, lineField",
            "—",
            "Two measures at different scales (volume + rate)",
          ],
          [
            <C key="h">waterfall</C>,
            "xField, yField",
            "—",
            "How a total is built up from contributions",
          ],
        ]}
      />

      <H3 id="ch-part">Part of a whole</H3>
      <Table
        headers={["Type", "Required fields", "Use for"]}
        rows={[
          [
            <C key="a">pie</C>,
            "nameField, valueField",
            "Few slices — beyond ~6 it stops being readable",
          ],
          [<C key="b">treemap</C>, "nameField, valueField", "Many parts, nested by size"],
          [<C key="c">funnel</C>, "nameField, valueField", "Stage-to-stage drop-off"],
          [<C key="d">nightingale</C>, "nameField, valueField", "Polar rose — cyclical categories"],
          [
            <C key="e">sankey</C>,
            "xField (source), yField (target), valueField",
            "Flow between nodes",
          ],
        ]}
      />

      <H3 id="ch-single">Single value</H3>
      <Table
        headers={["Type", "Required fields", "Optional", "Use for"]}
        rows={[
          [
            <C key="a">kpi</C>,
            "valueField",
            "label, targetField",
            "One headline number, optionally against a target",
          ],
          [
            <C key="b">gauge</C>,
            "valueField",
            "label, targetField, max",
            "Progress toward a ceiling",
          ],
        ]}
      />

      <H3 id="ch-dist">Distribution and relationship</H3>
      <Table
        headers={["Type", "Required fields", "Optional", "Use for"]}
        rows={[
          [
            <C key="a">scatter</C>,
            "xField, yField",
            "sizeField",
            "Correlation between two measures",
          ],
          [
            <C key="b">heatmap</C>,
            "xField, yField, valueField",
            "—",
            "Density across two dimensions",
          ],
          [<C key="c">boxplot</C>, "xField, yField", "—", "Spread and outliers per category"],
          [
            <C key="d">radar</C>,
            "xField, yField",
            "seriesField",
            "Several measures compared across entities",
          ],
        ]}
      />

      <H3 id="ch-detail">Tables and geography</H3>
      <Table
        headers={["Type", "Required fields", "Optional", "Use for"]}
        rows={[
          [<C key="a">table</C>, "—", "columnFormats", "Exact figures read row by row"],
          [
            <C key="b">matrix</C>,
            "rowField, colField, valueField",
            "rowSubField, condFormat",
            "Pivot. rowSubField makes rows expandable groups with subtotals; condFormat colours cells.",
          ],
          [<C key="c">map</C>, "locationField, valueField", "—", "Choropleth by region"],
          [<C key="d">bubblemap</C>, "locationField, valueField", "—", "Magnitude at points"],
        ]}
      />

      <H3 id="ch-special">Specialised</H3>
      <Table
        headers={["Type", "Required fields", "Optional", "Use for"]}
        rows={[
          [<C key="a">barrace</C>, "xField, yField, timeField", "—", "Animated ranking over time"],
          [
            <C key="b">wordcloud</C>,
            "textField",
            "valueField",
            "Term frequency; weight by valueField when you have one",
          ],
          [
            <C key="c">ontology</C>,
            "spec",
            "—",
            "AI-built knowledge graph: subject–predicate–object triples across datasets, warehouses and KB knowledge graphs; nodes and edges are clickable",
          ],
        ]}
      />
      <Callout kind="why">
        Pick the chart from the question, not the other way round. "Which region is biggest" is a
        bar; "is it growing" is a line; "what share" is a pie with few slices. If you cannot state
        the question a visual answers in one sentence, it is decoration — and decoration is what
        makes a dashboard stop being read.
      </Callout>

      <H2 id="formatting">Number formatting</H2>
      <Table
        headers={["Option", "Values", "Notes"]}
        rows={[
          [<C key="a">format</C>, <>currency | percent</>, "Omit for a plain number"],
          [<C key="b">currency</C>, "ISO 4217 code", "Defaults to USD when format is currency"],
          [
            <C key="c">decimals</C>,
            "0 – 4",
            "Fixed fraction digits. Leave undefined for automatic/compact (1.24M).",
          ],
          [
            <C key="d">columnFormats</C>,
            "per column",
            "Table widgets only — format each column independently (number | currency | percent, with its own currency and decimals).",
          ],
        ]}
      />

      <H2 id="analytics">Analytics options</H2>
      <P>
        Available on every chart spec; each renderer applies the ones it supports. This is where
        most of the analytical value lives, and it is the part people miss.
      </P>
      <Table
        headers={["Option", "Values", "Applies to", "Effect"]}
        rows={[
          [
            <C key="a">drillFields</C>,
            "string[]",
            "bar, hbar, pie",
            "Drill hierarchy; level 0 is the configured field. Readers descend one level per click.",
          ],
          [
            <C key="b">dateGrain</C>,
            "auto | day | week | month | quarter | year",
            "line, area",
            "Default bucketing; viewers can toggle it.",
          ],
          [
            <C key="c">compare</C>,
            "prior_period | prior_year",
            "line, area (single series)",
            "Overlays the previous bucket or the same bucket last year.",
          ],
          [
            <C key="d">running</C>,
            "boolean",
            "line, area (single series)",
            "Cumulative running total.",
          ],
          [<C key="e">trend</C>, "boolean", "line (single series)", "Linear trend line."],
          [
            <C key="f">forecast</C>,
            "number of buckets",
            "line (single series)",
            "Projects ahead with a ±1.96σ confidence corridor.",
          ],
        ]}
      />
      <Callout kind="warn" title="A forecast is a straight-line projection">
        The ±1.96σ corridor is a 95% band around a linear extrapolation, not a model of your
        business. It is honest about uncertainty and blind to seasonality, launches and price
        changes. Use it to frame a conversation, never to commit to a number.
      </Callout>

      <H3 id="condformat">Conditional formatting (matrix)</H3>
      <Table
        headers={["Mode", "Configuration"]}
        rows={[
          [
            <C key="a">scale</C>,
            "Continuous colour scale across the values, with an optional base colour.",
          ],
          [
            <C key="b">rules</C>,
            <>
              An ordered list — <strong>first match wins</strong>. Each rule is an operator (
              <C key="o">gt</C>, <C key="g">gte</C>, <C key="l">lt</C>, <C key="le">lte</C>,{" "}
              <C key="e">eq</C>, <C key="n">neq</C>, <C key="b2">between</C>), a value (plus{" "}
              <C key="v2">value2</C> for between, inclusive) and a colour.
            </>,
          ],
        ]}
      />

      <H3 id="refline">Reference lines</H3>
      <P>
        A horizontal reference line on cartesian charts, in one of two modes: <C>avg</C> draws the
        series average, or <C>value</C> draws a fixed number you supply. Both take an optional label
        — use it, because an unlabelled line invites the reader to guess what it means.
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
            name: "Ask AI (embeds)",
            body: "On an EMBEDDED dashboard, readers can ask a follow-up question of its data in natural language, including a drill-down on what they clicked. Inside the app this is not a separate control — the AI analyst in the builder answers the same questions with more of the model behind it.",
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
          <strong>Incremental refresh</strong> — re-query only a recent window instead of the whole
          table. Covered in <DocLink to="/docs/bi#incremental">how a widget gets its data</DocLink>,
          along with the assumption it commits you to.
        </li>
        <li>
          <strong>Scheduled reports</strong> — email a digest of the dashboard on a schedule.
        </li>
      </UL>
      <Callout kind="why" title="Aggregate in SQL — complete totals on any table size">
        A chart widget stores a capped snapshot (500 rows). On a large table, summing a capped
        snapshot in the browser is a <em>partial</em> total — the number looks confident and is
        quietly wrong. New widgets therefore aggregate in the database by default (a validated{" "}
        <C>GROUP BY</C> compiled from the chart), so the warehouse returns complete grouped rows
        instead of raw ones. Existing widgets are not switched automatically — turning it on can
        change the number they display, which is the owner's call — they show a{" "}
        <strong>Partial</strong> badge when their snapshot hit the cap, with an "Aggregate in SQL"
        toggle in the widget menu.
      </Callout>
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

      <H3 id="restricted-shares">Row filters and hidden columns on shares</H3>
      <P>
        A dashboard grant (Admin → IAM → Access) can carry a <strong>row filter</strong> (the
        grantee only sees rows where a column matches allowed values) and{" "}
        <strong>hidden columns</strong> (columns removed entirely). Both are enforced{" "}
        <em>server-side</em>: a grantee whose grant carries any restriction never reads stored
        widget data directly — the server applies the filter and drops masked columns before
        anything leaves it, on snapshots and on live direct queries alike. Semantics follow the rest
        of IAM: one unrestricted grant (directly or via any group) makes the whole dashboard
        visible, and a column is hidden only when <em>every</em> applicable grant hides it.
      </P>

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
          Switch heavy widgets from{" "}
          <DocLink to="/docs/bi#data-mode">direct query to imported snapshots</DocLink> with a
          refresh schedule. This is usually the whole fix.
        </li>
        <li>
          Turn on <DocLink to="/docs/bi#pushdown">Aggregate in SQL</DocLink>. It returns one row per
          category instead of thousands, so it makes the dashboard faster and the totals correct at
          the same time.
        </li>
        <li>
          Use <DocLink to="/docs/bi#incremental">incremental refresh</DocLink> if the refresh itself
          is what's slow rather than the view.
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
