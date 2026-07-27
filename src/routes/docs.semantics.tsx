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
              <C key="7">custom</C>
            </>,
          ],
          [
            <C key="e">sql</C>,
            "Depends",
            <>
              The column or expression to aggregate. Optional for <C key="c2">count</C>; REQUIRED
              for <C key="c3">custom</C>, where it is the full aggregate expression, e.g.{" "}
              <C key="c4">SUM(revenue) - SUM(cost)</C>.
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
          [<C key="e">type</C>, "No", "Field type, used for formatting and filter widgets"],
        ]}
      />
      <Callout kind="warn" title="These SQL fields are trusted">
        Both <C>sql</C> fields are inserted into the compiled query as written. Only people you
        trust to write SQL against your warehouse should be defining metrics — this is an authoring
        surface, not a user input.
      </Callout>

      <H2 id="define">Defining a metric</H2>
      <P>
        Pick the source table, name the metric, choose the aggregation and expression, add the
        filters that belong to the definition, and declare which dimensions it may be sliced by. The
        editor previews the compiled SQL and a sample result before you save — read the SQL, it is
        the definition.
      </P>
      <Code lang="Compiled preview">{`SELECT date_trunc('month', o.created_at) AS month,
       o.region                          AS region,
       SUM(o.amount)                     AS net_revenue
FROM   orders o
WHERE  o.status = 'settled'
  AND  o.is_refund = false
GROUP BY 1, 2`}</Code>

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
