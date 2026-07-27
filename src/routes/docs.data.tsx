import { createFileRoute } from "@tanstack/react-router";
import {
  C,
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

export const Route = createFileRoute("/docs/data")({
  head: () => ({
    meta: [
      { title: "Data Catalog & SQL — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Upload tables, connect warehouses and object stores, browse the catalog, and query everything from the SQL workbench.",
      },
      { property: "og:title", content: "Data Catalog & SQL — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Where your rows and columns live, and how agents query them.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/data" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/data" }],
  }),
  component: DataPage,
});

function DataPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Data Catalog & SQL"
        description="Everything tabular lives here: uploaded files, connected warehouses and crawled object stores. Agents query it, dashboards chart it, and the catalog tells you what it all means."
      />

      <P>
        Open <strong>Data → Data Catalog</strong>. The page has three jobs — hold your tables,
        describe them, and let you query them — split across tabs.
      </P>

      <H2 id="local-tables">Local tables</H2>
      <P>
        The simplest path. Upload a CSV or Excel file and it becomes a queryable table stored in
        your workspace. Column types are inferred on import and can be corrected afterwards.
      </P>
      <Steps
        items={[
          {
            title: "Upload",
            body: "Drag a CSV/XLSX in, or paste rows. The first row is treated as headers.",
          },
          {
            title: "Check the inferred types",
            body: (
              <>
                A column of <C>2024-03-01</C> should be a date, not text — otherwise date filters
                and time charts won't work on it later.
              </>
            ),
          },
          {
            title: "Name it for the model",
            body: (
              <>
                The table name is visible to agents and heavily influences whether they pick it.{" "}
                <C>monthly_revenue</C> gets chosen correctly far more often than <C>sheet1</C>.
              </>
            ),
          },
        ]}
      />
      <Callout kind="why">
        Table and column names are part of your prompt. When an agent has several tables attached,
        the only thing it has to go on is the schema — so a well-named table is a functional
        improvement, not cosmetics.
      </Callout>

      <H2 id="external">External tables</H2>
      <P>
        Rather than copying data in, connect the system that owns it. Configure connections under{" "}
        <strong>Integrations → Data Sources</strong>; they then appear here as browsable databases
        and schemas.
      </P>
      <Table
        headers={["Family", "Connectors"]}
        rows={[
          ["Cloud warehouses", "Snowflake, Databricks, BigQuery, Redshift, Synapse"],
          ["Query engines", "Trino / Starburst, Amazon Athena"],
          ["Databases", "PostgreSQL, MySQL, Oracle (ORDS)"],
          ["Lakehouse", "Iceberg REST catalog, Unity Catalog (metadata)"],
          ["Object stores", "S3, GCS and compatible endpoints — crawled into the catalog"],
        ]}
      />
      <P>
        Credentials are encrypted at rest and can be sourced from{" "}
        <DocLink to="/docs/secrets">Secrets</DocLink> instead of being typed into the connector, so
        one rotation updates every place that uses them.
      </P>
      <H3 id="direct-vs-import">Direct query vs import</H3>
      <P>
        Each external table can be read live or snapshotted. <strong>Direct query</strong> always
        reflects the source and always costs a round trip to it. <strong>Import</strong> copies a
        snapshot into the workspace, making it fast and cheap to chart repeatedly, at the cost of
        being as stale as its last refresh. Dashboards used by many people usually want import; an
        operational check wants direct.
      </P>

      <H2 id="catalog">The catalog</H2>
      <P>
        The <strong>Catalog</strong> tab is the inventory: every dataset, where it came from, who
        owns it, when it was last crawled, and what's in it. Beyond a listing it holds:
      </P>
      <FieldList
        items={[
          {
            name: "Column profiles",
            body: "Row counts, null rates, distinct values and ranges per column — the fastest way to spot a column that is 90% empty before you build a chart on it.",
          },
          {
            name: "AI descriptions",
            body: "Generate plain-English descriptions for tables and columns. These are read by agents too, so a described catalog produces better tool choices.",
          },
          {
            name: "Lineage",
            body: "Where a dataset came from and what depends on it — prep flows, dashboards, metrics. Check this before changing or deleting anything.",
          },
          {
            name: "Business glossary",
            body: 'Define terms once ("active customer", "booked revenue") and attach them to columns so the definition travels with the data.',
          },
          {
            name: "Change detection",
            body: "Scheduled crawls notice new, changed and removed columns, so a silently altered upstream schema surfaces as a change rather than a broken dashboard.",
          },
        ]}
      />
      <P>
        From any dataset, <strong>Query data</strong> opens it in the workbench with the table
        already loaded.
      </P>

      <H2 id="workbench">SQL workbench</H2>
      <P>
        A full query editor over everything connected. Results can be charted immediately, added to
        a <DocLink to="/docs/bi">dashboard</DocLink>, or exported to CSV or Excel.
      </P>
      <UL>
        <li>
          <strong>Ask in English.</strong> Describe the question and the assistant writes the SQL,
          which you can read and edit before running. Reading the generated SQL is worth the ten
          seconds — it shows you exactly which join or filter the answer depends on.
        </li>
        <li>
          <strong>Results are capped.</strong> Large result sets are truncated for display with the
          true match count shown, so a runaway query can't hang the page.
        </li>
      </UL>

      <H2 id="agent-access">How agents use this</H2>
      <P>
        Attach tables to an agent in the <DocLink to="/docs/agents">Agent Builder</DocLink> and
        enable the <C>sql_query</C> tool. At run time the agent sees each table's name, columns and
        a small sample of rows, writes a <strong>read-only</strong> <C>SELECT</C>, and gets back
        real rows.
      </P>
      <Callout kind="warn" title="Read-only, and scoped">
        Only <C>SELECT</C> is accepted — writes and DDL are rejected before execution. Queries run
        under your identity and row-level security, so an agent cannot read a table you cannot. When
        an agent runs on behalf of an anonymous embed visitor, it is explicitly scoped to the
        owner's data and no one else's.
      </Callout>
      <P>
        If the numbers matter and must match an agreed definition, prefer the{" "}
        <DocLink to="/docs/semantics">Semantic Layer</DocLink> over free-form SQL — it stops two
        people getting two different values for "revenue".
      </P>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <FieldList
        items={[
          {
            name: "The agent said a table doesn't exist",
            body: "It isn't attached to that agent, or it wrote a name that doesn't match. Check the agent's attached tables, and rename cryptic tables to something descriptive.",
          },
          {
            name: "It queried the wrong table",
            body: "Two tables with similar names and no descriptions. Add AI descriptions in the catalog — they are what the model disambiguates on.",
          },
          {
            name: "Dates won't filter",
            body: "The column was imported as text. Fix the column type on the table; date filters and time-series charts need a real date type.",
          },
          {
            name: "A connector test fails",
            body: "Outbound requests are guarded against internal addresses. A warehouse on a private network needs to be reachable from where the app runs — see Self-hosting.",
          },
        ]}
      />

      <NextPrev current="/docs/data" />
    </>
  );
}
