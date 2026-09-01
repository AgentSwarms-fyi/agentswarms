import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocsHeader,
  H2,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/lakehouse")({
  head: () => ({
    meta: [
      { title: "Lakehouse — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The built-in columnar warehouse: DuckDB over Parquet in your own object storage, with a transactional catalog, governed SQL, snapshots and NL→SQL.",
      },
      { property: "og:title", content: "Lakehouse — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Your local data warehouse — columnar SQL over Parquet in your own storage.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/lakehouse" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/lakehouse" }],
  }),
  component: LakehouseDocsPage,
});

function LakehouseDocsPage() {
  return (
    <>
      <DocsHeader
        title="Lakehouse"
        description="The built-in columnar warehouse — DuckDB attached to a DuckLake catalog. Use it wherever you'd reach for a data warehouse: fast analytical SQL over tables you own, with open Parquet in your own object storage, a transactional catalog, and stateless compute on every app replica."
      />

      <H2 id="what">What it is</H2>
      <P>
        The lakehouse stores table data as zstd-compressed Parquet in your object storage and keeps
        the transactional catalog — schemas, table manifests, snapshots — in a Postgres the
        deployment provides. Every request opens an ephemeral DuckDB, attaches that shared catalog
        and storage, runs, and closes. Nothing lives on a single machine&apos;s disk, so the
        lakehouse scales exactly like the app tier.
      </P>
      <UL>
        <li>
          <strong>Warehouse SQL</strong> — full DuckDB: joins, window functions, CTEs,{" "}
          <C>SUMMARIZE</C>, vectorised columnar execution.
        </li>
        <li>
          <strong>ACID rows</strong> — <C>INSERT</C>/<C>UPDATE</C>/<C>DELETE</C>/<C>MERGE</C> commit
          through the catalog; every commit is a snapshot you can time-travel-query.
        </li>
        <li>
          <strong>NL→SQL</strong> — ask in plain language; the draft is shown for review and runs
          through the same governed path as typed SQL.
        </li>
        <li>
          <strong>Imports</strong> — any platform dataset becomes a lakehouse table with inferred
          types.
        </li>
      </UL>

      <H2 id="use">Working in the Lakehouse</H2>
      <Steps
        items={[
          {
            title: "Create a schema",
            body: "Schemas are the unit of ownership and sharing. New schema in the sidebar; share it from Admin → IAM.",
          },
          {
            title: "Add tables",
            body: "Define columns, or import a platform dataset (uploads, prep outputs, connector-synced tables, samples).",
          },
          {
            title: "Query",
            body: "Type SQL (Ctrl+Enter runs) or ask in plain language. Results are a virtualized grid with CSV export.",
          },
          {
            title: "Inspect and time-travel",
            body: "The table view shows columns, a live preview, and the snapshot history — click a version to query the table as it was.",
          },
        ]}
      />

      <H2 id="lake">Querying your data lake</H2>
      <P>
        <strong>Mount data lake</strong> turns a crawled object-storage source into a read-only
        schema — one view per dataset, reading the files in place. Nothing is copied, and you can
        join lake files against lakehouse tables in one query (
        <C>FROM analytics.orders_rollup r LEFT JOIN raw_lake.orders o …</C>). The file-reading calls
        live inside server-authored view bodies, so user SQL never names a path, and each
        mount&apos;s credential is scoped to its own bucket. Mounts are read-only — writes are
        refused with a message saying why. Crawl the source in the Data Catalog first; that is where
        the dataset list comes from.
      </P>

      <H2 id="fast">Making queries fast</H2>
      <P>
        <strong>Partition</strong> on a table&apos;s toolbar picks up to four columns; DuckLake then
        writes one file set per partition value, so a query filtering on those columns opens only
        the matching files. Pick columns with few distinct values — a date, a region, a tenant —
        never a high-cardinality id, which writes a file per row and makes everything slower. It
        applies to files written from then on, so run maintenance or rewrite the table to re-lay
        what already exists. The badge reads back from DuckLake&apos;s own catalog, so partitioning
        applied from the SQL editor shows up here too.
      </P>
      <P>
        A repeated SELECT is served from memory and marked <C>cached</C> in the toolbar and in
        history. The cache key includes the catalog snapshot id, so{" "}
        <strong>any write invalidates it automatically</strong> — no TTL to tune, and no way to read
        a stale answer after an insert. It is keyed per user and consulted after the access check,
        so a revoked grant cannot read a warm result. The cache lives in each replica&apos;s memory:
        behind a load balancer the same query may be a hit on one replica and a miss on another,
        which changes timing but never the answer.
      </P>
      <P>
        <strong>Explain</strong> runs <C>EXPLAIN ANALYZE</C> and shows the plan the engine chose
        alongside what it cost — rows scanned, engine time, rows returned. Rows scanned is the
        number to watch: if a filtered query scans close to the whole table, the filter isn&apos;t
        matching a partition key. Only SELECTs can be profiled, because <C>EXPLAIN ANALYZE</C>
        executes the statement.
      </P>
      <P>
        Reading remote Parquet costs a footer round trip per file per query, so the engine caches
        that metadata — measured about 20% faster across <em>different</em> queries over the same
        files, the case the result cache doesn&apos;t cover. It stays correct because DuckLake never
        rewrites a data file: a write adds new paths and the catalog decides which are live, so what
        sits behind a cached path can&apos;t change. Files behind a lake mount can be overwritten,
        and the engine validates those.
      </P>
      <P>
        Memory and threads are editable under{" "}
        <strong>Admin → Developer runtime → Compute resources</strong>, which wins over the
        environment variables below — so a running deployment can be retuned without a redeploy, and
        neither is capped by the app.
      </P>
      <P>
        Each engine gets <C>LAKEHOUSE_MEMORY_LIMIT</C> (default 2GB) and spills past it to disk
        bounded by <C>LAKEHOUSE_SPILL_LIMIT</C> (default 20GB). Both are set together deliberately:
        with a memory limit and no spill directory, DuckDB fails a query rather than spilling, so a
        large <C>GROUP BY</C> would error instead of just running slower. Set the memory limit to
        roughly half a container&apos;s RAM, and give each replica real scratch disk rather than a
        tmpfs.
      </P>

      <H2 id="matviews">Materialized views</H2>
      <P>
        A query whose answer is worth keeping becomes a table. <strong>Save as view</strong> in the
        query editor stores the result and rebuilds it on a schedule — manual, hourly, daily or
        weekly — so a dashboard reads stored rows instead of recomputing. What you get is an
        ordinary lakehouse table: queryable, joinable, partitionable, and governed by the same
        chokepoint as everything else.
      </P>
      <P>
        Three properties decide how it behaves when something goes wrong. A rebuild is{" "}
        <strong>one commit</strong> (<C>CREATE OR REPLACE TABLE … AS query</C>), so anyone querying
        mid-rebuild sees the old rows or the new ones, never a half-built table. A{" "}
        <strong>failed rebuild keeps the previous data</strong> — stale rows you can see and
        diagnose beat an empty table — and the error is recorded on the view. And the definition is{" "}
        <strong>re-checked at every rebuild</strong>, not just when it was saved, so a grant revoked
        since then stops the refresh and a definition edited into a write is refused rather than
        executed.
      </P>
      <P>
        Rebuilds run as the view&apos;s owner, since a schedule has no session behind it, and ride
        the same sweep as BI refreshes and ETL schedules — with the same compare-and-set claim, so
        every replica can run the sweep without any view being rebuilt twice. Removing a view
        forgets the definition and leaves the table: deleting your data because you removed a
        schedule would be the wrong default.
      </P>

      <H2 id="policies">Row and column security</H2>
      <P>
        A grant gives someone a whole schema; a <strong>policy</strong> narrows what they see inside
        one table. The <strong>Security</strong> button on a table sets which rows a reader gets and
        which column values are hidden — blanked, or scrambled to a digest that stays groupable and
        joinable but unreadable. Two placeholders make one rule serve everyone:{" "}
        <code className="font-mono">@me</code> becomes the reader&apos;s email and{" "}
        <code className="font-mono">@user_id</code> their id, so <C>owner_email = @me</C> gives each
        person exactly their own rows.
      </P>
      <P>
        Only the schema owner sees the button or the rule — showing a reader the filter would tell
        them precisely what they are denied. The owner is never filtered themselves, because a rule
        its author can&apos;t see through would be impossible to check. And a policed table is
        read-only for everyone else: a reader who sees part of a table must not be able to update or
        delete the parts hidden from them.
      </P>
      <P>
        Enforcement rewrites the reader&apos;s SELECT before it runs, turning each reference to a
        policed table into a subquery that carries the filter and the masks. The rewrite is applied
        to the AST DuckDB itself produced, not to the SQL text — text rewriting can be defeated by
        comments, casing, aliases or a CTE, while the parser sees through all of them. If the
        rewrite can&apos;t be completed, the query is refused rather than run unfiltered. Filters
        are checked against the real table when you save, so a typo surfaces then rather than by
        blocking every reader at once.
      </P>

      <H2 id="concurrency">Concurrent writes</H2>
      <P>
        Two replicas writing at once is the case a shared catalog has to get right, so it was
        measured rather than assumed. Concurrent <em>appends</em> to one table both commit — each
        writes its own Parquet files and the catalog just orders the snapshots. Concurrent writes to
        the <em>same rows</em> are different: one commits and the other&apos;s commit fails, and the
        failed one applies <strong>nothing</strong> (verified with a 500-row insert bundled into the
        losing transaction, of which zero rows survived).
      </P>
      <P>
        That atomicity is what makes recovery safe. Because one statement per request runs in
        autocommit, a failed commit means the statement did not happen — so re-running it applies it
        exactly once, never twice. A losing write is retried automatically on a fresh connection,
        since retrying on the snapshot that just lost would simply lose again, with exponential
        backoff and jitter so two replicas that collided don&apos;t line up and collide again. Every
        retry is counted in query history, so a contended table shows rising retry counts long
        before anyone sees a failure. If retries run out you get a plain message saying the
        statement was rolled back and nothing was applied.
      </P>

      <H2 id="maintenance">Maintenance and compaction</H2>
      <P>
        An hourly pass keeps things fast and small: flush rows still inlined in the catalog into
        Parquet, merge adjacent small files (the biggest lever on scan speed), expire snapshots
        older than 7 days, then delete the files only those snapshots referenced. Steps are
        independent — one failing is logged and the rest still run.
      </P>

      <H2 id="governance">Governance and access</H2>
      <P>
        DuckDB has no per-user ACLs, so the server enforces everything before SQL reaches the
        engine, at one chokepoint. One statement per request, classified select / DML / DDL —
        anything else (<C>ATTACH</C>, <C>COPY</C>, <C>SET</C>, <C>INSTALL</C>, transactions) is
        refused. Every SELECT is parsed to an AST and each table it reads must resolve to a schema
        you own or hold a grant on; writes must be schema-qualified into an accessible schema. Every
        statement — refusals included — lands in your query history and the platform audit trail.
      </P>
      <Callout>
        Sharing a lakehouse schema from Admin → IAM grants query <em>and</em> write on its tables.
        The engine-side chokepoint enforces it on every statement, so a shared connection, dashboard
        or agent reads exactly what the schema&apos;s grants allow — never more.
      </Callout>

      <H2 id="ecosystem">Across the ecosystem</H2>
      <P>
        The lakehouse registers as a <strong>warehouse connection</strong> (Integrations → Data
        Sources → AgentSwarms Lakehouse — no credentials, it runs under your schema grants). That
        one connection wires it into everything:
      </P>
      <Table
        headers={["Surface", "How it reaches the lakehouse"]}
        rows={[
          [
            "BI Workbench & dashboards",
            "Pick the Lakehouse connection as a query source, like any warehouse.",
          ],
          [
            "AI Analyst & agents",
            "The warehouse_query tool runs against it, as the connection's owner.",
          ],
          [
            "Data Catalog",
            "Add a warehouse source over the connection — schemas and tables are crawled with row counts.",
          ],
          [
            "ETL Pipelines",
            "Dedicated Lakehouse table source and target nodes — replace, append or merge, checked against the pipeline owner's schema grants.",
          ],
        ]}
      />
      <P>
        A shared connection always runs as its <strong>owner</strong>: a dashboard or agent using it
        reads what the owner can read, never the viewer&apos;s own grants — the standard the rest of
        the platform&apos;s connections follow.
      </P>

      <H2 id="scaling">Scaling and limits</H2>
      <P>
        Stateless by construction: replicas need no coordination, and writes serialise through the
        catalog&apos;s ACID commits — a conflicting commit fails cleanly and is retried for you (see
        Concurrent writes). All replicas share the same <C>LAKEHOUSE_*</C> config and can reach the
        catalog Postgres and object store. The ceilings are the same single-node honesty as ETL —
        one query&apos;s working set lives on one replica (vectorised execution and file pruning are
        the speed story, not a cluster), and cold reads pay object-storage latency. Small inserts
        are held inlined in the catalog until flushed, so a fresh table can show real row counts
        with little Parquet yet written.
      </P>
      <Callout>
        Configure the engine with <C>LAKEHOUSE_CATALOG_URL</C> and the <C>LAKEHOUSE_*</C> storage
        variables (see <C>docs/LAKEHOUSE.md</C> and <C>.env.example</C>). Unconfigured, the page
        says so instead of half-working.
      </Callout>

      <Callout kind="warn" title="ETL targets: the catalog must sit on the kernel network">
        A pipeline whose target is a lakehouse table attaches the catalog from inside a{" "}
        <strong>notebook kernel</strong>, and kernels run on an <C>internal</C> Docker network whose
        only way out is the HTTP egress proxy. Parquet is HTTP and travels through it; the catalog
        is a raw Postgres connection and cannot. Name the catalog by its service (
        <C>lakehouse-catalog:5432</C>) rather than a host IP or published port — Compose already
        puts it on that network. For a catalog outside Docker, move kernels somewhere with a route
        using <C>NOTEBOOK_NETWORK</C>, accepting the weaker isolation. The symptom otherwise is{" "}
        <C>Network is unreachable</C> in the run log, and it appears only once the app runs in a
        container: under <C>npm run dev</C> kernels get a routable network instead.
      </Callout>

      <NextPrev current="/docs/lakehouse" />
    </>
  );
}
