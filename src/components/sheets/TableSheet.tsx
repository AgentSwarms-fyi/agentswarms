// A table sheet: a lakehouse table in the workbook, as many rows as it has.
//
// Rows arrive a page at a time as they scroll into view; the engine sorts,
// filters and computes the calculated columns (an Excel formula per column,
// compiled to SQL), so a table of millions of rows scrolls like a small one.
// Settings are saved with the workbook; the rows themselves stay in the
// lakehouse and are never copied into the sheet.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  ChevronDown,
  Database,
  LayoutGrid,
  EyeOff,
  Filter,
  Hash,
  Loader2,
  Plus,
  RefreshCw,
  Sigma,
  ToggleLeft,
  Type,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { formatGeneral } from "@/lib/sheets/formula/values";
import { toTsv } from "@/lib/sheets/ops";
import type { ColKind } from "@/lib/sheets/sql/compile";
import {
  describeFilter,
  sourceLabel,
  type TableColumn,
  type TableConfig,
  type TableFilter,
} from "@/lib/sheets/sql/tableQuery";
import { sheetsRefreshImport, sheetsTablePage } from "@/utils/sheetsTables.functions";
import { CalculatedColumnDialog } from "./CalculatedColumnDialog";
import { PivotDialog } from "./PivotDialog";
import { SaveToLakehouseDialog } from "./SaveToLakehouseDialog";
import { TableFilterPopover } from "./TableFilterPopover";
import type { TabMeta, useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;
type Row = (string | number | boolean | null)[];

const ROW_H = 26;
const HEADER_H = 30;
const NUM_W = 64;
const DEFAULT_W = 140;

const KIND_ICON: Record<ColKind, typeof Hash> = {
  number: Hash,
  text: Type,
  bool: ToggleLeft,
  date: Calendar,
  datetime: Calendar,
  other: Type,
};

function show(v: string | number | boolean | null, kind: ColKind): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatGeneral(v);
  if (kind === "number" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v)) {
    const n = Number(v);
    // BIGINT and DECIMAL arrive as text to keep their digits; show them whole.
    return Number.isSafeInteger(n) || !Number.isInteger(n) ? formatGeneral(n) : v;
  }
  return String(v);
}

export function TableSheet({
  wb,
  tab,
  token,
  config,
  pageRows,
  status,
}: {
  wb: Workbook;
  tab: TabMeta;
  token: string;
  config: TableConfig;
  pageRows: number;
  /** The save state, shown in the toolbar. */
  status?: React.ReactNode;
}) {
  const pageFn = useServerFn(sheetsTablePage);
  const refreshImportFn = useServerFn(sheetsRefreshImport);
  const [reimporting, setReimporting] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pivotOpen, setPivotOpen] = useState<"new" | "edit" | null>(null);
  // A pivot's table, by name (it may have been renamed or deleted since).
  const pivotSource = config.source.kind === "pivot" ? config.source.from.toLowerCase() : null;
  const pivotFrom = pivotSource
    ? wb.tabs.find((t) => t.kind === "table" && t.name.toLowerCase() === pivotSource)
    : undefined;
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState<Map<number, Row[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [calcDialog, setCalcDialog] = useState<{ index: number | null } | null>(null);
  const [sel, setSel] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const inFlight = useRef<Set<number>>(new Set());
  const gen = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // What changes the rows (not widths or hidden columns).
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        s: config.source,
        c: config.columns,
        k: config.calculated,
        o: config.sort,
        f: config.filters,
      }),
    [config.source, config.columns, config.calculated, config.sort, config.filters],
  );

  const setConfig = useCallback(
    (patch: Partial<TableConfig>) => wb.setTableConfig(tab.id, { ...configRef.current, ...patch }),
    [wb, tab.id],
  );

  const fetchPage = useCallback(
    async (page: number, g: number) => {
      if (inFlight.current.has(page)) return;
      inFlight.current.add(page);
      setLoading(true);
      try {
        const r = await pageFn({
          data: {
            access_token: token,
            tab_id: tab.id,
            config: configRef.current,
            offset: page * pageRows,
            limit: pageRows,
          },
        });
        if (g !== gen.current) return; // settings changed meanwhile
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setError(null);
        setColumns(r.columns);
        setTotal(r.total);
        setDuration(r.duration_ms);
        setPages((prev) => new Map(prev).set(page, r.rows));
        if (r.sourceColumns) {
          // The table changed shape in the lakehouse; keep the sheet in step.
          wb.setTableConfig(tab.id, { ...configRef.current, columns: r.sourceColumns });
          toast.info(`${sourceLabel(configRef.current.source)} has different columns now`);
        }
      } catch (e) {
        if (g === gen.current) setError((e as Error).message);
      } finally {
        inFlight.current.delete(page);
        if (g === gen.current) setLoading(inFlight.current.size > 0);
      }
    },
    [pageFn, token, tab.id, pageRows, wb],
  );

  // New settings: start over from the first page.
  useEffect(() => {
    gen.current += 1;
    inFlight.current.clear();
    setPages(new Map());
    setSel(null);
    void fetchPage(0, gen.current);
  }, [queryKey, fetchPage]);

  const refresh = () => {
    gen.current += 1;
    inFlight.current.clear();
    setPages(new Map());
    void fetchPage(0, gen.current);
    // The rows may have changed: grid formulas over this table ask again.
    wb.tableDataChanged(tab.id);
  };

  /** Run the connection's query again and replace the imported table's rows. */
  const reimport = async () => {
    const o = config.origin;
    if (o?.kind !== "warehouse") return;
    const ok = await confirmAsk({
      title: `Refresh from ${o.connection_name}?`,
      body: `Runs the import again and replaces the rows of ${sourceLabel(config.source)}, the table this sheet imported into. Anything else reading that table sees the new rows.`,
      actionLabel: "Refresh from source",
    });
    if (!ok) return;
    setReimporting(true);
    try {
      const r = await refreshImportFn({ data: { access_token: token, tab_id: tab.id } });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Refreshed: ${r.rows.toLocaleString()} rows from ${o.connection_name}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReimporting(false);
    }
  };

  const hidden = useMemo(() => new Set(config.hidden.map((h) => h.toLowerCase())), [config.hidden]);
  const visible = useMemo(
    () => columns.map((c, i) => ({ c, i })).filter(({ c }) => !hidden.has(c.name.toLowerCase())),
    [columns, hidden],
  );
  const widthOf = useCallback((name: string) => config.widths[name] ?? DEFAULT_W, [config.widths]);
  const offsets = useMemo(() => {
    const out = [NUM_W];
    for (const { c } of visible) out.push(out[out.length - 1] + widthOf(c.name));
    return out;
  }, [visible, widthOf]);
  const totalW = offsets[offsets.length - 1];

  const rowV = useVirtualizer({
    count: total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });
  const vRows = rowV.getVirtualItems();

  // Fetch the pages the visible rows are on.
  useEffect(() => {
    if (!vRows.length) return;
    const first = Math.floor(vRows[0].index / pageRows);
    const last = Math.floor(vRows[vRows.length - 1].index / pageRows);
    for (let p = first; p <= last; p++) {
      if (!pages.has(p)) void fetchPage(p, gen.current);
    }
  }, [vRows, pages, pageRows, fetchPage]);

  const rowAt = (index: number): Row | undefined =>
    pages.get(Math.floor(index / pageRows))?.[index % pageRows];

  // ── Column actions ───────────────────────────────────────────────────────

  const sortBy = (name: string, desc: boolean | null) => {
    const rest = config.sort.filter((s) => s.column.toLowerCase() !== name.toLowerCase());
    setConfig({ sort: desc === null ? rest : [{ column: name, desc }, ...rest].slice(0, 3) });
  };
  const setFilter = (name: string, f: TableFilter | null) => {
    const rest = config.filters.filter((x) => x.column.toLowerCase() !== name.toLowerCase());
    setConfig({ filters: f ? [...rest, f] : rest });
  };
  const hide = (name: string) => setConfig({ hidden: [...config.hidden, name] });
  const removeCalc = async (name: string) => {
    const users = config.calculated.filter(
      (c) => c.name !== name && c.formula.toLowerCase().includes(`[@${name.toLowerCase()}]`),
    );
    const ok = await confirmAsk({
      title: `Delete the column "${name}"?`,
      body: users.length
        ? `${users.map((u) => u.name).join(", ")} use${users.length === 1 ? "s" : ""} it and will show an error until changed.`
        : "Its formula goes with it. The table in the lakehouse is not changed.",
      actionLabel: "Delete column",
    });
    if (!ok) return;
    setConfig({
      calculated: config.calculated.filter((c) => c.name !== name),
      sort: config.sort.filter((s) => s.column !== name),
      filters: config.filters.filter((f) => f.column !== name),
    });
  };

  const startResize = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(name);
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.max(48, Math.min(1200, startW + ev.clientX - startX));
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-col-head="${CSS.escape(name)}"]`,
      );
      if (el) el.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (w !== startW) setConfig({ widths: { ...config.widths, [name]: Math.round(w) } });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ── Selection and copy ──────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!sel || total === null) return;
    const mod = e.ctrlKey || e.metaKey;
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (arrows[e.key]) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      const r = Math.max(0, Math.min(total - 1, sel.r1 + dr));
      const c = Math.max(0, Math.min(visible.length - 1, sel.c1 + dc));
      setSel(e.shiftKey ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
      rowV.scrollToIndex(r);
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      const r0 = Math.min(sel.r0, sel.r1);
      const r1 = Math.max(sel.r0, sel.r1);
      const c0 = Math.min(sel.c0, sel.c1);
      const c1 = Math.max(sel.c0, sel.c1);
      const out: string[][] = [];
      let missing = 0;
      for (let r = r0; r <= r1 && out.length < 100_000; r++) {
        const row = rowAt(r);
        if (!row) {
          missing++;
          continue;
        }
        const line: string[] = [];
        for (let c = c0; c <= c1; c++) {
          const { c: col, i } = visible[c];
          line.push(show(row[i + 1], col.kind));
        }
        out.push(line);
      }
      void navigator.clipboard
        .writeText(toTsv(out))
        .then(() =>
          toast.success(
            missing
              ? `Copied ${out.length.toLocaleString()} rows; ${missing.toLocaleString()} not loaded yet were left out`
              : `Copied ${out.length.toLocaleString()} row${out.length === 1 ? "" : "s"}`,
          ),
        )
        .catch(() => toast.error("The browser refused clipboard access"));
    }
  };

  const inSel = (r: number, c: number) =>
    sel !== null &&
    r >= Math.min(sel.r0, sel.r1) &&
    r <= Math.max(sel.r0, sel.r1) &&
    c >= Math.min(sel.c0, sel.c1) &&
    c <= Math.max(sel.c0, sel.c1);

  const sortOf = (name: string) =>
    config.sort.find((s) => s.column.toLowerCase() === name.toLowerCase());
  const filterOf = (name: string) =>
    config.filters.find((f) => f.column.toLowerCase() === name.toLowerCase());

  const origin = config.origin;
  const label = sourceLabel(config.source);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="table-sheet">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2 py-1 text-xs">
        <span className="font-mono text-foreground" title="The lakehouse table this sheet reads">
          {label}
        </span>
        {origin && origin.kind === "warehouse" && (
          <>
            <span className="text-muted-foreground">from {origin.connection_name}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={reimporting}
              onClick={() => void reimport()}
              title="Run the import again and replace the imported table's rows"
            >
              {reimporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}{" "}
              Refresh from source
            </Button>
          </>
        )}
        {origin && origin.kind === "upload" && (
          <span className="text-muted-foreground">from {origin.filename}</span>
        )}
        <span className="text-muted-foreground" data-testid="table-row-count">
          {total === null ? "…" : `${total.toLocaleString()} row${total === 1 ? "" : "s"}`}
          {config.filters.length > 0 && total !== null ? " (filtered)" : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={refresh}
          title="Read the table again"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setCalcDialog({ index: null })}
        >
          <Plus className="h-3.5 w-3.5" /> Column
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setPivotOpen("new")}
          title="Group this table's rows and total them, in a new table sheet"
        >
          <LayoutGrid className="h-3.5 w-3.5" /> Pivot
        </Button>
        {config.source.kind === "pivot" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() =>
              pivotFrom
                ? setPivotOpen("edit")
                : toast.error("The pivot's table is not in this workbook any more")
            }
          >
            Change pivot
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setSaveOpen(true)}
          title="Save what this sheet shows as a new lakehouse table"
        >
          <Database className="h-3.5 w-3.5" /> Save to lakehouse
        </Button>
        {config.filters.map((f) => (
          <span
            key={f.column}
            className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5"
            data-testid="filter-chip"
          >
            <Filter className="h-3 w-3" />
            {describeFilter(f)}
            <button
              aria-label={`Remove the filter on ${f.column}`}
              className="rounded-full p-0.5 hover:bg-primary/20"
              onClick={() => setFilter(f.column, null)}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {config.hidden.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
                <EyeOff className="h-3.5 w-3.5" /> {config.hidden.length} hidden
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {config.hidden.map((h) => (
                <DropdownMenuItem
                  key={h}
                  onSelect={() => setConfig({ hidden: config.hidden.filter((x) => x !== h) })}
                >
                  Show {h}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfig({ hidden: [] })}>
                Show all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="ml-auto flex items-center gap-3 text-muted-foreground">
          {status}
          {loading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading…
            </span>
          ) : duration !== null ? (
            `${duration.toLocaleString()} ms`
          ) : null}
        </span>
      </div>

      {error && (
        <div
          className="border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
          data-testid="table-error"
        >
          {error}
        </div>
      )}

      {/* Rows */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-background text-[13px] outline-none"
        tabIndex={0}
        role="grid"
        aria-label={`Table ${tab.name}`}
        aria-rowcount={total ?? 0}
        onKeyDown={onKeyDown}
      >
        <div
          style={{ width: totalW, height: HEADER_H + (total ?? 0) * ROW_H }}
          className="relative"
        >
          {/* Header */}
          <div
            className="sticky top-0 z-20 flex border-b border-border bg-muted"
            style={{ height: HEADER_H, width: totalW }}
          >
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-border bg-muted"
              style={{ width: NUM_W }}
            />
            {visible.map(({ c }) => {
              const Icon = c.calculated ? Sigma : KIND_ICON[c.kind];
              const s = sortOf(c.name);
              const f = filterOf(c.name);
              return (
                <div
                  key={c.name}
                  data-col-head={c.name}
                  role="columnheader"
                  className={cn(
                    "group relative flex shrink-0 items-center gap-1 border-r border-border px-2 text-xs font-medium",
                    c.error && "bg-destructive/10",
                  )}
                  style={{ width: widthOf(c.name) }}
                  title={
                    c.error
                      ? `${c.formula}\n\n${c.error}`
                      : c.formula
                        ? `${c.formula}  (${c.type})`
                        : c.type
                  }
                >
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      c.calculated ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate">{c.name}</span>
                  {s &&
                    (s.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                  <TableFilterPopover
                    token={token}
                    tabId={tab.id}
                    config={config}
                    column={c}
                    current={f ?? null}
                    onApply={(nf) => setFilter(c.name, nf)}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="ml-auto rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                        aria-label={`Column ${c.name} menu`}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => sortBy(c.name, false)}>
                        Sort {c.kind === "number" ? "smallest to largest" : "A to Z"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => sortBy(c.name, true)}>
                        Sort {c.kind === "number" ? "largest to smallest" : "Z to A"}
                      </DropdownMenuItem>
                      {s && (
                        <DropdownMenuItem onSelect={() => sortBy(c.name, null)}>
                          Remove sort
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => hide(c.name)}>Hide column</DropdownMenuItem>
                      {c.calculated && (
                        <>
                          <DropdownMenuItem
                            onSelect={() =>
                              setCalcDialog({
                                index: config.calculated.findIndex((x) => x.name === c.name),
                              })
                            }
                          >
                            Edit formula…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={() => void removeCalc(c.name)}
                          >
                            Delete column
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                    onMouseDown={(e) => startResize(e, c.name)}
                  />
                </div>
              );
            })}
          </div>

          {/* Body */}
          {total === 0 && !loading && !error && (
            <div className="px-4 py-6 text-sm text-muted-foreground" data-testid="table-empty">
              {config.filters.length ? "No rows match the filters." : "This table has no rows."}
            </div>
          )}
          {vRows.map((vr) => {
            const row = rowAt(vr.index);
            return (
              <div
                key={vr.key}
                className="absolute left-0 flex border-b border-border/60"
                style={{ top: HEADER_H + vr.start, height: ROW_H, width: totalW }}
                role="row"
              >
                <div
                  className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border bg-muted px-2 text-[11px] tabular-nums text-muted-foreground"
                  style={{ width: NUM_W }}
                >
                  {vr.index + 1}
                </div>
                {visible.map(({ c, i }, ci) => {
                  const v = row ? row[i + 1] : undefined;
                  const text = v === undefined ? "" : show(v, c.kind);
                  const numeric = c.kind === "number" || c.kind === "date" || c.kind === "datetime";
                  return (
                    <div
                      key={c.name}
                      role="gridcell"
                      className={cn(
                        "shrink-0 overflow-hidden whitespace-pre border-r border-border/60 px-2 leading-[25px]",
                        numeric && "text-right tabular-nums",
                        c.kind === "bool" && "text-center",
                        inSel(vr.index, ci) && "bg-primary/10",
                        !row && "animate-pulse bg-muted/40",
                      )}
                      style={{ width: widthOf(c.name) }}
                      onMouseDown={(e) => {
                        scrollRef.current?.focus();
                        setSel((s) =>
                          e.shiftKey && s
                            ? { ...s, r1: vr.index, c1: ci }
                            : { r0: vr.index, c0: ci, r1: vr.index, c1: ci },
                        );
                      }}
                      title={text.length > 20 ? text : undefined}
                    >
                      {text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {pivotOpen === "new" && (
        <PivotDialog
          open
          onOpenChange={(o) => !o && setPivotOpen(null)}
          wb={wb}
          token={token}
          from={tab}
        />
      )}
      {pivotOpen === "edit" && pivotFrom && (
        <PivotDialog
          open
          onOpenChange={(o) => !o && setPivotOpen(null)}
          wb={wb}
          token={token}
          from={pivotFrom}
          editing={{ tab, config }}
        />
      )}
      {saveOpen && (
        <SaveToLakehouseDialog
          open
          onOpenChange={setSaveOpen}
          token={token}
          workbookId={wb.workbookId}
          takenSheetNames={wb.tabs.map((t) => t.name)}
          source={{ kind: "table", tabId: tab.id, tabName: tab.name, config }}
          onOpenedTab={(row) => {
            wb.addTabLocal(row);
            toast.success(`Opened ${row.name}`);
          }}
        />
      )}
      {calcDialog && (
        <CalculatedColumnDialog
          open
          onOpenChange={(o) => !o && setCalcDialog(null)}
          wb={wb}
          tab={tab}
          config={config}
          editIndex={calcDialog.index}
          onSave={(calculated) => {
            setConfig({ calculated });
            setCalcDialog(null);
          }}
        />
      )}
    </div>
  );
}
