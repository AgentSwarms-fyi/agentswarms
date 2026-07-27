import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  Diagram,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
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

      <H2 id="steps">Steps</H2>
      <P>Beyond joining, a flow can:</P>
      <FieldList
        items={[
          {
            name: "Filter",
            body: "Keep rows matching a condition — the fastest way to cut a dataset to the population you actually mean.",
          },
          {
            name: "Select / rename",
            body: "Drop columns you don't need and give the rest names a human (and a model) can read.",
          },
          {
            name: "Change type",
            body: "Text→date, text→number. Fixes the imports that make charts and filters misbehave.",
          },
          {
            name: "Computed column",
            body: "A new column from an expression over existing ones — margin, ratio, bucketed band.",
          },
          {
            name: "Aggregate",
            body: "Group by one or more columns and summarise the rest (sum, average, count, min, max).",
          },
          {
            name: "Sort / limit",
            body: "Order the result and optionally cap it — for top-N tables.",
          },
        ]}
      />
      <P>
        Steps apply in order and any one can be removed. Removing a table it depends on is handled
        rather than silently breaking the flow — a joined table is promoted to base if the original
        base is deleted.
      </P>

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
