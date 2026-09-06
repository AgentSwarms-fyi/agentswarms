// Iceberg on the Lakehouse page: the catalogs a user registered, a form to
// add one (tried before it is saved), mounting a namespace as a schema, and
// - on a table tab - publishing the table into a catalog.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Snowflake, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  validateIcebergCatalog,
  type IcebergCatalogConfig,
} from "@/utils/lakehouse/iceberg";

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

  const [form, setForm] = useState<IcebergCatalogConfig>(defaultIcebergCatalog());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [mountCatalog, setMountCatalog] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [schemaName, setSchemaName] = useState("");
  const [mounting, setMounting] = useState(false);

  const set = <K extends keyof IcebergCatalogConfig>(k: K, v: IcebergCatalogConfig[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
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
            Register an Iceberg REST catalog (Lakekeeper, Polaris, Nessie, Glue, Unity, Snowflake
            Open Catalog…), mount one of its namespaces as a read-only schema, or publish lakehouse
            tables into it. Nothing is copied on a mount; the engine reads the Parquet the catalog
            points at.
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
                        {c.last_error && (
                          <Badge variant="destructive" className="text-[10px]" title={c.last_error}>
                            not attached
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {describeIcebergEndpoint(c.endpoint)} · warehouse {c.warehouse}
                      </p>
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

/** "Publish to Iceberg" on a table tab. */
export function PublishToIcebergDialog({ schema, table }: { schema: string; table: string }) {
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
  const [mode, setMode] = useState<"create" | "replace">("create");
  const [busy, setBusy] = useState(false);

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
                onChange={(e) => setMode(e.target.value as "create" | "replace")}
              >
                <option value="create">Refuse (keep the existing table)</option>
                <option value="replace">Replace it (drop, then create)</option>
              </select>
            </div>
            <Button
              className="w-full"
              disabled={busy || !catalogId || !namespace.trim() || !name.trim()}
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
                    },
                  });
                  if (!r.ok) return toast.error(r.error);
                  toast.success(
                    `Published ${r.rows.toLocaleString()} row(s) to ${namespace}.${name}`,
                  );
                  setOpen(false);
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
