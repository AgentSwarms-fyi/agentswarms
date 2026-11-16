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
        Open <strong>Data &amp; BI → BI Workspace</strong>. Dashboards live in workspaces and
        folders; each is a grid of resizable widgets you drag into place.
      </P>

      <H2 id="ai-analyst">AI Analyst — conversational analysis</H2>
      <P>
        <strong>AI Analyst</strong> (under Data &amp; BI) is the dedicated ask-anything surface. An
        analyst is three choices: a <strong>reasoning model</strong> from your connected providers
        (the dialog suggests reasoning families and nudges you when a pick doesn&apos;t look like
        one), <strong>the data</strong> it analyses — local datasets and uploads, one table, or a
        warehouse connection — and the <strong>predictive models</strong> it may score or forecast
        with: any model it can use, or exactly the ones you tick. It chooses among them by the
        question, and a model outside the list is refused even when a plan names it. All three stay{" "}
        <strong>editable</strong> from the pencil on the analyst&apos;s card, and an edit applies to
        your next question: earlier analyses are not re-run and each keeps a record of the model
        that produced it, so an exported report never attributes old numbers to a newly-chosen
        model. Reasoning models are also given a longer request deadline than chat models, because
        their time goes on thinking rather than output — sized for chat models, the analyst&apos;s
        required model class was the one that timed out. One question runs at a time: a second Enter
        while the first is starting is ignored, so it never runs twice or saves two threads.
      </P>
      <H3 id="analyst-governed">Governed steps</H3>
      <P>
        <strong>Governed steps are compiled, not described.</strong> When a step&apos;s numbers come
        from a governed semantic model, the plan names the model, its metrics and its dimensions,
        and the <strong>semantic compiler</strong> writes the SQL — with the fan-out refusals,
        rollup routing, row filters and column masks a hand-written SELECT cannot honour. Every name
        is checked against the catalog, and a block naming anything the model does not have is
        dropped whole: compiling the half that matched would answer a different question under a
        governance badge. A dropped block is not a refusal — the step falls back to written SQL and
        appears <em>without</em> the badge. A step whose SQL is later corrected by the self-check
        loses the badge too, because the correction is the analyst&apos;s SQL, not the
        compiler&apos;s. Where a rollup answered instead of the fact table, or a row filter narrowed
        the result, the step says so in words. Past analyses are all reachable from the picker
        beside <strong>New analysis</strong>.
      </P>
      <H3 id="analyst-predictions">Predictions from trained models</H3>
      <P>
        <strong>Scored steps predict; the analyst never estimates.</strong> When a question asks
        what <em>will</em> happen, which rows are <em>likely</em> something, or for a predicted
        value, and a trained model from ML Models is in scope, the plan may add{" "}
        <C>{'"score": { "model": "<name>" }'}</C> to a step. The step&apos;s SQL selects the
        entities — the model&apos;s key column(s) when it is bound to a feature view, so the
        features are read from the view, or its feature columns otherwise — and the model supplies
        the prediction columns, joined onto the step&apos;s rows (at most fifty, the agent
        tool&apos;s cap). The step carries a <strong>scored</strong> badge naming the model, and
        under its table says how many rows were scored, the model&apos;s version and headline
        metric, where the features came from and which keys were not found. Every name is checked
        against the models the analyst actually loaded; a step naming anything else is simply not
        scored. A scoring that fails leaves the rows unscored and says so in the self-check note.
        The write-up is told which steps were scored and must report predictions as what the model
        estimates, naming it, never as something observed. A step whose SQL the self-check corrects
        is scored again on the corrected rows, and its note says so; a step re-run by hand loses its
        predictions with the badge — they belonged to the old rows — until the question is asked
        again. A prediction column that collides with one the SQL already returned is kept under a{" "}
        <C>predicted_</C> prefix, so the model&apos;s numbers are the ones on the table the badge
        vouches for. The SQL writer is told, in the step&apos;s own goal, that the rows will be
        scored afterwards and what they must carry — the model&apos;s key column(s) from the source
        table, at most fifty rows, no stored predictions table and no prediction of its own. And a
        write-up that comes back as data rather than prose (an object of rows under <C>answer</C>,
        with <C>caveats</C>) is rendered as a table with its caveats, not reported as &quot;no
        write-up&quot;. The self-check is told which columns the model added and that they exist in
        no table — it judges the SQL by the rows it was asked to return, and a correction it writes
        never selects the model&apos;s columns (live, one did, and died on a binder error); and the
        contribution and trend arithmetic the check and the write-up are handed reads only the
        observed columns, never the estimates (live, a table of <C>order_id</C>, <C>prediction</C>,{" "}
        <C>probability</C> was read as a two-period breakdown by prediction, and the write-up listed
        the resulting &quot;total change&quot; as a caveat beside the real one). The model&apos;s{" "}
        <strong>health</strong> rides along: the planner sees each scorable model&apos;s latest
        drift reading or evaluation verdict, and a scored step&apos;s badge and disclosure say it —{" "}
        {'"open drift alert (PSI 3.291 on 2026-09-14)"'} — so the write-up can warn beside the
        numbers it cites.
      </P>
      <P>
        <strong>Forecasts, rankings and what a model can say.</strong> A trained{" "}
        <strong>forecast</strong> model in scope is offered to the planner as a forecast step (
        <C>{'"forecast": { "model": "<name>", "horizon": N }'}</C>): no SQL — the step&apos;s rows
        are the model&apos;s projected periods with their interval, the badge says{" "}
        <strong>forecast by</strong>, and the write-up is told the rows are a projection. A
        regression model is never a forecast: the planner is told so, and the write-up is told a
        scored regression step gives one estimate per row and is not a series. The{" "}
        <strong>most, least or top-N by a model&apos;s output</strong> — most anomalous, most likely
        enterprise, highest predicted value — is decided by the platform on the scored rows (
        <C>{'"rank": { "by": "<output column>", "desc": true, "limit": N }'}</C> inside <C>score</C>
        ), never in SQL, where the column does not exist; the disclosure says &quot;ranked by
        anomaly_score (highest first), top 10 of the 50 scored&quot;. A step whose goal names a
        model in scope is scored by it even when the planner forgot the block, because naming the
        model is the request. The tool&apos;s <strong>model notes</strong> — what each class means,
        each group&apos;s size and typical row, the trainer&apos;s warnings — travel with the scored
        step (a collapsible under the disclosure) and into the write-up, so it can describe a group
        rather than say it was not told. And the analyst refuses rather than improvises: a question
        naming a model nobody has (&quot;the churn model&quot;) stops and asks, naming the models
        that exist, instead of scoring with another; rows missing most of a model&apos;s feature
        columns are not scored, and the missing ones are named; a self-review correction that reads
        a model&apos;s column is refused in code and the original result stands; a correction that
        fails says so, and the write-up is told the step did not fail. A scored step&apos;s rows are
        quoted to the write-up in full (up to the fifty the model scored) — summarised, fifteen
        scored orders became &quot;order_id total=22104&quot; and a findings table built from it —
        and an identifier column is never totalled in the facts at all.
      </P>
      <H3 id="analyst-what-if">What-if scenarios</H3>
      <P>
        <strong>What-if scenarios</strong> ride the same compiler. A compiled step offers the two
        things that can honestly vary — the model&apos;s <strong>declared parameters</strong> and
        the values of filters the step already has — and recompiles the <em>same</em> query with one
        thing changed, so the difference between the numbers is that change and nothing else. The
        result is labelled with exactly what was assumed, shown beside the measured result rather
        than replacing it, and never folded into the findings. Where both sides are a single row the
        delta is computed in code; where they are grouped the comparison is refused rather than
        matching rows by position. A scenario that varies nothing is refused too — re-running an
        identical query under a &ldquo;scenario&rdquo; heading invites the reader to conclude a
        change was tested and made no difference.
      </P>
      <H3 id="analyst-verified">Verified answers and the self-check</H3>
      <P>
        <strong>Verified answers.</strong> Mark a finished analysis verified, or flag it wrong with
        a reason — a flag without one leaves the next reader where they started. The verdict records
        who and when, and is pinned to a fingerprint of the steps it judged: each step&apos;s SQL
        and the governed model that compiled it. Edit a step, or let the self-check rewrite one, and
        the verdict <strong>voids</strong> — shown as void rather than dropped, because the reader
        needs to know a check existed and no longer covers these queries. Results and prose sit
        outside the fingerprint: the same SQL over refreshed data is the same checked work. Ask a
        question someone has already judged and the verdict is <em>offered, not applied</em> —
        asking re-runs the queries against today&apos;s data, and only still-valid verdicts are
        offered. Every question runs a transparent loop: plan the steps, write and run the SQL (the
        same generator and governed metric definitions the BI analyst uses, SELECT-only),{" "}
        <em>check its own work</em> — a wrong step re-runs with corrected SQL, a doubtful one is
        presented flagged — then write up findings where every number cites the step it came from.
        Analyses persist per analyst, follow-up questions see the earlier answers, and the whole
        trace exports as a <strong>PDF</strong>.
      </P>
      <H3 id="analyst-charts">Charts, pinning and computed reasoning</H3>
      <P>
        <strong>Every step that has something to show gets its own chart</strong>, so a three-query
        answer arrives as three visuals rather than one headline picture. Any step can be{" "}
        <strong>pinned to a dashboard</strong> — the widget keeps that step&apos;s SQL and chart,
        and re-runs it on refresh — or <strong>edited and re-run</strong> with your own SQL. When
        you edit one, the findings above are marked <em>written before a step was re-run</em> until
        you rewrite them, and the step drops the check verdict that judged the previous query: a
        green &ldquo;Check passed&rdquo; must never vouch for SQL the analyst never saw. After each
        answer it offers <strong>follow-up questions</strong>, and a brand-new analyst offers{" "}
        <strong>starter questions</strong> written from its own schema.
      </P>
      <P>
        Three kinds of reasoning are <strong>computed in code, not narrated</strong>, because a
        plausible number reads exactly as confident as a correct one. A step returning two periods
        side by side gets <strong>contribution analysis</strong> — each member&apos;s change and its
        share of the total change, with drivers separated from the <em>offsets</em> a headline
        hides, and shares left above 100% when winners and losers cancel. A time-series step gets
        its <strong>trend and outliers</strong> (median-based, so the spike does not hide inside the
        statistic judging it) and, with at least eight periods, a{" "}
        <strong>projection labelled as an estimate</strong> carrying its method and fit error — with
        less history it refuses to extrapolate at all. And when a question genuinely cannot be
        answered without knowing something — an unstated time range, a word your schema defines two
        ways — it <strong>asks before querying</strong>, offering the assumption it would otherwise
        make so accepting takes one click.
      </P>
      <H3 id="analyst-runs">Concurrency and schedules</H3>
      <P>
        <strong>Steps run concurrently</strong> — a three-query analysis issues its queries at once,
        bounded so one question cannot become everyone&apos;s rate limit. That is safe because no
        step consumes another&apos;s output: each writes its SQL from its own goal, and results are
        read only once every step has finished. Results are matched back to steps by index, never by
        completion order, so the trace still reads top to bottom; you just see steps finish out of
        order. Identical SQL inside one analysis runs <em>once</em> — the cache holds the in-flight
        query, so two steps asking the same thing at the same moment share one round-trip. It is
        never carried across questions, because between two questions the data can move and a cached
        row served later is a number that is no longer true.
      </P>
      <P>
        <strong>Schedule</strong> re-runs an analysis hourly, daily or weekly — and it re-runs{" "}
        <em>the saved queries</em>, it does not ask the question again. Re-planning would let the
        SQL differ between runs, so the number you watch over time would have a definition that
        moves underneath you. The steps are pinned instead, no model is called, and the findings are
        marked <em>written before a step was re-run</em> until you rewrite them. A human verdict
        survives (the SQL it judged did not change); a what-if is dropped, because one computed
        against last week is not a what-if against this week. The digest reports what moved —
        precisely for a single-row result, as a row count where results are grouped, since matching
        rows between runs would invent findings — and says so plainly when nothing changed.{" "}
        <strong>Run now</strong> takes the identical path.
      </P>
      <P>
        An analysis is stored encrypted under your own key, with nothing to set up: its questions,
        SQL, write-up and result samples, and its title (
        <DocLink to="/docs/keys">Keys &amp; encryption</DocLink>). A schedule opens and reseals it
        on the server. If your key cannot be had, the run fails with the reason and stores nothing,
        and an analysis that cannot be read says why; what you ask next starts a new one. The
        notification a schedule leaves, and its email, carry the title and what moved, and are not
        under your key.
      </P>
      <H3 id="analyst-sharing">Sharing an analyst</H3>
      <P>
        <strong>Sharing an analyst shares the analyst, not your data access.</strong> Grant it to
        IAM groups and recipients can open it and ask their own questions — but every query they run
        is authorised as <em>them</em>, with their dataset grants, their warehouse credentials and
        their row filters. A shared analyst can therefore return different numbers to different
        people, which the share dialog states before you grant, blocking problems first. The groups
        you tick hold until you save, even across a session refresh. An analyst scoped to{" "}
        <em>all local datasets</em> resolves per reader, so shared it points at the recipient&apos;s
        data rather than yours. <strong>Your saved analyses stay yours</strong> — they hold rows
        fetched under your access — and renaming, editing and deleting remain owner-only. A grant is
        refused outright if the recipients&apos; IAM model rules do not allow the analyst&apos;s
        model.
      </P>
      <H3 id="analyst-provenance">Provenance and export</H3>
      <P>
        Every step that ran a query carries a <strong>Where these numbers came from</strong>{" "}
        disclosure. The tables it names come from <em>the SQL that actually ran</em>, never from the
        model definition — models get edited, and a panel built from today&apos;s definition would
        misdescribe a query that ran against yesterday&apos;s. So a step answered by a rollup names
        the rollup and says the fact table was not read, and a step whose SQL you edited says no
        governed definition vouches for it. Under each table, where the evidence exists, sits what a{" "}
        <strong>prep flow</strong> combined to build it and what the warehouse&apos;s own lineage
        records upstream — loaded only when you open the disclosure. A lookup that fails says so,
        rather than reporting &ldquo;nothing upstream&rdquo;.
      </P>
      <P>
        <strong>Export data</strong> gives you the analysis as a <strong>workbook</strong> rather
        than a document: an overview sheet with the questions, findings and — per step — its
        governed model, check verdict, human verdict and whether it was edited by hand, then one
        sheet per step result. A spreadsheet gets mailed around and outlives the query behind it, so
        the qualifiers travel in the cells: the file is stamped with its export date, and{" "}
        <strong>what-if rows get their own sheet with the assumption in the first column</strong> —
        an unlabelled hypothetical becomes a measurement the moment someone copies it. Steps that
        returned no rows are skipped rather than exported as empty sheets.
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
            body: "The right-hand builder pane takes your source (table, prepared table, or a governed metric). Click fields to group and add up — it writes the query, picks the chart and names it (see Build a visual from fields below) — or switch to SQL and write the query yourself. Until the visual can be added, the line under Add to dashboard says what is still missing: a query to run, the columns to chart, or the title.",
          },
          {
            title: "Or describe it",
            body: "The AI tab writes a whole dashboard, or a single visual, from a sentence. Point it at a table and it writes SQL you should read before trusting the chart; point it at a semantic model and the compiler writes the SQL instead.",
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

      <P>
        Generated from a table with a date, the headline KPIs compare periods — the latest month
        against the one before, with a trend line — and the plan can include narratives: the top
        regions, the change since last month, the next month&apos;s forecast. Each is shaped from
        the columns the query actually returned, so a plan the data cannot carry falls back to the
        chart the model picked rather than an empty frame.
      </P>

      <H3 id="generate-governed">Generate a dashboard from a governed model</H3>
      <P>
        <strong>Generate dashboard with AI</strong> offers two sources: your <strong>tables</strong>
        , or a <DocLink to="/docs/semantics">semantic model</DocLink>. Choosing a model governs the
        whole dashboard.
      </P>
      <P>
        On the governed path the planner is shown the model&apos;s <em>declared</em> metrics and
        dimensions — deliberately not the physical tables or columns, because showing it the schema
        invites it to reach past the layer this path exists to enforce. It picks names from that
        vocabulary and the compiler turns each choice into SQL. So the worst a bad suggestion can do
        is ask a well-formed question nobody wanted, rather than compute a number nobody defined.
      </P>
      <P>
        Everything it returns is checked before it reaches the compiler: an undeclared metric or
        dimension, a time grain on something that is not a time, a rollup the compiler does not
        know, a chart shape that cannot render what it was given, or a duplicate query wearing a
        second name. Each is <strong>refused with a reason naming the offending item</strong>, and
        the rejections are shown in the dialog rather than swallowed — a generate that proposed
        twelve and built nine has to say which three it lost.
      </P>
      <Callout kind="info" title="Metrics only, chosen once">
        The source is picked at the dialog, not per widget. Mixing governed and ungoverned visuals
        would let an ungoverned chart hide among certified ones on a dashboard whose whole claim is
        that its numbers are defined. Questions the semantic model cannot express are simply not
        asked.
      </Callout>

      <H2 id="fields">Build a visual from fields</H2>
      <P>
        The builder opens in <strong>Fields</strong> mode. Pick a table and click the fields you
        want; it writes the query for you — the grouping, the aggregation, the date period, the sort
        and the limit — runs it over the <strong>whole table</strong> as you click, picks the chart
        that reads best and names it. The query it wrote is always one click away, and{" "}
        <strong>Edit as SQL</strong> carries it into the SQL editor when you need something fields
        cannot say. <strong>SQL</strong> mode, beside Fields at the top of the pane, is the
        hand-written path it has always been.
      </P>
      <Steps
        items={[
          {
            title: "Pick a table",
            body: "The field list shows each column with its kind: a number, a date or text. Kinds come from the column's declared type and a 50-row sample, so a text column of dates such as 11/9/2024 is a date, and a numeric id such as Customer ID, order_id or zip_code is text — it labels rows, it is not something to add up, even where the table stores it as a number. The table picker searches as you type, on any part of the name, and shows each table's column count; Search fields narrows a long field list.",
          },
          {
            title: "Click fields",
            body: "Clicking a field puts it where it usually belongs: text and dates go to Group by (dates by month), numbers go to Values as a Sum. The small Group and Value buttons on each row put it in the other place. Number of rows, at the top of the list, counts the rows in each group.",
          },
          {
            title: "Adjust each chip",
            body: "A value's menu sets its aggregation — Sum, Average, Min, Max, Count or Count distinct; a number starts as Sum, and text and dates, which can only be counted, start as Count distinct. A date's menu sets its period — Year, Quarter, Month, Week or Day. × removes the chip.",
          },
          {
            title: "Filter, sort, keep the top",
            body: "A filter is a field, a condition and a value. Sort orders the groups by their first value, largest first, or by their label. Show top keeps the first N groups after sorting. A grouped date runs in time order instead, and Show top becomes Show latest: 12 means the latest 12 periods, still drawn oldest first.",
          },
          {
            title: "Check it and add it",
            body: "The preview, the chart and the title follow every click. Change the chart type or the title and your choice sticks. Add to dashboard saves the visual with its fields, so editing it later opens Fields mode with the same picks.",
          },
        ]}
      />
      <Table
        headers={["Your fields", "The chart it starts as"]}
        rows={[
          ["Values only, nothing grouped", "KPI — one number"],
          ["A date grouped by a period, with values", "Line"],
          ["One text field, with values", "Bar"],
          ["Two text fields and one value", "Stacked column — the second field is the series"],
          ["Groups only, no values", "Table"],
        ]}
      />
      <P>
        Picking another type keeps the fields and reassigns them: the bar&apos;s category becomes
        the pie&apos;s slices, a KPI takes the grouped date as its period, a narrative ranks by the
        first value, a combo draws the second value as its line. On bar, line, area and radar
        charts, every further value becomes its own series (see{" "}
        <a href="#fields-more">More values</a>).
      </P>
      <Callout kind="why" title="Why not just pick a table and chart its rows?">
        Picking a table used to write <C>SELECT * … LIMIT 50</C> and leave the grouping to you. A
        chart over that sums fifty arbitrary rows: Sales by Region drew the first fifty orders, not
        each region&apos;s total, and nothing on the chart said so. Fields write the aggregation
        into the query, so the engine adds up every row and the chart receives one row per group.
      </Callout>

      <H3 id="fields-filters">Filter conditions</H3>
      <Table
        headers={["Condition", "Value", "Example"]}
        rows={[
          [
            "is one of / is not one of",
            "One or more values, comma-separated",
            "Region · is one of · EMEA, AMER",
          ],
          ["= ≠ > ≥ < ≤", "One value", "Discount · > · 0"],
          [
            "between",
            "Two values, comma-separated; both ends included",
            "Sales · between · 10, 500",
          ],
          [
            "contains",
            "Text found anywhere in the value, ignoring case",
            "Customer · contains · energy",
          ],
          ["is not empty", "None — drops NULLs, and empty text too", "Industry · is not empty"],
        ]}
      />
      <P>
        A number field takes numbers only. A date field takes an ISO date (<C>2025-01-31</C>, with
        an optional time) or a date written the way the column writes it (<C>1/31/2025</C> for a
        column of <C>m/d/yyyy</C> text), and compares dates as dates — so 11/30/2024 is before
        1/2/2025 even though, as text, it sorts after it.
      </P>

      <H3 id="fields-calc">Calculated fields</H3>
      <P>
        <strong>Calculated field</strong>, above the field list, adds a field of your own: a name
        and an expression over the table&apos;s columns, in the source&apos;s own SQL. Quote column
        names that have spaces. Leave <em>It aggregates by itself</em> ticked when the expression
        contains its own <C>SUM</C>, <C>AVG</C> or <C>COUNT</C> — it is then used as a value exactly
        as written, and cannot be grouped by. Untick it for a per-row expression, such as{" "}
        <C>{`"Sales" - "Profit"`}</C>, which then behaves like any other column: summed and averaged
        if it is a number, grouped by if it is text. A calculated field lives with the visual; it
        runs inside the same read-only query, and an expression containing <C>;</C> is refused.
      </P>

      <H3 id="fields-more">More values, column titles and totals</H3>
      <FieldList
        items={[
          {
            name: "More values (each its own series)",
            body: "Bar, line, area and radar charts without a Series field draw each further value as its own series — Sales and Profit by month as two lines. Fields mode fills it from Values; in SQL mode you pick the extra number columns here. On a radar each value is a spoke and each category a polygon, and each spoke is on its own scale: its largest value reaches the rim, so sales in millions and quantity in units share one chart, and the tooltip gives the actual figures. A negative value sits at the centre. Stacked columns and bars stack a Series field instead, because values that overlap — profit is part of sales — would stack into a total that means nothing.",
          },
          {
            name: "Column title",
            body: "Each table column's style button in Column formats sets the heading the table shows, so distinct_customer can read Customers. The column keeps its name in the query, in filters and in exports of the data.",
          },
          {
            name: "Totals row",
            body: "On by default. Turn it off where adding the column up means nothing, such as distinct counts. Columns formatted as Percent, and columns whose names mark them as averages, rates or margins (avg_profit, margin, conversion_rate), are never totalled either way.",
          },
        ]}
      />

      <H3 id="fields-narratives">Suggested narratives</H3>
      <P>
        Under the preview, <strong>Suggested narratives</strong> lists the sentences the
        visual&apos;s rows support, already computed: with a date, the change since the period
        before, the next period&apos;s forecast (8 or more periods) and the latest anomaly (5 or
        more); with a category, the top and the bottom members. A sentence the data cannot carry is
        not offered. <strong>Add</strong> puts it on the dashboard as its own{" "}
        <a href="#ch-narrative">narrative</a> visual over the same query, so it follows filters and
        refreshes like the chart beside it.
      </P>
      <P>
        The sentences are about the visual&apos;s own measure and category when it has them — a
        points chart gets sentences about points. A rank, a round, a sequence number or an id is
        never summed as if it were an amount, and a column of pictures, links or colours never names
        a row. A query that returns a running total still gets a sum of that total, since nothing
        marks a column as cumulative: suggest from the per-period figures instead.
      </P>

      <H3 id="fields-examples">Worked examples</H3>
      <P>
        Each example uses the sample table <C>saas_sales</C> — 9,994 orders of a software company
        from 99 customers, with Order Date, Region, Customer, Industry, Segment, Product, Sales,
        Quantity, Discount and Profit. The SQL shown is exactly what Fields mode writes for a local
        dataset.
      </P>
      <P>
        <strong>1. Sales by region.</strong> Click <strong>Region</strong>, then{" "}
        <strong>Sales</strong>. It becomes a bar chart titled <em>Sales by Region</em>, largest
        first.
      </P>
      <Code lang="sql">{`SELECT "Region" AS "region",
       SUM("Sales") AS "sales"
FROM "saas_sales"
GROUP BY "Region"
ORDER BY "sales" DESC
LIMIT 1000`}</Code>
      <P>
        <strong>2. Sales and profit by month.</strong> Click <strong>Order Date</strong> (grouped by
        month), <strong>Sales</strong> and <strong>Profit</strong>. It becomes a line chart with two
        lines, <em>Sales and Profit by month</em>. The sample stores its dates as text such as
        11/9/2024, so the query reads them in that format before bucketing; the months come back as{" "}
        <C>2024-11</C>, <C>2024-12</C> and so on, the labels KPIs and narratives read as periods.
        Set the chip to <strong>Quarter</strong> and they become <C>2024-Q4</C>; to{" "}
        <strong>Week</strong>, <C>2024-W45</C>.
      </P>
      <Code lang="sql">{`SELECT STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m') AS "order_date_month",
       SUM("Sales") AS "sales",
       SUM("Profit") AS "profit"
FROM "saas_sales"
GROUP BY STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m')
ORDER BY "order_date_month" ASC
LIMIT 1000`}</Code>
      <P>
        <strong>3. This month against last month.</strong> Build example 2 with Sales alone and pick{" "}
        <strong>KPI</strong>. The grouped month becomes the KPI&apos;s date: the tile shows the
        latest month, its change against the month before and a trend line of the months behind it
        (see <a href="#kpi-periods">KPIs that compare periods</a>). Set{" "}
        <strong>Compare with</strong> to the same period last year for a year-on-year tile, and tick{" "}
        <strong>Lower is better</strong> for a cost.
      </P>
      <P>
        <strong>4. Top 10 customers in EMEA by profit.</strong> Click <strong>Customer</strong> and{" "}
        <strong>Profit</strong>, add the filter <em>Region · is one of · EMEA</em>, and set{" "}
        <strong>Show top</strong> to 10.
      </P>
      <Code lang="sql">{`SELECT "Customer" AS "customer",
       SUM("Profit") AS "profit"
FROM "saas_sales"
WHERE "Region" IN ('EMEA')
GROUP BY "Customer"
ORDER BY "profit" DESC
LIMIT 10`}</Code>
      <P>
        <strong>5. Margin by industry.</strong> Add the calculated field <C>Margin %</C> with the
        expression <C>{`100 * SUM("Profit") / SUM("Sales")`}</C>, leaving{" "}
        <em>It aggregates by itself</em> ticked. Click <strong>Industry</strong> and{" "}
        <strong>Margin %</strong>, then set the value format to <strong>Percent</strong>, which adds
        the % sign — the expression already multiplies by 100. Each industry&apos;s margin is its
        total profit over its total sales, not an average of each order&apos;s margin, which would
        weigh a $5 order the same as a $5,000 one.
      </P>
      <Code lang="sql">{`SELECT "Industry" AS "industry",
       (100 * SUM("Profit") / SUM("Sales")) AS "margin"
FROM "saas_sales"
GROUP BY "Industry"
ORDER BY "margin" DESC
LIMIT 1000`}</Code>
      <P>
        <strong>6. A product table.</strong> Click <strong>Product</strong>, <strong>Sales</strong>,
        then <strong>Customer</strong> as a value — text is counted distinct — and{" "}
        <strong>Number of rows</strong>; pick <strong>Table</strong>. In Column formats, title the
        columns <em>Sales</em>, <em>Customers</em> and <em>Orders</em> (they arrive as Sales (Sum),
        Customer (Count distinct) and Number of rows), and turn <strong>Totals row</strong> off: a
        customer who bought several products is counted under each, so the Customers column adds up
        to 1,260 while the table has 99 customers.
      </P>
      <Code lang="sql">{`SELECT "Product" AS "product",
       SUM("Sales") AS "sales",
       COUNT(DISTINCT "Customer") AS "distinct_customer",
       COUNT(*) AS "rows"
FROM "saas_sales"
GROUP BY "Product"
ORDER BY "sales" DESC
LIMIT 1000`}</Code>
      <P>
        <strong>7. A headline sentence.</strong> With example 2 built,{" "}
        <strong>Suggested narratives</strong> offers the change in the latest month, the next
        month&apos;s forecast and the latest anomaly, each already written from the data. On the
        sample the change reads{" "}
        <em>Sales for Dec 2025 decreased by 19.5% (−21.9k) from 112.3k to 90.5k.</em> and the
        anomaly{" "}
        <em>
          The most recent anomaly was Nov 2025: sales was 112.3k, higher than the typical 39.8k.
        </em>{" "}
        Add one and it is recomputed whenever the dashboard&apos;s filters change its rows.
      </P>
      <Callout kind="warn" title="Refused, not guessed">
        Fields mode writes a query only when it can say what it means. Summing a text field (
        <em>Region is not a number — count it instead</em>), grouping by a calculated field that
        aggregates, a number field filtered by something that is not a number, a date filter that is
        not a date, and a filter or field the table no longer has are each refused with that reason
        under the fields, and nothing runs until it is fixed.
      </Callout>
      <Callout kind="info" title="Warehouses write their own SQL">
        On a warehouse the same picks write that warehouse&apos;s SQL — its identifier quoting
        (backticks on BigQuery, MySQL and Databricks), its string escapes and its own date
        truncation, so a month is the month&apos;s first day rather than a <C>2026-07</C> label.
        Local datasets run on DuckDB, in the browser for the preview and on the server for scheduled
        refreshes. A server set to <C>LOCAL_ENGINE=alasql</C> cannot run DuckDB&apos;s date
        functions; build those visuals in SQL mode.
      </Callout>

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
      <Callout kind="warn" title="Aggregating in SQL fixes the values, not the row count">
        Pushdown makes each row&rsquo;s number complete. It does not shorten the result: a daily
        series over a year still returns 365 rows, and if that exceeds the snapshot cap the tail of
        the chart is simply absent. A cumulative line measured this way ended its year twelve times
        short while every visible point was individually correct. So the <strong>Partial</strong>{" "}
        badge appears whenever a snapshot hit the cap — <em>including</em> aggregated widgets, where
        it means &ldquo;rows are missing from this chart&rdquo; rather than &ldquo;this total is a
        subset&rdquo;. Narrow the query, or raise <C>PUBLIC_BI_SNAPSHOT_ROWS_CAP</C> (read at
        startup) or <C>VITE_BI_SNAPSHOT_ROWS_CAP</C> (baked in at build).
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

      <H2 id="charts">Chart types — all 31, with required fields</H2>
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
            "seriesField, stacked, extraMeasures",
            "Vertical columns; ranking and comparison",
          ],
          [<C key="b">hbar</C>, "xField, yField", "—", "Horizontal bars; long category names"],
          [
            <C key="c">line</C>,
            "xField, yField",
            "seriesField, extraMeasures, colorField, endLabels, xBands",
            "Change over time. colorField takes each line's colour from a #rrggbb column; endLabels names every line at its end; xBands shades spans of the x axis",
          ],
          [
            <C key="d">area</C>,
            "xField, yField",
            "seriesField, extraMeasures",
            "Trend with volume emphasis",
          ],
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
            "label, targetField, dateField, compareTo, sparkline, lowerIsBetter",
            "One headline number. With dateField: the latest period, its change and a trend line",
          ],
          [
            <C key="b">gauge</C>,
            "valueField",
            "label, targetField, max",
            "Progress toward a ceiling",
          ],
        ]}
      />

      <H3 id="kpi-periods">KPIs that compare periods</H3>
      <P>
        Give a KPI a <strong>date</strong> in the builder and its rows become a series: the tile
        shows the <strong>latest period</strong>, the change against{" "}
        <strong>the period before</strong> or <strong>the same period last year</strong> (▲ 4.2%
        (+$1.2M) vs Oct 2026) and, with <strong>Trend line</strong> on, the periods behind it. A
        target column adds a progress bar. <strong>Lower is better</strong> turns a fall green for
        costs, churn and defects.
      </P>
      <P>
        <strong>Period</strong> decides what one period is. <em>As the rows are</em> keeps each row
        as its own period, so a rate or an average per month is never added up; picking a month,
        week, quarter or year adds the rows inside each one together. Quarter labels such as{" "}
        <C>2026-Q3</C> and week labels such as <C>2026-W05</C> are read as dates.
      </P>
      <Callout kind="warn" title="A missing month is said, not skipped">
        When the period being compared with has no row — November against an October the query did
        not return — the tile says <em>No data for Oct 2026 to compare with</em>. It never compares
        with the nearest month that does have data, which would call August &ldquo;last
        month&rdquo;.
      </Callout>

      <H3 id="ch-narrative">Narratives</H3>
      <P>
        A <strong>Narrative</strong> widget is a sentence computed from its own rows — the kind
        every good dashboard leads with. It is arithmetic, not prose from a model, so it is
        recomputed whenever a filter or a cross-filter changes those rows, and it cannot state a
        number the data does not contain.
      </P>
      <Table
        headers={["Narrative", "Needs", "Says"]}
        rows={[
          [
            "Top ranked / Bottom ranked",
            "A category and a measure",
            "The top (or bottom) N members with their values and share of the total",
          ],
          [
            "Period over period",
            "A date and a measure",
            "Revenue for Nov 2026 increased by 44.4% (+$34.5M) from $77.8M to $112.3M.",
          ],
          [
            "Forecast",
            "A date and a measure, 8+ periods",
            "The next period's forecast with its likely range and method",
          ],
          [
            "Anomaly",
            "A date and a measure, 5+ periods",
            "The most recent period 3+ deviations from the median, or that none is",
          ],
          [
            "Growth rate",
            "A date and a measure",
            "The compounded growth rate per period over the last N periods",
          ],
          [
            "Top movers",
            "A category, a date and a measure",
            "The members that changed most between the latest two periods",
          ],
        ]}
      />
      <P>
        <strong>Your own sentence</strong> replaces the standard wording. Its <strong>Value</strong>{" "}
        menu lists what the kind computes — <C>{"{{period}}"}</C>, <C>{"{{change_pct}}"}</C>,{" "}
        <C>{"{{list}}"}</C> and so on — and each fills in from the data. A token the kind does not
        have stays visible as written, so a typo shows rather than vanishing. Too little history is
        answered with the reason (&ldquo;A forecast needs at least 8 periods; this has 5&rdquo;),
        never with a weaker sentence.
      </P>
      <Callout kind="why" title="Narrative or AI insight?">
        <strong>AI insight</strong> writes a paragraph about one snapshot, the way a person would;
        it does not change when the filters do. A narrative is one sentence a dashboard must never
        get wrong, so it is computed every time it is drawn. Use the narrative for the headline
        facts and the insight for the reading of them.
      </Callout>

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
            "scale",
            "Density across two dimensions. scale: diverging (Green below zero, red above) for a value measured against a baseline where less is better, such as seconds against a median lap",
          ],
          [<C key="c">boxplot</C>, "xField, yField", "—", "Spread and outliers per category"],
          [
            <C key="d">radar</C>,
            "xField, yField",
            "seriesField, extraMeasures",
            "Several measures compared across entities: with extraMeasures each measure is a spoke and each xField value a polygon",
          ],
        ]}
      />

      <H3 id="ch-detail">Tables and geography</H3>
      <Table
        headers={["Type", "Required fields", "Optional", "Use for"]}
        rows={[
          [
            <C key="a">table</C>,
            "—",
            "columnFormats, totals, striped",
            "Exact figures read row by row; cells can be data bars, pictures, links, coloured and given icons, with text before and after the value; columns can be retitled, alternate rows shaded and the totals row turned off",
          ],
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
            <C key="e">bump</C>,
            "xField, yField, seriesField",
            "colorField, xBands",
            "Rank over time: 1 at the top, every line named at the start and the end — positions lap by lap, standings round by round",
          ],
          [
            <C key="f">range</C>,
            "categoryField, startField, endField",
            "labelField, higherIsBetter",
            "Where each row started and finished: green where it gained, red where it lost, a dot where it held",
          ],
          [
            <C key="g">radialbar</C>,
            "nameField, valueField",
            "colorField",
            "Concentric arcs, the leader outermost — a standings table drawn as a ring",
          ],
          [
            <C key="h">cards</C>,
            "title (a template)",
            "layout, imageField, iconFields, heading, body, lead, value, max",
            "One card per row from templates: a podium, a fastest lap, a top three, the races left",
          ],
          [
            <C key="b">wordcloud</C>,
            "textField",
            "valueField",
            "Term frequency; weight by valueField when you have one",
          ],
          [
            <C key="d">insight</C>,
            "kind, valueField",
            "categoryField, dateField, topN, periods, label, template, lowerIsBetter",
            "A narrative sentence computed from the rows — see Narratives above",
          ],
          [
            <C key="c">ontology</C>,
            "spec",
            "—",
            "AI-built knowledge graph: subject–predicate–object triples across datasets, warehouses and KB knowledge graphs; nodes and edges are clickable",
          ],
        ]}
      />
      <P>
        A bar race starts playing when it is drawn and can be paused. Pausing it, and where it has
        got to, survive whatever the dashboard does around it — a filter changed on another widget,
        a refresh after a write, a session renewed in the background. It restarts only when the
        periods it is animating actually change.
      </P>

      <Callout kind="why">
        Pick the chart from the question, not the other way round. "Which region is biggest" is a
        bar; "is it growing" is a line; "what share" is a pie with few slices. If you cannot state
        the question a visual answers in one sentence, it is decoration — and decoration is what
        makes a dashboard stop being read.
      </Callout>

      <H3 id="non-chart-widgets">Two widgets that plot nothing</H3>
      <P>
        Not everything on a dashboard is a chart. Two widget types take no data at all, and they are
        what turns a wall of numbers into something a reader can follow without being told what it
        means.
      </P>
      <Table
        headers={["Widget", "Takes", "Use it for"]}
        rows={[
          [
            <C key="a">text</C>,
            "A title and Markdown content — no fields, no query.",
            "The executive summary at the top, a definition of a metric people keep misreading, a note on why last month looks odd.",
          ],
          [
            <C key="b">image</C>,
            "An uploaded image or an image URL.",
            "A logo, an architecture diagram, a photograph — anything the numbers are about but cannot show.",
          ],
        ]}
      />
      <Callout kind="why" title="A dashboard nobody can read is a dashboard nobody uses">
        These two cost nothing to add and are the difference between a page that answers a question
        and a page that presents evidence and leaves the reader to infer the question. A text widget
        stating what the dashboard is for, and one sentence per section saying what good looks like,
        does more for adoption than another chart.
      </Callout>

      <H2 id="design">Designing a dashboard that looks like its subject</H2>
      <P>
        A race result reads best on black with the winner&apos;s name in large type; a board pack
        reads best on white with nothing competing for attention. Everything below is set from the
        editor, is saved with the dashboard, and looks the same on a shared view, a public link, an
        embed and a PDF. The <strong>Grand Prix Results · Sample</strong> dashboard uses all of it;
        its walkthrough is at the end of this section.
      </P>

      <H3 id="design-canvas">The canvas: always dark, a colour, a pattern</H3>
      <P>
        <strong>Theme</strong> in the editor toolbar sets the page behind the widgets:
      </P>
      <FieldList
        items={[
          {
            name: "Canvas",
            body: (
              <>
                <strong>Follow the app</strong> (light or dark, as each viewer has it) or{" "}
                <strong>Always dark</strong>. Always dark keeps the dashboard dark for every viewer,
                with its widgets in dark colours too — the reader of a black race page should not
                get a white one because their app is light.
              </>
            ),
          },
          {
            name: "Canvas colour",
            body: "A colour behind everything: Black, White, Racing red, Gold, Grey, Charcoal, or any colour from the picker. Theme colour clears it.",
          },
          {
            name: "Pattern",
            body: "Grid, Fine grid or Diagonal, drawn as faint lines in the colour beside them and tiled behind the widgets. A pattern replaces a background image, and an image replaces a pattern.",
          },
          {
            name: "Background image and font",
            body: "As before: an image (compressed to 0.9 MB and kept with the dashboard) with fit and darken, and a dashboard font.",
          },
        ]}
      />

      <H3 id="design-cards">A widget&apos;s appearance</H3>
      <P>
        Each widget&apos;s menu has <strong>Appearance</strong>:
      </P>
      <UL>
        <li>
          <strong>Accent colour</strong> — eight preset colours, six swatches and any colour from
          the picker. It colours the chart&apos;s primary series, card titles and the header icon.
        </li>
        <li>
          <strong>Card style</strong> — Default, Accent tint, Glass (over an image) or{" "}
          <strong>No card — sits on the canvas</strong>, which drops the frame so a title or a row
          of cards sits directly on the page. The frame shows faintly on hover, so the widget can
          still be found and moved.
        </li>
        <li>
          <strong>Hide the title</strong> — for a text block that is its own title. The menu stays
          reachable on hover, and a chart still shows its <em>Partial</em> badge, and its data age
          once stale.
        </li>
        <li>
          <strong>Title size</strong> (S, M, L, XL) and <strong>title colour</strong>.
        </li>
      </UL>
      <P>
        Editing a widget keeps all of this. Saving an edit used to reset it, because the editor
        rebuilt the widget from the fields it shows; the appearance and the Import/Direct choice are
        now carried over.
      </P>

      <H3 id="design-text">Text blocks set like a title page</H3>
      <P>
        <strong>Text</strong> takes Markdown and, below it, a size (Small to Headline), an
        alignment, a text colour, a heading colour and italic, with a preview on a dark ground. A
        line break you type is a line break on the dashboard; a blank line starts a new paragraph.
        The race title in the sample is:
      </P>
      <Code lang="markdown">{`# Brazilian Grand Prix
*8 November 2026 · Round 20 of 23*`}</Code>
      <P>
        set at Display size, centred, white text, Racing red headings, italic, with no card and the
        title hidden.
      </P>

      <H3 id="design-card-templates">Cards from templates</H3>
      <P>
        The <C>cards</C> visual draws one card per row, and each line of a card is a template over
        the row&apos;s columns:
      </P>
      <Table
        headers={["Write", "Gets", "Example"]}
        rows={[
          [<C key="a">{"{{column}}"}</C>, "The value, in the visual's number format", "Norris"],
          [
            <C key="b">{"{{column|ordinal}}"}</C>,
            "A whole number as 1st, 2nd, 3rd, 11th, 22nd",
            "1st",
          ],
          [<C key="c">**bold**</C>, "Bold text — around a value or plain words", "**Norris**"],
          [
            <C key="d">a new line</C>,
            "Another line (in the lines under the title)",
            "1:35:23.504 / 25 points",
          ],
        ]}
      />
      <P>
        A value is always text: a column holding markup prints the markup. Two layouts:{" "}
        <strong>Side by side (a podium)</strong> shows a heading, a picture, a title and lines under
        it; <strong>One row each (a list)</strong> shows a number at the start, a picture, a title,
        lines under it and a value at the end. <strong>Picture</strong> takes a column holding an
        image address or an image data URI; <strong>Small pictures</strong> adds more, such as a
        flag. Lists size themselves to the card they are in, so a narrow card drops the small
        pictures and steps the text down rather than cutting a name to one letter.
      </P>

      <H3 id="design-rank">Rank, range and radial visuals</H3>
      <FieldList
        items={[
          {
            name: "Rank over time (bump)",
            body: (
              <>
                One line per series (<C>seriesField</C>) along <C>xField</C>, with rank 1 at the top
                and each line named at its start and end. The chart holds a rank until it changes,
                so the query only needs the points where a rank changes: the sample&apos;s 1,435 lap
                rows become 343, under the snapshot cap, and draw the same chart. <C>xBands</C>{" "}
                shades spans such as pit-stop laps.
              </>
            ),
          },
          {
            name: "Start → finish (range)",
            body: "A bar from startField to endField for each category: green where the value improved, red where it got worse, a dot where it held. Set higherIsBetter for values where bigger is better (lower is better by default, as for positions). labelField prints a sentence beside each bar.",
          },
          {
            name: "Radial bars",
            body: "Concentric arcs, the largest outermost and sweeping three quarters of a turn, so every name fits in the clear quarter at the top left.",
          },
        ]}
      />

      <H3 id="design-colours">Colours from the data, names at line ends</H3>
      <P>
        <strong>Colour from column</strong> (line, rank and radial visuals) takes each series&apos;
        colour from a <C>#rrggbb</C> column in the rows — a team&apos;s colour, a product
        line&apos;s brand colour. Anything that is not a six-digit colour is ignored and the series
        keeps its default. <strong>Name each line at its end</strong> prints the series and its last
        value at the end of each line, spaced apart when lines finish close together, so a chart
        with ten lines can be read without the legend. In table conditional formatting, Gold, Silver
        and Bronze sit beside the other rule colours.
      </P>

      <H3 id="design-cap">Fitting under the snapshot cap</H3>
      <P>
        A widget keeps at most 500 rows (see <a href="#row-cap">the row cap</a>). Detail-level data
        — every lap of every car — is past that, so write the query at the level the chart draws:
      </P>
      <UL>
        <li>
          A rank chart needs only the rows where a rank changes, plus each series&apos; first and
          last.
        </li>
        <li>
          A heatmap over time can group the time axis into blocks: three-lap blocks give 487 cells
          for 22 drivers over 71 laps.
        </li>
        <li>
          A running total per series is one row per series per step (200 rows for 10 drivers over 20
          rounds).
        </li>
      </UL>

      <H3 id="design-sample">Walkthrough: the Grand Prix Results sample</H3>
      <P>
        Two pages over the <C>gp_*</C> sample tables: the 2026 Brazilian Grand Prix, and the
        championships after it. The canvas is Always dark on black with a red Grid pattern. The
        first page&apos;s visuals sit on the canvas with no card; the second page&apos;s keep their
        cards, with Racing red titles at size L (M on the two radial charts, whose cards are
        narrow).
      </P>
      <Table
        headers={["Widget", "Visual", "Set up"]}
        rows={[
          [
            "Wordmark, race title, circuit",
            "Text",
            "No card, title hidden; Larger or Display, white text, Racing red headings, italic",
          ],
          [
            "Podium",
            "Cards, side by side",
            <>
              Heading <C>{"**{{finish_position|ordinal}}** Place"}</C>, title{" "}
              <C>{"{{given_name}} **{{family_name}}**"}</C>, picture <C>badge</C>, small picture{" "}
              <C>flag</C>
            </>,
          ],
          [
            "Lap by lap",
            "Rank over time",
            "Along lap, rank position, one line per code, colour team_color, band laps 14–17",
          ],
          [
            "Final result",
            "Table",
            'badge as a picture with a blank title, points after the value " pts", pos rules = 1 Gold, = 2 Silver, = 3 Bronze colouring the whole row, totals off',
          ],
          [
            "Lap times",
            "Heatmap, diverging",
            "Seconds against each driver's median lap, capped at ±1.5 s",
          ],
          [
            "Starting grid vs final position",
            "Start → finish",
            "From grid to finish, label a sentence per driver",
          ],
          [
            "Driver and constructor leaders",
            "Cards, one row each",
            <>
              Number <C>{"{{position}}"}</C>, picture <C>badge</C>, title{" "}
              <C>{"**{{family_name}}**"}</C>, line <C>{"{{team}} · {{wins}} wins"}</C>, value{" "}
              <C>{"**{{points}}** pts"}</C>
            </>,
          ],
          ["Top drivers, Constructors", "Radial bars", "Colour from team_color"],
          [
            "Points races",
            "Line",
            "x round, one line per driver or team, colour team_color, names at the ends",
          ],
        ]}
      />
      <P>The rank chart&apos;s query keeps only the laps where a position changed:</P>
      <Code lang="sql">{`WITH p AS (
  SELECT 0 AS lap, code, grid AS position, team_color FROM gp_race_results
  UNION ALL
  SELECT lap, code, position, team_color FROM gp_race_laps
), k AS (
  SELECT *, LAG(position) OVER (PARTITION BY code ORDER BY lap) AS prev,
    LEAD(position) OVER (PARTITION BY code ORDER BY lap) AS nxt
  FROM p
)
SELECT lap, code, position, team_color
FROM k
WHERE prev IS NULL OR nxt IS NULL OR position <> prev
ORDER BY lap, position`}</Code>
      <P>The heatmap compares each driver with their own median lap, in three-lap blocks:</P>
      <Code lang="sql">{`WITH med AS (
  SELECT code, MEDIAN(lap_seconds) AS m FROM gp_race_laps GROUP BY code
)
SELECT
  CAST(FLOOR((l.lap - 1) / 3) AS INTEGER) * 3 + 1 AS lap,
  CAST(l.final_position AS INTEGER) || '. ' || l.family_name AS driver,
  ROUND(LEAST(GREATEST(AVG(l.lap_seconds) - MAX(med.m), -1.5), 1.5), 2) AS vs_median
FROM gp_race_laps l JOIN med USING (code)
GROUP BY 1, 2, l.final_position
ORDER BY l.final_position, lap`}</Code>
      <P>
        The points race fills every round for every driver, so a driver who missed races keeps an
        unbroken line:
      </P>
      <Code lang="sql">{`SELECT r.round, d.family_name, d.team_color, SUM(p.points) AS total_points
FROM (SELECT DISTINCT round FROM gp_season_points) r
CROSS JOIN gp_driver_standings d
JOIN gp_season_points p ON p.code = d.code AND p.round <= r.round
WHERE d.position <= 10
GROUP BY r.round, d.family_name, d.team_color
ORDER BY r.round, total_points DESC`}</Code>
      <Callout kind="info" title="The data">
        The <C>gp_*</C> tables come from the Jolpica F1 API (CC BY-NC-SA 4.0, free for
        non-commercial use) and are rebuilt for any race with{" "}
        <C>node scripts/buildGrandPrixSample.mjs [season] [round]</C>. Badges and flags are drawn
        shapes, not photographs or logos.
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
            "Table widgets only — format each column independently (number | currency | percent, with its own currency and decimals), and style its cells: label (the column's title), prefix and suffix (text before and after each value, as in 390 pts), display (bar | image | link), cond (colours and icons) and rowHighlight.",
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
            "line, area, period KPIs, narratives",
            "Default bucketing; viewers can toggle it. Buckets are UTC, the zone the SQL engines run in: a timestamp written without an offset is read as UTC, so a viewer in any time zone sees the months and days the query returned.",
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
            "number of buckets, or a registry model",
            "line (single series)",
            "Projects ahead — seasonal exponential smoothing when the history shows a season that beats a straight line, else a linear trend — with a residual band that widens with distance. Or draws a registry forecast model's projection.",
          ],
        ]}
      />
      <Callout kind="warn" title="A projection is not a plan">
        The built-in forecaster fits the history it is given: exponential smoothing of level, trend
        and season when at least two full cycles are visible and that fit beats a straight line on
        the past, a straight line otherwise. Its band is the spread of its own one-step errors,
        widened with distance. It knows nothing about launches, pricing or anything that has not
        already happened. The same module projects for the AI Analyst and for forecast alerts, so a
        chart, its write-up and its alert cannot disagree; a model trained on the ML page can be
        attached instead, in which case the chart draws that model&apos;s projection from the
        registry. Use any of them to frame a conversation, never to commit to a number.
      </Callout>

      <H3 id="condformat">Conditional formatting (matrix and table)</H3>
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
      <P>
        A <strong>table</strong> column takes the same two modes from the brush button beside it in{" "}
        <strong>Column formats</strong>, plus three things the pivot has no room for: text rules (
        <C>is</C> and <C>contains</C>, ignoring case, so a sentiment column can read NEGATIVE in
        red), an <strong>icon</strong> per rule (▲ ▼ ● ⚑ ✓ ⚠), and{" "}
        <strong>Colour the whole row</strong> — a results table can paint first place gold and a
        did-not-finish row grey. The same button draws a column as a <strong>data bar</strong> sized
        against its largest value, a <strong>picture</strong> or a <strong>link</strong>. Pictures
        and links are drawn only from absolute <C>https://</C> and <C>http://</C> addresses (and
        image data or <C>mailto:</C>); anything else shows as text.
      </P>

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
            body: "Open the underlying rows behind any data point — the answer to \"is this number real?\" and the fastest way to spot a broken join. Everything narrowing the view goes into the query: the widget's own filters, the drill level you clicked into, the active cross-filter. The 1,000-row cap applies after that, so the count is the real number of matching rows and the cap is disclosed when it bites. A category computed in the widget's SELECT list (DATE_TRUNC(…) AS month) has no column to trace back to, and that is refused rather than answered with the whole table.",
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
        The <em>numbers</em> in an insight are checked (below); the <em>judgement</em> is still
        model output. &ldquo;Revenue fell 12%&rdquo; is verified against the data.
        &ldquo;…indicating a demand problem&rdquo; is a colleague&rsquo;s first impression, and
        should be read as one.
      </Callout>

      <H3 id="verified-figures">Every figure is checked before you see it</H3>
      <P>
        This applies to the insight card and to the answer the AI analyst writes under a chart — the
        two places the product puts numbers into prose.
      </P>
      <P>
        A card that reports a number nobody can check is worse than a card that says nothing. So
        every numeral written into an insight is matched back against what the query actually
        returned — a value in a row, a computed total, minimum, maximum or mean, or a
        category&rsquo;s share. Anything matching nothing is sent back once, with the offending
        figures named, and whatever survives that is disclosed to you rather than shown quietly.
      </P>
      <P>
        Rounding is allowed for readability, and the tolerance comes from the precision written.{" "}
        <C>$1.0M</C> is a claim that the value rounds to 1.0M, so it admits fifty thousand either
        way; <C>410,379.26</C> is held to half a cent. This is why a card will say <C>$837.9k</C>{" "}
        where you might have written <C>$837k</C> — the underlying value is 837,900, and $837k is a
        claim it does not meet.
      </P>
      <Callout kind="why" title="Where this came from">
        An insight card once reported regional shares of 48%, 39% and 19%. They sum to 106%, so no
        denominator makes them true — the model had the rows and did the division itself. The
        arithmetic is now done before the model writes, and checked after.
      </Callout>

      <P>
        Figures the writer was <em>given</em> count as checkable too. An analyst answer is handed a
        prepared block of computed facts — totals, ranges, how many rows of how many the engine
        returned — and told to use them. A check that did not admit those would flag the model for
        doing as it was told, which is the fastest way to make a warning worth ignoring.
      </P>

      <H3 id="partial-results">A result that is only part of the data says so</H3>
      <P>
        If a visual&rsquo;s SQL ends in <C>LIMIT 5</C>, its rows are the top five and not the whole
        picture. An insight over them is told exactly that, and is barred from stating shares of a
        total, calling anything 100%, or saying that other categories are absent — because none of
        those is knowable from a result that was cut short.
      </P>
      <P>
        This is the one failure a check on the wording cannot catch. A card reading &ldquo;AMER
        accounts for 100% of revenue&rdquo; over a <C>LIMIT 1</C> query is <em>true of its data</em>{" "}
        and false about the business, and every figure in it verifies.
      </P>

      <P>
        There are two ways a result can be part of the data, and only one of them is visible in the
        SQL. The first is a query that caps <em>itself</em> with a trailing <C>LIMIT</C>. The second
        is the <strong>snapshot</strong> hitting its row cap while the query had more to give — the
        query asked for everything and the cap took the tail, so nothing in the SQL says a word
        about it. On a large table that is the ordinary case rather than an exotic one.
      </P>
      <P>
        Both now reach the insight. Totals are still stated, because they are true of the rows that
        are there; the shares are withheld, because shares of a fragment are not shares; and the
        caveat rules out the superlatives a prefix cannot support — <em>the largest region</em>,{" "}
        <em>no other category</em> — since the rows that would contradict them were never fetched.
      </P>
      <P>
        This one matters more than it looks. The figures in a prefix are real: they are genuinely
        derivable from the rows the card was given, so the numeric check <em>passes</em> them. A
        verifier can only compare prose against the data it holds — it cannot know the data is a
        fragment unless the widget says so, which is why the widget now does.
      </P>

      <H3 id="title-claims">A title is a claim, and it is checked too</H3>
      <P>
        The AI names a visual before it knows what the query will return, and the two drift apart in
        both directions: a chart called <C>Top 5 Products</C> drawing fourteen bars, or one called{" "}
        <C>Revenue by Region</C> whose query kept a single row. Both are now reconciled when the
        visual is generated:
      </P>
      <UL>
        <li>
          A title promising <strong>top N</strong> over a query that returned more takes the N it
          promised — but only when the query sorted its rows, since the first five of an unordered
          result are an arbitrary five.
        </li>
        <li>
          A query that <strong>capped itself</strong> below what its title shows is run again for
          the number the title names. <C>Top 5 Months by Revenue</C> over a query ending{" "}
          <C>LIMIT 1</C> is one row of a table that has thirty-six. A category chart narrowed to a
          single row is re-run without the limit at all — a one-bar bar chart is not a chart, and
          the title never asked for one.
        </li>
        <li>
          A title promising more rows than exist <strong>says so</strong> — rows cannot be invented.
          Which sentence you get matters: <em>the data has 3 rows, not 5</em> is written only once
          the limit that might have been hiding the rest is gone. Until then the note says the{" "}
          <em>query</em> stopped short, because that is the part that is known to be true.
        </li>
      </UL>

      <P>
        <strong>And the note is re-checked every refresh.</strong> A sentence like{" "}
        <C>Showing the top 5 of 36.</C> is a claim about one query result, and a refresh replaces
        that result. Left alone it goes on being displayed — a chart drawing five bars under a title
        still insisting the data has three rows, which is worse than the silence it replaced,
        because a reader who checks the caveat against the chart finds the product contradicting
        itself. So each refresh re-derives the count and rewrites the note, or takes it away when
        the data has caught up with the title.
      </P>
      <P>
        Three things stop it. A snapshot that hit the row cap has no count to speak of, so the note
        stands and the <strong>Partial</strong> badge explains the widget instead. A title you have
        renamed is yours — if the note is no longer the last thing in it, nothing is edited. And a
        note that is still exactly right is left exactly as it is, so a refresh that changes nothing
        writes nothing.
      </P>
      <P>
        A widget set to <strong>direct query</strong> draws a live result rather than its stored
        snapshot, so both sentences are derived per view instead — from the rows actually on screen,
        including whatever the dashboard's filters narrowed them to. The same card can therefore say
        different things to two people looking at it through different filters, which is the only
        honest answer when they are looking at different rows. Nothing is written back: a live
        result belongs to one view, and persisting it would make one viewer's filter everybody's
        snapshot.
      </P>

      <H3 id="chart-fields">A chart names its columns, and those are checked too</H3>
      <P>
        A chart says which column is its category and which is its measure. The query that feeds it
        does not always return them. The clearest case: a query that ends{" "}
        <C>ORDER BY revenue DESC</C> and never puts <C>revenue</C> in its SELECT list — so the chart
        drew month labels, no axis, no bars, and no explanation. It looks like a widget still
        loading, and it never will.
      </P>
      <P>
        The title check cannot see this. It compares a title against a <em>row count</em>, and five
        rows under a title promising five agree perfectly. Only reading the chart's fields against
        the query's columns finds it. Three outcomes, in order of confidence:
      </P>
      <UL>
        <li>
          A missing <strong>series split</strong> is dropped without comment. A chart that cannot
          find the column it was going to split by is not broken; it is a chart with one series.
        </li>
        <li>
          A missing <strong>measure or category</strong> is re-pointed when exactly one unused
          column of the right kind could have been meant — a number for a measure, a label for a
          category, and never a column another field is already drawing. Two candidates is a guess,
          and a guess drawn as a chart is worse than no chart.
        </li>
        <li>
          Otherwise the widget <strong>shows its rows as a table</strong> and the title says which
          column is missing. The rows are real and the reader can see them; an empty frame tells
          them nothing.
        </li>
      </UL>
      <P>
        Which field has to be a number depends on the chart, not on the field's name: a bar chart's{" "}
        <C>yField</C> is its measure, a sankey's is a node label, and a heatmap's axes are both
        categorical with the measure in <C>valueField</C>. Getting that backwards would move a
        repair onto the wrong column, which is worse than the blank chart it set out to fix.
      </P>

      <H3 id="stale-prose">Written insight is withdrawn when its figures stop holding</H3>
      <P>
        A widget keeps the sentence the AI wrote about it —{" "}
        <em>"The top region, AMER, generated $25.9k in revenue"</em> — and shows it when you hover
        the title. A refresh replaces the rows underneath that sentence, which is how prose ends up
        describing data the widget no longer has, with the figures still in it.
      </P>
      <P>
        Every refresh re-checks those figures against the rows the widget now holds, using the same
        verifier that checked them when they were written, and no model call. Prose whose numbers
        still ground is left exactly as it is — which is almost always, because most refreshes
        return the same rows. Prose that states a figure the data no longer supports is{" "}
        <strong>withdrawn</strong> rather than corrected: nothing here can rewrite an English
        sentence truthfully, and no tooltip is better than a confidently wrong one.
      </P>
      <P>
        Two limits, stated rather than hidden. A snapshot that hit the row cap is not checked — the
        figure may be true of the table and simply not derivable from the part of it kept here, and
        deleting correct prose on that evidence would be the worse error. And a numeric check has
        nothing to say about <em>"AMER leads the regions"</em>, which survives AMER falling to
        third; sentences with no figures in them are left alone rather than deleted on suspicion.
      </P>

      <H3 id="one-of-many">A single-value card says which row it is showing</H3>
      <P>
        A KPI draws the first row of its result and nothing else. When the query returned one row
        that is the whole truth. When it returned three, the card is showing a third of a breakdown
        in the type size reserved for a headline — <C>Revenue by Region</C> displaying one region's
        25,874.92 out of a 51,749.84 total, with nothing on the card saying so.
      </P>
      <P>
        Single-value charts now carry <strong>1 of N rows</strong> under the number whenever their
        query returned more rows than they draw. A KPI with a date is exempt: it shows the latest
        period of a series on purpose, and says which period that is. It appears only when the value
        is a <em>measure</em>: <C>Best Month by Revenue</C> is a KPI over thirty-six ordered rows
        whose value is a month name, and there row one is the answer. A caveat on that would be
        noise, and noise is what teaches people to ignore the caveats that matter.
      </P>
      <P>
        It is computed where the number is drawn rather than stored with the widget. A count of rows
        is exactly the kind of sentence that goes stale when the data changes — this one cannot,
        because nothing keeps it.
      </P>

      <H3 id="scan">Scan — computed, not generated</H3>
      <P>
        <strong>Scan</strong> in the toolbar is the opposite kind of thing: it runs the obvious
        checks across every widget's snapshot using arithmetic, not a model. No call, no cost, no
        wait, and the same answer twice. It looks for three things and states the bar for each:
      </P>
      <UL>
        <li>
          <strong>Trends</strong> — a least-squares slope of at least 2% per period, over at least
          five points.
        </li>
        <li>
          <strong>Outliers</strong> — 3 or more MAD from the median. Median and MAD, not mean and
          standard deviation, because an outlier inflates the very standard deviation a naive check
          would judge it by.
        </li>
        <li>
          <strong>Concentration</strong> — one member holding 60% or more of a total, across at
          least four members. (With two, one is always over half.)
        </li>
      </UL>
      <P>
        Findings are ranked by how far each cleared <em>its own</em> threshold — shown as{" "}
        <C>2.6×</C> — which is what makes an outlier and a trend comparable at all.
      </P>
      <Callout kind="warn" title="Finding nothing is not an all-clear">
        A scan that returns nothing says so precisely: how many widgets it examined, how many it
        could <em>not</em> and why, and the exact thresholds it applied. Widgets get skipped for
        real reasons — a snapshot that hit its row cap holds an arbitrary subset, so every total or
        share over it would be computed from part of the data; a share of a measure with negative
        values can exceed 100% or flip sign. In both cases the scan refuses and names the reason
        rather than printing a confident number.
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
      <P>
        A rule&apos;s <strong>basis</strong> is either the latest refreshed values (the default) or
        the <strong>forecast</strong>: the aggregate over the next N projected periods of a
        single-series line or area widget, from the built-in forecaster or from the registry model
        attached to the chart. &ldquo;Notify me when projected revenue for the next three months
        falls below target&rdquo; is a rule, not a glance.
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
          [
            "Export",
            "Whoever you send the file to",
            "PDF or PowerPoint for the page, Excel/CSV for the data",
          ],
        ]}
      />

      <H3 id="deck">Export as a PowerPoint deck</H3>
      <P>
        <strong>Export → Export to PowerPoint</strong> builds a branded deck. You choose which
        visuals to include (grouped by page), a model to write the prose, and optionally an
        instruction for tone, audience or emphasis. Every exportable visual starts ticked when the
        dialog opens, and what you untick stays unticked until you export or close it.
      </P>
      <P>
        <strong>The figures are the dashboard&apos;s figures.</strong> Every slide is filled from
        the same saved snapshot the card on screen renders — never re-queried while the deck is
        built. A deck that disagrees with the dashboard it came from is two sources of truth, and
        the one in the meeting room is the one people act on.
      </P>
      <P>
        <strong>The model writes sentences and is not allowed to calculate.</strong> It receives the
        computed values as text it may quote, so it can write &ldquo;revenue peaked in March&rdquo;
        but not &ldquo;revenue grew 12%&rdquo; — the second is arithmetic, and arithmetic is done in
        code or not at all. Any figure in its prose that did not come from the data is stripped
        before it reaches a slide. That holds even if you explicitly ask for growth percentages in
        the instruction box.
      </P>
      <P>
        A widget with no saved snapshot cannot become a slide and is listed with the reason (refresh
        the dashboard first) rather than quietly missing from a deck you believe is complete.
        Visuals PowerPoint cannot draw — sankey, geo map, bar race — become a table of the same data
        with the substitution printed on the slide, and category or row caps are disclosed on the
        slide itself.
      </P>

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

      <H2 id="paginated">Paginated reports</H2>
      <P>
        A dashboard is a grid you scroll and resize. A <strong>paginated report</strong> is the
        other shape: a fixed page, a flow of blocks down it, and content that continues onto the
        next page when the room runs out — the thing a month-end pack, an invoice or a regulatory
        return has to be, because somebody prints it and the page count matters. Open{" "}
        <strong>Data &amp; BI → BI Workspace → Reports</strong>.
      </P>
      <P>
        Reports and dashboards share everything below the layout. A report&apos;s chart block{" "}
        <em>is</em> a dashboard widget — the same query, the same cached rows, the same chart spec
        and the same renderer — so nothing about a number changes when it moves from a tile to a
        page.
      </P>

      <H3 id="report-blocks">Blocks</H3>
      <FieldList
        items={[
          {
            name: "Heading",
            body: "Title, section or sub-section. The first two rule off underneath.",
          },
          { name: "Text", body: "A paragraph. Wraps to the content width and flows across pages." },
          { name: "Spacer", body: "Vertical room, in points. 72 points is an inch." },
          {
            name: "Page break",
            body: "Starts the next page. Ignored when the current page is still empty, so a break at the top does not print a blank sheet.",
          },
          {
            name: "Chart",
            body: "A widget's chart at a height you set. Exported as an image drawn from the same rows the preview shows.",
          },
          {
            name: "Table",
            body: "A widget's rows, printed. This is the block that continues onto the next page and redraws its header row when it does.",
          },
        ]}
      />

      <Callout kind="why" title="Why the preview is the layout, not a picture of one">
        The designer&apos;s preview and the PDF renderer call the <em>same</em> pagination function,
        in the same units, from the same row and header heights. A preview that flowed differently
        would be a picture of a document nobody receives. A test builds a real PDF and asserts the
        two agree on the page count for tables of 5, 60 and 200 rows.
      </Callout>

      <H3 id="report-reuse">Reusing a dashboard&apos;s widgets</H3>
      <P>
        <strong>Add from a dashboard</strong> puts a widget you already built onto a page. It comes
        across whole — its query, its saved rows and its chart spec — so the page cannot disagree
        with the tile it came from, and you choose whether the page shows the visual or the rows
        behind it. Widgets from <em>every</em> page of a multi-page dashboard are offered. A widget
        with no saved snapshot is not offered at all, because it would print an empty box; refresh
        the dashboard first.
      </P>

      <H3 id="report-page">Page setup, header and footer</H3>
      <P>
        Choose A4, Letter, Legal or A3, portrait or landscape, and a uniform margin. The running{" "}
        <strong>header</strong> and <strong>footer</strong> each have a left, centre and right slot
        that accept tokens: <C>{"{{page}}"}</C>, <C>{"{{pages}}"}</C>, <C>{"{{title}}"}</C>,{" "}
        <C>{"{{date}}"}</C> and <C>{"{{time}}"}</C>. Each slot&apos;s <strong>Token</strong> menu
        lists them and puts the one you pick at the cursor. A new report opens with{" "}
        <C>
          Page {"{{page}}"} of {"{{pages}}"}
        </C>{" "}
        in the footer, because the first thing anybody misses on a printed report is which page they
        are holding.
      </P>
      <P>
        <strong>The bands are stamped after the layout, not during it.</strong> The total page count
        is not knowable until the last block has been placed, and a footer that says &ldquo;of
        3&rdquo; on a four-page report is worse than no footer at all. The date and time are fixed
        once per export so every page of one file agrees.
      </P>

      <H3 id="report-tables">How a long table breaks</H3>
      <P>
        A table taller than the space left is not clipped and not shunted whole onto the next page.
        It fills what is there, breaks, and <strong>continues</strong> — with its header row drawn
        again on every page, because a column of numbers with no heading on page four is unreadable.
        A table that cannot fit its header plus at least one row starts on the next page instead of
        stranding a header at the bottom of this one. <strong>Max rows</strong> caps what the block
        prints; leave it blank to print every row the query returned.
      </P>

      <H3 id="report-ai">Generating a report with AI</H3>
      <P>
        <strong>Generate with AI</strong> runs the dashboard generator&apos;s machinery with one
        difference of shape. Pick a table, optionally say what the report is for, and the planner
        returns an ordered <strong>outline</strong> of sections rather than a set of tiles: each
        section is a heading, the question behind it, whether the answer belongs in a chart or in a
        table somebody will check a row of, and whether it should start a new page.
      </P>
      <Steps
        items={[
          {
            title: "Pick the table",
            body: "Optionally say what the report is for — the planner writes a different outline for a board pack than for an operations check.",
          },
          {
            title: "Review the planned sections",
            body: "Each shows its question, whether it will be a chart or a table, and whether it starts a new page. Untick any you don't want.",
          },
          {
            title: "Build",
            body: "Every section runs the same BI turn a dashboard widget does, and becomes a heading plus a chart or table block.",
          },
          {
            title: "Edit and save",
            body: "Reorder, retitle, change the page setup and the bands in the designer.",
          },
          { title: "Export PDF" },
        ]}
      />
      <P>
        A section whose query fails or returns no rows is reported with its reason and skipped; the
        rest of the report is still built. If nothing could be built the dialog stays open with the
        reasons, rather than handing back an empty document. The planner runs through the same
        IAM-gated server route as every other BI generation and is traced as{" "}
        <C>BI Agent: Report outline</C>.
      </P>

      <H3 id="report-export">Export</H3>
      <P>
        <strong>Export PDF</strong> builds a real vector-text PDF: headings, paragraphs and table
        cells are selectable text, not a screenshot. Only charts are images, rasterised from the
        nodes the preview is already showing, so the exported chart is the chart you were looking
        at. A chart with no rows prints a visible <C>[chart unavailable]</C> marker rather than a
        silent gap.
      </P>

      <Callout kind="info" title="Reports are owner-only">
        A report belongs to the account that created it. Unlike dashboards, there is no group share,
        public link or embed key — send the exported PDF. Name and page setup changes are written to
        the audit log.
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
