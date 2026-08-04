import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  Diagram,
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

export const Route = createFileRoute("/docs/data-prep")({
  head: () => ({
    meta: [
      { title: "Data preparation — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Join, clean and reshape tables visually, save the recipe as a reusable flow, and refresh it on a schedule.",
      },
      { property: "og:title", content: "Data preparation — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Turn raw tables into an analysis-ready one, repeatably.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/data-prep" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/data-prep" }],
  }),
  component: DataPrepPage,
});

function DataPrepPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Data preparation"
        description="Raw tables rarely answer a question on their own. Prep joins them, fixes the columns and saves the whole recipe so tomorrow's data goes through the same steps."
      />

      <P>
        Find it under <strong>Data → Data Catalog → Data preparation</strong>. The output is a new
        prepared table that behaves like any other: chart it, query it, attach it to an agent.
      </P>

      <Callout kind="why">
        The point of prep is not the transformation — you could do that in SQL — it's{" "}
        <em>repeatability</em>. A saved flow re-runs the same joins and casts against refreshed
        source data, so a dashboard doesn't quietly rot when next month's file has a differently
        named column.
      </Callout>

      <H2 id="canvas">The canvas</H2>
      <P>
        The left palette lists what you can bring in, split by where it lives so you always know
        whether you're touching a local copy or a live system:
      </P>
      <UL>
        <li>
          <strong>Local tables</strong> — uploads and previously prepared tables, already in the
          workspace.
        </li>
        <li>
          <strong>External tables</strong> — connected warehouses and databases, expanded as{" "}
          <em>schema.table</em> so you can see exactly which object you're picking. Clicking one
          brings a capped snapshot onto the canvas to design against, rather than pulling millions
          of rows into the browser.
        </li>
      </UL>
      <P>
        Drop a table to make it the base, then add more and connect them. Every step shows a live
        preview of the resulting rows, so you find a broken join immediately rather than at the end.
      </P>
      <Diagram caption="A flow is a base table plus an ordered list of steps.">{`orders ──┐
         ├── join (customer_id) ──▶ filter ──▶ computed column ──▶ prepared table
customers┘                          status=       margin =
                                    'shipped'     revenue - cost`}</Diagram>

      <H2 id="joins">Joins</H2>
      <P>Pick the two key columns and the join type. The four types, in plain terms:</P>
      <FieldList
        items={[
          {
            name: "Inner",
            body: "Only rows that matched on both sides. Loses unmatched rows silently — check your row count after.",
          },
          {
            name: "Left",
            body: "Every row from the base table; missing right-hand values become null. The safe default when the base table is your unit of analysis.",
          },
          {
            name: "Right",
            body: "The mirror of left. Usually clearer to swap the tables and use a left join instead.",
          },
          {
            name: "Full",
            body: "Everything from both sides. Useful for reconciliation — finding what exists on one side only.",
          },
        ]}
      />
      <Callout kind="warn" title="Watch the row count">
        If joining doubles your rows, the key isn't unique on one side and you're now
        double-counting every measure downstream. The preview's row count is the cheapest way to
        catch this.
      </Callout>

      <H2 id="column-types">Column types</H2>
      <P>
        Every column carries a type, set on import and changeable in the prep canvas. The type
        decides which filters, aggregates and charts are available downstream, so getting it right
        here saves debugging later.
      </P>
      <Table
        headers={["Type", "Use for"]}
        rows={[
          [<C key="a">text</C>, "Free text"],
          [<C key="b">integer</C>, "Whole numbers"],
          [<C key="c">decimal</C>, "Fractional numbers"],
          [<C key="d">date</C>, "Dates — required for date filters and time-series charts"],
          [<C key="e">boolean</C>, "True/false"],
          [<C key="f">location</C>, "Place names or codes — enables map charts"],
          [
            <C key="g">category</C>,
            "A small set of repeating values; the natural grouping dimension",
          ],
          [<C key="h">currency</C>, "Money — formats as currency downstream"],
          [<C key="i">percent</C>, "Rates and shares"],
          [
            <C key="j">id</C>,
            "Identifiers — excluded from aggregation suggestions, since summing an id is meaningless",
          ],
        ]}
      />

      <H2 id="steps">The nine steps</H2>
      <P>Steps apply in order. Any one can be removed, and the preview updates as you go.</P>
      <Table
        headers={["Step", "What it does", "Configure"]}
        rows={[
          [
            <>
              Calculated field <C key="a">calc</C>
            </>,
            "Add a column from a formula",
            "Name, expression, and the resulting column type",
          ],
          [
            <>
              Filter rows <C key="b">filter</C>
            </>,
            "Keep only rows that match",
            <>
              One or more conditions, combined with <C key="x">AND</C> or <C key="y">OR</C>
            </>,
          ],
          [
            <>
              Summarize <C key="c">aggregate</C>
            </>,
            "Group by and roll up",
            "Group-by columns plus measures (Sum, Average, Count rows, Count distinct, Minimum, Maximum)",
          ],
          [
            <>
              Append rows <C key="d">append</C>
            </>,
            "Union rows from another dataset",
            <>
              Source table, columns to keep, and mode <C key="a2">all</C> or{" "}
              <C key="d2">distinct</C>
            </>,
          ],
          [
            <>
              Pivot <C key="e">pivot</C>
            </>,
            "Turn row values into columns",
            "The column to spread, and the value to fill with",
          ],
          [
            <>
              Unpivot <C key="f">unpivot</C>
            </>,
            "Turn columns into rows (wide → long)",
            "Which columns to melt, and names for the key/value columns",
          ],
          [
            <>
              Split column <C key="g">split</C>
            </>,
            "Split text into multiple columns",
            "Source column and delimiter",
          ],
          [
            <>
              Remove duplicates <C key="h">dedupe</C>
            </>,
            "Drop duplicate rows",
            "Which columns define a duplicate",
          ],
          [
            <>
              Find &amp; replace <C key="i">replace</C>
            </>,
            "Replace values in a column",
            "Column, match and replacement",
          ],
        ]}
      />

      <H3 id="calc-expressions">Writing a calculated field</H3>
      <P>
        The expression is <strong>SQL</strong>, not a spreadsheet formula language. It is dropped
        into a <C>SELECT</C> as <C>{"(your expression) AS your_column_name"}</C>, so anything valid
        in a SQL select list works — arithmetic, functions, <C>CASE</C>, references to any column
        available at that point in the flow.
      </P>
      <Code lang="sql">{`-- arithmetic across columns
revenue - cost

-- a rate, guarding the divide-by-zero that would otherwise produce nulls
CASE WHEN visits > 0 THEN conversions * 1.0 / visits ELSE 0 END

-- bucketing, for grouping later in the flow
CASE
  WHEN amount >= 10000 THEN 'enterprise'
  WHEN amount >= 1000  THEN 'mid-market'
  ELSE 'smb'
END

-- text tidying
lower(trim(email))

-- a month key to summarise by
date_trunc('month', ordered_at)`}</Code>
      <Callout kind="info" title="The dialect is DuckDB, everywhere">
        Local datasets run on DuckDB both in the browser preview and on the server for scheduled
        refreshes — deliberately the same engine, so what you see in the preview is what the
        schedule produces. That means DuckDB's function library is available to you:{" "}
        <C>date_trunc</C>, <C>strftime</C>, <C>regexp_extract</C>, <C>list_aggregate</C>, window
        functions, and the rest.
      </Callout>
      <Callout kind="warn" title="Order matters, and so does naming">
        Steps run in sequence, so a calculated field can only reference columns that exist{" "}
        <em>above</em> it — including earlier calculated fields, which is the intended way to build
        something up in readable pieces. Give each one a name you would be happy to see on a chart
        axis: it becomes a real column that dashboards, metrics and agents all address by that name,
        and renaming it later breaks whatever already points at it.
      </Callout>

      <H3 id="filter-ops">Filter operators</H3>
      <P>
        Beyond the usual comparisons, the text and null operators are the ones people look for:{" "}
        <C>contains</C>, <C>starts with</C>, <C>ends with</C>, <C>is empty</C> and{" "}
        <C>is not empty</C>.
      </P>
      <Callout kind="warn" title="is empty is not the same as equals blank">
        A column can hold a genuine empty string or a null, and they filter differently. If a filter
        returns fewer rows than expected, check which of the two your data actually contains — the
        column profile in the <DocLink to="/docs/data">catalog</DocLink> shows the null rate.
      </Callout>

      <H2 id="save-refresh">Saving and refreshing</H2>
      <Steps
        items={[
          {
            title: "Save the flow",
            body: "The recipe is stored — sources, joins, steps — not just the output.",
          },
          {
            title: "Run it",
            body: "Produces (or replaces) the prepared table. It appears in the catalog marked as prepared.",
          },
          {
            title: "Schedule it",
            body: "Set a refresh cadence so the prepared table is rebuilt from current source data. Anything built on it — dashboards, agents, metrics — updates with it.",
          },
        ]}
      />
      <H3 id="lineage">Lineage</H3>
      <P>
        A prepared table records what it was built from, visible in the{" "}
        <DocLink to="/docs/data">catalog</DocLink>. Before deleting or restructuring a source table,
        check what depends on it there.
      </P>

      <H2 id="when-not">When not to use prep</H2>
      <UL>
        <li>
          <strong>A one-off answer</strong> — just write the query in the SQL workbench.
        </li>
        <li>
          <strong>Logic your organisation must agree on</strong> — a shared definition of "active
          customer" belongs in the <DocLink to="/docs/semantics">Semantic Layer</DocLink>, where it
          is defined once and reused, rather than baked into one prepared table.
        </li>
        <li>
          <strong>Heavy transformation over very large tables</strong> — push that down to the
          warehouse and connect the result.
        </li>
      </UL>

      <NextPrev current="/docs/data-prep" />
    </>
  );
}
