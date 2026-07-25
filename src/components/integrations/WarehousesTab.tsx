// "Data Warehouses" tab of the Integration Hub: connect Redshift, Snowflake,
// Databricks, BigQuery, or Azure Synapse. Credentials are encrypted
// server-side and never come back to the client; queries run through
// /api/warehouse/* and the warehouse agent tools.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Loader2, Plug2, Trash2, X } from "lucide-react";

// Official provider marks, used nominatively to identify each integration.
// Sources: Simple Icons (CC0) for Snowflake / Databricks / BigQuery;
// Wikimedia Commons for Amazon Redshift; Microsoft's Azure architecture
// icon set for Synapse.
import redshiftLogo from "@/assets/warehouses/redshift.svg";
import snowflakeLogo from "@/assets/warehouses/snowflake.svg";
import databricksLogo from "@/assets/warehouses/databricks.svg";
import bigqueryLogo from "@/assets/warehouses/bigquery.svg";
import synapseLogo from "@/assets/warehouses/synapse.svg";
import postgresLogo from "@/assets/warehouses/postgres.svg";
import mysqlLogo from "@/assets/warehouses/mysql.svg";
import trinoLogo from "@/assets/warehouses/trino.svg";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const PROVIDER_LOGOS: Record<WarehouseProvider, string> = {
  redshift: redshiftLogo,
  snowflake: snowflakeLogo,
  databricks: databricksLogo,
  bigquery: bigqueryLogo,
  azure_synapse: synapseLogo,
  postgres: postgresLogo,
  mysql: mysqlLogo,
  trino: trinoLogo,
};

const PROVIDER_META: Record<
  WarehouseProvider,
  { description: string; fields: Field[]; note?: string }
> = {
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
    note: "Requires a Node deployment (Docker/bare Node) — Synapse speaks TDS, which isn't available on Cloudflare Workers.",
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

  const remove = async (id: string, connName: string) => {
    if (!token) return;
    if (!window.confirm(`Remove warehouse connection "${connName}"?`)) return;
    const res = await deleteFn({ data: { access_token: token, connection_id: id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Connection removed");
    reload();
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
                  <img
                    src={PROVIDER_LOGOS[p]}
                    alt={`${WAREHOUSE_LABELS[p]} logo`}
                    className="h-full w-full object-contain"
                  />
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
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openDialog(p)}>
                <Plug2 className="h-3.5 w-3.5" /> Connect
              </Button>
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
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <img
                          src={PROVIDER_LOGOS[c.provider]}
                          alt=""
                          className="h-4 w-4 object-contain"
                        />
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
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => remove(c.id, c.name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
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
    </div>
  );
}
