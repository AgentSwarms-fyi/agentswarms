// "Data Sources" tab of the Integration Hub. The provider list comes from
// WAREHOUSE_PROVIDERS, so adding a connector there makes it appear here —
// this file only supplies each one's description and connection fields.
// Credentials are encrypted server-side and never come back to the client;
// queries run through /api/warehouse/* and the warehouse agent tools.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Loader2, Plug2, Trash2, Unplug, X } from "lucide-react";

// Official provider marks, used nominatively to identify each integration.
// Sources: Simple Icons (CC0) for Snowflake / Databricks / BigQuery;
// Wikimedia Commons for Amazon Redshift; Microsoft's Azure architecture
// icon set for Synapse.
//
// These explicit imports exist only because their filenames predate the
// convention. ANY NEW LOGO IS A FILE DROP — see src/assets/README.md for the
// naming contract, the list of providers still showing initials, and the
// licence check to do before bundling a mark.
import redshiftLogo from "@/assets/warehouses/redshift.svg";
import snowflakeLogo from "@/assets/warehouses/snowflake.svg";
import databricksLogo from "@/assets/warehouses/databricks.svg";
import bigqueryLogo from "@/assets/warehouses/bigquery.svg";
import synapseLogo from "@/assets/warehouses/synapse.svg";
import postgresLogo from "@/assets/warehouses/postgres.svg";
import mysqlLogo from "@/assets/warehouses/mysql.svg";
import trinoLogo from "@/assets/warehouses/trino.svg";
import athenaLogo from "@/assets/warehouses/athena.svg";
import oracleLogo from "@/assets/warehouses/oracle.svg";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CredentialAgeBadge } from "@/components/integrations/ConnectionHealthBadges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import {
  WAREHOUSE_LABELS,
  WAREHOUSE_PROVIDERS,
  type WarehouseConnectionSummary,
  type WarehouseProvider,
} from "@/utils/warehouse/types";
import {
  deleteWarehouseConnection,
  listWarehouseConnections,
  saveWarehouseConnection,
  testWarehouseConnectionFn,
} from "@/utils/warehouse.functions";

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  type?: "password" | "textarea";
  optional?: boolean;
  hint?: string;
};

/**
 * Bundled logos. PARTIAL ON PURPOSE — a provider without one falls back to a
 * lettered tile, so adding a connector never blocks on sourcing a trademarked
 * image this project may not have the right to redistribute.
 *
 * (This used to name MIT as the project's licence. It is Elastic License 2.0 —
 * and a comment about redistribution rights is the last place to get that
 * wrong. docsFactCheck now fails on a self-reference to the old licence.)
 */
const PROVIDER_LOGOS: Partial<Record<WarehouseProvider, string>> = {
  redshift: redshiftLogo,
  snowflake: snowflakeLogo,
  databricks: databricksLogo,
  bigquery: bigqueryLogo,
  azure_synapse: synapseLogo,
  postgres: postgresLogo,
  mysql: mysqlLogo,
  trino: trinoLogo,
  athena: athenaLogo,
  oracle: oracleLogo,
};

/**
 * Any logo dropped into the assets directory, keyed by filename.
 *
 * DROP IN `src/assets/warehouses/<provider>.svg` AND IT APPEARS — no code
 * change. The hand-written map above is exactly why twelve providers added in
 * one commit had none: nobody edits a lookup table in a component file when
 * adding a connector, and nothing fails if they do not.
 */
const LOGO_FILES = import.meta.glob<{ default: string }>("../../assets/warehouses/*.svg", {
  eager: true,
});

function logoFor(provider: WarehouseProvider): string | null {
  const explicit = PROVIDER_LOGOS[provider];
  if (explicit) return explicit;
  const hit = Object.entries(LOGO_FILES).find(([path]) => path.endsWith(`/${provider}.svg`));
  return hit ? hit[1].default : null;
}

/**
 * Initials for a provider with no bundled logo.
 *
 * A single-word label takes its first TWO letters, not one: ClickHouse and
 * CockroachDB would otherwise render as two identical "C" tiles in the same
 * grid.
 */
export function providerInitials(label: string): string {
  const words = label
    .replace(/[^A-Za-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The logo tile, or the provider's initials when no logo is bundled. */
function ProviderMark({ provider }: { provider: WarehouseProvider }) {
  const logo = logoFor(provider);
  if (logo) {
    return (
      <img
        src={logo}
        alt={`${WAREHOUSE_LABELS[provider]} logo`}
        className="h-full w-full object-contain"
      />
    );
  }
  return (
    <span aria-hidden className="text-[11px] font-semibold tracking-tight text-muted-foreground">
      {providerInitials(WAREHOUSE_LABELS[provider])}
    </span>
  );
}

/**
 * Fields for a host/port provider.
 *
 * Generated rather than written out per provider: twelve hand-copied field
 * lists is twelve places for the SSL hint to drift, and the only thing that
 * legitimately differs between them is the default port.
 */
function hostPortFields(defaultPort: number, dbPlaceholder?: string): Field[] {
  return [
    { key: "host", label: "Host", placeholder: "db.example.com" },
    { key: "port", label: "Port", placeholder: String(defaultPort), optional: true },
    { key: "database", label: "Database", placeholder: dbPlaceholder },
    { key: "username", label: "Username" },
    { key: "password", label: "Password", type: "password" },
    {
      key: "ssl",
      label: "SSL",
      optional: true,
      placeholder: "require",
      hint: 'Set to "require" for managed hosts (TLS without CA verification).',
    },
  ];
}

const READ_ONLY_NOTE = "Use a read-only role — only SELECT statements are ever sent.";

const PROVIDER_META: Record<
  WarehouseProvider,
  { description: string; fields: Field[]; note?: string }
> = {
  // ── PostgreSQL wire protocol ──────────────────────────────────────────
  cockroachdb: {
    description:
      "Distributed SQL, Postgres-compatible. Works with Cockroach Cloud and self-hosted.",
    fields: hostPortFields(26257, "defaultdb"),
    note: READ_ONLY_NOTE,
  },
  timescaledb: {
    description: "PostgreSQL for time-series. Works with Timescale Cloud and self-hosted.",
    fields: hostPortFields(5432, "tsdb"),
    note: READ_ONLY_NOTE,
  },
  alloydb: {
    description:
      "Google Cloud's PostgreSQL-compatible database. Connect via its private or public IP.",
    fields: hostPortFields(5432, "postgres"),
    note: READ_ONLY_NOTE,
  },
  greenplum: {
    description: "Massively parallel PostgreSQL-derived warehouse.",
    fields: hostPortFields(5432, "gpadmin"),
    note: READ_ONLY_NOTE,
  },
  yugabytedb: {
    description: "Distributed SQL with a PostgreSQL-compatible API (YSQL).",
    fields: hostPortFields(5433, "yugabyte"),
    note: READ_ONLY_NOTE,
  },

  // ── MySQL wire protocol ───────────────────────────────────────────────
  mariadb: {
    description: "MariaDB server or SkySQL, over the MySQL wire protocol.",
    fields: hostPortFields(3306),
    note: READ_ONLY_NOTE,
  },
  singlestore: {
    description: "SingleStore (formerly MemSQL), real-time analytics over the MySQL protocol.",
    fields: hostPortFields(3306),
    note: READ_ONLY_NOTE,
  },
  starrocks: {
    description: "StarRocks MPP analytics engine. Connect to the FE query port.",
    fields: hostPortFields(9030),
    note: READ_ONLY_NOTE,
  },
  doris: {
    description: "Apache Doris MPP analytics engine. Connect to the FE query port.",
    fields: hostPortFields(9030),
    note: READ_ONLY_NOTE,
  },
  planetscale: {
    description: "PlanetScale serverless MySQL. Use a branch password from the dashboard.",
    fields: hostPortFields(3306),
    note: 'PlanetScale requires TLS — set SSL to "require".',
  },
  sqlserver: {
    description: "Microsoft SQL Server or Azure SQL Database, over TDS. Needs a Node deployment.",
    fields: [
      { key: "host", label: "Host", placeholder: "sql.example.com" },
      { key: "port", label: "Port", placeholder: "1433", optional: true },
      {
        key: "instance_name",
        label: "Named instance",
        placeholder: "SQLEXPRESS",
        optional: true,
        hint: "Only for a named instance. Leave the port blank when using this.",
      },
      { key: "database", label: "Database" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", type: "password" },
      {
        key: "ssl",
        label: "Encryption",
        optional: true,
        placeholder: "require",
        hint: 'Encrypted by default. Set to "disable" only for a legacy on-prem server.',
      },
      {
        key: "trust_server_certificate",
        label: "Trust server certificate",
        optional: true,
        placeholder: "true",
        hint: 'Set "true" for a self-signed on-prem certificate. Leave blank for Azure SQL.',
      },
    ],
    note: READ_ONLY_NOTE,
  },
  clickhouse: {
    description: "ClickHouse Cloud or self-hosted, over its HTTP interface.",
    fields: [
      {
        key: "url",
        label: "HTTP URL",
        placeholder: "https://abc.clickhouse.cloud:8443",
        hint: "Include the scheme and port. Self-hosted defaults to port 8123 (or 8443 for TLS).",
      },
      { key: "username", label: "Username", placeholder: "default" },
      { key: "password", label: "Password", type: "password", optional: true },
      { key: "database", label: "Database", placeholder: "default", optional: true },
    ],
    note: "Queries are sent with readonly=1, so the server refuses writes regardless.",
  },
  postgres: {
    description: "Connect any PostgreSQL database directly (Supabase, RDS, Neon, self-hosted).",
    fields: [
      { key: "host", label: "Host", placeholder: "db.example.com" },
      { key: "port", label: "Port", placeholder: "5432", optional: true },
      { key: "database", label: "Database", placeholder: "postgres" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", type: "password" },
      {
        key: "ssl",
        label: "SSL",
        optional: true,
        placeholder: "require",
        hint: 'Set to "require" for managed hosts (TLS without CA verification).',
      },
    ],
    note: "Use a read-only role — only SELECT statements are ever sent.",
  },
  mysql: {
    description: "Connect any MySQL or MariaDB database directly (RDS, PlanetScale, self-hosted).",
    fields: [
      { key: "host", label: "Host", placeholder: "mysql.example.com" },
      { key: "port", label: "Port", placeholder: "3306", optional: true },
      { key: "database", label: "Database" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", type: "password" },
      {
        key: "ssl",
        label: "SSL",
        optional: true,
        placeholder: "require",
        hint: 'Set to "require" for managed hosts (TLS without CA verification).',
      },
    ],
    note: "Use a read-only user — only SELECT statements are ever sent.",
  },
  oracle: {
    description:
      "Connect Oracle Database or Autonomous Database over ORDS REST SQL — HTTPS only, no wallet or client driver needed.",
    fields: [
      {
        key: "ords_url",
        label: "ORDS base URL",
        placeholder: "https://<id>-<db>.adb.<region>.oraclecloudapps.com/ords",
        hint: "Autonomous DB: Database Actions → copy the base URL up to /ords.",
      },
      {
        key: "username",
        label: "Database user",
        placeholder: "ANALYST",
        hint: "The REST-enabled schema's DB user (HTTP Basic auth).",
      },
      { key: "password", label: "Password", type: "password" },
      {
        key: "schema",
        label: "Schema alias",
        optional: true,
        hint: "URL path segment from ORDS.ENABLE_SCHEMA. Defaults to the lower-cased user.",
      },
    ],
    note: "Needs ORDS with the schema REST-enabled (Autonomous DB has ORDS on by default). Use a read-only user — only SELECT statements are ever sent.",
  },
  redshift: {
    description: "Query via the Redshift Data API — serverless workgroups or provisioned clusters.",
    fields: [
      { key: "region", label: "AWS region", placeholder: "us-east-1" },
      { key: "access_key_id", label: "Access key ID" },
      { key: "secret_access_key", label: "Secret access key", type: "password" },
      { key: "database", label: "Database", placeholder: "dev" },
      {
        key: "workgroup_name",
        label: "Workgroup (serverless)",
        optional: true,
        hint: "Fill this OR the cluster fields below.",
      },
      { key: "cluster_identifier", label: "Cluster identifier (provisioned)", optional: true },
      { key: "db_user", label: "DB user (provisioned)", optional: true },
    ],
    note: "The IAM user needs redshift-data:* and redshift:GetClusterCredentials (provisioned) permissions.",
  },
  snowflake: {
    description: "Query via the Snowflake SQL API with a programmatic access token.",
    fields: [
      { key: "account", label: "Account identifier", placeholder: "xy12345.eu-west-1" },
      {
        key: "token",
        label: "Programmatic access token",
        type: "password",
        hint: "Snowsight → your profile → Programmatic access tokens.",
      },
      { key: "warehouse", label: "Warehouse", placeholder: "COMPUTE_WH" },
      { key: "database", label: "Database" },
      { key: "schema", label: "Schema", optional: true },
      { key: "role", label: "Role", optional: true },
    ],
  },
  databricks: {
    description: "Query a Databricks SQL warehouse via the Statement Execution API.",
    fields: [
      { key: "host", label: "Workspace URL", placeholder: "https://dbc-xxxx.cloud.databricks.com" },
      {
        key: "warehouse_id",
        label: "SQL warehouse ID",
        hint: "SQL Warehouses → your warehouse → Connection details.",
      },
      { key: "token", label: "Personal access token", type: "password" },
      { key: "catalog", label: "Catalog", optional: true },
      { key: "schema", label: "Schema", optional: true },
    ],
  },
  bigquery: {
    description: "Query via the BigQuery REST API with a service-account key.",
    fields: [
      { key: "project_id", label: "Project ID" },
      {
        key: "service_account_json",
        label: "Service account key (JSON)",
        type: "textarea",
        hint: "IAM → Service accounts → Keys → JSON. Needs the BigQuery Job User + Data Viewer roles.",
      },
      { key: "location", label: "Location", placeholder: "US", optional: true },
      {
        key: "dataset",
        label: "Dataset (limit browsing)",
        optional: true,
        hint: "Leave empty to browse every dataset in the region.",
      },
    ],
  },
  azure_synapse: {
    description: "Query a dedicated SQL pool over TDS (SQL authentication).",
    fields: [
      { key: "server", label: "Server", placeholder: "myworkspace.sql.azuresynapse.net" },
      { key: "database", label: "Database (SQL pool)" },
      { key: "username", label: "SQL username" },
      { key: "password", label: "SQL password", type: "password" },
    ],
    note: "Speaks TDS via the `tedious` driver, which is loaded on demand.",
  },
  trino: {
    description:
      "Query a Trino, Starburst or Presto cluster over the HTTP protocol — the usual way to reach a raw Iceberg / Delta / Hive lakehouse.",
    fields: [
      { key: "host", label: "Coordinator host", placeholder: "trino.example.com" },
      {
        key: "port",
        label: "Port",
        placeholder: "443 (TLS) / 8080 (plain)",
        optional: true,
      },
      { key: "username", label: "User", placeholder: "analyst" },
      {
        key: "password",
        label: "Password",
        type: "password",
        optional: true,
        hint: "For Basic auth. Leave empty for anonymous coordinators.",
      },
      {
        key: "access_token",
        label: "JWT / OAuth2 token",
        type: "password",
        optional: true,
        hint: "Bearer token — takes precedence over the password (e.g. Starburst Galaxy).",
      },
      {
        key: "catalog",
        label: "Catalog",
        optional: true,
        placeholder: "iceberg",
        hint: "The lakehouse catalog to browse/query (iceberg, delta, hive…).",
      },
      { key: "schema", label: "Schema", placeholder: "default", optional: true },
      {
        key: "ssl",
        label: "TLS",
        optional: true,
        placeholder: "on",
        hint: 'Set to "disable" for a plain-HTTP coordinator; TLS is used otherwise.',
      },
    ],
    note: "Use read-only credentials — only SELECT statements are ever sent.",
  },
  athena: {
    description:
      "Query a Glue / Iceberg lakehouse through Amazon Athena — serverless SQL over data in S3.",
    fields: [
      { key: "region", label: "AWS region", placeholder: "us-east-1" },
      { key: "access_key_id", label: "Access key ID" },
      { key: "secret_access_key", label: "Secret access key", type: "password" },
      {
        key: "session_token",
        label: "Session token",
        type: "password",
        optional: true,
        hint: "Only for temporary (STS) credentials.",
      },
      { key: "database", label: "Database (Glue)", placeholder: "default", optional: true },
      {
        key: "output_location",
        label: "Results S3 location",
        placeholder: "s3://my-bucket/athena-results/",
        optional: true,
        hint: "Required unless the workgroup already sets one.",
      },
      { key: "workgroup", label: "Workgroup", placeholder: "primary", optional: true },
      { key: "catalog", label: "Data catalog", placeholder: "AwsDataCatalog", optional: true },
    ],
    note: "The IAM user needs athena:StartQueryExecution/GetQueryExecution/GetQueryResults, Glue read, and s3:GetObject/PutObject on the results location.",
  },
};

export function WarehousesTab() {
  const { session } = useAuth();
  const token = session?.access_token;

  const listFn = useServerFn(listWarehouseConnections);
  const saveFn = useServerFn(saveWarehouseConnection);
  const deleteFn = useServerFn(deleteWarehouseConnection);
  const testFn = useServerFn(testWarehouseConnectionFn);

  const [connections, setConnections] = useState<WarehouseConnectionSummary[]>([]);
  const [dialogProvider, setDialogProvider] = useState<WarehouseProvider | null>(null);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  // Pending disconnect confirmation: which connection rows would be removed
  // and a human label for the warning dialog.
  const [confirmRemove, setConfirmRemove] = useState<{
    ids: string[];
    label: string;
    names: string[];
  } | null>(null);
  const [removing, setRemoving] = useState(false);

  const reload = useCallback(() => {
    if (!token) return;
    listFn({ data: { access_token: token } }).then((res) => {
      if (res.ok) setConnections(res.connections);
    });
  }, [token, listFn]);

  useEffect(() => {
    reload();
  }, [reload]);

  const openDialog = (provider: WarehouseProvider) => {
    setDialogProvider(provider);
    setName(`My ${WAREHOUSE_LABELS[provider].split(" ")[0]}`);
    setFields({});
  };

  const submit = async () => {
    if (!token || !dialogProvider) return;
    const meta = PROVIDER_META[dialogProvider];
    for (const f of meta.fields) {
      if (!f.optional && !fields[f.key]?.trim()) {
        return toast.error(`${f.label} is required`);
      }
    }
    if (
      dialogProvider === "redshift" &&
      !fields.workgroup_name?.trim() &&
      !(fields.cluster_identifier?.trim() && fields.db_user?.trim())
    ) {
      return toast.error("Provide a workgroup (serverless) or cluster identifier + DB user");
    }
    setBusy(true);
    try {
      const config = { provider: dialogProvider } as Record<string, string>;
      for (const f of meta.fields) {
        const v = fields[f.key]?.trim();
        if (v) config[f.key] = f.key === "service_account_json" ? fields[f.key] : v;
      }
      const saved = await saveFn({
        data: {
          access_token: token,
          name: name.trim(),
          config: config as never,
        },
      });
      if (!saved.ok) return toast.error(saved.error);
      setDialogProvider(null);
      reload();
      // Immediately verify connectivity so the status badge is honest.
      toast.info("Saved — testing connection…");
      const test = await testFn({ data: { access_token: token, connection_id: saved.id } });
      if (test.ok) toast.success("Connection verified — SELECT 1 succeeded");
      else toast.error(`Connection saved but the test failed: ${test.error}`);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (id: string) => {
    if (!token) return;
    setTestingId(id);
    try {
      const res = await testFn({ data: { access_token: token, connection_id: id } });
      if (res.ok) toast.success("Connection verified");
      else toast.error(res.error);
      reload();
    } finally {
      setTestingId(null);
    }
  };

  // Ask before removing — deleting a connection breaks anything built on it
  // (dashboards, prep flows, catalog assets, agent SQL). The card's Disconnect
  // covers every connection of that provider; the table's trash covers one row.
  const requestRemove = (ids: string[], label: string, names: string[]) =>
    setConfirmRemove({ ids, label, names });

  const performRemove = async () => {
    if (!token || !confirmRemove) return;
    setRemoving(true);
    try {
      for (const id of confirmRemove.ids) {
        const res = await deleteFn({ data: { access_token: token, connection_id: id } });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
      }
      toast.success(
        confirmRemove.ids.length > 1
          ? `${confirmRemove.ids.length} connections removed`
          : "Connection removed",
      );
      reload();
    } finally {
      setRemoving(false);
      setConfirmRemove(null);
    }
  };

  const meta = dialogProvider ? PROVIDER_META[dialogProvider] : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {WAREHOUSE_PROVIDERS.map((p) => (
          <Card key={p} className="border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/50 bg-white p-1.5">
                  <ProviderMark provider={p} />
                </div>
                <CardTitle className="text-base">{WAREHOUSE_LABELS[p]}</CardTitle>
              </div>
              <p className="text-xs text-muted-foreground">{PROVIDER_META[p].description}</p>
              {connections.some((c) => c.provider === p && c.last_test_status === "ok") ? (
                <Badge variant="outline" className="w-fit text-primary border-primary/30">
                  <Check className="h-3 w-3 mr-1" /> Connected
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => openDialog(p)}
                >
                  <Plug2 className="h-3.5 w-3.5" /> Connect
                </Button>
                {connections.some((c) => c.provider === p) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      const mine = connections.filter((c) => c.provider === p);
                      requestRemove(
                        mine.map((c) => c.id),
                        WAREHOUSE_LABELS[p],
                        mine.map((c) => c.name),
                      );
                    }}
                  >
                    <Unplug className="h-3.5 w-3.5" /> Disconnect
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {connections.length > 0 && (
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Your connections</CardTitle>
            <CardDescription>
              These are available on the Data &amp; SQL page and to agents with the SQL tool
              enabled. Queries are read-only and capped at 1,000 rows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last tested</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        {c.name}
                        {c.shared && (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            Shared
                          </Badge>
                        )}
                        <CredentialAgeBadge rotatedAt={c.credentials_rotated_at} />
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="flex h-4 w-4 items-center justify-center">
                          <ProviderMark provider={c.provider} />
                        </span>
                        {WAREHOUSE_LABELS[c.provider]}
                      </span>
                    </TableCell>
                    <TableCell>
                      {c.last_test_status === "ok" ? (
                        <Badge variant="outline" className="text-primary border-primary/30">
                          <Check className="h-3 w-3 mr-1" /> OK
                        </Badge>
                      ) : c.last_test_status === "error" ? (
                        <Badge
                          variant="outline"
                          className="max-w-64 truncate text-destructive border-destructive/40"
                          title={c.last_test_error ?? undefined}
                        >
                          <X className="h-3 w-3 mr-1" /> {c.last_test_error ?? "Failed"}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Untested</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.last_tested_at ? format(new Date(c.last_tested_at), "d MMM HH:mm") : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={testingId === c.id}
                          onClick={() => runTest(c.id)}
                        >
                          {testingId === c.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Test"
                          )}
                        </Button>
                        {/* A shared connection belongs to someone else. The
                            server refuses the delete regardless, but a button
                            that always errors is its own bug. */}
                        {!c.shared && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              requestRemove([c.id], WAREHOUSE_LABELS[c.provider], [c.name])
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!dialogProvider} onOpenChange={(o) => !o && setDialogProvider(null)}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {dialogProvider && (
                <span className="flex h-6 w-6 items-center justify-center rounded border border-border/50 bg-white p-0.5">
                  <img
                    src={PROVIDER_LOGOS[dialogProvider]}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                </span>
              )}
              Connect {dialogProvider ? WAREHOUSE_LABELS[dialogProvider] : ""}
            </DialogTitle>
            <DialogDescription>
              Credentials are encrypted at rest and only used server-side. Use a read-only database
              user/role — the app additionally rejects non-SELECT statements. Any field accepts a
              Secrets Manager reference like <code className="text-xs">{"{{secret:NAME}}"}</code>{" "}
              instead of the raw value.
            </DialogDescription>
          </DialogHeader>
          {meta ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Connection name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  Agents reference this name in tool calls — keep it short and unique.
                </p>
              </div>
              {meta.fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label>
                    {f.label}
                    {f.optional ? (
                      <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
                    ) : null}
                  </Label>
                  {f.type === "textarea" ? (
                    <Textarea
                      rows={5}
                      className="font-mono text-xs"
                      placeholder={f.placeholder}
                      value={fields[f.key] ?? ""}
                      onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  ) : (
                    <Input
                      type={f.type === "password" ? "password" : "text"}
                      placeholder={f.placeholder}
                      value={fields[f.key] ?? ""}
                      onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  )}
                  {f.hint ? <p className="text-xs text-muted-foreground">{f.hint}</p> : null}
                </div>
              ))}
              {meta.note ? <p className="text-xs text-muted-foreground">{meta.note}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogProvider(null)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save & test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {confirmRemove?.label}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {confirmRemove && confirmRemove.names.length > 1
                    ? `This removes ${confirmRemove.names.length} connections: ${confirmRemove.names.join(", ")}.`
                    : `This removes the connection "${confirmRemove?.names[0] ?? ""}".`}{" "}
                  The stored credentials are deleted.
                </p>
                <p className="text-destructive">
                  Anything built on this connection stops working: BI dashboards and prep flows that
                  query it, catalog assets crawled from it, and agents using it through the SQL
                  tool. This cannot be undone — reconnecting later requires re-entering credentials.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removing}
              onClick={(e) => {
                // Keep the dialog open while the delete runs.
                e.preventDefault();
                void performRemove();
              }}
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
