// Pickers for the visual pipeline editor.
//
// Everything a source or a target can be is something the platform already
// knows: a connection and the schemas and tables behind it, a lakehouse
// schema and its tables, a bucket and the folders and datasets the catalog
// crawled in it, a catalog source and its schemas and assets, a secret by
// name, an AWS region. So none of it is typed, and each is picked the way
// it is organised - one level at a time, each level narrowing the next:
// connection, schema, table; bucket, folder, dataset; catalog source, schema
// or folder, asset. A target that may create something new offers "New …"
// and then, only then, asks for a name. What the platform cannot know - a
// URL, a topic on somebody else's broker, an expression - stays a field,
// and those are the only fields left.
//
// Every picker reports the columns of what was picked, so the incremental
// cursor, the merge keys and the transforms downstream can be picked too,
// without a preview having run first.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listCatalogAssets,
  listCatalogSources,
  type CatalogAsset,
  type CatalogSource,
} from "@/lib/dataCatalog";
import { catalogListStorageTables } from "@/utils/catalog.functions";
import { etlListLakehouseTables, etlListWarehouseTables } from "@/utils/etl.functions";
import {
  describeResolvedSource,
  resolveCatalogAsset,
  type CatalogAssetSourceConfig,
} from "@/utils/etl/catalogAsset";
import type { SourceFileFormat } from "@/utils/etl/codegen";
import { AWS_REGIONS } from "@/utils/etl/streaming";
import { listSecrets } from "@/utils/secrets.functions";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import type { WarehouseTable } from "@/utils/warehouse/types";

/** The option that turns a picker into a name field, for targets that may create. */
export const NEW_ENTRY = "__new__";
/** The option that turns a path picker into a path field. */
export const CUSTOM_ENTRY = "__custom__";
/** A bucket's root, or a warehouse asset with no schema, as a Select value. */
const ROOT_ENTRY = "__root__";

type Option = { value: string; label: string; hint?: string; disabled?: boolean };

export function PickField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One Select over options with hints; empty and error states say what to do. */
function Picker({
  value,
  onChange,
  placeholder,
  options,
  extra,
  loading,
  error,
  empty,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: Option[];
  /** A trailing "New …" or "Custom …" entry. */
  extra?: Option;
  loading?: boolean;
  error?: string | null;
  /** Shown instead of the list when there is nothing to pick. */
  empty?: string;
  disabled?: boolean;
}) {
  const all = extra ? [...options, extra] : options;
  return (
    <>
      <Select value={value} onValueChange={onChange} disabled={disabled || loading}>
        <SelectTrigger className="h-8">
          <SelectValue placeholder={loading ? "Loading…" : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {all.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {empty ?? "Nothing to pick yet."}
            </div>
          ) : (
            all.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                <span className="font-mono text-xs">{o.label}</span>
                {o.hint ? (
                  <span className="ml-2 text-[11px] text-muted-foreground">{o.hint}</span>
                ) : null}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {error ? <p className="mt-1 text-[11px] text-red-500">{error}</p> : null}
    </>
  );
}

/** A name field with a way back to the list, for the one entry a target may create. */
function NameField({
  value,
  onValue,
  placeholder,
  onPick,
}: {
  value: string;
  onValue: (v: string) => void;
  placeholder: string;
  /** Present when there is a list to go back to. */
  onPick?: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8 font-mono text-xs"
        value={value}
        onChange={(e) => onValue(e.target.value.trim())}
        placeholder={placeholder}
        autoFocus
      />
      {onPick ? (
        <button
          type="button"
          className="shrink-0 text-[11px] text-muted-foreground underline"
          onClick={onPick}
        >
          pick
        </button>
      ) : null}
    </div>
  );
}

const fmtRows = (n: number | null | undefined) =>
  n == null ? "" : `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── Data the pickers read ───────────────────────────────────────────────────

/** The caller's secrets by name (own and IAM-granted), never their values. */
export function useSecretNames(token: string): { names: string[]; loaded: boolean } {
  const fn = useServerFn(listSecrets);
  const [names, setNames] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!token) return;
    void fn({ data: { access_token: token } })
      .then((res) => {
        if (res.ok) setNames(res.secrets.map((s) => s.name));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return { names, loaded };
}

function useWarehouseTables(token: string, connectionId: string | undefined) {
  const fn = useServerFn(etlListWarehouseTables);
  const [tables, setTables] = useState<WarehouseTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTables([]);
    setError(null);
    if (!token || !connectionId) return;
    let alive = true;
    setLoading(true);
    void fn({ data: { access_token: token, connection_id: connectionId } })
      .then((res) => {
        if (!alive) return;
        if (res.ok) setTables(res.tables);
        else setError(res.error);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not list tables"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, connectionId]);
  return { tables, loading, error };
}

type StorageTable = {
  table: string;
  key: string;
  format: string;
  columns: { name: string; type: string }[];
  row_count: number | null;
};

function useStorageTables(token: string, sourceId: string | undefined) {
  const fn = useServerFn(catalogListStorageTables);
  const [tables, setTables] = useState<StorageTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTables([]);
    setError(null);
    if (!token || !sourceId) return;
    let alive = true;
    setLoading(true);
    void fn({ data: { access_token: token, source_id: sourceId } })
      .then((res) => {
        if (!alive) return;
        if (res.ok) setTables(res.tables as StorageTable[]);
        else setError(res.error);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not list the bucket"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sourceId]);
  return { tables, loading, error };
}

type LakehouseListing = {
  enabled: boolean;
  schemas: { name: string; writable: boolean }[];
  tables: { schema: string; table: string; columns: { name: string; type: string }[] }[];
};

/** Schemas and tables the caller can reach, from information_schema alone: fast on a cold engine. */
function useLakehouseTables(token: string) {
  const fn = useServerFn(etlListLakehouseTables);
  const [listing, setListing] = useState<LakehouseListing>({
    enabled: true,
    schemas: [],
    tables: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    void fn({ data: { access_token: token } })
      .then((res) => {
        if (!alive) return;
        if (res.ok) setListing(res);
        else setError(res.error);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not list tables"))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return { ...listing, loaded, error };
}

// ── Secrets and regions ─────────────────────────────────────────────────────

/** A secret by name. The value never enters the graph; the run resolves it as the owner. */
export function SecretPicker({
  label,
  secrets,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  secrets: string[];
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
}) {
  const options: Option[] = secrets.map((n) => ({ value: n, label: n }));
  if (value && !secrets.includes(value)) {
    options.unshift({ value, label: value, hint: "not found in Settings → Secrets" });
  }
  return (
    <PickField
      label={label}
      hint={
        secrets.length === 0
          ? "No secrets yet. Add one under Settings → Secrets; its value never enters the graph."
          : "The value stays in Settings → Secrets and reaches the run as the pipeline owner."
      }
    >
      <Picker
        value={value}
        onChange={onChange}
        placeholder={placeholder ?? "Choose a secret"}
        options={options}
        empty="No secrets yet — add one under Settings → Secrets."
      />
    </PickField>
  );
}

export function RegionPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const options: Option[] = AWS_REGIONS.map((r) => ({
    value: r.code,
    label: r.code,
    hint: r.name,
  }));
  if (value && !AWS_REGIONS.some((r) => r.code === value)) {
    options.unshift({ value, label: value, hint: "custom region" });
  }
  return (
    <PickField label="Region">
      <Picker value={value} onChange={onChange} placeholder="Choose a region" options={options} />
    </PickField>
  );
}

// ── Warehouse: connection → schema → table ──────────────────────────────────

/**
 * Schema, then table, from the connection's own information_schema. A target
 * may name something that does not exist yet: "New …" turns that one level
 * into a name field.
 */
export function WarehouseTablePicker({
  token,
  connectionId,
  schema,
  table,
  onChange,
  allowNew,
  schemaLabel = "Schema",
}: {
  token: string;
  connectionId: string | undefined;
  schema: string;
  table: string;
  onChange: (v: { schema?: string; table?: string; columns?: string[] }) => void;
  allowNew?: boolean;
  schemaLabel?: string;
}) {
  const { tables, loading, error } = useWarehouseTables(token, connectionId);
  const schemas = useMemo(() => [...new Set(tables.map((t) => t.schema))].sort(), [tables]);
  const inSchema = useMemo(
    () => tables.filter((t) => t.schema === schema).sort((a, b) => a.name.localeCompare(b.name)),
    [tables, schema],
  );
  const knownSchema = schemas.includes(schema);
  const knownTable = inSchema.some((t) => t.name === table);
  const [newSchema, setNewSchema] = useState(false);
  const [newTable, setNewTable] = useState(false);
  useEffect(() => {
    // A saved node naming something the connection no longer lists stays
    // editable as a name rather than silently blanking.
    if (tables.length && schema && !knownSchema) setNewSchema(true);
    if (tables.length && table && !knownTable && knownSchema) setNewTable(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.length]);

  if (!connectionId) {
    return <p className="text-[11px] text-muted-foreground">Choose a connection first.</p>;
  }
  return (
    <>
      <PickField label={schemaLabel}>
        {newSchema ? (
          <NameField
            value={schema}
            onValue={(v) => onChange({ schema: v, table: "" })}
            placeholder="new_schema"
            onPick={
              schemas.length
                ? () => {
                    setNewSchema(false);
                    onChange({ schema: "", table: "" });
                  }
                : undefined
            }
          />
        ) : (
          <Picker
            value={knownSchema ? schema : ""}
            onChange={(v) => {
              if (v === NEW_ENTRY) {
                setNewSchema(true);
                onChange({ schema: "", table: "" });
                return;
              }
              onChange({ schema: v, table: "" });
            }}
            placeholder="Choose a schema"
            options={schemas.map((s) => ({
              value: s,
              label: s,
              hint: plural(tables.filter((t) => t.schema === s).length, "table"),
            }))}
            extra={allowNew ? { value: NEW_ENTRY, label: "New schema…" } : undefined}
            loading={loading}
            error={error}
            empty="This connection lists no schemas."
          />
        )}
      </PickField>
      <PickField label="Table">
        {newTable || newSchema ? (
          <NameField
            value={table}
            onValue={(v) => onChange({ table: v })}
            placeholder="new_table"
            onPick={
              !newSchema && inSchema.length
                ? () => {
                    setNewTable(false);
                    onChange({ table: "" });
                  }
                : undefined
            }
          />
        ) : (
          <Picker
            value={knownTable ? table : ""}
            onChange={(v) => {
              if (v === NEW_ENTRY) {
                setNewTable(true);
                onChange({ table: "" });
                return;
              }
              const t = inSchema.find((x) => x.name === v);
              onChange({ table: v, columns: t?.columns.map((c) => c.name) });
            }}
            placeholder={schema ? "Choose a table" : "Choose a schema first"}
            options={inSchema.map((t) => ({
              value: t.name,
              label: t.name,
              hint: plural(t.columns.length, "column"),
            }))}
            extra={allowNew && schema ? { value: NEW_ENTRY, label: "New table…" } : undefined}
            loading={loading}
            disabled={!schema}
            empty="No tables in this schema."
          />
        )}
      </PickField>
    </>
  );
}

// ── Lakehouse: schema → table ───────────────────────────────────────────────

/**
 * Schema, then table, among the lakehouse schemas the signed-in user can
 * reach (owned and IAM-granted). A target sees only the schemas it may write
 * to - a mounted lake or Iceberg namespace is read-only - and may create a
 * new table. Columns arrive with the pick.
 */
export function LakehousePicker({
  token,
  schema,
  table,
  onChange,
  allowNew,
  withTable = true,
}: {
  token: string;
  schema: string;
  table: string;
  onChange: (v: { schema?: string; table?: string; columns?: string[] }) => void;
  allowNew?: boolean;
  /** False for a SQL-query source: only the schema is picked. */
  withTable?: boolean;
}) {
  const { enabled, schemas, tables, loaded, error } = useLakehouseTables(token);
  const offered = allowNew ? schemas.filter((s) => s.writable) : schemas;
  const inSchema = tables.filter((t) => t.schema === schema);
  const knownTable = inSchema.some((t) => t.table === table);
  const [newTable, setNewTable] = useState(false);
  useEffect(() => {
    if (loaded && table && !knownTable) setNewTable(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (loaded && !enabled) {
    return (
      <p className="text-[11px] text-red-500">
        The lakehouse isn&apos;t configured on this deployment — this node can&apos;t run.
      </p>
    );
  }
  return (
    <>
      <PickField label="Lakehouse schema">
        <Picker
          value={schema}
          onChange={(v) => onChange({ schema: v, table: "" })}
          placeholder="Choose a schema"
          options={offered.map((s) => ({
            value: s.name,
            label: s.name,
            hint: [
              plural(tables.filter((t) => t.schema === s.name).length, "table"),
              s.writable ? "" : "read-only mount",
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
          loading={!loaded}
          error={error}
          empty={
            allowNew
              ? "No schema you can write to — create one under Lakehouse."
              : "No lakehouse schemas you can reach — create one under Lakehouse, or ask for a share."
          }
        />
      </PickField>
      {withTable ? (
        <PickField label="Table">
          {newTable ? (
            <NameField
              value={table}
              onValue={(v) => onChange({ table: v.toLowerCase() })}
              placeholder="new_table"
              onPick={
                inSchema.length
                  ? () => {
                      setNewTable(false);
                      onChange({ table: "" });
                    }
                  : undefined
              }
            />
          ) : (
            <Picker
              value={knownTable ? table : ""}
              onChange={(v) => {
                if (v === NEW_ENTRY) {
                  setNewTable(true);
                  onChange({ table: "" });
                  return;
                }
                const t = inSchema.find((x) => x.table === v);
                onChange({ table: v, columns: t?.columns.map((c) => c.name) });
              }}
              placeholder={schema ? "Choose a table" : "Choose a schema first"}
              options={inSchema.map((t) => ({
                value: t.table,
                label: t.table,
                hint: plural(t.columns.length, "column"),
              }))}
              extra={allowNew && schema ? { value: NEW_ENTRY, label: "New table…" } : undefined}
              loading={!loaded}
              disabled={!schema}
              empty={allowNew ? "No tables yet — pick New table…" : "No tables in this schema."}
            />
          )}
        </PickField>
      ) : null}
    </>
  );
}

// ── Object storage: bucket → folder → dataset ───────────────────────────────

/** A crawled key split the way the picker shows it: the folder, and the entry in it. */
function splitKey(key: string): { folder: string; entry: string } {
  const k = key.replace(/^\.\//, "");
  const i = k.lastIndexOf("/");
  return i < 0 ? { folder: "", entry: k } : { folder: k.slice(0, i), entry: k.slice(i + 1) };
}

/**
 * The datasets the catalog crawled in the bucket, one folder at a time: the
 * folder, then the file or partitioned folder in it, with its format. A
 * custom path or glob stays one entry away for what the crawl has not seen.
 */
export function StoragePathPicker({
  token,
  sourceId,
  path,
  format,
  onChange,
}: {
  token: string;
  sourceId: string | undefined;
  path: string;
  format: string;
  onChange: (v: { path?: string; format?: SourceFileFormat; columns?: string[] }) => void;
}) {
  const { tables, loading, error } = useStorageTables(token, sourceId);
  const known = tables.find((t) => t.key === path);
  const folders = useMemo(
    () => [...new Set(tables.map((t) => splitKey(t.key).folder))].sort(),
    [tables],
  );
  const [folder, setFolder] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    if (loading) return;
    if (known) setFolder(splitKey(known.key).folder);
    else if (tables.length && path) setCustom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  const currentFolder = folder ?? (known ? splitKey(known.key).folder : null);
  const inFolder = tables.filter((t) => splitKey(t.key).folder === (currentFolder ?? ""));

  if (!sourceId) {
    return <p className="text-[11px] text-muted-foreground">Choose a bucket first.</p>;
  }
  if (custom) {
    return (
      <PickField
        label="Path or glob"
        hint="A key or glob under the bucket's prefix, e.g. raw/orders/*.csv."
      >
        <NameField
          value={path}
          onValue={(v) => onChange({ path: v })}
          placeholder="raw/orders/*.csv"
          onPick={
            tables.length
              ? () => {
                  setCustom(false);
                  onChange({ path: "" });
                }
              : undefined
          }
        />
      </PickField>
    );
  }
  return (
    <>
      <PickField label="Folder">
        <Picker
          value={currentFolder === null ? "" : currentFolder || ROOT_ENTRY}
          onChange={(v) => {
            if (v === CUSTOM_ENTRY) {
              setCustom(true);
              onChange({ path: "" });
              return;
            }
            setFolder(v === ROOT_ENTRY ? "" : v);
            onChange({ path: "" });
          }}
          placeholder="Choose a folder"
          options={folders.map((f) => ({
            value: f || ROOT_ENTRY,
            label: f || "(bucket root)",
            hint: plural(tables.filter((t) => splitKey(t.key).folder === f).length, "dataset"),
          }))}
          extra={{ value: CUSTOM_ENTRY, label: "Custom path or glob…" }}
          loading={loading}
          error={error}
          empty="The crawl found nothing readable here — pick Custom path or glob…"
        />
      </PickField>
      <PickField
        label="Dataset"
        hint="What the Data Catalog crawled in this folder. Re-crawl the source to see new files."
      >
        <Picker
          value={known ? known.key : ""}
          onChange={(v) => {
            if (v === CUSTOM_ENTRY) {
              setCustom(true);
              onChange({ path: "" });
              return;
            }
            const t = tables.find((x) => x.key === v);
            onChange({
              path: v,
              format: (t?.format as SourceFileFormat | undefined) ?? (format as SourceFileFormat),
              columns: t?.columns.map((c) => c.name),
            });
          }}
          placeholder={currentFolder === null ? "Choose a folder first" : "Choose a dataset"}
          options={inFolder.map((t) => ({
            value: t.key,
            label: splitKey(t.key).entry,
            hint: [t.format.toUpperCase(), fmtRows(t.row_count)].filter(Boolean).join(" · "),
          }))}
          extra={{ value: CUSTOM_ENTRY, label: "Custom path or glob…" }}
          loading={loading}
          disabled={currentFolder === null}
          empty="Nothing readable in this folder."
        />
      </PickField>
    </>
  );
}

/** Where a storage target writes, dataset/table pairs the crawl found: <bucket>/<dataset>/<table>/… */
function storageTargets(tables: StorageTable[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    const key = t.key.replace(/^\.\//, "");
    const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
    const parts = dir.split("/").filter((p) => p && p !== "*");
    if (parts.length === 0) continue;
    const dataset = parts[0];
    const table =
      parts.length >= 2 ? parts[1] : key.slice(key.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    if (!out.has(dataset)) out.set(dataset, new Set());
    if (table) out.get(dataset)?.add(table);
  }
  return out;
}

/**
 * Where a storage target writes: <bucket>/<dataset>/<table>/. Existing
 * datasets and tables come from the crawl; either can be new.
 */
export function StorageTargetPicker({
  token,
  sourceId,
  dataset,
  table,
  onChange,
}: {
  token: string;
  sourceId: string | undefined;
  dataset: string;
  table: string;
  onChange: (v: { dataset?: string; table?: string }) => void;
}) {
  const { tables, loading } = useStorageTables(token, sourceId);
  const map = useMemo(() => storageTargets(tables), [tables]);
  const datasets = [...map.keys()].sort();
  const inDataset = [...(map.get(dataset) ?? [])].sort();
  const knownDataset = map.has(dataset);
  const knownTable = inDataset.includes(table);
  const [newDataset, setNewDataset] = useState(false);
  const [newTable, setNewTable] = useState(false);
  useEffect(() => {
    if (loading) return;
    if (dataset && !knownDataset) setNewDataset(true);
    if (table && !knownTable && knownDataset) setNewTable(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  return (
    <div className="grid grid-cols-2 gap-2">
      <PickField label="Dataset">
        {newDataset || (!loading && datasets.length === 0) ? (
          <NameField
            value={dataset}
            onValue={(v) => onChange({ dataset: v })}
            placeholder="etl"
            onPick={
              datasets.length
                ? () => {
                    setNewDataset(false);
                    onChange({ dataset: "", table: "" });
                  }
                : undefined
            }
          />
        ) : (
          <Picker
            value={knownDataset ? dataset : ""}
            onChange={(v) => {
              if (v === NEW_ENTRY) {
                setNewDataset(true);
                onChange({ dataset: "", table: "" });
                return;
              }
              onChange({ dataset: v, table: "" });
            }}
            placeholder="Choose a dataset"
            options={datasets.map((d) => ({
              value: d,
              label: d,
              hint: plural(map.get(d)?.size ?? 0, "table"),
            }))}
            extra={{ value: NEW_ENTRY, label: "New dataset…" }}
            loading={loading}
            disabled={!sourceId}
          />
        )}
      </PickField>
      <PickField label="Table">
        {newDataset || newTable || (!loading && inDataset.length === 0) ? (
          <NameField
            value={table}
            onValue={(v) => onChange({ table: v })}
            placeholder="output"
            onPick={
              !newDataset && inDataset.length
                ? () => {
                    setNewTable(false);
                    onChange({ table: "" });
                  }
                : undefined
            }
          />
        ) : (
          <Picker
            value={knownTable ? table : ""}
            onChange={(v) => {
              if (v === NEW_ENTRY) {
                setNewTable(true);
                onChange({ table: "" });
                return;
              }
              onChange({ table: v });
            }}
            placeholder="Choose a table"
            options={inDataset.map((t) => ({ value: t, label: t }))}
            extra={{ value: NEW_ENTRY, label: "New table…" }}
            loading={loading}
            disabled={!dataset}
          />
        )}
      </PickField>
    </div>
  );
}

// ── Data Catalog: source → schema or folder → asset ─────────────────────────

const KIND_LABEL: Record<string, string> = {
  warehouse: "warehouse",
  object_storage: "bucket",
  iceberg_rest: "Iceberg catalog",
};

/**
 * Any asset the catalog crawled, one level at a time: the catalog source,
 * then its schema (a warehouse) or folder (a bucket), then the table, view,
 * file or dataset. Picking the asset resolves it to the source config the
 * compiler already knows and reports its columns. An Iceberg REST source is
 * listed but not pickable: its tables are read through a lakehouse mount,
 * and the entry says so.
 */
export function CatalogAssetPicker({
  token,
  assetId,
  onPick,
}: {
  token: string;
  assetId: string;
  onPick: (config: CatalogAssetSourceConfig, columns: string[]) => void;
}) {
  const connFn = useServerFn(listWarehouseConnections);
  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [assets, setAssets] = useState<CatalogAsset[]>([]);
  const [providers, setProviders] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      listCatalogSources().catch(() => [] as CatalogSource[]),
      listCatalogAssets().catch(() => [] as CatalogAsset[]),
      token
        ? connFn({ data: { access_token: token } }).catch(() => ({ ok: false as const }))
        : Promise.resolve({ ok: false as const }),
    ]).then(([s, a, c]) => {
      if (!alive) return;
      setSources(s);
      setAssets(a);
      if (c.ok) setProviders(new Map(c.connections.map((x) => [x.id, x.provider])));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const picked = assets.find((a) => a.id === assetId);
  // The levels above the picked asset follow it; a level chosen on its own
  // (before an asset is picked) is kept here.
  const [sourceSel, setSourceSel] = useState<string | null>(null);
  const [schemaSel, setSchemaSel] = useState<string | null>(null);
  const sourceId = sourceSel ?? picked?.source_id ?? "";
  const source = sources.find((s) => s.id === sourceId);
  const schemaOf = (a: CatalogAsset) => a.schema_name ?? "";
  const schema = schemaSel ?? (picked && picked.source_id === sourceId ? schemaOf(picked) : null);
  const inSource = useMemo(
    () => assets.filter((a) => a.source_id === sourceId),
    [assets, sourceId],
  );
  const schemas = useMemo(() => [...new Set(inSource.map(schemaOf))].sort(), [inSource]);
  const inSchema = useMemo(
    () => (schema === null ? [] : inSource.filter((a) => schemaOf(a) === schema)),
    [inSource, schema],
  );
  const resolved =
    picked && source && picked.source_id === source.id
      ? resolveCatalogAsset(picked, source, {
          provider: source.connection_id ? providers.get(source.connection_id) : undefined,
        })
      : null;
  const isBucket = source?.kind === "object_storage";

  return (
    <>
      <PickField label="Catalog source">
        <Picker
          value={sourceId}
          onChange={(v) => {
            setSourceSel(v);
            setSchemaSel(null);
          }}
          placeholder="Choose a catalog source"
          options={sources.map((s) => ({
            value: s.id,
            label: s.name,
            hint:
              s.kind === "iceberg_rest"
                ? "Iceberg catalog · read through a lakehouse mount"
                : `${KIND_LABEL[s.kind] ?? s.kind} · ${plural(
                    assets.filter((a) => a.source_id === s.id).length,
                    "asset",
                  )}`,
            disabled: s.kind === "iceberg_rest",
          }))}
          loading={!loaded}
          empty="The catalog has no sources yet. Add one under Data Catalog and crawl it."
        />
      </PickField>
      <PickField label={isBucket ? "Folder" : "Schema"}>
        <Picker
          value={schema === null ? "" : schema || ROOT_ENTRY}
          onChange={(v) => setSchemaSel(v === ROOT_ENTRY ? "" : v)}
          placeholder={
            sourceId ? `Choose a ${isBucket ? "folder" : "schema"}` : "Choose a source first"
          }
          options={schemas.map((s) => ({
            value: s || ROOT_ENTRY,
            label: s || (isBucket ? "(bucket root)" : "(no schema)"),
            hint: plural(inSource.filter((a) => schemaOf(a) === s).length, "asset"),
          }))}
          loading={!loaded}
          disabled={!sourceId}
          empty="This source has no crawled assets yet — crawl it under Data Catalog."
        />
      </PickField>
      <PickField
        label={isBucket ? "File or dataset" : "Table or view"}
        hint={
          resolved
            ? resolved.ok
              ? describeResolvedSource(resolved.resolved)
              : resolved.error
            : "Picking one reads it the way its source is read, with the same credentials and access checks."
        }
      >
        <Picker
          value={picked && schema !== null && schemaOf(picked) === schema ? picked.id : ""}
          onChange={(v) => {
            const asset = assets.find((a) => a.id === v);
            if (!asset || !source) return;
            const r = resolveCatalogAsset(asset, source, {
              provider: source.connection_id ? providers.get(source.connection_id) : undefined,
            });
            if (!r.ok) {
              toast.error(r.error);
              return;
            }
            onPick(
              {
                type: "catalog_asset",
                asset_id: asset.id,
                source_id: source.id,
                fqn: asset.fqn,
                source_name: source.name,
                resolved: r.resolved,
              },
              asset.columns.map((c) => c.name),
            );
          }}
          placeholder={
            schema === null
              ? `Choose a ${isBucket ? "folder" : "schema"} first`
              : `Choose a ${isBucket ? "file or dataset" : "table or view"}`
          }
          options={inSchema.map((a) => ({
            value: a.id,
            label: a.name,
            hint: [
              a.asset_type,
              a.format?.toUpperCase(),
              plural(a.columns.length, "col"),
              fmtRows(a.row_count),
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
          loading={!loaded}
          disabled={schema === null}
          empty="Nothing crawled here."
        />
      </PickField>
    </>
  );
}
