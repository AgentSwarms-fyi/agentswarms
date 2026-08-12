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
              <strong>grain</strong> at query time — <C key="g1">day</C>, <C key="g2">week</C>,{" "}
              <C key="g3">month</C>, <C key="g4">quarter</C>, <C key="g5">year</C>, plus{" "}
              <C key="g6">fiscal_year</C> and <C key="g7">fiscal_quarter</C> (see{" "}
              <a className="underline underline-offset-2" href="#fiscal">
                fiscal calendars
              </a>
              ) — the compiler emits the right truncation per warehouse dialect, so you write the
              raw column once and get monthly or quarterly buckets on demand. Local datasets support
              every grain on DuckDB, the default engine; on the <C key="t3">LOCAL_ENGINE=alasql</C>{" "}
              escape hatch, every grain except week and the fiscal pair.
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
        real source, reporting failures per field — and then goes further: it measures each join's
        real cardinality, checks the primary key's uniqueness, and re-computes every pinned
        assertion (see <a href="#trust">Trust checks</a>). Use it before saving: a typo'd column
        otherwise surfaces as an engine error much later, on a dashboard refresh. The{" "}
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
      <P>
        Each join declares its <strong>cardinality</strong> — how many joined rows one source row
        matches. A lookup (<C>many_to_one</C>, <C>one_to_one</C>) is safe; a fanning join (
        <C>one_to_many</C>, <C>many_to_many</C>) repeats each source row per match, which silently
        inflates any <C>sum</C>/<C>avg</C>/<C>count</C> over source columns. With the cardinality
        declared, the compiler builds a <strong>multi-fact plan</strong> instead of that wrong
        number: each metric aggregates in its own branch — the source plus only the fanning join its
        columns reference — at the requested dimension grain, and the branches are stitched on a
        dimension spine. Base metrics and fact metrics come back correct <em>side by side</em>, two
        fanning facts (the classic chasm: orders → items, orders → shipments) each aggregate at
        their own grain, and a group missing from one fact shows blank for that fact rather than
        vanishing. What the plan cannot prove still <strong>refuses</strong> with the reason: an
        unqualified column (no branch may guess its table), a bare <C>count</C>, a metric reading
        two facts at once, a dimension taken from a fanning table, an <C>INNER</C> fanning join, and
        period-over-period across a plan. Models saved before cardinality existed keep compiling
        unchanged — Validate measures them instead.
      </P>
      <Callout kind="why">
        Measured on a two-order fixture: orders A (100) and B (50), where A has three line items.
        Joined to the items table, <C>SUM(orders.amount)</C> returns 350 against a truth of 150 — no
        error, no caveat. Once the join declares <C>one_to_many</C>, the same query compiles to a
        per-fact plan and returns 150 — with the line-item metrics right beside it, also correct.
      </Callout>

      <H2 id="trust">Trust checks — grain, measurement, assertions</H2>
      <P>
        A model can declare its <strong>primary key</strong> — the column that identifies one row of
        the source, i.e. the model's grain. <strong>Validate</strong> doesn't trust any of these
        declarations: it <em>measures</em> them. It counts the source rows, re-counts after each
        join cumulatively, and compares the result to the declared cardinality — an undeclared join
        that fans out in the data, or a &ldquo;lookup&rdquo; that actually multiplies rows, is
        reported with the real row counts. The primary key is checked for uniqueness (
        <C>COUNT(*)</C> vs <C>COUNT(DISTINCT key)</C>), and with a key declared the join measurement
        also catches fan-out an <C>INNER</C> join's dropped rows would hide from a bare row count.
      </P>
      <P>
        <strong>Assertions</strong> pin the numbers a model must keep producing: a metric, a set of
        absolute filters, and the expected value (with an optional tolerance). Every Validate
        re-computes each one against the live backend and fails if the number moved — the difference
        between &ldquo;the SQL still runs&rdquo; and &ldquo;revenue still means what the board was
        told&rdquo;. Relative date windows are refused in assertion filters, because a pin on
        &ldquo;ytd&rdquo; would go stale by itself; pin an explicit date range instead. The editor's{" "}
        <strong>Pin current value</strong> button records what the model computes today — confirm
        the number against a trusted reference before relying on it.
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

      <H3 id="fiscal">Fiscal calendars</H3>
      <P>
        A model can declare the month its <strong>fiscal year starts</strong> (Source tab). That
        unlocks two extra rollups — <C>fiscal_year</C> and <C>fiscal_quarter</C> — and five extra
        windows: <C>this_fiscal_year</C>, <C>last_fiscal_year</C>, <C>this_fiscal_quarter</C>,{" "}
        <C>last_fiscal_quarter</C> and <C>fiscal_ytd</C>. A fiscal year is named by the calendar
        year it <strong>ends</strong> in — with a July start, July 2025 opens FY&nbsp;2026 — and the
        buckets come back as sortable <em>numbers</em>: <C>2026</C> for a year, <C>20261</C> for
        FY2026&nbsp;Q1, so they order correctly in every engine and chart without per-dialect date
        formatting. With no fiscal start configured (or January), the fiscal vocabulary still works
        and simply equals its calendar counterparts.
      </P>
      <Callout kind="why">
        The windows are computed here and compiled as literal date ranges, so they run everywhere —
        but fiscal <em>rollups</em> need date arithmetic in SQL, which the AlaSQL escape hatch does
        not have. Fiscal grains refuse on <C>LOCAL_ENGINE=alasql</C> with that message rather than
        bucketing into the wrong year.
      </Callout>

      <H3 id="parameters">Parameters — governed what-ifs</H3>
      <P>
        A model can declare named <strong>parameters</strong> its SQL fragments reference as{" "}
        <C>{"{{name}}"}</C> tokens — a commission rate, a materiality floor, a status filter.
        Callers (the runner, agents via <C>metric_query</C>, dashboards) may override them per
        query; every parameter <strong>must carry a default</strong>, because Validate, assertions
        and scheduled refreshes compile without a caller and a parameter that breaks unattended
        compiles is a footgun, not a feature. Values substitute as <em>literals</em> — numbers must
        parse, strings are escaped like any other literal — and a query naming an undeclared
        parameter, or a fragment referencing one the model never declared, is refused with the
        declared list. Join <C>ON</C> conditions cannot use parameters: a parameterised join would
        change the query graph per caller, and every cardinality declaration and measured probe
        would be describing a different query.
      </P>
      <Code lang="Metric SQL">{`-- metric big_sales, with parameter {{min_amount}} (number, default 100)
SUM(CASE WHEN amount >= {{min_amount}} THEN amount ELSE 0 END)`}</Code>

      <H3 id="hierarchies">Hierarchies — declared drill paths</H3>
      <P>
        A <strong>hierarchy</strong> is an ordered drill path over existing dimensions —{" "}
        <C>geo: region → subregion → city</C> — declared once on the model. Agents see it in the
        catalog, so &ldquo;break that down&rdquo; has a governed next level instead of a guess, and
        the answer to &ldquo;drill into EMEA&rdquo; is the same path everyone else drills. Levels
        must name real dimensions on the model (2–6 of them, broadest first); a level that is not a
        dimension, or appears twice, is refused at save with the list of what exists.
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

      <H3 id="agent-catalog">What the agent sees — synonyms, values, honest sizes</H3>
      <P>
        The catalog injected into <C>metric_query</C> carries each field&apos;s{" "}
        <strong>description</strong>, each metric&apos;s <strong>governed formula</strong> (
        <C>revenue = SUM(amount)</C>), its <strong>synonyms</strong> (add them per field in the
        editor — <C>aka: turnover, GMV</C>) and <strong>sampled values</strong> for low-cardinality
        categorical dimensions (<C>values: AMER|APAC|EMEA</C>, measured by Validate — a dimension
        with more than 8 distinct values lists none, because a partial list reads as a complete
        one). Synonyms are also <strong>resolved server-side</strong>: a query for
        &ldquo;turnover&rdquo; maps to <C>revenue</C> with a disclosed note, and an ambiguous
        synonym refuses rather than guessing. Unknown names refuse <em>listing what exists</em>, and
        a result larger than the tool&apos;s 50-row cap says{" "}
        <em>&ldquo;first 50 row(s) of a LARGER result&rdquo;</em> instead of a silent partial list.
      </P>

      <H2 id="consumers">Who uses it</H2>
      <Table
        headers={["Consumer", "How"]}
        rows={[
          [
            <DocLink key="bi" to="/docs/bi">
              Dashboards
            </DocLink>,
            "Pick a metric in the builder instead of writing a query. The tile inherits the definition and updates if it changes — including its display format, so a currency metric charts as currency, not a bare number.",
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

      <H3 id="access">Access — sharing with row-level security</H3>
      <P>
        Metrics inherit access from the tables underneath them — a user who cannot read the source
        table cannot use a metric built on it. A superadmin can also <strong>share a model</strong>{" "}
        (grant type <em>Semantic model</em> in <DocLink to="/docs/iam">Access control</DocLink>):
        the grantee queries governed numbers computed over the <em>owner&apos;s</em> data, without
        access to the underlying tables. The grant can carry a <strong>row filter</strong>{" "}
        (dimension ∈ values, e.g. <C>region ∈ [EMEA]</C>) and a <strong>field mask</strong> — both
        enforced <em>inside the compiled SQL</em> at the one choke point every consumer uses
        (agents, the runner, BI refresh). A filter naming a dimension the model no longer has{" "}
        <strong>fails closed</strong>. And the restriction is disclosed everywhere: the grantee's
        editor, the runner's results and the agent's tool output all say the numbers are a scoped
        view — a restricted share must never pass for the global truth.
      </P>
      <P>
        A row-filter value can also be the <strong>attribute token</strong>{" "}
        <C>{"{{user.<key>}}"}</C> instead of a literal. It resolves at query time to the{" "}
        <em>calling viewer&apos;s</em> values for that key, set by an admin under{" "}
        <strong>Admin → IAM → Attributes</strong> — so one grant on a group,{" "}
        <C>{"region ∈ [{{user.region}}]"}</C>, scopes every member to their own region. A viewer
        whose account lacks the attribute is <strong>refused with the attribute named</strong> —
        never run unfiltered, never silently empty — and a malformed token is refused when the grant
        is written, using the same grammar the enforcer applies. The disclosure shows the{" "}
        <em>resolved</em> values, so a viewer always knows the scope they are actually seeing.
      </P>

      <H3 id="certification">Certification, history and dependents</H3>
      <P>
        A model is <C>draft</C>, <C>certified</C> or <C>deprecated</C>. <strong>Certify</strong>{" "}
        re-runs the whole validation pipeline against the live backend and refuses if anything
        fails, then stamps who and when;{" "}
        <strong>editing a certified model&apos;s definition drops it back to draft</strong> (a
        database trigger, so no write path can carry a stale certificate). Agents see{" "}
        <C>[certified]</C> and <C>[DEPRECATED]</C> markers in their catalog. Every change to a saved
        model also snapshots the previous definition — the <strong>History &amp; usage</strong> tab
        shows a field-level diff per version, a restore (itself undoable), and everything that
        depends on the model: metric-backed widgets, agents and swarm nodes that allow-list it, and
        who it is shared with. Deleting a model warns with that list first.
      </P>

      <NextPrev current="/docs/semantics" />
    </>
  );
}
