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
        description="Everything tabular: uploaded files, 22 databases and warehouses, 5 app sources, the catalog that describes them, and the workbench that queries them."
      />

      <P>
        Open <strong>Data → Data Catalog</strong>.
      </P>

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
        Configure these under <strong>Integrations → Data Sources → Add connection</strong>. Every
        connector has a <strong>Name</strong> (your label) and a <strong>Test connection</strong>{" "}
        button; the last test result and its error are kept on the connection so you can see when it
        started failing. All secrets are encrypted at rest and never returned to the browser.
      </P>
      <Callout kind="info">
        Any field below can be filled from <DocLink to="/docs/secrets">Secrets</DocLink> instead of
        being typed in, so rotating a password is one edit rather than a hunt through every
        connection.
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

      <Callout kind="info" title="Nine more databases use exactly the fields above">
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

      <H3 id="c-other">Object stores and lakehouse catalogs</H3>
      <P>
        S3, GCS and compatible endpoints are added as <strong>catalog sources</strong> rather than
        query connections — they are crawled and their files registered as datasets. Iceberg REST
        and Unity Catalog are connected for metadata. Both are configured through{" "}
        <strong>Data Catalog → Add source</strong>.
      </P>

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
        vault.
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
      <Callout kind="warn" title="A sync replaces its dataset">
        That is the right semantic for a source whose rows are edited and deleted in place — an
        append would resurrect deleted rows for ever. The previous contents are snapshotted as a
        restorable version first, so a sync that pulls a truncated source is recoverable. Syncs run
        on demand or hourly / daily / weekly, and you are notified if one fails or comes back
        partial.
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
            "Generated plain-English descriptions for tables and columns. Agents read these too, so a described catalog measurably improves tool choice.",
          ],
          [
            "Lineage",
            "What a dataset came from and what depends on it — prep flows, dashboards, metrics. Check before changing or deleting anything.",
          ],
          [
            "Business glossary",
            'Define terms once ("active customer") and attach them to columns so the definition travels with the data.',
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
        and correlated subqueries all work now, and they behave identically wherever they run.
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

      <NextPrev current="/docs/data" />
    </>
  );
}
