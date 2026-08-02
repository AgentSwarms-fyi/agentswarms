import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/semantics")({
  head: () => ({
    meta: [
      { title: "Semantic Layer — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Define metrics and dimensions once so every dashboard, agent and query returns the same number for the same question.",
      },
      { property: "og:title", content: "Semantic Layer — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Governed metrics — one definition of revenue, everywhere.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/semantics" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/semantics" }],
  }),
  component: SemanticsPage,
});

function SemanticsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Semantic Layer"
        description="A metric defined once and reused everywhere. It exists so that two people asking the same question of the same data cannot get two different answers."
      />

      <P>
        Open <strong>Data → Semantic Layer</strong>. You define <strong>metrics</strong> (numbers)
        and <strong>dimensions</strong> (ways to slice them) over your tables; the platform compiles
        a request for them into SQL and runs it.
      </P>

      <Callout kind="why">
        Without this layer, "revenue" is whatever SQL the last person wrote. One analyst excludes
        refunds, another includes tax, an agent invents a third variation — and all three are
        defended in a meeting. A metric definition makes the choice once, in the open, and every
        consumer inherits it.
      </Callout>

      <H2 id="model">The pieces — exact fields</H2>

      <H3 id="metric">Metric</H3>
      <Table
        headers={["Field", "Required", "Values / notes"]}
        rows={[
          [
            <C key="a">name</C>,
            "Yes",
            <>
              Stable id matching <C key="p">^[a-zA-Z_][a-zA-Z0-9_]*$</C> — it becomes the SQL alias,
              so no spaces or hyphens.
            </>,
          ],
          [<C key="b">label</C>, "No", "Human-readable display name"],
          [
            <C key="c">description</C>,
            "No",
            "What it means and what it excludes. Agents read this too.",
          ],
          [
            <C key="d">agg</C>,
            "Yes",
            <>
              <C key="1">sum</C>, <C key="2">avg</C>, <C key="3">count</C>,{" "}
              <C key="4">count_distinct</C>, <C key="5">min</C>, <C key="6">max</C>,{" "}
              <C key="7">custom</C>, <C key="8">derived</C>
            </>,
          ],
          [
            <C key="e">sql</C>,
            "Depends",
            <>
              The column or expression to aggregate. Optional for <C key="c2">count</C>; REQUIRED
              for <C key="c3">custom</C>, where it is the full aggregate expression, e.g.{" "}
              <C key="c4">SUM(revenue) - SUM(cost)</C>. For <C key="c5">derived</C> it is a formula
              over OTHER metrics referenced as <C key="c6">{"{metric_name}"}</C>, e.g.{" "}
              <C key="c7">{"{revenue} / NULLIF({orders}, 0)"}</C> — each token is replaced with that
              metric's own expression, so a ratio always tracks its parts' current definitions.
              Derived metrics may reference other derived metrics; circular or unknown references
              are refused at compile time.
            </>,
          ],
          [
            <C key="f">filters</C>,
            "No",
            <>
              Boolean SQL fragments ANDed INSIDE the aggregate — a filtered measure, e.g.{" "}
              <C key="f2">status = 'paid'</C>. Ignored when agg is <C key="f3">custom</C>.
            </>,
          ],
          [<C key="g">format</C>, "No", <>number | currency | percent</>],
          [<C key="h">currency</C>, "No", "ISO 4217 code when format is currency"],
        ]}
      />
      <Callout kind="why">
        <C>filters</C> lands inside the aggregate rather than in the query's WHERE clause. That
        distinction is the whole point: <C>net_revenue</C> can exclude refunds while sitting on the
        same row set as <C>gross_revenue</C>, so both can appear in one result without one of them
        quietly filtering the other.
      </Callout>

      <H3 id="dimension">Dimension</H3>
      <Table
        headers={["Field", "Required", "Values / notes"]}
        rows={[
          [<C key="a">name</C>, "Yes", "Same identifier rule as a metric — it is the SQL alias."],
          [<C key="b">label</C>, "No", "Display name"],
          [<C key="c">description</C>, "No", "What this slice means"],
          [
            <C key="d">sql</C>,
            "Yes",
            <>
              A column, or an expression such as <C key="e2">DATE_TRUNC('month', created_at)</C>.
            </>,
          ],
          [
            <C key="e">type</C>,
            "No",
            <>
              Field type. A <C key="t2">time</C> dimension can be rolled up to a{" "}
              <strong>grain</strong> at query time (day/week/month/quarter/year) — the compiler
              emits the right truncation per warehouse dialect, so you write the raw column once and
              get monthly or quarterly buckets on demand. Local datasets support every grain on
              DuckDB, the default engine; on the <C key="t3">LOCAL_ENGINE=alasql</C> escape hatch,
              every grain except week.
            </>,
          ],
        ]}
      />
      <Callout kind="warn" title="These SQL fields are trusted">
        Both <C>sql</C> fields are inserted into the compiled query as written. Only people you
        trust to write SQL against your warehouse should be defining metrics — this is an authoring
        surface, not a user input.
      </Callout>

      <H2 id="define">Defining a metric</H2>
      <P>
        Pick a source — a <strong>local dataset</strong> or a <strong>warehouse table</strong> (any
        connected Snowflake / BigQuery / Postgres / … connection; the editor browses its tables) —
        name the metric, choose the aggregation and expression, add the filters that belong to the
        definition, and declare which dimensions it may be sliced by. The editor previews the
        compiled SQL and a sample result before you save — read the SQL, it is the definition.
      </P>
      <P>
        <strong>Validate</strong> compiles every dimension and metric and runs each one against the
        real source, reporting failures per field. Use it before saving: a typo'd column otherwise
        surfaces as an engine error much later, on a dashboard refresh. The{" "}
        <strong>query runner</strong> below the editor picks metrics and dimensions, adds filters
        (dimension filters become <C>WHERE</C>, metric filters <C>HAVING</C>) and time rollups, and
        the result can be sent straight to a dashboard as a governed widget.
      </P>
      <Code lang="Compiled preview">{`SELECT date_trunc('month', o.created_at) AS month,
       o.region                          AS region,
       SUM(o.amount)                     AS net_revenue
FROM   orders o
WHERE  o.status = 'settled'
  AND  o.is_refund = false
GROUP BY 1, 2`}</Code>

      <H3 id="joins">Joins — spanning a star schema</H3>
      <P>
        A model can declare up to eight <C>LEFT</C>/<C>INNER</C> joins from its source table, so
        dimensions and metrics can reference related tables (<C>customers.segment</C> on an{" "}
        <C>orders</C> fact) without pre-joining in a view or prep flow — the metric definition stays
        the whole story. Table names and aliases are validated as strict identifiers; the <C>ON</C>{" "}
        condition is authored by the model owner, the same trust as a dimension's SQL. Once a join
        exists, qualify column names in your fragments.
      </P>

      <H3 id="relative-dates">Relative date filters</H3>
      <P>
        Prefer these to hard-coded dates: they resolve against today every time the query runs, so a
        dashboard never needs editing as time passes. <C>last_n_days</C> (with the number of days as
        the value), <C>this_month</C>, <C>last_month</C>, <C>this_quarter</C>, <C>last_quarter</C>{" "}
        and <C>ytd</C>. They apply only to a <strong>time</strong> dimension, and compare the raw
        date rather than a rollup bucket — so &ldquo;last 30 days&rdquo; grouped by month still
        means 30 days. Windows are half-open and computed in UTC, and the runner shows the exact
        dates each one resolves to.
      </P>

      <H3 id="compare">Period-over-period</H3>
      <P>
        Set <C>compare</C> to <C>yoy</C>, <C>mom</C> or <C>prior_period</C> and every metric gains{" "}
        <C>_prev</C>, <C>_change</C> and <C>_pct_change</C> (a fraction — <C>0.25</C> is +25%). It
        needs exactly one time dimension with a grain: that is the axis being compared.{" "}
        <C>prior_period</C> steps back one unit of that grain, <C>mom</C> one month and <C>yoy</C>{" "}
        one year whatever the grain.
      </P>
      <P>
        Three behaviours worth knowing. A period with <strong>no predecessor</strong> — the first in
        the series, or a gap in the data — shows blank rather than being dropped from the result.{" "}
        <C>_pct_change</C> is <strong>blank when the earlier value was zero</strong>, because a
        change from nothing is not a percentage. And any date filter you set{" "}
        <strong>moves with the comparison</strong>, so filtering to this year still compares against
        last year rather than against nothing.
      </P>
      <P>
        Not available on the AlaSQL escape hatch (<C>LOCAL_ENGINE=alasql</C>), which has neither
        CTEs nor date arithmetic — the compiler refuses with that message rather than emitting SQL
        it cannot run.
      </P>
      <Code lang="Compiled preview">{`WITH semantic_cur AS (…), semantic_prev AS (… shifted one year …)
SELECT semantic_cur."month",
       semantic_cur."net_revenue",
       semantic_prev."net_revenue"                                    AS "net_revenue_prev",
       (semantic_cur."net_revenue" - semantic_prev."net_revenue")     AS "net_revenue_change",
       CASE WHEN semantic_prev."net_revenue" = 0 THEN NULL
            ELSE (semantic_cur."net_revenue" - semantic_prev."net_revenue")
                 * 1.0 / semantic_prev."net_revenue" END              AS "net_revenue_pct_change"
FROM   semantic_cur
LEFT JOIN semantic_prev ON semantic_cur."month" IS NOT DISTINCT FROM semantic_prev."month"`}</Code>

      <H2 id="consumers">Who uses it</H2>
      <Table
        headers={["Consumer", "How"]}
        rows={[
          [
            <DocLink key="bi" to="/docs/bi">
              Dashboards
            </DocLink>,
            "Pick a metric in the builder instead of writing a query. The tile inherits the definition and updates if it changes.",
          ],
          [
            "Agents",
            <>
              Enable the <C key="m">metric_query</C> tool. The agent asks for a metric by name with
              dimensions and filters — it never re-derives the number.
            </>,
          ],
          [
            <DocLink key="p" to="/docs/playground">
              Agent Chat
            </DocLink>,
            "Answers about governed numbers come back consistent with the dashboards showing the same metric.",
          ],
          [
            <DocLink key="ai" to="/docs/bi">
              BI AI analyst
            </DocLink>,
            "When it writes SQL for a chart or an AI-generated dashboard, the governed definitions for the tables in play are injected into its context with an instruction to compute those metrics with exactly the defined expression — so ad-hoc BI agrees with the metric tiles instead of improvising a different formula.",
          ],
        ]}
      />
      <Callout kind="info">
        When an agent answers from a metric, the source shown under the answer names the metric and
        marks it as coming from the semantic layer — so a reader can tell a governed number from an
        ad-hoc query at a glance.
      </Callout>

      <H2 id="metric-vs-sql">Metric or plain SQL?</H2>
      <Table
        headers={["Use a metric when", "Use SQL when"]}
        rows={[
          ["The number appears in more than one place", "It's a one-off investigation"],
          ["People would argue about its definition", "The shape is exploratory and changing"],
          ["An agent might be asked for it", "You need a join or window the layer doesn't model"],
          [
            "It must stay consistent as the data model changes",
            "You're prototyping and will discard it",
          ],
        ]}
      />

      <H2 id="practice">Practical advice</H2>
      <UL>
        <li>
          <strong>Name for the business, not the schema.</strong> <C>net_revenue</C>, not{" "}
          <C>sum_amt_filtered</C>. The name is what people and agents select on.
        </li>
        <li>
          <strong>Write the exclusions into the description.</strong> "Excludes refunds and internal
          test accounts" prevents most of the arguments this layer exists to end.
        </li>
        <li>
          <strong>Start with the contested few.</strong> Five metrics everyone disputes are worth
          more than fifty nobody looks at.
        </li>
        <li>
          <strong>Declare dimensions deliberately.</strong> Every dimension you expose is a slice
          someone will screenshot — leave out the ones where the metric doesn't mean anything.
        </li>
        <li>
          <strong>Changing a definition changes history.</strong> Everything reading the metric
          moves with it. Announce it, and note the change in the description.
        </li>
      </UL>

      <H3 id="access">Access</H3>
      <P>
        Metrics inherit access from the tables underneath them — a user who cannot read the source
        table cannot use a metric built on it. Grants are managed in{" "}
        <DocLink to="/docs/iam">Access control</DocLink>.
      </P>

      <NextPrev current="/docs/semantics" />
    </>
  );
}
