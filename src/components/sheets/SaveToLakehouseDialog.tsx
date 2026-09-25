// Save a sheet's data as a new lakehouse table, and (by default) put it in
// the data catalog, described and tagged, so others can find and use it.
// A table sheet saves what it shows; a grid saves a range whose first row
// names the columns.

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { RangeAddr } from "@/lib/sheets/a1";
import type { CellInput } from "@/lib/sheets/engine";
import { exportRows, rangeToTable, type ExportColumn, type ExportType } from "@/lib/sheets/export";
import type { Scalar } from "@/lib/sheets/formula/values";
import { describeRange } from "@/lib/sheets/ops";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";
import {
  sheetsRegisterTable,
  sheetsSaveGridAs,
  sheetsSaveTableAs,
  type SaveResult,
} from "@/utils/sheetsPublish.functions";
import { sheetsAddTableTab, sheetsTableSources } from "@/utils/sheetsTables.functions";
import type { SheetTabRow } from "@/utils/sheets.functions";
import { suggestTableName } from "@/lib/sheets/names";

const LAKE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const COLUMN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const TYPES: ExportType[] = ["VARCHAR", "DOUBLE", "BIGINT", "BOOLEAN", "DATE", "TIMESTAMP"];

export type SaveSource =
  | { kind: "table"; tabId: string; tabName: string; config: TableConfig }
  | {
      kind: "grid";
      tabId: string;
      tabName: string;
      range: RangeAddr;
      get: (row: number, col: number) => { v: Scalar; input: CellInput | undefined };
    };

function lakeName(text: string): string {
  const n = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return (n || "sheet_output").slice(0, 63);
}

export function SaveToLakehouseDialog({
  open,
  onOpenChange,
  token,
  workbookId,
  takenSheetNames,
  source,
  onOpenedTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  workbookId: string;
  takenSheetNames: string[];
  source: SaveSource;
  onOpenedTab: (tab: SheetTabRow) => void;
}) {
  const sourcesFn = useServerFn(sheetsTableSources);
  const saveTableFn = useServerFn(sheetsSaveTableAs);
  const saveGridFn = useServerFn(sheetsSaveGridAs);
  const addTabFn = useServerFn(sheetsAddTableTab);
  const registerFn = useServerFn(sheetsRegisterTable);
  const [registering, setRegistering] = useState(false);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schema, setSchema] = useState("");
  const [table, setTable] = useState(lakeName(source.tabName));
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [register, setRegister] = useState(true);
  const [certify, setCertify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SaveResult | null>(null);
  const [opening, setOpening] = useState(false);

  // A grid range's columns, with names and types the person can change.
  const initial = useMemo(
    () => (source.kind === "grid" ? rangeToTable(source.range, source.get) : null),
    // The range is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [columns, setColumns] = useState<ExportColumn[]>(initial?.columns ?? []);

  useEffect(() => {
    if (!open) return;
    sourcesFn({ data: { access_token: token } })
      .then((r) => {
        if (!r.ok) return setLoadError(r.error);
        const w = r.schemas.filter((s) => s.writable).map((s) => s.name);
        setSchemas(w);
        setSchema((cur) => cur || w[0] || "");
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [open, sourcesFn, token]);

  const problem = (() => {
    if (!schema) {
      return schemas && !schemas.length
        ? "You own no lakehouse schema to save into; create one on the Lakehouse page"
        : "Pick a schema";
    }
    if (!LAKE_NAME.test(table)) {
      return "The table name is lowercase letters, digits and _, starting with a letter";
    }
    if (source.kind === "grid") {
      if (source.range.r1 <= source.range.r0) {
        return "Select the header row and at least one row of data";
      }
      const names = columns.map((c) => c.name);
      const bad = names.find((n) => !COLUMN_NAME.test(n));
      if (bad !== undefined) return `"${bad}" is not a column name (lowercase, digits, _)`;
      if (new Set(names).size !== names.length) return "Two columns have the same name";
    }
    return null;
  })();

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const meta = {
        description: description.trim() || undefined,
        tags: tagList.length ? tagList : undefined,
        register,
        certify: register && certify,
      };
      const r =
        source.kind === "table"
          ? await saveTableFn({
              data: {
                access_token: token,
                tab_id: source.tabId,
                config: source.config,
                target_schema: schema,
                target_table: table,
                ...meta,
              },
            })
          : await saveGridFn({
              data: {
                access_token: token,
                tab_id: source.tabId,
                columns: columns.map((c) => ({ name: c.name, type: c.type })),
                rows: exportRows(source.range, source.get, columns),
                target_schema: schema,
                target_table: table,
                ...meta,
              },
            });
      if (!r.ok) return setError(r.error);
      setDone(r);
      toast.success(`Saved ${r.fqn} (${r.rows.toLocaleString()} rows)`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** The table saved but the catalog step failed: try that step again on its own. */
  const retryRegister = async () => {
    if (!done) return;
    setRegistering(true);
    try {
      const [s, t] = done.fqn.split(".");
      const r = await registerFn({
        data: {
          access_token: token,
          schema: s,
          table: t,
          description: description.trim() || undefined,
          tags: tagList.length ? tagList : undefined,
          certify,
        },
      });
      setDone({
        ...done,
        catalog: r.ok ? { source_id: r.source_id, asset_id: r.asset_id } : { error: r.error },
      });
      if (r.ok) toast.success(`${done.fqn} is in the data catalog`);
    } catch (e) {
      setDone({ ...done, catalog: { error: (e as Error).message } });
    } finally {
      setRegistering(false);
    }
  };

  const openAsSheet = async () => {
    if (!done) return;
    setOpening(true);
    try {
      const [s, t] = done.fqn.split(".");
      const r = await addTabFn({
        data: {
          access_token: token,
          workbook_id: workbookId,
          name: suggestTableName(t, new Set(takenSheetNames.map((n) => n.toLowerCase()))),
          schema: s,
          table: t,
        },
      });
      if (!r.ok) return void toast.error(r.error);
      onOpenedTab(r.tab);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const rowCount =
    source.kind === "grid"
      ? initial
        ? exportRows(source.range, source.get, columns).length
        : 0
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Save to the lakehouse</DialogTitle>
          <DialogDescription>
            {source.kind === "table"
              ? "Saves what this sheet shows (calculated columns, filters and sort applied, hidden columns left out) as a new table."
              : `Saves ${describeRange(source.range)} of ${source.tabName} as a new table: the first row names the columns, the values are what the sheet computed.`}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="grid gap-3 text-sm" data-testid="save-result">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Saved{" "}
              <code className="font-mono">{done.fqn}</code> — {done.rows.toLocaleString()} rows
            </p>
            {done.catalog && "error" in done.catalog && (
              <div className="grid gap-2">
                <p className="text-destructive">
                  The table is saved, but it was not added to the catalog: {done.catalog.error}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  disabled={registering}
                  onClick={() => void retryRegister()}
                >
                  {registering && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Try adding it
                  to the catalog again
                </Button>
              </div>
            )}
            {done.catalog && "asset_id" in done.catalog && (
              <p className="text-muted-foreground">
                In the data catalog with its columns, owner
                {tagList.length ? ", tags" : ""}
                {description ? ", description" : ""} and lineage. The rest of the lakehouse source
                is being re-crawled in the background.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void openAsSheet()} disabled={opening}>
                {opening && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Open it as a table
                sheet
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/lakehouse">Open the Lakehouse</Link>
              </Button>
              {done.catalog && "asset_id" in done.catalog && (
                <Button size="sm" variant="outline" asChild>
                  <Link to="/data-sql">Open the Data Catalog</Link>
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            <div className="grid gap-1">
              <Label>New table</Label>
              <div className="flex gap-1">
                <Select value={schema} onValueChange={setSchema}>
                  <SelectTrigger className="w-44" aria-label="Schema">
                    <SelectValue placeholder={schemas === null ? "Reading…" : "schema"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(schemas ?? []).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Table name"
                  className="font-mono"
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                A new table; saving never replaces one. Pick another name if it exists.
              </p>
            </div>

            {source.kind === "grid" && (
              <div className="grid gap-1">
                <Label>
                  Columns{" "}
                  <span className="font-normal text-muted-foreground">
                    · {rowCount?.toLocaleString()} rows
                  </span>
                </Label>
                <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 font-medium">Header</th>
                        <th className="px-2 py-1 font-medium">Column name</th>
                        <th className="px-2 py-1 font-medium">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((c, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="max-w-40 truncate px-2 py-1">{c.header || "—"}</td>
                          <td className="px-2 py-1">
                            <Input
                              className={cn(
                                "h-7 font-mono text-xs",
                                !COLUMN_NAME.test(c.name) && "border-destructive",
                              )}
                              aria-label={`Column ${i + 1} name`}
                              value={c.name}
                              onChange={(e) =>
                                setColumns(
                                  columns.map((x, j) =>
                                    j === i ? { ...x, name: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Select
                              value={c.type}
                              onValueChange={(v) =>
                                setColumns(
                                  columns.map((x, j) =>
                                    j === i ? { ...x, type: v as ExportType } : x,
                                  ),
                                )
                              }
                            >
                              <SelectTrigger
                                className="h-7 w-32 text-xs"
                                aria-label={`Column ${i + 1} type`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {TYPES.map((t) => (
                                  <SelectItem key={t} value={t} className="text-xs">
                                    {t}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={register} onCheckedChange={(c) => setRegister(Boolean(c))} />
              Add it to the data catalog, ready for others to find and use
            </label>
            {register && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label htmlFor="save-desc">Description</Label>
                  <Textarea
                    id="save-desc"
                    rows={3}
                    value={description}
                    placeholder="What this table holds and how it was made"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="save-tags">Tags</Label>
                  <Input
                    id="save-tags"
                    value={tags}
                    placeholder="finance, monthly"
                    onChange={(e) => setTags(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated. It is also tagged <code>sheets</code>.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <Checkbox checked={certify} onCheckedChange={(c) => setCertify(Boolean(c))} />
                  Mark it certified, ready for others to rely on (a draft otherwise)
                </label>
              </div>
            )}
            {(error || (problem && table)) && (
              <p className="text-sm text-destructive" role="alert">
                {error ?? problem}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button onClick={() => void save()} disabled={Boolean(problem) || busy}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save table
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
