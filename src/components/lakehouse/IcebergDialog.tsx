// Iceberg on the Lakehouse page: the catalogs a user registered, a form to
// add one (tried before it is saved), mounting a namespace as a schema, and
// - on a table tab - publishing the table into a catalog.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Snowflake, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { publishFailureHelp } from "@/lib/icebergPublishHelp";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import {
  icebergCatalogCreate,
  icebergCatalogDelete,
  icebergCatalogNetworkPath,
  icebergCatalogSetRequirePrivate,
  icebergCatalogsList,
  icebergMount,
  icebergNamespacesList,
  icebergPublish,
  type IcebergCatalogView,
} from "@/utils/icebergCatalogs.functions";
import {
  defaultIcebergCatalog,
  describeIcebergEndpoint,
  ICEBERG_AUTH_LABELS,
  ICEBERG_AUTH_TYPES,
  icebergLayoutError,
  keyable,
  upsertKeyError,
  v3OnlyColumns,
  validateIcebergCatalog,
  type IcebergCatalogConfig,
  type IcebergPartitionKey,
  type IcebergPartitionTransform,
} from "@/utils/lakehouse/iceberg";
import { reportFailure } from "@/lib/silentFailureNet";
import { partitionable } from "@/utils/lakehouse/partitioning";

/** A schema name for a namespace: ice_<namespace>, made safe. */
function suggestedSchemaName(namespace: string): string {
  return `ice_${namespace.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 40);
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

function useCatalogs(token: string, open: boolean) {
  const listFn = useServerFn(icebergCatalogsList);
  const [catalogs, setCatalogs] = useState<IcebergCatalogView[]>([]);
  const [loading, setLoading] = useState(false);
  const reload = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await listFn({ data: { access_token: token } });
      if (r.ok) setCatalogs(r.catalogs);
      else toast.error(r.error);
    } catch (e) {
      reportFailure("load the catalogs", e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (open) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);
  return { catalogs, loading, reload };
}

/** Catalogs and mounts: the "Iceberg" button beside "Mount data lake". */
export function IcebergCatalogsDialog({ onChanged }: { onChanged: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [open, setOpen] = useState(false);
  const { catalogs, loading, reload } = useCatalogs(token, open);
  const createFn = useServerFn(icebergCatalogCreate);
  const deleteFn = useServerFn(icebergCatalogDelete);
  const namespacesFn = useServerFn(icebergNamespacesList);
  const mountFn = useServerFn(icebergMount);
  const pathFn = useServerFn(icebergCatalogNetworkPath);
  const ruleFn = useServerFn(icebergCatalogSetRequirePrivate);

  // Which way the engine would reach the form's catalog (R428).
  const [path, setPath] = useState<{ label: string; summary: string; private: boolean }[]>([]);
  const [pathError, setPathError] = useState("");
  const [checkingPath, setCheckingPath] = useState(false);
  const [ruleBusy, setRuleBusy] = useState("");

  const [form, setForm] = useState<IcebergCatalogConfig>(defaultIcebergCatalog());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [mountCatalog, setMountCatalog] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [schemaName, setSchemaName] = useState("");
  const [mounting, setMounting] = useState(false);

  const set = <K extends keyof IcebergCatalogConfig>(k: K, v: IcebergCatalogConfig[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    // A report about other addresses would mislead.
    if (k === "endpoint" || k === "oauth2_server_uri") {
      setPath([]);
      setPathError("");
    }
  };

  async function checkPath() {
    setCheckingPath(true);
    setPath([]);
    setPathError("");
    try {
      const r = await pathFn({
        data: {
          access_token: token,
          endpoint: form.endpoint,
          oauth2_server_uri: form.auth_type === "oauth2" ? form.oauth2_server_uri : "",
        },
      });
      if (r.ok) setPath(r.lines);
      else setPathError(r.error);
    } catch (e) {
      reportFailure("check the network path", e);
    } finally {
      setCheckingPath(false);
    }
  }

  async function setRule(c: IcebergCatalogView, on: boolean) {
    setRuleBusy(c.id);
    try {
      const r = await ruleFn({ data: { access_token: token, id: c.id, require_private: on } });
      if (!r.ok) return toast.error(r.error);
      toast.success(
        on
          ? `${c.name} now requires a private network path`
          : `${c.name} no longer requires a private network path`,
      );
      await reload();
    } catch (e) {
      reportFailure("change the network rule", e);
    } finally {
      setRuleBusy("");
    }
  }
  const problem = adding ? validateIcebergCatalog(form) : null;

  async function loadNamespaces(id: string) {
    setMountCatalog(id);
    setNamespaces([]);
    setNamespace("");
    if (!id) return;
    const r = await namespacesFn({ data: { access_token: token, id } });
    if (!r.ok) return toast.error(r.error);
    setNamespaces(r.namespaces);
    if (r.namespaces.length === 1) {
      // One namespace: pick it, and name the schema the way a manual pick
      // would - otherwise the Mount button waits for a name nobody was asked for.
      setNamespace(r.namespaces[0]);
      setSchemaName((s) => s || suggestedSchemaName(r.namespaces[0]));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          title="Iceberg catalogs: mount a namespace as a schema, or publish tables"
        >
          <Snowflake className="mr-1 h-4 w-4" /> Iceberg
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Iceberg catalogs</DialogTitle>
          <DialogDescription>
            Register an Iceberg REST catalog (Lakekeeper, Polaris, Nessie, Unity, Snowflake Open
            Catalog…), mount one of its namespaces as a read-only schema, or publish lakehouse
            tables into it. Glue&apos;s and S3 Tables&apos; endpoints need AWS SigV4 signing, which
            is not offered yet. Nothing is copied on a mount; the engine reads the Parquet the
            catalog points at.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Catalogs</p>
              <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
                {adding ? "Cancel" : "Add catalog"}
              </Button>
            </div>
            {loading && catalogs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : catalogs.length === 0 && !adding ? (
              <p className="text-xs text-muted-foreground">No catalogs yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {catalogs.map((c) => (
                  <li key={c.id} className="flex items-start justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm">{c.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {ICEBERG_AUTH_LABELS[c.auth_type as keyof typeof ICEBERG_AUTH_LABELS] ??
                            c.auth_type}
                        </Badge>
                        {c.require_private && (
                          <Badge variant="outline" className="text-[10px]">
                            private path required
                          </Badge>
                        )}
                        {c.last_error && (
                          <Badge variant="destructive" className="text-[10px]" title={c.last_error}>
                            not attached
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {describeIcebergEndpoint(c.endpoint)} · warehouse {c.warehouse}
                      </p>
                      {c.last_error && (
                        <p className="text-xs text-destructive" data-testid="iceberg-last-error">
                          {c.last_error}
                        </p>
                      )}
                      <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={c.require_private === true}
                          disabled={ruleBusy === c.id}
                          onCheckedChange={(v) => void setRule(c, v === true)}
                          aria-label={`Require a private network path for ${c.name}`}
                        />
                        Require a private network path
                      </label>
                      {c.mounts.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Mounted: {c.mounts.map((m) => `${m.name} ← ${m.namespace}`).join(", ")}
                        </p>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      title="Remove this catalog and its mounted schemas"
                      onClick={async () => {
                        const ok = await confirmAsk({
                          title: `Remove "${c.name}"?`,
                          body:
                            c.mounts.length > 0
                              ? `Its ${c.mounts.length} mounted schema(s) go with it. Tables in the catalog itself are untouched.`
                              : "Tables in the catalog itself are untouched.",
                          actionLabel: "Remove",
                        });
                        if (!ok) return;
                        const r = await deleteFn({ data: { access_token: token, id: c.id } });
                        if (!r.ok) return toast.error(r.error);
                        toast.success(`Removed ${c.name}`);
                        await reload();
                        onChanged();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {adding && (
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value.toLowerCase())}
                    placeholder="lakekeeper"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Warehouse</Label>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={form.warehouse}
                    onChange={(e) => set("warehouse", e.target.value)}
                    placeholder="s3://iceberg/ or a warehouse name"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">REST endpoint</Label>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={form.endpoint}
                    onChange={(e) => set("endpoint", e.target.value)}
                    placeholder="https://catalog.example.com/api/catalog"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Authentication</Label>
                  <select
                    className={selectClass}
                    value={form.auth_type}
                    onChange={(e) =>
                      set("auth_type", e.target.value as IcebergCatalogConfig["auth_type"])
                    }
                  >
                    {ICEBERG_AUTH_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {ICEBERG_AUTH_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Table files are read with</Label>
                  <select
                    className={selectClass}
                    value={form.storage}
                    onChange={(e) =>
                      set("storage", e.target.value as IcebergCatalogConfig["storage"])
                    }
                  >
                    <option value="vended">Credentials the catalog vends</option>
                    <option value="lakehouse">The lakehouse&apos;s own storage credentials</option>
                  </select>
                </div>
                {form.auth_type === "bearer" && (
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Token secret (Settings → Secrets)</Label>
                    <Input
                      className="h-8 font-mono text-xs"
                      value={form.token_secret}
                      onChange={(e) => set("token_secret", e.target.value)}
                      placeholder="ICEBERG_TOKEN"
                    />
                  </div>
                )}
                {form.auth_type === "oauth2" && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">Client id secret</Label>
                      <Input
                        className="h-8 font-mono text-xs"
                        value={form.client_id_secret}
                        onChange={(e) => set("client_id_secret", e.target.value)}
                        placeholder="ICEBERG_CLIENT_ID"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Client secret secret</Label>
                      <Input
                        className="h-8 font-mono text-xs"
                        value={form.client_secret_secret}
                        onChange={(e) => set("client_secret_secret", e.target.value)}
                        placeholder="ICEBERG_CLIENT_SECRET"
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">OAuth2 server URI (optional)</Label>
                      <Input
                        className="h-8 font-mono text-xs"
                        value={form.oauth2_server_uri}
                        onChange={(e) => set("oauth2_server_uri", e.target.value)}
                        placeholder="https://auth.example.com/oauth/token"
                      />
                    </div>
                  </>
                )}
                <div
                  className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 sm:col-span-2"
                  data-testid="iceberg-network"
                >
                  <p className="text-xs font-medium">Network</p>
                  <p className="text-xs text-muted-foreground">
                    The lakehouse engine calls the catalog itself. A catalog on a private endpoint
                    keeps its name and resolves privately from this server (private DNS, a VPN or a
                    peering link); there is nothing else to enter.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={checkingPath || !form.endpoint.trim()}
                      onClick={() => void checkPath()}
                    >
                      {checkingPath ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                      Check network path
                    </Button>
                  </div>
                  {path.length > 0 && (
                    <ul className="space-y-0.5 text-xs" data-testid="iceberg-network-path">
                      {path.map((l) => (
                        <li key={l.label}>
                          <span className="font-medium">{l.label}:</span> {l.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                  {pathError && (
                    <p className="text-xs text-destructive" data-testid="iceberg-network-path">
                      {pathError}
                    </p>
                  )}
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={form.require_private === true}
                      onCheckedChange={(v) => set("require_private", v === true)}
                      aria-label="Require a private network path"
                    />
                    <span>
                      Require a private network path
                      <span className="block text-xs text-muted-foreground">
                        The catalog is attached only when its endpoint, and its OAuth2 server,
                        resolve to private addresses from this server, checked again at every engine
                        sync. The table files are read where the catalog points; this rule does not
                        reach them.
                      </span>
                    </span>
                  </label>
                </div>
                {problem && <p className="text-xs text-destructive sm:col-span-2">{problem}</p>}
                <div className="sm:col-span-2">
                  <Button
                    size="sm"
                    disabled={busy || Boolean(problem)}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await createFn({ data: { access_token: token, config: form } });
                        if (!r.ok) return toast.error(r.error);
                        toast.success(
                          `Registered ${form.name}: ${r.namespaces.length} namespace${r.namespaces.length === 1 ? "" : "s"}`,
                        );
                        setForm(defaultIcebergCatalog());
                        setAdding(false);
                        await reload();
                      } catch (e) {
                        reportFailure("register the catalog", e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    Test and save
                  </Button>
                </div>
              </div>
            )}
          </div>

          {catalogs.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Mount a namespace as a schema</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs">Catalog</Label>
                  <select
                    className={selectClass}
                    value={mountCatalog}
                    onChange={(e) => void loadNamespaces(e.target.value)}
                  >
                    <option value="">Pick a catalog…</option>
                    {catalogs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Namespace</Label>
                  <select
                    className={selectClass}
                    value={namespace}
                    onChange={(e) => {
                      setNamespace(e.target.value);
                      if (!schemaName) setSchemaName(suggestedSchemaName(e.target.value));
                    }}
                    disabled={!mountCatalog}
                  >
                    <option value="">{mountCatalog ? "Pick a namespace…" : "—"}</option>
                    {namespaces.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Mount as schema</Label>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={schemaName}
                    onChange={(e) => setSchemaName(e.target.value.toLowerCase())}
                    placeholder="ice_sales"
                  />
                </div>
              </div>
              <Button
                size="sm"
                disabled={mounting || !mountCatalog || !namespace || !schemaName.trim()}
                onClick={async () => {
                  setMounting(true);
                  try {
                    const r = await mountFn({
                      data: {
                        access_token: token,
                        id: mountCatalog,
                        namespace,
                        schema_name: schemaName.trim(),
                      },
                    });
                    if (!r.ok) return toast.error(r.error);
                    toast.success(
                      `Mounted ${r.views} table${r.views === 1 ? "" : "s"}${r.skipped ? ` — ${r.skipped} skipped` : ""}`,
                    );
                    setSchemaName("");
                    setNamespace("");
                    await reload();
                    onChanged();
                  } catch (e) {
                    reportFailure("mount the namespace", e);
                  } finally {
                    setMounting(false);
                  }
                }}
              >
                {mounting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Mount
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const TRANSFORM_LABELS: Record<IcebergPartitionTransform, string> = {
  identity: "value",
  year: "year",
  month: "month",
  day: "day",
  hour: "hour",
  bucket: "hash bucket",
  truncate: "truncate",
};

/** The transforms a source column can take in an Iceberg partition spec, most useful first. */
function icebergTransformsFor(type: string): IcebergPartitionTransform[] {
  if (/^TIMESTAMP/i.test(type)) return ["day", "month", "year", "hour", "identity", "bucket"];
  if (/^DATE/i.test(type)) return ["day", "month", "year", "identity", "bucket"];
  if (/^(VARCHAR|TEXT|STRING)/i.test(type)) return ["identity", "truncate", "bucket"];
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|DECIMAL|NUMERIC)/i.test(type)) {
    return ["identity", "bucket", "truncate"];
  }
  return ["identity", "bucket"];
}

/**
 * "Publish to Iceberg" on a table tab: which catalog and name, what the table
 * is written as (format version, partition spec), and what happens when it
 * exists already: refuse, replace, or upsert by key (R457).
 */
export function PublishToIcebergDialog({
  schema,
  table,
  columns,
}: {
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [open, setOpen] = useState(false);
  const { catalogs } = useCatalogs(token, open);
  const namespacesFn = useServerFn(icebergNamespacesList);
  const publishFn = useServerFn(icebergPublish);
  const [catalogId, setCatalogId] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [name, setName] = useState(table);
  const [mode, setMode] = useState<"create" | "replace" | "upsert">("create");
  const [busy, setBusy] = useState(false);
  const needsV3 = v3OnlyColumns(columns);
  const [formatVersion, setFormatVersion] = useState<2 | 3>(needsV3.length ? 3 : 2);
  const [partition, setPartition] = useState<IcebergPartitionKey[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    if (open && needsV3.length) setFormatVersion(3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const layoutProblem =
    mode === "upsert" ? null : icebergLayoutError({ formatVersion, partition }, columns);
  const problem =
    layoutProblem ??
    (mode !== "upsert"
      ? null
      : keys.length
        ? upsertKeyError(keys, columns)
        : "Pick the key columns an upsert matches rows on.");
  const addKey = (column: string) => {
    const col = columns.find((c) => c.name === column);
    if (!col || partition.length >= 4) return;
    const transform = icebergTransformsFor(col.type)[0];
    setPartition([
      ...partition,
      {
        column,
        transform,
        ...(transform === "bucket" ? { width: 16 } : transform === "truncate" ? { width: 4 } : {}),
      },
    ]);
  };
  const setKey = (i: number, patch: Partial<IcebergPartitionKey>) =>
    setPartition(
      partition.map((k, j) => {
        if (j !== i) return k;
        const next = { ...k, ...patch };
        if (next.transform === "bucket" && !next.width) next.width = 16;
        if (next.transform === "truncate" && !next.width) next.width = 4;
        if (next.transform !== "bucket" && next.transform !== "truncate") delete next.width;
        return next;
      }),
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" title="Write this table into an Iceberg catalog">
          <Upload className="mr-1 h-3.5 w-3.5" /> Publish to Iceberg
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Publish {schema}.{table} to Iceberg
          </DialogTitle>
          <DialogDescription>
            A copy of the table is written into the catalog as an Iceberg table, readable by Spark,
            Trino, Snowflake and everything else that speaks Iceberg. The lakehouse table stays as
            it is.
          </DialogDescription>
        </DialogHeader>
        {catalogs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Register a catalog first (Iceberg button above the object explorer).
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Catalog</Label>
              <select
                className={selectClass}
                value={catalogId}
                onChange={async (e) => {
                  const id = e.target.value;
                  setCatalogId(id);
                  setNamespaces([]);
                  if (!id) return;
                  const r = await namespacesFn({ data: { access_token: token, id } });
                  if (r.ok) setNamespaces(r.namespaces);
                  else toast.error(r.error);
                }}
              >
                <option value="">Pick a catalog…</option>
                {catalogs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Namespace (existing, or a new one)</Label>
              <Input
                className="h-8 font-mono text-xs"
                list="iceberg-namespaces"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="analytics"
              />
              <datalist id="iceberg-namespaces">
                {namespaces.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Table name in the catalog</Label>
              <Input
                className="h-8 font-mono text-xs"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">If it exists</Label>
              <select
                className={selectClass}
                value={mode}
                onChange={(e) => setMode(e.target.value as "create" | "replace" | "upsert")}
              >
                <option value="create">Refuse (keep the existing table)</option>
                <option value="replace">Replace it (swap the new table in)</option>
                <option value="upsert">Upsert into it by key (update matches, add the rest)</option>
              </select>
            </div>
            {mode === "upsert" ? (
              <div className="space-y-1" data-testid="iceberg-upsert-keys">
                <Label className="text-xs">Key columns</Label>
                <div className="flex flex-wrap gap-1">
                  {columns.map((c) => {
                    const on = keys.includes(c.name);
                    const usable = keyable(c.type);
                    return (
                      <button
                        key={c.name}
                        aria-pressed={on}
                        disabled={!usable && !on}
                        title={usable ? undefined : `A ${c.type.toLowerCase()} cannot be a key`}
                        className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${on ? "border-primary/60 bg-primary/10" : ""}`}
                        onClick={() =>
                          setKeys(on ? keys.filter((k) => k !== c.name) : [...keys, c.name])
                        }
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  The catalog&apos;s table must already have this table&apos;s columns. Rows whose
                  keys match are updated, the rest added, in one commit; a key that appears twice
                  here is refused.
                </p>
              </div>
            ) : (
              <div className="space-y-2 rounded-md border p-2" data-testid="iceberg-layout">
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Format</Label>
                  <select
                    className={`${selectClass} w-auto`}
                    value={formatVersion}
                    aria-label="Iceberg format version"
                    onChange={(e) => setFormatVersion(Number(e.target.value) as 2 | 3)}
                  >
                    <option value={2}>v2 (read by every engine)</option>
                    <option value={3}>v3 (deletion vectors, row lineage, VARIANT)</option>
                  </select>
                </div>
                {needsV3.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {needsV3.join(", ")} {needsV3.length === 1 ? "needs" : "need"} v3.
                  </p>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">Partitioned by</Label>
                  {partition.map((k, i) => {
                    const type = columns.find((c) => c.name === k.column)?.type ?? "";
                    return (
                      <div key={`${k.column}-${i}`} className="flex items-center gap-1 text-xs">
                        <span className="min-w-0 flex-1 truncate font-mono">{k.column}</span>
                        <select
                          className="h-7 rounded-md border border-input bg-background px-1 text-xs"
                          value={k.transform}
                          aria-label={`Transform for ${k.column}`}
                          onChange={(e) =>
                            setKey(i, { transform: e.target.value as IcebergPartitionTransform })
                          }
                        >
                          {icebergTransformsFor(type).map((t) => (
                            <option key={t} value={t}>
                              {TRANSFORM_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        {(k.transform === "bucket" || k.transform === "truncate") && (
                          <Input
                            type="number"
                            min={1}
                            max={1024}
                            className="h-7 w-16 text-xs"
                            aria-label={
                              k.transform === "bucket"
                                ? `Buckets for ${k.column}`
                                : `Width for ${k.column}`
                            }
                            value={k.width ?? ""}
                            onChange={(e) => setKey(i, { width: Number(e.target.value) })}
                          />
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label={`Remove ${k.column} from the partition spec`}
                          onClick={() => setPartition(partition.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                  {partition.length < 4 && (
                    <select
                      className={selectClass}
                      value=""
                      aria-label="Add a partition column"
                      onChange={(e) => addKey(e.target.value)}
                    >
                      <option value="">
                        {partition.length
                          ? "Add another column…"
                          : "Not partitioned · add a column…"}
                      </option>
                      {columns
                        .filter(
                          (c) =>
                            !partition.some((k) => k.column === c.name) && partitionable(c.type),
                        )
                        .map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name} ({c.type.toLowerCase()})
                          </option>
                        ))}
                    </select>
                  )}
                </div>
                {mode === "replace" && (
                  <p className="text-[11px] text-muted-foreground">
                    A replace into a table with the same columns keeps that table&apos;s format and
                    partitioning; these apply when the table is new or its columns changed.
                  </p>
                )}
              </div>
            )}
            {problem && <p className="text-xs text-destructive">{problem}</p>}
            <Button
              className="w-full"
              disabled={busy || !catalogId || !namespace.trim() || !name.trim() || Boolean(problem)}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await publishFn({
                    data: {
                      access_token: token,
                      id: catalogId,
                      namespace: namespace.trim(),
                      table: name.trim(),
                      source_schema: schema,
                      source_table: table,
                      mode,
                      ...(mode === "upsert"
                        ? { keys }
                        : { layout: { format_version: formatVersion, partition } }),
                    },
                  });
                  if (!r.ok) return toast.error(r.error);
                  toast.success(
                    mode === "upsert"
                      ? `Upserted into ${namespace}.${name}: it now has ${r.rows.toLocaleString()} row(s)`
                      : `Published ${r.rows.toLocaleString()} row(s) to ${namespace}.${name}${r.format_version ? ` as Iceberg v${r.format_version}` : ""}`,
                  );
                  setOpen(false);
                } catch (e) {
                  // R245. This had a `finally` and no `catch`: a publish the
                  // catalog rejected stopped the spinner and said NOTHING,
                  // which is the "No toast" recorded on 2026-10-01 over a
                  // refused commit. A write to someone else's catalog is
                  // exactly where silence is least affordable — the reader
                  // cannot tell "it did not happen" from "it happened and the
                  // dialog is being slow".
                  toast.error(`Could not publish ${schema}.${table}`, {
                    description: publishFailureHelp(e),
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Publish
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
