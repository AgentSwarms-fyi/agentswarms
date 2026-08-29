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

export const Route = createFileRoute("/docs/etl")({
  head: () => ({
    meta: [
      { title: "ETL Pipelines — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Move data from APIs, databases, warehouses and files into destinations your catalog, BI and agents can query — on a visual canvas, in Python, or generated with AI.",
      },
      { property: "og:title", content: "ETL Pipelines — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Extract, transform and load — sandboxed, scheduled, and catalogued.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/etl" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/etl" }],
  }),
  component: EtlDocsPage,
});

function EtlDocsPage() {
  return (
    <>
      <DocsHeader
        title="ETL Pipelines"
        description="Move data from APIs, databases, warehouses and files into destinations the Data Catalog, BI, the AI Analyst and agents can query. Build on a visual canvas, write Python, or generate it with AI — every run executes in the same sandboxed runtime with full logs and audit."
      />

      <H2 id="when-to-use">When a pipeline is the right tool</H2>
      <P>
        AgentSwarms has three ways to reshape data, and they are deliberately not the same feature.{" "}
        <DocLink to="/docs/data-prep">Data preparation</DocLink> transforms tables the platform can
        already query, in place. The <DocLink to="/docs/semantics">Semantic Layer</DocLink> defines
        governed metrics over warehouse tables. An{" "}
        <strong>ETL pipeline moves data between systems</strong>: it exists for the work the other
        two cannot express — calling an external API, converting raw bucket files, reading one
        database and writing another, or any transform that wants a real programming language.
      </P>
      <Table
        headers={["You want to…", "Use"]}
        rows={[
          [
            "Join and clean tables already in the platform",
            <DocLink key="a" to="/docs/data-prep">
              Data preparation
            </DocLink>,
          ],
          [
            "Define a governed metric over warehouse tables",
            <DocLink key="b" to="/docs/semantics">
              Semantic Layer
            </DocLink>,
          ],
          ["Pull an external API into analysable tables", "ETL pipeline"],
          ["Convert raw bucket files into queryable tables", "ETL pipeline"],
          ["Copy between databases, or database → storage", "ETL pipeline"],
          ["Transforms needing custom logic or libraries", "ETL pipeline"],
        ]}
      />

      <H2 id="building">Building one</H2>
      <H3 id="canvas">The visual canvas</H3>
      <P>
        A pipeline is a graph: source nodes on the left, transform nodes in the middle, target nodes
        on the right, connected by dragging between handles. Multiple sources can feed a join or a
        union; one output can branch to several targets. Click a node to configure it in the side
        panel; the <strong>Code</strong> toggle shows the exact Python the graph compiles to — what
        you see is literally what a run executes. A graph that isn&apos;t valid yet (a join with one
        input, an unconnected node) still saves; the canvas shows what to fix, and the run button
        refuses until it compiles.
      </P>
      <FieldList
        items={[
          {
            name: "Sources",
            body: (
              <>
                Object storage files (CSV, TSV, JSON, JSONL, Parquet, Excel — with glob patterns
                like <C>raw/orders/*.csv</C>), a database or warehouse table or SQL query, an HTTP
                API returning JSON, a platform dataset (uploads, prep outputs, connector-synced
                tables), or custom Python.
              </>
            ),
          },
          {
            name: "Transforms",
            body: "Filter, select, rename, derive, join (inner/left/right/outer), union, aggregate (group by with sum/mean/min/max/count/…), sort, deduplicate, fill or drop nulls, limit, quality gate (validate columns; fail, warn or drop on violation), SQL over the incoming frame, or custom Python.",
          },
          {
            name: "Targets",
            body: (
              <>
                Object storage (Parquet, CSV or JSONL under{" "}
                <C>&lt;bucket&gt;/&lt;dataset&gt;/&lt;table&gt;/</C>) or a database/warehouse table
                — each with <C>replace</C>, <C>append</C> or <C>merge</C> (upsert on primary keys).
                SQL-family databases load over SQLAlchemy; Snowflake, BigQuery and Databricks load
                through their native bulk paths using the connection you already added.
              </>
            ),
          },
        ]}
      />
      <H3 id="code">Code</H3>
      <P>
        A full-height Python editor. The contract is small: define <C>entrypoint(inputs=None)</C>,
        return a JSON-able metrics dict (at minimum <C>{"{'rows_loaded': n}"}</C>), read credentials
        from environment variables, and list the packages you import under Requirements — they are
        installed in the sandbox before the run. Ejecting a canvas pipeline hands you its compiled
        Python as a starting point (one-way: edited code cannot be turned back into a graph).
      </P>
      <H3 id="ai">AI generate and refine</H3>
      <P>
        The AI assist panel drafts a pipeline from a brief, or refines the current code from an
        instruction (“add retry logic to the fetch”, “partition by month”). It uses{" "}
        <strong>your</strong> connected provider and the shared model picker, so IAM model rules
        apply here exactly as in BI, and drafts follow the runtime contract — credentials from the
        environment, never literals. A draft is only ever text in the editor until you review, save
        and run it.
      </P>

      <H2 id="samples">Sample pipelines</H2>
      <P>
        The New pipeline dialog offers six worked scenarios, each solving a classically hard ETL
        problem against messy demo datasets bundled with the app (under <C>/etl-samples/</C> on your
        own deployment — the runs fetch them from your instance&apos;s origin, so they work
        offline). Pick your destination bucket under Settings and run.
      </P>
      <Table
        headers={["Sample", "The hard part it solves"]}
        rows={[
          [
            "Medallion branch-out",
            "One messy source fans to silver rows, gold KPIs and a quarantine of rejects with reasons — branching and multiple targets.",
          ],
          [
            "Orders ↔ payments reconciliation",
            "Full outer join plus per-row classification: missing, duplicate, mismatched and orphan payments land in an exception report.",
          ],
          [
            "SCD Type 2 dimension history",
            "Changed dimension rows close out with validity ranges instead of being overwritten — the pipeline reads its own destination back to compute the delta.",
          ],
          [
            "Incremental load with watermark",
            "Only rows newer than the last run, with the watermark persisted in the destination bucket. Run twice; the second load is empty.",
          ],
          [
            "Fuzzy contact dedupe",
            "Two CRM exports with clashing name/phone/email formats become one golden table via canonical match keys and survivorship rules.",
          ],
          [
            "Clickstream sessionization",
            "Shuffled events become per-user sessions under a 30-minute inactivity rule — stateful windowing after restoring time order.",
          ],
        ]}
      />

      <H2 id="connections">Connections and supported systems</H2>
      <P>
        Pipelines reuse the connections the rest of the product already governs — object-storage
        sources from the <DocLink to="/docs/data">Data Catalog</DocLink> (AWS S3, MinIO, R2, Spaces,
        B2, GCS in S3-compat mode) and database connections from{" "}
        <DocLink to="/docs/data">Data Sources</DocLink>, including ones shared with you through{" "}
        <DocLink to="/docs/iam">IAM</DocLink>. Credentials are resolved server-side at run start and
        delivered into the sandbox process only.
      </P>
      <Table
        headers={["Database family", "Providers", "Source", "Target"]}
        rows={[
          [
            "PostgreSQL wire",
            "PostgreSQL, CockroachDB, TimescaleDB, AlloyDB, Greenplum, YugabyteDB",
            "✓",
            "✓",
          ],
          ["MySQL wire", "MySQL, MariaDB, SingleStore, StarRocks, Doris, PlanetScale", "✓", "✓"],
          ["SQL Server wire", "SQL Server, Azure Synapse", "✓", "✓"],
          [
            "Own protocols",
            "Snowflake, BigQuery, Redshift, Databricks, Trino, Athena, Oracle, ClickHouse",
            "stage via object storage",
            "stage via object storage",
          ],
        ]}
      />
      <Callout kind="info" title="Why some systems say “stage via object storage”">
        Those systems authenticate in ways that cannot ride a plain connection URL into a sandbox
        (IAM roles, token-only auth, service accounts). Land Parquet in a bucket they can read
        instead — every one of them ingests object storage natively, and the pipeline refuses at
        save time with this exact guidance rather than failing inside a container.
      </Callout>

      <H2 id="how-it-runs">How a run executes</H2>
      <P>
        Every run is a <strong>batch kernel on the sandboxed runtime</strong> — the same hardened
        containers, egress allow-list and reaper as the{" "}
        <DocLink to="/docs/notebooks">Developer workspace</DocLink>. Nothing runs in the app
        process. The run installs the pipeline&apos;s requirements, fetches its resolved credentials
        over HTTPS into process memory (never container environment variables, never the code text),
        executes <C>entrypoint(inputs)</C>, and reports metrics, logs and status back to the Runs
        tab. Secret values are scrubbed from captured logs before they are stored.
      </P>
      <Callout kind="warn" title="The runtime must be enabled">
        Pipelines execute on the Developer-workspace runtime. If an administrator has not enabled it
        (Admin → Developer runtime, or the <C>notebooks</C> Compose profile on a self-hosted
        install), runs fail immediately with a message saying exactly that. See{" "}
        <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink>.
      </Callout>

      <H2 id="credentials">Credentials and secrets</H2>
      <P>
        Storage nodes resolve their catalog source&apos;s credentials; database nodes resolve their
        connection&apos;s. Each node&apos;s variables are namespaced by its id (visible in the
        generated code), and storage access stays scoped to the source&apos;s configured bucket
        prefix. Code-mode pipelines get the pipeline-level destination as:
      </P>
      <Table
        headers={["Variable", "Meaning"]}
        rows={[
          [
            <C key="a">ETL_DEST_BUCKET_URL</C>,
            "s3://bucket[/prefix] — scoped to the source's configured prefix",
          ],
          [<C key="b">ETL_DEST_ENDPOINT_URL</C>, "Custom endpoint (MinIO et al.); unset on AWS"],
          [<C key="c">ETL_DEST_ACCESS_KEY_ID</C>, "Access key"],
          [<C key="d">ETL_DEST_SECRET_ACCESS_KEY</C>, "Secret key"],
        ]}
      />
      <P>
        Anything else the code needs — an API token, a password for a system without a stored
        connection — is bound under Settings as <C>{"KEY={{secret:NAME}}"}</C> lines referencing{" "}
        <DocLink to="/docs/secrets">Secrets</DocLink>, and arrives the same way. A binding that
        fails to resolve is dropped rather than failing the run, so the code that needed it reports
        a missing variable — far easier to diagnose than a run that never starts.
      </P>

      <H2 id="scheduling">Schedules, triggers and chaining</H2>
      <UL>
        <li>
          <strong>Manual</strong> — the Run now button, or <strong>Run with parameters</strong>{" "}
          beside it (see below).
        </li>
        <li>
          <strong>Hourly / daily / weekly</strong> — simple presets, swept by the same scheduler
          that drives BI refreshes and catalog crawls. A pipeline that overruns its interval skips a
          beat rather than queueing a backlog behind itself.
        </li>
        <li>
          <strong>Cron</strong> — a five-field expression evaluated in an IANA timezone:{" "}
          <C>0 6 * * 1-5</C> with <C>Europe/Berlin</C> runs weekdays at 06:00 Berlin time, DST
          handled. Supported syntax: <C>*</C>, numbers, ranges, lists and steps (<C>*/15</C>); typos
          are refused at save with the reason.
        </li>
        <li>
          <strong>External trigger</strong> — mint a token under Settings and{" "}
          <C>POST /api/etl/run</C> with it as a bearer plus <C>{'{"pipeline_id": "…"}'}</C>{" "}
          (optionally <C>{'"params"'}</C>). This is how a swarm&apos;s http node, an n8n workflow or
          CI starts a load. Tokens are shown once and stored only as a hash; triggering is
          rate-limited (<C>ETL_TRIGGER_PER_MIN</C>, default 6/min per pipeline).
        </li>
        <li>
          <strong>Chaining</strong> — set <em>Run after</em> in Settings and this pipeline starts
          when the selected one succeeds (medallion layers, staging → merge). Cycles are refused at
          save time.
        </li>
      </UL>

      <H3 id="retries">Retries and overlap</H3>
      <P>
        A pipeline can retry up to five times with exponential backoff (1, 2, 4, 8, 16 minutes).
        Retries reuse the same run, so the Runs tab shows one logical run whose logs carry every
        attempt&apos;s story; a runtime that was briefly unavailable counts as a retryable failure,
        and the failure notification fires only when the ladder is exhausted. Overlap is refused by
        default — a second start (manual, webhook, chain or schedule) is rejected while a run is
        queued, running or waiting out a backoff, because append-mode targets double-load under
        overlap. Flip <em>Allow concurrent runs</em> when a pipeline is genuinely idempotent.
      </P>

      <H3 id="parameters">Parameters and backfills</H3>
      <P>
        Every run delivers a JSON object to <C>entrypoint(inputs)</C>: the pipeline&apos;s default
        parameters merged under any per-run values from the <strong>Run with parameters</strong>{" "}
        dialog or the trigger body. The object is pinned on the run row, so “re-run July 3–9” is one
        dialog away and forever attributable:
      </P>
      <Code lang="python">{`def entrypoint(inputs=None):
    inputs = inputs or {}
    start = inputs.get('start_date', '2026-08-01')
    end = inputs.get('end_date', '2026-08-07')
    # query/filter the window, load as usual`}</Code>

      <H3 id="incremental">Engine-managed incremental loads</H3>
      <P>
        Database and object-storage source nodes take an optional <em>incremental cursor column</em>
        . The engine stores the highest value each successful run loaded and hands it back to the
        next run; database sources push the filter down as SQL, storage sources filter rows after
        reading. The watermark advances only after a durable load — a crash between load and
        bookkeeping re-reads rows rather than skipping them — and an empty read keeps the previous
        cursor. State is server-held per node and never client-writable.
      </P>

      <H2 id="ecosystem">Where the data goes next</H2>
      <Steps
        items={[
          {
            title: "The run loads tables into your destination",
            body: "Files under dataset/table folders in a bucket, or rows in a database table. Every target reports the schema it loaded in the run's metrics.",
          },
          {
            title: "The destination is re-crawled automatically",
            body: "After every successful run the linked catalog source is crawled, so new tables appear as assets without waiting for a crawl schedule.",
          },
          {
            title: "Preview any node on sampled data",
            body: "Select a node and Preview data runs its upstream steps in the sandbox on sampled sources, showing the rows and column types that node produces — before anything is loaded anywhere.",
          },
          {
            title: "Every meaningful save is a version",
            body: "The Settings tab keeps a version history of the pipeline's graph and code. Restore any version with one click — the restore itself becomes the newest version, so nothing is ever lost.",
          },
          {
            title: "Schema drift is caught before the load",
            body: "Targets can evolve silently (default), warn, or fail on drift. Strict targets compare the incoming frame against last run's stored shape and abort before writing — the error names exactly which columns were added, removed or retyped.",
          },
          {
            title: "Quality gates keep bad rows out",
            body: "A Quality gate transform checks columns mid-pipeline — not null, unique, in range, regex, allowed values, minimum row count. Per rule, a violation fails the run, warns, or drops the offending rows; every outcome lands in the run's quality metrics and [quality] log lines.",
          },
          {
            title: "Lineage is registered in the catalog",
            body: "Each run records which sources fed which produced assets. Open an asset in the Data Catalog and the drawer shows its upstream edges — a storage path, a database table, an API URL, or a Python script.",
          },
          {
            title: "Everything downstream can use it",
            body: "Catalog assets back BI dashboards, AI Analyst questions, agent SQL tools and swarm retrieve nodes — loaded data is queryable the moment the crawl lands.",
          },
        ]}
      />

      <H2 id="observability">Observability, logs, audit and IAM</H2>
      <P>
        The Runs tab is the record: status, trigger, attempt count, pinned parameters, duration,
        rows loaded per target, and the sandbox&apos;s output with secret values scrubbed —{" "}
        <strong>streamed live</strong> while the run executes, so a long job narrates itself instead
        of going dark until the end. A failed scheduled run also sends a notification — a pipeline
        that fails silently at 3am is the failure mode the runs table exists to prevent. Pipeline
        creation, edits, deletion, run starts and outcomes are written to the{" "}
        <DocLink to="/docs/analytics">audit log</DocLink>; runs are server-written rows a client
        cannot forge or edit. Connections honour <DocLink to="/docs/iam">IAM</DocLink>: a connection
        shared with you works in a pipeline exactly as it does in BI, and the AI assist obeys your
        model allow-lists.
      </P>

      <H2 id="limits">Limits, stated plainly</H2>
      <UL>
        <li>
          Database connectivity covers the three wire families in the table above; the rest stage
          through object storage. The refusal happens at save time, with the message telling you so.
        </li>
        <li>
          The first run pays a cold start plus a package install — a couple of minutes for the full
          stack. Later runs on a warm image are much faster.
        </li>
        <li>
          Three runs may execute concurrently per account; the trigger endpoint answers 409 when the
          pipeline has no capacity to start.
        </li>
      </UL>

      <NextPrev current="/docs/etl" />
    </>
  );
}
