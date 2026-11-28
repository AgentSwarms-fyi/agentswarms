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
  Note,
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
          "Upload tables and connect warehouses — the exact configuration fields for every connector, the catalog, and the SQL workbench.",
      },
      { property: "og:title", content: "Data Catalog & SQL — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Every connector field, and how agents query your tables.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/data" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/data" }],
  }),
  component: DataPage,
});

/** Renders one connector's field table with a consistent shape. */
function Connector({
  id,
  title,
  where,
  rows,
  note,
}: {
  id: string;
  title: string;
  where?: React.ReactNode;
  rows: React.ReactNode[][];
  note?: React.ReactNode;
}) {
  return (
    <>
      <H3 id={id}>{title}</H3>
      {where && <P>{where}</P>}
      <Table headers={["Field", "Required", "Example / notes"]} rows={rows} />
      {note}
    </>
  );
}

function DataPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Data Catalog & SQL"
        description="Everything tabular: uploaded files, 22 databases and warehouses, 18 app sources, the catalog that describes them, and the workbench that queries them."
      />

      <P>
        Open <strong>Data engineering → Data Catalog</strong>.
      </P>

      <H2 id="choosing">Which kind of source do you want?</H2>
      <P>
        There are four ways to get data in here and they are not interchangeable. Picking the wrong
        one is recoverable but tedious — a CSV uploaded monthly by hand is a warehouse connection
        nobody made, and a warehouse connected for a one-off question is a credential you now have
        to look after.
      </P>
      <Table
        headers={["", "Where the data lives", "Freshness", "Reach for it when"]}
        rows={[
          [
            <strong key="a">Upload a file</strong>,
            "Copied in, as a local dataset",
            "Frozen at upload — re-upload to update",
            "A one-off analysis, a hand-maintained list, or anything that has no system behind it. Fastest path from nothing to a chart.",
          ],
          [
            <strong key="b">Connect a database</strong>,
            "Stays where it is; queried in place",
            "Live — every query hits the source",
            "The data already lives in a system of record and must not go stale. This is the default for anything a business actually runs on.",
          ],
          [
            <strong key="c">Connect an app</strong>,
            "Pulled into local datasets on a schedule",
            "As fresh as the sync interval",
            "Stripe, Shopify, HubSpot, Salesforce, Jira, Zendesk, Google Sheets — SaaS tools with no query language of their own.",
          ],
          [
            <strong key="d">Crawl a bucket</strong>,
            "Stays in object storage; read per query",
            "Live, per file",
            "Files someone else drops into S3-compatible storage — exports, logs, partitioned Parquet.",
          ],
        ]}
      />
      <Callout kind="why" title="Queried in place versus pulled in is the real distinction">
        A database connection sends your question to the database. An app source cannot — SaaS APIs
        have no query language — so those rows are copied here on a schedule and behave exactly like
        an uploaded file afterwards. That is why apps have a sync interval and databases do not, and
        why a question about "right now" is answered honestly by one and approximately by the other.
      </Callout>
      <Table
        headers={["Also worth knowing", ""]}
        rows={[
          [
            "Uploads have a ceiling",
            <>
              500,000 rows per dataset (<C key="u">UPLOAD_MAX_ROWS</C>). Past that you want a
              database connection rather than a bigger file.
            </>,
          ],
          [
            "Connections are read-only",
            "The drivers accept a single SELECT-shaped statement and reject writes and DDL before execution. Still connect with a read-only account — the warehouse's own permissions are the real boundary, and this is the belt to that braces.",
          ],
          [
            "Bucket queries are not pushed down",
            <>
              Files are read up to 50,000 rows each and the query runs here, so a filter does not
              reduce what is fetched. Fine for exports; not a substitute for a warehouse.
            </>,
          ],
          [
            "You can mix them",
            "The catalog describes all four the same way, and the SQL workbench and agents treat a synced app table exactly like an uploaded one. Start with an upload to prove the question is worth answering, then connect the real source.",
          ],
        ]}
      />

      {/* ── LOCAL ── */}
      <H2 id="local-tables">Local tables</H2>
      <Steps
        items={[
          {
            title: "Upload",
            body: (
              <>
                Drag in a <C>.csv</C> or <C>.xlsx</C>, or paste rows. The first row is treated as
                headers.
              </>
            ),
          },
          {
            title: "Check the inferred column types",
            body: (
              <>
                A column of <C>2024-03-01</C> must be <strong>date</strong>, not text, or date
                filters and time-series charts will not work on it later. Fix it now — it is far
                more annoying after dashboards are built.
              </>
            ),
          },
          {
            title: "Name it for the model",
            body: (
              <>
                <C>monthly_revenue</C> is chosen correctly by agents far more often than{" "}
                <C>sheet1</C>. Lower case, underscores, no spaces.
              </>
            ),
          },
        ]}
      />
      <Callout kind="why">
        Table and column names are part of your prompt. When an agent has several tables attached,
        the schema is the only thing it has to go on — so naming is a functional improvement, not
        cosmetics.
      </Callout>

      {/* ── CONNECTORS ── */}
      <H2 id="connectors">External connections — every field</H2>
      <P>
        Configure these under <strong>Integrations → Data sources → Add connection</strong>. Every
        connector has a <strong>Name</strong> (your label) and a <strong>Test connection</strong>{" "}
        button; the last test result and its error are kept on the connection so you can see when it
        started failing. All secrets are encrypted at rest and never returned to the browser.
      </P>
      <Callout kind="info">
        Any field below can be filled from <DocLink to="/docs/secrets">Secrets</DocLink> instead of
        being typed in, so rotating a password is one edit rather than a hunt through every
        connection. A secret shared with you fills a password, token or key only toward the host the
        connection reaches, and only if its owner allowed that host; the host, account or region
        itself takes only your own secrets.
        <br />
        <br />
        <strong>Over a private path:</strong> the form&rsquo;s <strong>Network</strong> box says how
        each engine is reached privately (a cloud private endpoint keeping its name,
        Snowflake&rsquo;s <C>.privatelink</C> account, a VPN). <strong>Test connection</strong>{" "}
        reports the address it reached, and <strong>Require a private network path</strong> refuses
        every connection that would not be private, before it is opened. A Postgres, MySQL or SQL
        Server host that is, or resolves to, the cloud metadata address is always refused, and both
        checks run again as each connection opens, on the address it then connects to. BigQuery,
        Redshift and Athena also take a <strong>Private endpoint</strong> for when private DNS does
        not resolve their usual host privately: a Private Service Connect name (
        <C>bigquery-&lt;endpoint&gt;.p.googleapis.com</C>) or an interface endpoint&rsquo;s{" "}
        <C>vpce-…</C> name, in the connection&rsquo;s region.
      </Callout>

      <Connector
        id="c-postgres"
        title="PostgreSQL"
        rows={[
          [<C key="a">host</C>, "Yes", "db.example.com"],
          [<C key="b">port</C>, "No", "Defaults to 5432"],
          [<C key="c">database</C>, "Yes", "analytics"],
          [<C key="d">username</C>, "Yes", "Create a read-only role for this"],
          [<C key="e">password</C>, "Yes", "—"],
          [
            <C key="f">ssl</C>,
            "No",
            <>
              Set to <C key="r">require</C> to enable TLS. Needed by most managed hosts (RDS, Cloud
              SQL, Neon, Supabase).
            </>,
          ],
        ]}
      />

      <Connector
        id="c-mysql"
        title="MySQL / MariaDB"
        rows={[
          [<C key="a">host</C>, "Yes", "db.example.com"],
          [<C key="b">port</C>, "No", "Defaults to 3306"],
          [<C key="c">database</C>, "Yes", "analytics"],
          [<C key="d">username</C>, "Yes", "—"],
          [<C key="e">password</C>, "Yes", "—"],
          [
            <C key="f">ssl</C>,
            "No",
            <>
              Set to <C key="r">require</C> for TLS.
            </>,
          ],
        ]}
      />

      <Callout kind="info" title="Ten more databases use exactly the fields above">
        Most &ldquo;new databases&rdquo; are not new protocols. Each of these is a first-class entry
        in the picker with its own name, logo and default port, but it speaks a wire protocol we
        already support, so it takes the same fields and shares the same proven driver:
        <UL>
          <li>
            <strong>PostgreSQL fields</strong> — CockroachDB, TimescaleDB, AlloyDB, Greenplum,
            YugabyteDB
          </li>
          <li>
            <strong>MySQL fields</strong> — MariaDB, SingleStore, StarRocks, Apache Doris,
            PlanetScale
          </li>
        </UL>
        Pick the one you actually run — the port default and the docs differ even where the driver
        does not.
      </Callout>

      <Connector
        id="c-sqlserver"
        title="Microsoft SQL Server / Azure SQL"
        where={
          <>
            Speaks TDS through the <C>tedious</C> driver, so it needs a{" "}
            <strong>Node or Docker deployment</strong> — there is no REST SQL API to fall back on.
          </>
        }
        rows={[
          [<C key="a">host</C>, "Yes", "sql.example.com or acme.database.windows.net"],
          [<C key="b">port</C>, "No", "Defaults to 1433. Leave blank if using a named instance."],
          [<C key="c">database</C>, "Yes", "analytics"],
          [<C key="d">username</C>, "Yes", "—"],
          [<C key="e">password</C>, "Yes", "—"],
          [
            <C key="f">instance_name</C>,
            "No",
            <>
              A named instance such as <C key="x">SQLEXPRESS</C>.{" "}
              <strong>Mutually exclusive</strong> with a port — send both and the instance is
              ignored, which silently connects you to the wrong server.
            </>,
          ],
          [
            <C key="g">trust_server_certificate</C>,
            "No",
            <>
              Set <C key="y">true</C> for an on-prem server with a self-signed certificate. Leave
              off for Azure SQL, which never needs it.
            </>,
          ],
        ]}
      />

      <Connector
        id="c-clickhouse"
        title="ClickHouse"
        where={<>Uses the HTTP interface, so it works on any deployment.</>}
        rows={[
          [
            <C key="a">url</C>,
            "Yes",
            <>
              Base URL of the HTTP interface, e.g. <C key="x">https://abc.clickhouse.cloud:8443</C>
            </>,
          ],
          [<C key="b">username</C>, "Yes", "default"],
          [<C key="c">password</C>, "Yes", "—"],
          [<C key="d">database</C>, "No", "Scopes table browsing"],
        ]}
      />

      <Connector
        id="c-snowflake"
        title="Snowflake"
        where={
          <>
            Uses a <strong>programmatic access token (PAT)</strong>, not a password — generate one
            in Snowflake under your user's settings.
          </>
        }
        rows={[
          [
            <C key="a">account</C>,
            "Yes",
            <>
              Account identifier: <C key="x">xy12345.eu-west-1</C> or <C key="y">myorg-myaccount</C>
            </>,
          ],
          [<C key="b">token</C>, "Yes", "The PAT"],
          [<C key="c">warehouse</C>, "Yes", "COMPUTE_WH — the compute that runs the query"],
          [<C key="d">database</C>, "Yes", "ANALYTICS"],
          [<C key="e">schema</C>, "No", "PUBLIC — scopes table browsing"],
          [
            <C key="f">role</C>,
            "No",
            "Defaults to the user's default role. Set it explicitly for least privilege.",
          ],
        ]}
      />

      <Connector
        id="c-databricks"
        title="Databricks SQL"
        where={
          <>
            The <C>warehouse_id</C> comes from the SQL warehouse's <em>Connection Details</em> tab.
          </>
        }
        rows={[
          [<C key="a">host</C>, "Yes", "https://dbc-xxxx.cloud.databricks.com"],
          [<C key="b">warehouse_id</C>, "Yes", "From Connection Details"],
          [<C key="c">token</C>, "Yes", "Personal access token"],
          [<C key="d">catalog</C>, "No", "Unity Catalog catalog name"],
          [<C key="e">schema</C>, "No", "Default schema"],
        ]}
      />

      <Connector
        id="c-bigquery"
        title="Google BigQuery"
        rows={[
          [<C key="a">project_id</C>, "Yes", "my-gcp-project"],
          [
            <C key="b">service_account_json</C>,
            "Yes",
            "The FULL service-account key JSON, pasted as a string. Grant it BigQuery Data Viewer + Job User.",
          ],
          [
            <C key="c">location</C>,
            "No",
            <>
              US, EU or a region like <C key="r">us-central1</C>. Used for jobs and region-wide
              table listing.
            </>,
          ],
          [<C key="d">dataset</C>, "No", "Restricts browsing to one dataset"],
        ]}
      />

      <Connector
        id="c-redshift"
        title="Amazon Redshift"
        where={
          <>
            Two shapes: <strong>Serverless</strong> (set <C>workgroup_name</C>) or{" "}
            <strong>provisioned</strong> (set <C>cluster_identifier</C> and <C>db_user</C>). Fill
            one pair, not both.
          </>
        }
        rows={[
          [<C key="a">region</C>, "Yes", "us-east-1"],
          [<C key="b">access_key_id</C>, "Yes", "—"],
          [<C key="c">secret_access_key</C>, "Yes", "—"],
          [<C key="d">database</C>, "Yes", "dev"],
          [<C key="e">workgroup_name</C>, "Serverless", "Serverless workgroup name"],
          [<C key="f">cluster_identifier</C>, "Provisioned", "Cluster id"],
          [<C key="g">db_user</C>, "Provisioned", "Database user for the cluster"],
        ]}
      />

      <Connector
        id="c-synapse"
        title="Azure Synapse (dedicated SQL pool)"
        rows={[
          [<C key="a">server</C>, "Yes", "myworkspace.sql.azuresynapse.net"],
          [<C key="b">database</C>, "Yes", "Pool name"],
          [<C key="c">username</C>, "Yes", "—"],
          [<C key="d">password</C>, "Yes", "—"],
        ]}
      />

      <Connector
        id="c-trino"
        title="Trino / Starburst / Presto"
        rows={[
          [<C key="a">host</C>, "Yes", "trino.example.com — hostname only, no scheme"],
          [<C key="b">port</C>, "No", "Defaults to 443 with TLS, 8080 plain"],
          [<C key="c">username</C>, "Yes", "Required by the protocol (sent as X-Trino-User)"],
          [<C key="d">password</C>, "No", "Basic auth; optional on anonymous coordinators"],
          [
            <C key="e">access_token</C>,
            "No",
            "JWT/OAuth2 bearer — takes precedence over password when set",
          ],
          [<C key="f">catalog</C>, "No", <>iceberg, hive, delta …</>],
          [<C key="g">schema</C>, "No", "Default schema"],
          [
            <C key="h">ssl</C>,
            "No",
            <>
              Set to <C key="r">disable</C> for plain HTTP; anything else is HTTPS (the default).
            </>,
          ],
        ]}
      />

      <Connector
        id="c-athena"
        title="Amazon Athena"
        rows={[
          [<C key="a">region</C>, "Yes", "us-east-1"],
          [<C key="b">access_key_id</C>, "Yes", "—"],
          [<C key="c">secret_access_key</C>, "Yes", "—"],
          [<C key="d">session_token</C>, "No", "For temporary STS credentials"],
          [<C key="e">database</C>, "No", "Glue database queried by default; also scopes browsing"],
          [
            <C key="f">catalog</C>,
            "No",
            <>
              Defaults to <C key="r">AwsDataCatalog</C>
            </>,
          ],
          [
            <C key="g">workgroup</C>,
            "No",
            <>
              Defaults to <C key="r">primary</C>
            </>,
          ],
          [
            <C key="h">output_location</C>,
            "Usually",
            <>
              <C key="r">s3://bucket/prefix/</C> for query results. Required unless the workgroup
              already sets one — the most common cause of a failing Athena connection.
            </>,
          ],
        ]}
      />

      <Connector
        id="c-oracle"
        title="Oracle Database / Autonomous DB"
        where={
          <>
            Connects over <strong>ORDS</strong> — plain HTTPS, so no wallet and no Instant Client.
            Autonomous Database ships ORDS enabled.
          </>
        }
        rows={[
          [
            <C key="a">ords_url</C>,
            "Yes",
            <>
              Base URL from Database Actions, e.g.{" "}
              <C key="r">
                https://&lt;id&gt;-&lt;db&gt;.adb.&lt;region&gt;.oraclecloudapps.com/ords
              </C>
            </>,
          ],
          [<C key="b">username</C>, "Yes", "DB user, HTTP Basic against the REST-enabled schema"],
          [<C key="c">password</C>, "Yes", "—"],
          [
            <C key="d">schema</C>,
            "No",
            <>
              URL schema-alias segment from <C key="r">ORDS.ENABLE_SCHEMA</C>. Defaults to the
              lower-cased username, which is ORDS's own default.
            </>,
          ],
        ]}
      />

      <H3 id="c-other">Object stores and external table catalogs</H3>
      <Callout kind="why" title="Three different things are called a catalog">
        The word does a lot of work in this business, so: the <strong>Data Catalog</strong> is this
        page — an inventory of every dataset you can reach, with its columns, tags and profile. An{" "}
        <strong>external table catalog</strong> is somebody else&apos;s metadata service — Hive
        Metastore, AWS Glue, Iceberg REST, Unity, Polaris, Nessie — which you connect as a source
        here. And the <strong>lakehouse catalog</strong> (<C>LAKEHOUSE_CATALOG_URL</C>) is the
        Postgres the built-in lakehouse keeps its own table manifests and snapshots in; it is
        machinery, not an inventory, and you never browse it. The first describes data for people;
        the third is what makes the Parquet in your bucket queryable at all.
      </Callout>
      <P>
        S3, Cloudflare R2, MinIO, DigitalOcean Spaces, Backblaze B2, GCS over its S3 API, any other
        S3-compatible endpoint, and Azure Blob Storage / ADLS Gen2 (account key or SAS token) are
        added as <strong>catalog sources</strong> through <strong>Data Catalog → Add source</strong>
        . A crawl lists the bucket, groups a folder of same-format files into one dataset, and
        records each file&rsquo;s columns. A Hive-partitioned folder such as{" "}
        <C>sales/dt=2026-01-01/</C> is one table with <C>dt</C> as a partition column, not one asset
        per folder, and a pipeline reading it gets the partition columns too. A row count marked{" "}
        <C>≈</C> was scaled from a sample rather than counted. A folder holding <C>_delta_log/</C>,{" "}
        <C>.hoodie/</C> or Iceberg metadata is cataloged as that table, read from its own metadata,
        and is not queried here: scanning its Parquet files would return rows the table has deleted.
        Iceberg REST, Unity Catalog, Hive Metastore and AWS Glue are connected for metadata only.
      </P>
      <P>
        <strong>Hive Metastore and AWS Glue.</strong> Add a metastore with the value of{" "}
        <C>hive.metastore.uris</C> from hive-site.xml, such as <C>thrift://hms.internal:9083</C>,
        and Glue with a region and a key. A crawl reads databases, tables, columns, locations,
        formats, partition keys and counts, bucketing and view SQL, and a view&rsquo;s upstreams
        join the lineage graph. It writes nothing. Kerberos-secured metastores are not supported.
      </P>
      <Callout kind="warn" title="A blank row count on a Hive table is deliberate">
        Hive can report 0 rows for an external table with data in it, and call that accurate,
        because a file written from outside Hive does not update the metastore. So a zero on such a
        table reads as unknown. A non-zero count is whatever the last <C>ANALYZE</C> found. Table
        properties are kept by a list of known-safe names, because a JDBC table holds its password
        in one.
      </Callout>
      <P>
        <strong>A bucket can be reached over a private path.</strong> Public is the default. The{" "}
        <strong>Network</strong> box in Add source says how each provider is reached privately: an
        S3 interface endpoint or a GCS Private Service Connect name goes in the Endpoint URL
        (optional for AWS), while Azure Private Link keeps the account&rsquo;s own name and resolves
        it privately. The test reports how the store was reached, e.g. &ldquo;Reached direct to
        10.0.4.7 (private)&rdquo;. <strong>Require a private network path</strong> refuses every
        read, before it is sent, unless the store resolves only to private addresses from the
        server; it covers crawls, queries, lake mounts and ETL runs, and a refusal is audited. With{" "}
        <C>BLOCK_PRIVATE_NETWORK_FETCH</C> on, the clouds&rsquo; own storage names may still resolve
        privately; any other host, a self-hosted MinIO included, stays under the switch.
      </P>
      <P>
        <strong>Parquet, CSV, JSON, NDJSON and ORC files are queryable.</strong> Press{" "}
        <strong>Query data</strong> on a file in the catalog and it opens in the Workbench with the
        bucket selected as the engine. The SQL name is the file&rsquo;s basename without its
        extension, so <C>data/orders.parquet</C> is <C>orders</C>; a partitioned folder{" "}
        <C>sales/*.parquet</C> is <C>sales</C>. Files in the same bucket can be joined, including
        across formats — a Parquet fact table against a CSV lookup is an ordinary query.
      </P>
      <P>
        In the Workbench, <strong>Run query</strong> and Ctrl+Enter (⌘+Enter on a Mac) run one query
        at a time. A second press while one runs is ignored, so a query is never sent, kept in
        Recent queries, or audited twice for one double press.
      </P>
      <Table
        headers={["Format", "Schema", "Query", "Notes"]}
        rows={[
          ["Parquet", "Yes", "Yes", "Read in place; schema and row count from the footer"],
          ["CSV / TSV", "Yes", "Yes", "Schema and profile stats from a head-of-file sample"],
          ["JSON / NDJSON", "Yes", "Yes", "—"],
          [
            "ORC",
            "Yes",
            "Yes",
            <>
              Downloaded whole and read in a separate process — see below. Capped by{" "}
              <C key="o">ORC_MAX_DOWNLOAD_BYTES</C> (256 MB).
            </>,
          ],
          ["Avro", "No", "No", "Cataloged with its name and size; there is no reader for it"],
        ]}
      />
      <Callout kind="warn" title="ORC is read differently, and sometimes cannot be read at all">
        Two things are true of ORC that are not true of Parquet, both measured rather than assumed.
        First, <C>read_orc</C> cannot open <C>s3://</C> — on the same connection,{" "}
        <C>read_parquet(&apos;s3://…&apos;)</C> works and <C>read_orc(&apos;s3://…&apos;)</C>{" "}
        reports &ldquo;no files found&rdquo; — so the object is downloaded whole before it is read,
        which is what the size cap bounds. Second, the ORC extension can{" "}
        <strong>crash the process</strong> on files with nested <C>STRUCT</C>/<C>LIST</C>/<C>MAP</C>{" "}
        columns, including conformance files published by the Apache ORC project. It therefore
        always runs in a child process: the read fails with a message saying the reader crashed, and
        your server keeps serving. Flat ORC files read normally, and schemas are read for all of
        them — a nested file is still cataloged with its columns even though it cannot be queried.
      </Callout>
      <Callout kind="info" title="Why Avro is listed but cannot be opened">
        Avro needs a DuckDB community extension with no published build for the DuckDB version this
        project uses — checked across every platform it targets; the last release was for DuckDB
        v1.1.3. Rather than hiding <C>.avro</C> files, the catalog lists them with their name and
        size and says why they have no columns. If a build appears, enabling it is a one-line
        change.
      </Callout>
      <Callout kind="why" title="Where a Parquet schema comes from">
        A Parquet file keeps its schema in the FOOTER, so the head-of-file sample that infers
        columns for CSV cannot see it — Parquet files used to appear in the catalog as a name and a
        size with no columns at all. The crawler now reads the footer directly, which also gives an
        exact row count without scanning the file. Nothing is downloaded to do it.
      </Callout>
      <Callout kind="why" title="Personal data in lake files, from their values">
        A crawl marks the columns that look personal, and for a file it reads it says so from the
        values, the same way a dataset&apos;s page does: a <C>contact</C> column of email addresses
        is found, an <C>email_campaign_id</C> of numbers is not. A CSV or JSON file is judged from
        the sample the crawl already reads for its columns; a Parquet file from the first 200 rows
        of up to 40 of its text columns, which reads those columns of one row group and stops, not
        the file. Its other columns, and files the crawl does not read (ORC, a file past the
        crawl&apos;s sample budget, a table in Iceberg, Delta or Hudi), are judged by their names,
        and their findings say so. The values read for this are not kept, only the finding. An
        unchanged file keeps what its values showed on the next crawl; a file crawled before this
        was added is read once more.
      </Callout>
      <Callout kind="why" title="No values of personal columns in the catalog">
        A crawl keeps three values it read of each column: one sample, and for numbers the lowest
        and highest. A column that holds personal data keeps none of them, and its Sample reads{" "}
        <C>not kept</C>: one judged personal, one you tagged <C>pii</C>, one a lakehouse tag rule or
        table policy masks, and every column of a table under a row filter. The catalog can be
        shared with people who cannot read the data, and it would otherwise hold a copy that erasing
        or masking the data does not reach. The finding, its counts and the column&apos;s null and
        distinct figures stay. AI docs tells the model what such a column holds, never an example of
        it. A rule written later applies to what is already kept; a value comes back only when a
        crawl reads it again with the rule gone.
      </Callout>
      <Callout kind="warn" title="Bucket queries read up to 50,000 rows per file">
        A bucket query is not pushed down. The referenced files are read up to a per-file cap and
        the query runs locally, so a filter does not reduce what is fetched. When a file hits that
        cap the Workbench says which one, because the answer is then over a prefix of the file
        rather than all of it — narrow the source data, or use a warehouse connection, if you need a
        query over more than that.
      </Callout>
      <Callout kind="why" title="Why bucket SQL does not run against the bucket">
        The engine that can reach <C>s3://</C> needs network access, and DuckDB offers no setting
        that grants that while denying the local filesystem — so an engine able to read your bucket
        could also read the server&rsquo;s own files. Your SQL therefore runs in the sandboxed
        engine over rows fetched for it, and only queries the platform composes itself ever reach
        the networked one. That is also why a query naming a file the catalog has not crawled is
        refused by name rather than attempted.
      </Callout>

      <Callout kind="warn" title="Create a read-only user">
        Every connector above will happily accept an admin credential. Don't give it one — the
        platform only ever issues <C>SELECT</C>, so a read-only role loses you nothing and bounds
        the blast radius of a leaked secret.
      </Callout>

      <H3 id="direct-vs-import">Direct query vs import</H3>
      <Table
        headers={["Mode", "Freshness", "Cost", "Use for"]}
        rows={[
          [
            "Direct query",
            "Always current",
            "A round trip to the source per query",
            "Operational checks; data that changes minute to minute",
          ],
          [
            "Import (snapshot)",
            "As of the last refresh",
            "Cheap and fast to re-query",
            "Dashboards many people open; anything charted repeatedly",
          ],
        ]}
      />

      {/* ── SHARING ── */}
      <H2 id="sharing">Sharing a connection with your team</H2>
      <P>
        A connection belongs to whoever created it. Rather than every analyst creating their own —
        several copies of one credential, each rotated separately, each a place it can leak — a
        superadmin can share it under <strong>Admin → IAM → Access</strong>, to a user or a group,
        as either a <strong>Database / warehouse connection</strong> or an{" "}
        <strong>App source</strong>.
      </P>
      <P>
        <strong>A shared connection runs as its owner.</strong> The credential <em>is</em> the
        connection — a grantee has none of their own — so the owner's credential is decrypted
        server-side and the query runs against the owner's warehouse. A grantee can query it, test
        it and see its health; they cannot see the credential, edit it or delete it.{" "}
        <C>{`{{secret:NAME}}`}</C> references resolve as the owner, never against the grantee's own
        vault. A grantee cannot use it in an <DocLink to="/docs/etl">ETL pipeline</DocLink>, whose
        code would receive the credential: pipelines run only on connections their owner owns.
      </P>
      <Callout kind="warn" title="Revocation takes effect on the next use">
        Grants are resolved fresh on every call, including scheduled refreshes, so nothing keeps
        working off a cached grant. Equally, a shared connection is a live dependency: revoking it
        stops the grantee's dashboards refreshing.
      </Callout>
      <P>
        A shared <strong>app source</strong> syncs as its owner, into the owner's datasets — so a
        teammate who notices stale data can re-run it and refresh the real datasets rather than
        building a parallel copy under their own account. The audit entry records both who triggered
        it and whose data moved. Sharing the source lets someone keep it healthy; to let them read
        the resulting data, share those datasets too.
      </P>

      {/* ── APPS ── */}
      <H2 id="apps">Apps — SaaS sources</H2>
      <P>
        Databases are <strong>queried in place</strong>. Apps have no query language, so they are{" "}
        <strong>pulled into datasets</strong> instead: <strong>Integrations → Apps</strong> →
        connect, discover what is in there, choose what to sync. Each stream becomes its own dataset
        and is then indistinguishable from an uploaded CSV — same type inference, same version
        history, same use in BI, prep flows and the semantic layer.
      </P>
      <Table
        headers={["App", "Auth", "Streams"]}
        rows={[
          [
            "Google Sheets",
            "Service-account JSON",
            "One dataset per worksheet. Share the sheet with the key's client_email, or Google returns 403 however valid the key is.",
          ],
          [
            "Stripe",
            "Secret or restricted key",
            "Charges, customers, invoices, subscriptions, payment intents, products, prices, refunds, payouts, balance transactions",
          ],
          [
            "Shopify",
            "Admin API access token",
            "Orders, customers, products, draft orders, price rules",
          ],
          [
            "HubSpot",
            "Private app token",
            "Contacts, companies, deals, tickets, line items, products",
          ],
          [
            "Salesforce",
            "Connected app (client credentials)",
            "Accounts, contacts, leads, opportunities, cases, campaigns, users",
          ],
        ]}
      />
      <P>
        Auth is a pasted credential, never OAuth: a redirect flow needs a public callback URL that a
        self-hosted deployment behind a firewall may not have, so each connector uses the vendor's
        server-to-server credential instead.
      </P>
      <P>
        Syncs run on demand or hourly / daily / weekly, and you are notified if one fails or comes
        back partial. <strong>Preview</strong> beside each stream shows its first rows before you
        sync, for every app.
      </P>

      <H3 id="apps-rest">Any REST API</H3>
      <P>
        For an API with no connector of its own, describe one in JSON: one https address, where the
        key goes (bearer, a header, basic or a query parameter, optionally only when there is a
        key), and one stream per list with its path, where the records are in the response, how to
        ask for the next page (page numbers, offsets, a cursor, a next URL or a Link header) and,
        where the API can, how to ask for what changed since the last sync. It then syncs like any
        app. <strong>Start from</strong> offers templates (GitHub repository, run against the live
        API; Pipedrive and Mailchimp, built from their published references and not yet run against
        a live account here), and the form checks the JSON as you type.
      </P>
      <UL>
        <li>
          <strong>One host.</strong> Every request stays on the connector&apos;s host, including a
          next page the API names, and the key is sent only there.
        </li>
        <li>
          <strong>No secrets inside it.</strong> The key is picked from your secrets; a connector
          that puts it in a header or a parameter is refused, and it cannot set Authorization, Host
          or Cookie itself.
        </li>
        <li>
          <strong>Bounded.</strong> At most <C>max_pages</C> pages per stream per sync (500 by
          default), and a sync stops if the API hands back the same next page twice.
        </li>
        <li>
          <strong>Adding a template</strong> is two files, no code:{" "}
          <C>npm run connector:new -- &lt;id&gt;</C>, then <C>npm run connector:check</C> against a
          real account before it is marked as run live. The database needs migration{" "}
          <C>20261125000000</C>.
        </li>
      </UL>

      <H3 id="apps-incremental">Following a source instead of re-reading it</H3>
      <P>
        A sync does one of two things, and the <strong>Streams</strong> button on a connection says
        which for every stream it syncs.
      </P>
      <P>
        <strong>Full refresh</strong> re-reads the source and replaces the dataset — the right
        semantic where rows are edited and deleted in place with nothing to filter on, because an
        append would resurrect deleted rows for ever. The previous contents are snapshotted as a
        restorable version first, so a sync that pulls a truncated source is recoverable.
      </P>
      <P>
        <strong>Incremental</strong> asks the API for records changed since the last sync and folds
        them into the dataset by key. Salesforce, Shopify, HubSpot, Jira, ServiceNow and GitHub
        follow every stream they offer, as do Linear and Asana; Stripe follows its six immutable
        object types; Zendesk follows tickets and users; Intercom follows contacts and
        conversations; Freshdesk follows tickets and contacts; Klaviyo and Notion follow everything
        they offer, and GA4 follows every report on its date. Everything else is a full refresh —
        Zendesk has no incremental export for organizations, Intercom none for admins, Freshdesk
        none for companies or agents, and neither a Google Sheets worksheet nor an Airtable table
        has a timestamp to follow at all.
      </P>
      <Callout kind="why" title="GA4 is measured, not fetched">
        Every other app source syncs records. GA4 has none: you ask for dimensions and metrics over
        a date range and get aggregated rows back. So a stream is a report, the cursor is a date,
        and the key is the dimension tuple. GA4 also <strong>restates recent days</strong> as late
        data arrives, so each run re-reads the previous fortnight and replaces those days — trusting
        the first figure would leave a dashboard permanently understated with nothing to show for
        it.
      </Callout>
      <Callout kind="warn" title="Each API is asked in its own dialect">
        Jira and ServiceNow page by offset, so both are ordered oldest-first: newest-first meant a
        record edited mid-sync shifted every later page down one and a row was skipped per edit.
        HubSpot&apos;s list endpoint cannot filter by date at all, so following it means searching —
        and search stops paging at 10,000 results, so the query is reissued from the last timestamp
        rather than paged further. Zendesk&apos;s export walks a time-ordered log where an empty
        page is a quiet hour, not the end. Intercom&apos;s cursor is Unix seconds and compares
        numerically, because as text &ldquo;9…&rdquo; beats &ldquo;10…&rdquo;.
      </Callout>
      <Callout kind="why" title="Why some Stripe objects are deliberately not followed">
        <C>customers</C>, <C>subscriptions</C>, <C>products</C> and <C>prices</C> are edited in
        place while their <C>created</C> never moves, so following it would miss every edit. They
        are few enough that re-reading costs little, and correctness is worth more than the saving.
        Salesforce follows <C>SystemModstamp</C> rather than <C>LastModifiedDate</C> for the same
        reason: LastModifiedDate reflects user edits only, while SystemModstamp also moves on a
        merge, a cascade or a bulk update.
      </Callout>
      <P>
        The first pass has no high-water mark, so it reads everything and <strong>replaces</strong>:
        merging a full read into a stale dataset would leave rows the source has since deleted, for
        ever. The mark is written only after the rows are committed — advanced first and then lost
        to a failed sync, the next run would skip that whole window and nothing would say so.
      </P>

      <H3 id="apps-start-over">Starting a stream over</H3>
      <P>
        <strong>Streams → Start over</strong> forgets the high-water mark, so the next sync reads
        that stream in full. It is the escape hatch for what a cursor cannot see: records the API
        changed without moving their cursor field, or a backfill predating the connection.
      </P>
      <Callout kind="warn" title="Starting over is the owner's to decide">
        Unlike triggering a sync, it is owner-only and written to the audit log. A full re-read is
        charged to the owner&apos;s API quota and can take hours on a large account, so somebody the
        source is shared with cannot spend that on their behalf.
      </Callout>

      {/* ── RELIABILITY ── */}
      <H2 id="reliability">Staying connected</H2>
      <P>
        Three things run underneath every connection without being asked for. All are tunable by
        whoever runs the instance — see <DocLink to="/docs/self-hosting">self-hosting</DocLink>.
      </P>
      <Table
        headers={["", "What happens", "What you see"]}
        rows={[
          [
            <strong key="a">Health checks</strong>,
            <>
              Every connection is re-tested on a schedule with the same probe the{" "}
              <strong>Test</strong> button uses. A warehouse password that expires on your
              company&rsquo;s rotation policy is found by us, not by a dashboard erroring in front
              of a customer.
            </>,
            <>
              A <em>Failing</em> badge in Integrations, one notification when it breaks and one when
              it recovers — not one per check.
            </>,
          ],
          [
            <strong key="b">Credential age</strong>,
            <>
              How long ago the stored secret was entered. Re-saving a connection resets it; a health
              check does not.
            </>,
            <>
              An <em>&ldquo;N d old&rdquo;</em> badge once it passes the policy age (90 days by
              default). Advisory — <strong>nothing expires or stops working</strong>.
            </>,
          ],
          [
            <strong key="c">Retries</strong>,
            <>
              A rate limit or a brief outage from a provider is retried with backoff rather than
              failed. Retries are always reads, so nothing can be double-written.
            </>,
            <>Nothing — that is the point. A tile that would have errored simply loads.</>,
          ],
        ]}
      />
      <Callout kind="info" title="Behind a corporate proxy?">
        If your network has no direct route to the internet, the person running the instance sets{" "}
        <C>HTTPS_PROXY</C> and <C>NO_PROXY</C> and every connector follows them. Without it,
        reaching Snowflake or Stripe fails as a connection timeout rather than anything that names
        the real cause — so it is worth checking first if a connector that should work does not.
      </Callout>

      {/* ── CATALOG ── */}
      <H2 id="catalog">The catalog</H2>
      <Table
        headers={["Feature", "What it gives you"]}
        rows={[
          [
            "Column profiles",
            "Row counts, null rates, distinct values, min/max per column — the fastest way to spot a column that is 90% empty before charting it.",
          ],
          [
            "AI descriptions",
            "Generated plain-English descriptions for tables and columns. Agents read these too, so a described catalog measurably improves tool choice. AI docs in the asset drawer writes the description and leaves the owner, status and tags you are editing as they are; Save keeps them.",
          ],
          [
            "Lineage",
            "What a dataset came from and what depends on it — prep flows, dashboards, metrics, and the ML models that train on a lakehouse table, score it or write predictions into it — down to the column: which source columns fed each column of a pipeline's target or a SQL model, with steps the tracer cannot read marked. Check before changing or deleting anything.",
          ],
          [
            "Business glossary",
            'Define terms once ("active customer") and attach them to columns so the definition travels with the data.',
          ],
          [
            "Column tags",
            "Tag a column pii or a table restricted in the asset drawer, and a lakehouse tag policy masks or filters it everywhere the tag appears — one rule, not one per table.",
          ],
          [
            "Change detection",
            "Scheduled crawls report new, changed and removed columns, so an altered upstream schema surfaces as a change rather than a broken dashboard.",
          ],
          ["Owner & status", "Who owns it and when it was last crawled."],
        ]}
      />
      <P>
        <strong>Query data</strong> on any dataset opens it in the workbench with the table loaded.
      </P>

      <H2 id="dataset-page">A dataset&apos;s page</H2>
      <P>
        Every dataset stored here has a page of its own, at <C>/data-sql/&lt;id&gt;</C>: search, My
        work and a dataset&apos;s link all open it, and <strong>Open its page</strong> in the
        catalog&apos;s drawer does too. It starts with one plain verdict and the facts it rests on:
        how long ago its rows were last loaded (against its own freshness check when it has one,
        otherwise a day), whether its checks pass, where its rows come from, and how many things of
        yours are built on it. There is no score: the facts are short enough to read.
      </P>
      <Table
        headers={["Tab", "What it shows", "Who sees it"]}
        rows={[
          [
            "Overview",
            "The verdict; which columns look personal and, for the owner, who else can read them; where its rows come from (an upload, a warehouse copy, a synced connection, or the data-prep flow that writes it and how often that flow refreshes it); and what uses it: dashboards, semantic models, AI analysts and agents that name it, data-prep flows, saved metrics, and how many analysts and agents read every dataset of yours.",
            "Everyone who can open it; the source is the owner's",
          ],
          ["Sample", "The first 100 rows, as the reader may see them.", "Everyone"],
          [
            "Columns",
            "What each column holds, read from the first 500 rows: numbers, dates, text or true/false, whether it looks personal, how many are empty, how many different values, the range, the most common values.",
            "Everyone",
          ],
          [
            "Checks and versions",
            "Its data-quality checks and freshness check, and the versions kept before each overwrite, with restore.",
            "Owner",
          ],
          [
            "Schema changes",
            "Columns added and removed between the kept versions and today.",
            "Owner",
          ],
          [
            "Access",
            "For the owner: every grant on it — the person or group (and how many are in the group), the rows it allows, the columns it hides, and who gave it when. For someone it is shared with: whether their access leaves out rows or columns, never which.",
            "Owner, and whoever it is shared with",
          ],
        ]}
      />
      <P>
        Grants are made by an administrator under Admin → IAM → Access; the page shows them, and the
        one change it makes to them is hiding personal columns (below). <strong>Query</strong> opens
        the workbench with a first query on the dataset written and run, and the owner&apos;s{" "}
        <strong>Delete</strong> lists what would break first, as everywhere else.
      </P>

      <H3 id="personal-data">Personal data</H3>
      <P>
        The page says which columns look personal, and how it knows. Where a column&apos;s values
        have a shape, the values decide: email addresses, phone numbers, payment card numbers (with
        their checksum), ID numbers, bank account numbers (IBAN, with its checksum), IP addresses
        and keys or tokens. A column named <C>contact</C> full of email addresses is found, and one
        named <C>email_campaign_id</C> full of numbers is not. Where values have no shape to check
        (people&apos;s names, postal addresses, dates and places of birth, pay, gender, passwords
        and their hashes), the column&apos;s name decides. A text column that only mentions an email
        address, a card number, an ID or a key now and then is found too. Each finding says what it
        rests on: &quot;48 of 50 values are email addresses&quot;, or &quot;Its name suggests
        people&apos;s names&quot;. The patterns are the ones the guardrails redact from chat with.
      </P>
      <P>
        A name&apos;s last word says what the column holds. A column named for something personal
        but ending in a key, a time or a description of it holds none of it: <C>address_id</C>,{" "}
        <C>email_confirmed_at</C>, <C>phone_type</C> and <C>is_email_verified</C> are not marked.
        Some keys are the data, and stay marked: a date key such as <C>birth_date_sk</C>, a key to a
        gender or a country of birth, and <C>email_id</C>, which in common usage is the address
        itself (ten values without an @ overrule it). A column whose values are all true or false
        holds no name, address or password, whatever it is called. The name check is held to the
        columns of public sample schemas, every column of each table.
      </P>
      <P>
        For the owner, each personal column also says how many of the dataset&apos;s grants can read
        it. <strong>Hide from shares…</strong> hides the columns you choose from every grant on the
        dataset: the people it is shared with stop seeing them wherever they read it, and you still
        see everything. It only ever takes something away, which is why the owner may do it to a
        grant an administrator made; an administrator can show a column again under Admin → IAM →
        Access. Every change is audited.
      </P>
      <Callout title="Asked in your approvals">
        A few times a day the scheduler looks at every shared dataset. When a personal column can be
        read through a grant, its owner gets a suggestion in the approvals inbox, and a
        notification, naming the columns and what they hold. Approving hides them from every grant
        on the dataset, through the same action as the button, checked against who owns the dataset
        rather than what the suggestion says. Rejecting leaves the shares as they are, and you are
        not asked about those columns again. Lakehouse tables shared outside the platform are
        checked the same way:{" "}
        <DocLink to="/docs/lakehouse#share-personal-data">personal data in a share</DocLink>.
      </Callout>

      {/* ── WORKBENCH ── */}
      <H2 id="workbench">SQL workbench</H2>
      <P>
        Write SQL against anything connected. Results can be charted, added to a{" "}
        <DocLink to="/docs/bi">dashboard</DocLink>, or exported to CSV/Excel.
      </P>
      <Code lang="sql">{`-- Monthly revenue and order count for the last 12 months
SELECT date_trunc('month', o.created_at) AS month,
       COUNT(*)                          AS orders,
       SUM(o.amount)                     AS revenue
FROM   orders o
WHERE  o.status = 'settled'
  AND  o.created_at >= current_date - INTERVAL '12 months'
GROUP  BY 1
ORDER  BY 1;`}</Code>
      <UL>
        <li>
          <strong>Ask in English</strong> — describe the question and the assistant writes the SQL.
          Read it before running: it shows you exactly which join and filter the answer depends on.
        </li>
        <li>
          <strong>Results are capped</strong> for display, with the true match count shown, so a
          runaway query cannot hang the page.
        </li>
      </UL>

      <H3 id="workbench-engine">Which engine runs your SQL</H3>
      <P>
        Queries against a <strong>connected warehouse</strong> run on that warehouse. Queries
        against <strong>uploaded tables and prepared datasets</strong> run on{" "}
        <strong>DuckDB</strong> — in your browser for the workbench and Ask&nbsp;AI, and on the
        server for scheduled refreshes, prep flows and agent tools.
      </P>
      <Callout kind="why">
        It is the <em>same</em> engine in both places, which is the point. Local queries used to run
        on a different in-browser engine that lacked window functions, so a question like
        &ldquo;what percentage of total sales does each region account for?&rdquo; could return a
        different answer in the workspace than on a schedule — and did so <em>silently</em>: a
        running total came back as zero for every row rather than erroring. Window functions, CTEs
        and correlated subqueries all work now, and they behave identically wherever they run. Every
        engine also runs in <strong>UTC</strong>, whatever your browser&apos;s or the server&apos;s
        time zone, so <code>current_date</code> and a timestamp cast to a date name the same day in
        the workbench as on a schedule. Dates and timestamps come back written the same way from
        both, <code>2022-01-04</code> and <code>2022-01-01 00:00:00</code>, in the results grid and
        in exports. Both are the same DuckDB build, 1.5.5, as is the sandbox image&apos;s Python
        DuckDB, and a test holds them to one release and the same result types, so{" "}
        <code>date_trunc</code> on a timestamp is a timestamp in both, and a chart draws the same
        axis from either.
      </Callout>
      <H3 id="workbench-first-query">The first query in a session is slower</H3>
      <P>
        The engine is WebAssembly — roughly <strong>8 MB</strong>, fetched once and then cached by
        your browser for every later visit. You will see{" "}
        <strong>&ldquo;Starting the SQL engine…&rdquo;</strong> with a progress bar while that
        happens.
      </P>
      <UL>
        <li>
          It starts <strong>as soon as you open a data page</strong>, not when you press Run, so it
          usually finishes while you are still choosing a table.
        </li>
        <li>
          Your datasets are loaded into it the same way. A query run before they are all in waits
          for them, so it answers over every row rather than the ones loaded so far, and never says
          a table that is on its way does not exist. Its time includes that wait.
        </li>
        <li>
          It downloads <strong>once per browser</strong>, not per query, per dataset or per tab.
        </li>
        <li>
          It is served <strong>from your own deployment</strong>, never a CDN — so an air-gapped
          install works, and no third party sees that you loaded it.
        </li>
      </UL>
      <Callout kind="info" title="If it never finishes">
        A Content-Security-Policy or corporate proxy that blocks WebAssembly or web workers will
        stop it loading, and the strip says so rather than leaving Run looking broken. Open{" "}
        <DocLink to="/engine-check">/engine-check</DocLink> — it reports which stage failed and
        which build your browser selected, which is normally enough for whoever administers the
        policy to fix it.
      </Callout>

      <H2 id="query-history">Query history</H2>
      <P>
        <strong>Data engineering → Query history</strong> lists every query run for you, not only
        the ones you typed: the workbench, and the dashboards, agents, the AI Analyst, schedules,
        data monitors, metrics, sheets and data prep that ran one on your behalf. Each says what it
        was for, which engine and connection ran it, how long it took, how many rows came back, how
        much data the engine read where it says, and what it cost. Totals for the period sit at the
        top; filter by source, engine or failed queries, search the SQL, or sort by cost, time or
        data read. <em>Open in workbench</em> writes a query into the editor with its source chosen,
        without running it, since running a warehouse query again costs again.
      </P>
      <Table
        headers={["Engine", "What is recorded about cost"]}
        rows={[
          [
            "Athena",
            "Bytes scanned, priced at $5 per TB with a 10 MB minimum, unless your server sets QUERY_COST_ATHENA_USD_PER_TB",
          ],
          [
            "BigQuery",
            "Bytes processed, and the bytes billed priced at $6.25 per TiB on demand (QUERY_COST_BIGQUERY_USD_PER_TIB); a cached answer bills nothing",
          ],
          [
            "Trino",
            "Bytes processed, and the engine's query id; no amount, as Trino has no price per query",
          ],
          [
            "Lakehouse",
            "Time and rows, and the model cost of any ai_* functions the statement called",
          ],
          [
            "Other warehouses, the local engine, your browser",
            "Time and rows; these are billed by the hour or not at all, so no amount is made up",
          ],
        ]}
      />
      <P>
        An amount is an estimate at the price shown beside it, and the price used is kept with the
        query, so a later change of price does not rewrite last month. The server alone writes the
        history: you can read yours, and no one can edit or delete what a query cost. A query that
        runs for nobody in particular (a catalog crawl, a connection test) is not in anyone&apos;s.
        It is kept as long as runs and traces are (Admin → IAM → Settings, trace retention).
      </P>
      <Note>
        Query history needs migrations <C>20261127000000</C> and <C>20261128000000</C> on the
        database. Until they are applied, the page says so and nothing else changes.
      </Note>

      {/* ── AGENTS ── */}
      <H2 id="agent-access">Giving an agent access</H2>
      <Steps
        items={[
          {
            title: "Open the agent → Tools",
            body: (
              <>
                Enable <C>sql_query</C>. Also enable <C>calculator</C> — see the warning below.
              </>
            ),
          },
          {
            title: "Set Allowed tables",
            body: "Only tables in this list are visible to the agent. Leaving it empty means sql_query has nothing to query.",
          },
          {
            title: "Mention the data in the system prompt",
            body: (
              <>
                e.g.{" "}
                <em>
                  "Use sql_query for anything involving counts, totals or dates. Never estimate a
                  number you could compute."
                </em>
              </>
            ),
          },
          {
            title: "Test with a counting question",
            body: "Ask for a total. Check the sources under the answer name the table — if they name a document instead, it answered from prose.",
          },
        ]}
      />
      <P>
        At run time the agent sees each table's name, columns and a small sample of rows, writes a{" "}
        <C>SELECT</C>, and gets real rows back.
      </P>
      <Callout kind="warn" title="Read-only, and scoped to you">
        Only <C>SELECT</C> is accepted — writes and DDL are rejected before execution. Queries run
        under your identity and row-level security, so an agent cannot read a table you cannot. When
        an agent runs for an anonymous embed visitor it is explicitly scoped to the owner's data.
      </Callout>

      {/* ── TROUBLESHOOTING ── */}
      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["Symptom", "Cause", "Fix"]}
        rows={[
          [
            '"Table does not exist"',
            "Not in Allowed tables, or the agent guessed a name",
            "Add it to Allowed tables; rename cryptic tables; add AI descriptions.",
          ],
          [
            "It queried the wrong table",
            "Two similar names, no descriptions",
            "Generate AI descriptions — they are what the model disambiguates on.",
          ],
          [
            "Date filters do nothing",
            "Column imported as text",
            "Change the column type on the table to date.",
          ],
          [
            "Athena connection fails",
            "No query result location",
            <>
              Set <C key="o">output_location</C> to an S3 prefix, or configure one on the workgroup.
            </>,
          ],
          [
            "Managed Postgres refuses to connect",
            "TLS not enabled",
            <>
              Set <C key="s">ssl</C> to <C key="r">require</C>.
            </>,
          ],
          [
            "Snowflake auth fails",
            "Using a password",
            "This connector expects a programmatic access token (PAT), not your account password.",
          ],
          [
            "Connector test fails on a private host",
            "Outbound guard",
            <>
              Requests to private and link-local addresses are refused. The database must be
              reachable from wherever the app runs — see{" "}
              <DocLink key="s" to="/docs/self-hosting">
                Install &amp; deploy
              </DocLink>
              .
            </>,
          ],
          [
            "Agent totals are wrong",
            "It did arithmetic itself",
            "Enable the calculator tool and set temperature to 0.",
          ],
        ]}
      />

      <H2 id="use-cases">Use cases</H2>
      <H3 id="use-case-warehouse">The production warehouse, handed to the team</H3>
      <Steps
        items={[
          {
            title: "Integrations → Data sources → new connection",
            body: (
              <>
                Name it, pick the provider, enter a read-only login, test. The credential is
                encrypted at rest under <C>PROVIDER_CREDS_SECRET</C> and never shown again.
              </>
            ),
          },
          {
            title: "Admin → IAM → Access → share it with a group",
            body: "The connection runs as its owner; grantees query without ever holding the credential. Rows returned to an agent are capped, so a runaway SELECT * cannot flood a context window.",
          },
        ]}
      />
      <H3 id="use-case-azure">Catalog an Azure container</H3>
      <Steps
        items={[
          {
            title: "Data catalog → add a source → Azure Blob Storage / ADLS Gen2",
            body: "Container, storage account name, and an account key or SAS token.",
          },
          {
            title: "Read in place, or mount",
            body: (
              <>
                Files are read with DuckDB over <C>az://</C>; mount the container into the lakehouse
                as a read-only source when agents should query it with SQL.
              </>
            ),
          },
        ]}
      />
      <H3 id="use-case-jira">Ask an agent about Jira, or Zendesk</H3>
      <Steps
        items={[
          {
            title: "Integrations → Apps → Jira",
            body: (
              <>
                Site URL, account email, API token, optional project keys. Each project becomes a
                stream (<C>issues:KEY</C>) that syncs into a local table on a schedule. Zendesk
                works the same way and exposes tickets, users and organizations.
              </>
            ),
          },
          {
            title: "Give an agent the synced tables as a source",
            body: "Which open bugs in PROJ are older than thirty days? The answer comes from your copy of the data, on your schedule, with the same provenance as any other read.",
          },
        ]}
      />

      <NextPrev current="/docs/data" />
    </>
  );
}
