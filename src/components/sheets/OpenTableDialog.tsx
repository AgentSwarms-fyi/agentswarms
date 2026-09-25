// Add a table sheet: a lakehouse table, a table from the data catalog, a
// table or query from a connected database, or an uploaded CSV. Everything
// that is not already in the lakehouse lands there first, as a new table in a
// schema the person owns; the sheet then reads that table.

import { useEffect, useMemo, useState } from "react";
import { useTokenRef } from "@/hooks/use-token-ref";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen, Database, FileUp, Loader2, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { suggestTableName, tableNameProblem } from "@/lib/sheets/names";
import {
  sheetsAddTableTab,
  sheetsCatalogAssets,
  sheetsConnectionTables,
  sheetsImportCsv,
  sheetsImportFromConnection,
  sheetsOpenCatalogAsset,
  sheetsTableSources,
  type SheetCatalogAsset,
  type SheetSourceTable,
} from "@/utils/sheetsTables.functions";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import type { SheetTabRow } from "@/utils/sheets.functions";

type Mode = "lakehouse" | "catalog" | "connection" | "upload";

const MODES: { id: Mode; label: string; icon: typeof Database }[] = [
  { id: "lakehouse", label: "Lakehouse", icon: Database },
  { id: "catalog", label: "Data catalog", icon: BookOpen },
  { id: "connection", label: "Connection", icon: Plug },
  { id: "upload", label: "Upload CSV", icon: FileUp },
];

/** "Orders 2024.csv" → "orders_2024": a lakehouse table name. */
function lakeName(text: string): string {
  const n = text
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return (n || "sheet_import").slice(0, 63);
}

const LAKE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function OpenTableDialog({
  open,
  onOpenChange,
  token,
  workbookId,
  takenNames,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  workbookId: string;
  takenNames: string[];
  onOpened: (tab: SheetTabRow) => void;
}) {
  const sourcesFn = useServerFn(sheetsTableSources);
  const addFn = useServerFn(sheetsAddTableTab);
  const catalogFn = useServerFn(sheetsCatalogAssets);
  const openAssetFn = useServerFn(sheetsOpenCatalogAsset);
  const connsFn = useServerFn(listWarehouseConnections);
  const connTablesFn = useServerFn(sheetsConnectionTables);
  const { tokenRef, signedIn } = useTokenRef(token);
  const importFn = useServerFn(sheetsImportFromConnection);
  const csvFn = useServerFn(sheetsImportCsv);

  const [mode, setMode] = useState<Mode>("lakehouse");
  const [tables, setTables] = useState<SheetSourceTable[] | null>(null);
  const [schemas, setSchemas] = useState<{ name: string; writable: boolean }[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<SheetSourceTable | null>(null);
  const [assets, setAssets] = useState<SheetCatalogAsset[] | null>(null);
  const [asset, setAsset] = useState<SheetCatalogAsset | null>(null);
  const [conns, setConns] = useState<{ id: string; name: string; provider: string }[] | null>(null);
  const [connId, setConnId] = useState<string>("");
  const [connTables, setConnTables] = useState<{ schema: string; name: string }[] | null>(null);
  const [connTable, setConnTable] = useState<{ schema: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [targetSchema, setTargetSchema] = useState("");
  const [targetTable, setTargetTable] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = useMemo(() => new Set(takenNames.map((n) => n.toLowerCase())), [takenNames]);
  const writable = schemas.filter((s) => s.writable);

  // The lakehouse (tables and the schemas an import may land in) is read once.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    sourcesFn({ data: { access_token: token } })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) return setLoadError(r.error);
        setEnabled(r.enabled);
        setTables(r.tables);
        setSchemas(r.schemas);
        const first = r.schemas.find((s) => s.writable);
        if (first) setTargetSchema((cur) => cur || first.name);
      })
      .catch((e) => !cancelled && setLoadError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [open, sourcesFn, token]);

  useEffect(() => {
    if (!open || mode !== "catalog") return;
    let cancelled = false;
    const t = setTimeout(() => {
      catalogFn({ data: { access_token: token, search: search.trim() || undefined } })
        .then((r) => {
          if (cancelled) return;
          if (!r.ok) return setLoadError(r.error);
          setLoadError(null);
          setAssets(r.assets);
        })
        .catch((e) => !cancelled && setLoadError((e as Error).message));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, mode, search, catalogFn, token]);

  useEffect(() => {
    if (!open || mode !== "connection" || conns) return;
    connsFn({ data: { access_token: token } })
      .then((r) => {
        if (!r.ok) return setLoadError(r.error);
        setConns(
          r.connections
            .filter((c) => c.is_active && c.provider !== "lakehouse")
            .map((c) => ({ id: c.id, name: c.name, provider: c.provider })),
        );
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [open, mode, conns, connsFn, token]);

  // A connection's tables are listed when it is picked, not when the session
  // refreshes (R125): that cleared the table picked and hid the names typed
  // for it, and picking it again replaced them with fresh suggestions.
  useEffect(() => {
    if (!connId) return;
    let cancelled = false;
    setConnTables(null);
    setConnTable(null);
    connTablesFn({ data: { access_token: tokenRef.current, connection_id: connId } })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) return setError(r.error);
        setConnTables(r.tables);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, connTablesFn, signedIn]);

  const shownTables = useMemo(
    () =>
      (tables ?? []).filter((t) =>
        `${t.schema}.${t.table}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [tables, search],
  );
  const shownConnTables = useMemo(
    () =>
      (connTables ?? []).filter((t) =>
        `${t.schema}.${t.name}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [connTables, search],
  );

  const choose = (baseName: string) => {
    setName(suggestTableName(baseName, taken));
    setTargetTable(lakeName(baseName));
    setError(null);
  };

  // Does this choice copy rows into the lakehouse (and so need a target)?
  const importing =
    mode === "connection" ||
    mode === "upload" ||
    (mode === "catalog" && asset?.via === "warehouse");

  const nameProblem = name
    ? (tableNameProblem(name) ??
      (taken.has(name.trim().toLowerCase())
        ? `This workbook already has a sheet named "${name.trim()}"`
        : null))
    : "Name the sheet";
  const targetProblem = !importing
    ? null
    : !targetSchema
      ? tables === null && !loadError
        ? "Reading your schemas…"
        : writable.length
          ? "Pick the schema it lands in"
          : "You own no lakehouse schema to import into; create one on the Lakehouse page"
      : !LAKE_NAME.test(targetTable)
        ? "The lakehouse table name is lowercase letters, digits and _, starting with a letter"
        : null;
  const chosen =
    mode === "lakehouse"
      ? Boolean(picked)
      : mode === "catalog"
        ? Boolean(asset && asset.via !== "unsupported")
        : mode === "connection"
          ? Boolean(connId && (connTable || query.trim()))
          : Boolean(file);

  const go = async () => {
    if (!chosen || nameProblem || targetProblem) return;
    setBusy(true);
    setError(null);
    try {
      let r: { ok: true; tab: SheetTabRow; rows?: number } | { ok: false; error: string };
      if (mode === "lakehouse") {
        r = await addFn({
          data: {
            access_token: token,
            workbook_id: workbookId,
            name: name.trim(),
            schema: picked!.schema,
            table: picked!.table,
          },
        });
      } else if (mode === "catalog") {
        r = await openAssetFn({
          data: {
            access_token: token,
            workbook_id: workbookId,
            asset_id: asset!.id,
            sheet_name: name.trim(),
            ...(asset!.via === "warehouse"
              ? { target_schema: targetSchema, target_table: targetTable }
              : {}),
          },
        });
      } else if (mode === "connection") {
        r = await importFn({
          data: {
            access_token: token,
            workbook_id: workbookId,
            connection_id: connId,
            ...(query.trim() ? { query: query.trim() } : { table: connTable! }),
            target_schema: targetSchema,
            target_table: targetTable,
            sheet_name: name.trim(),
          },
        });
      } else {
        const csv = await file!.text();
        r = await csvFn({
          data: {
            access_token: token,
            workbook_id: workbookId,
            filename: file!.name,
            csv,
            target_schema: targetSchema,
            target_table: targetTable,
            sheet_name: name.trim(),
          },
        });
      }
      if (!r.ok) return setError(r.error);
      if (r.rows !== undefined) {
        toast.success(
          `Imported ${r.rows.toLocaleString()} rows into ${targetSchema}.${targetTable}`,
        );
      }
      onOpened(r.tab);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const listClass = "max-h-56 overflow-y-auto rounded-md border border-border";
  const rowClass = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
      active ? "bg-primary/15" : "hover:bg-muted",
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a table sheet</DialogTitle>
          <DialogDescription>
            A table sheet reads its rows from the lakehouse, so it can be as large as the lakehouse
            holds. Data from a connection or a file is copied into a new lakehouse table first.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border" role="tablist">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm",
                mode === m.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setMode(m.id);
                setSearch("");
                setError(null);
                setLoadError(null);
              }}
            >
              <m.icon className="h-3.5 w-3.5" /> {m.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3">
          {mode !== "upload" && (mode !== "connection" || connId) && (
            <Input
              placeholder={mode === "catalog" ? "Search the catalog" : "Search tables"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          )}
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}

          {mode === "lakehouse" && (
            <div className={listClass} role="listbox" aria-label="Lakehouse tables">
              {!tables && !loadError && (
                <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading the lakehouse…
                </p>
              )}
              {tables && !enabled && (
                <p className="p-3 text-sm text-muted-foreground">
                  The lakehouse is not configured on this instance.
                </p>
              )}
              {tables && enabled && !shownTables.length && (
                <p className="p-3 text-sm text-muted-foreground">
                  {tables.length ? "No table matches." : "You can't read any lakehouse table yet."}
                </p>
              )}
              {shownTables.map((t) => {
                const key = `${t.schema}.${t.table}`;
                const active = Boolean(picked && `${picked.schema}.${picked.table}` === key);
                return (
                  <button
                    key={key}
                    role="option"
                    aria-selected={active}
                    className={rowClass(active)}
                    onClick={() => {
                      setPicked(t);
                      choose(t.table);
                    }}
                  >
                    <Database className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono">{key}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t.columns} columns
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {mode === "catalog" && (
            <div className={listClass} role="listbox" aria-label="Catalog tables">
              {!assets && !loadError && (
                <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading the catalog…
                </p>
              )}
              {assets && !assets.length && (
                <p className="p-3 text-sm text-muted-foreground">
                  {search ? "No catalog table matches." : "Nothing in the catalog you can see yet."}
                </p>
              )}
              {assets?.map((a) => (
                <button
                  key={a.id}
                  role="option"
                  aria-selected={asset?.id === a.id}
                  disabled={a.via === "unsupported"}
                  className={cn(
                    rowClass(asset?.id === a.id),
                    a.via === "unsupported" && "opacity-50",
                  )}
                  title={
                    a.via === "unsupported"
                      ? "Files in object storage open through an ETL pipeline into the lakehouse"
                      : (a.description ?? undefined)
                  }
                  onClick={() => {
                    setAsset(a);
                    choose(a.name);
                  }}
                >
                  <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate font-mono">{a.fqn}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {a.via === "lakehouse"
                      ? "lakehouse"
                      : a.via === "warehouse"
                        ? `import from ${a.source}`
                        : "not a table"}
                  </span>
                </button>
              ))}
            </div>
          )}

          {mode === "connection" && (
            <>
              <div className="grid gap-1">
                <Label>Connection</Label>
                <Select value={connId} onValueChange={setConnId}>
                  <SelectTrigger aria-label="Connection">
                    <SelectValue
                      placeholder={conns === null ? "Reading connections…" : "Pick a connection"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(conns ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.provider})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {conns && !conns.length && (
                  <p className="text-xs text-muted-foreground">
                    No database connections yet. Add one under{" "}
                    <Link to="/integrations" className="text-primary hover:underline">
                      Integrations → Data Sources
                    </Link>
                    .
                  </p>
                )}
              </div>
              {connId && (
                <>
                  <div className={cn(listClass, "max-h-40")} role="listbox" aria-label="Tables">
                    {!connTables && (
                      <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Listing tables…
                      </p>
                    )}
                    {shownConnTables.slice(0, 300).map((t) => {
                      const active =
                        connTable?.schema === t.schema && connTable?.name === t.name && !query;
                      return (
                        <button
                          key={`${t.schema}.${t.name}`}
                          role="option"
                          aria-selected={active}
                          className={rowClass(active)}
                          onClick={() => {
                            setConnTable(t);
                            setQuery("");
                            choose(t.name);
                          }}
                        >
                          <span className="font-mono">
                            {t.schema}.{t.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="import-query">…or a query (read-only)</Label>
                    <Textarea
                      id="import-query"
                      className="font-mono text-xs"
                      rows={3}
                      placeholder="SELECT region, product, amount FROM sales.orders WHERE year = 2024"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        if (e.target.value.trim() && !name) choose("query_result");
                      }}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {mode === "upload" && (
            <div className="grid gap-1">
              <Label htmlFor="import-file">CSV file (first row is the header)</Label>
              <Input
                id="import-file"
                type="file"
                accept=".csv,text/csv,.tsv,text/tab-separated-values,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f) choose(f.name.replace(/\.[A-Za-z0-9]+$/, ""));
                }}
              />
              {file && (
                <p className="text-xs text-muted-foreground">
                  {file.name} · {(file.size / 1_048_576).toFixed(2)} MB
                </p>
              )}
            </div>
          )}

          {chosen && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label htmlFor="table-sheet-name">Sheet name (used in formulas)</Label>
                <Input
                  id="table-sheet-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {nameProblem ?? (
                    <>
                      Formulas refer to it as{" "}
                      <code className="font-mono">{name.trim()}[column]</code>
                    </>
                  )}
                </p>
              </div>
              {importing && (
                <div className="grid gap-1">
                  <Label>Lands in the lakehouse as</Label>
                  <div className="flex gap-1">
                    <Select value={targetSchema} onValueChange={setTargetSchema}>
                      <SelectTrigger className="w-40" aria-label="Target schema">
                        <SelectValue placeholder="schema" />
                      </SelectTrigger>
                      <SelectContent>
                        {writable.map((s) => (
                          <SelectItem key={s.name} value={s.name}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label="Target table"
                      className="font-mono"
                      value={targetTable}
                      onChange={(e) => setTargetTable(e.target.value)}
                    />
                  </div>
                  <p
                    className={cn(
                      "text-xs",
                      targetProblem && !targetProblem.startsWith("Reading")
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {targetProblem ?? "A new table; an import never replaces one."}
                  </p>
                </div>
              )}
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void go()}
            disabled={!chosen || Boolean(nameProblem) || Boolean(targetProblem) || busy}
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {importing ? "Import and open" : "Open table"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
