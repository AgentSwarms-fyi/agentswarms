// "Data preparation" tab of the BI Workspace: drag tables from the palette
// onto the canvas to build a join pipeline, tune per-column names/types,
// watch the result update live at the bottom, then materialise it as a
// local dataset (and a saved, re-runnable flow).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowDown,
  ChevronDown,
  Code2,
  Database,
  FolderOpen,
  GripVertical,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { fmtBiNumber } from "@/components/bi/BiChartRender";
import {
  addTableToFlow,
  buildPrepSql,
  castRows,
  deletePrepFlow,
  emptyPrepConfig,
  listPrepFlows,
  parsePrepConfig,
  PREP_JOIN_TYPES,
  PREP_SAVE_ROW_CAP,
  PREP_TYPE_META,
  prepTables,
  removeTableFromFlow,
  runAndSavePrep,
  savePrepFlow,
  syncColumns,
  validatePrepConfig,
  type PrepColumnType,
  type PrepFlowConfig,
  type PrepFlowRow,
  type PrepJoinType,
  type PrepTableInfo,
} from "@/lib/dataPrep";
import {
  hydrateFromSupabase,
  runQuery,
  safeTableName,
  saveDataset,
  type DatasetMeta,
} from "@/lib/sqlEngine";
import { fetchWarehouseSchema, runWarehouseQuery } from "@/lib/warehouseClient";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import {
  WAREHOUSE_LABELS,
  type WarehouseConnectionSummary,
  type WarehouseTable,
} from "@/utils/warehouse/types";

const DRAG_MIME = "text/x-prep-table";

type PreviewState =
  | { kind: "empty" }
  | { kind: "invalid"; error: string }
  | { kind: "error"; error: string }
  | {
      kind: "ok";
      columns: string[];
      rows: Record<string, unknown>[];
      total: number;
      failures: Record<string, number>;
    };

export function DataPrepTab() {
  const { user, session } = useAuth();
  const token = session?.access_token ?? null;

  const [datasets, setDatasets] = useState<DatasetMeta[] | null>(null);
  const [flows, setFlows] = useState<PrepFlowRow[]>([]);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowName, setFlowName] = useState("");
  const [outputName, setOutputName] = useState("");
  const [cfg, setCfg] = useState<PrepFlowConfig>(emptyPrepConfig());
  const [preview, setPreview] = useState<PreviewState>({ kind: "empty" });
  const [runBusy, setRunBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const tableInfos: PrepTableInfo[] = useMemo(
    () => (datasets ?? []).map((d) => ({ name: d.name, columns: d.columns })),
    [datasets],
  );
  const onCanvas = useMemo(() => new Set(prepTables(cfg)), [cfg]);
  const preparedNames = useMemo(
    () => new Set(flows.map((f) => f.output_table_name).filter((n): n is string => Boolean(n))),
    [flows],
  );

  const reloadDatasets = useCallback(async () => {
    try {
      const tables = await hydrateFromSupabase();
      setDatasets(tables);
    } catch (e) {
      toast.error(`Could not load datasets: ${(e as Error).message}`);
      setDatasets([]);
    }
  }, []);

  useEffect(() => {
    void reloadDatasets();
    listPrepFlows()
      .then(setFlows)
      .catch(() => {});
  }, [reloadDatasets]);

  // ── Live preview (debounced) ────────────────────────────────────────
  useEffect(() => {
    if (!cfg.base) {
      setPreview({ kind: "empty" });
      return;
    }
    const t = setTimeout(() => {
      const valid = validatePrepConfig(cfg);
      if (!valid.ok) {
        setPreview({ kind: "invalid", error: valid.error });
        return;
      }
      try {
        const res = runQuery(buildPrepSql(cfg));
        const cast = castRows(res.rows, cfg);
        setPreview({
          kind: "ok",
          columns: cast.columns.map((c) => c.name),
          rows: cast.rows,
          total: res.total_matched,
          failures: cast.failures,
        });
      } catch (e) {
        setPreview({ kind: "error", error: (e as Error).message });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [cfg]);

  // ── Flow actions ────────────────────────────────────────────────────
  function resetFlow() {
    setFlowId(null);
    setFlowName("");
    setOutputName("");
    setCfg(emptyPrepConfig());
  }

  function loadFlow(f: PrepFlowRow) {
    const parsed = parsePrepConfig(f.config);
    const available = new Set(tableInfos.map((t) => t.name));
    let next = parsed;
    if (parsed.base && !available.has(parsed.base)) {
      toast.error(`The base table "${parsed.base}" no longer exists — starting fresh.`);
      next = emptyPrepConfig();
    } else {
      const missing = parsed.joins.filter((j) => !available.has(j.table)).map((j) => j.table);
      if (missing.length > 0) {
        toast.warning(`Dropped missing table(s): ${missing.join(", ")}`);
        next = missing.reduce((acc, m) => removeTableFromFlow(acc, m), parsed);
      }
      next = syncColumns(next, tableInfos);
    }
    setFlowId(f.id);
    setFlowName(f.name);
    setOutputName(f.output_table_name ?? "");
    setCfg(next);
  }

  async function handleDeleteFlow() {
    if (!flowId) return;
    if (!window.confirm(`Delete flow "${flowName}"? The saved output dataset is kept.`)) return;
    try {
      await deletePrepFlow(flowId);
      setFlows((prev) => prev.filter((f) => f.id !== flowId));
      resetFlow();
      toast.success("Flow deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleRunAndSave() {
    if (!user?.id) return;
    const valid = validatePrepConfig(cfg);
    if (!valid.ok) return toast.error(valid.error);
    if (!flowName.trim()) return toast.error("Name the flow first");
    const out = safeTableName(outputName.trim() || flowName.trim());
    setRunBusy(true);
    try {
      const id = await savePrepFlow({
        id: flowId,
        userId: user.id,
        name: flowName.trim(),
        cfg,
      });
      const result = await runAndSavePrep({
        userId: user.id,
        flowName: flowName.trim(),
        outputName: out,
        cfg,
      });
      await savePrepFlow({
        id,
        userId: user.id,
        name: flowName.trim(),
        cfg,
        outputTableId: result.dataset.id,
        outputTableName: result.dataset.name,
        markRun: true,
      });
      setFlowId(id);
      setOutputName(result.dataset.name);
      setFlows(await listPrepFlows());
      await reloadDatasets();
      toast.success(
        `Saved "${result.dataset.name}" with ${result.rowCount.toLocaleString()} rows` +
          (result.capped ? ` (capped at ${PREP_SAVE_ROW_CAP.toLocaleString()})` : ""),
      );
      const failed = Object.entries(result.failures).filter(([, n]) => n > 0);
      if (failed.length > 0) {
        toast.warning(
          `Some values could not be converted and were set to null: ${failed
            .map(([c, n]) => `${c} (${n})`)
            .join(", ")}`,
        );
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunBusy(false);
    }
  }

  // ── Canvas dnd ──────────────────────────────────────────────────────
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const name = e.dataTransfer.getData(DRAG_MIME);
    const info = tableInfos.find((t) => t.name === name);
    if (!info) return;
    addTable(info);
  }

  function addTable(info: PrepTableInfo) {
    if (onCanvas.has(info.name)) return;
    setCfg((prev) => addTableToFlow(prev, info, tableInfos));
  }

  function updateJoin(index: number, patch: Partial<PrepJoinUpdate>) {
    setCfg((prev) => ({
      ...prev,
      joins: prev.joins.map((j, i) => (i === index ? { ...j, ...patch } : j)),
    }));
  }
  type PrepJoinUpdate = {
    type: PrepJoinType;
    leftTable: string;
    leftColumn: string;
    rightColumn: string;
  };

  function columnsOf(table: string): string[] {
    return tableInfos.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];
  }

  const sql = cfg.base && validatePrepConfig(cfg).ok ? buildPrepSql(cfg) : null;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Palette */}
      <div className="w-full shrink-0 space-y-3 lg:w-64">
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5">
                <Database className="h-4 w-4 text-primary" /> Source tables
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                title="Reload tables"
                onClick={() => void reloadDatasets()}
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </CardTitle>
            <CardDescription className="text-xs">
              Drag a table onto the canvas — or click to add.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[420px] space-y-1.5 overflow-y-auto pt-0">
            {datasets === null ? (
              <>
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </>
            ) : datasets.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No datasets yet — upload CSVs on the Data &amp; SQL page or import from a warehouse
                below.
              </p>
            ) : (
              datasets.map((d) => {
                const used = onCanvas.has(d.name);
                return (
                  <div
                    key={d.id}
                    draggable={!used}
                    onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, d.name)}
                    onClick={() => !used && addTable({ name: d.name, columns: d.columns })}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition ${
                      used
                        ? "cursor-not-allowed border-border/40 opacity-40"
                        : "cursor-grab border-border/60 hover:border-primary/50 hover:bg-muted/50"
                    }`}
                    title={used ? "Already on the canvas" : "Drag onto the canvas"}
                  >
                    <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono font-medium">{d.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {d.columns.length} cols · {d.row_count.toLocaleString()} rows
                      </p>
                    </div>
                    {preparedNames.has(d.name) && (
                      <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                        <Wand2 className="mr-0.5 h-2.5 w-2.5" /> prep
                      </Badge>
                    )}
                    {d.is_sample && (
                      <Badge variant="outline" className="shrink-0 px-1 text-[9px]">
                        sample
                      </Badge>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5 text-xs"
          onClick={() => setImportOpen(true)}
        >
          <Database className="h-3.5 w-3.5" /> Import from warehouse
        </Button>
      </div>

      {/* Main column */}
      <div className="min-w-0 flex-1 space-y-4">
        {/* Flow header */}
        <Card className="border-border/60">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1">
              <Label className="text-xs">Flow name</Label>
              <Input
                value={flowName}
                onChange={(e) => setFlowName(e.target.value)}
                placeholder="orders_with_customers"
                className="h-8 w-52 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Output table</Label>
              <Input
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                placeholder={safeTableName(flowName || "prepared_data")}
                className="h-8 w-48 font-mono text-xs"
              />
            </div>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void handleRunAndSave()}
              disabled={runBusy || !cfg.base}
            >
              {runBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run &amp; save dataset
            </Button>
            <div className="ml-auto flex items-end gap-1.5">
              {flows.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Saved flows</Label>
                  <Select
                    value={flowId ?? undefined}
                    onValueChange={(id) => {
                      const f = flows.find((x) => x.id === id);
                      if (f) loadFlow(f);
                    }}
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue placeholder="Open a flow…" />
                    </SelectTrigger>
                    <SelectContent>
                      {flows.map((f) => (
                        <SelectItem key={f.id} value={f.id} className="text-xs">
                          <FolderOpen className="mr-1 inline h-3 w-3" /> {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                onClick={resetFlow}
                title="Start a new flow"
              >
                <Plus className="h-3.5 w-3.5" /> New
              </Button>
              {flowId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  title="Delete this flow"
                  onClick={() => void handleDeleteFlow()}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Canvas */}
        <Card
          className={`border-border/60 transition ${dragOver ? "border-primary bg-primary/5" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <CardContent className="p-4">
            {!cfg.base ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/70 py-14 text-center">
                <Table2 className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">Drag your first table here</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  The first table is the base. Drop more tables to join them — join keys are
                  auto-detected from matching column names and fully editable.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <TableNode
                  name={cfg.base}
                  info={tableInfos.find((t) => t.name === cfg.base)}
                  isBase
                  removable={cfg.joins.length === 0}
                  onRemove={() => setCfg((p) => removeTableFromFlow(p, cfg.base!))}
                />
                {cfg.joins.map((j, i) => (
                  <div key={j.table} className="flex flex-wrap items-center gap-3">
                    <div className="w-56 space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-2">
                      <Select
                        value={j.type}
                        onValueChange={(v) => updateJoin(i, { type: v as PrepJoinType })}
                      >
                        <SelectTrigger className="h-7 text-[11px] font-medium">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PREP_JOIN_TYPES.map((t) => (
                            <SelectItem key={t.value} value={t.value} className="text-xs">
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="grid grid-cols-2 gap-1">
                        <Select
                          value={j.leftTable || undefined}
                          onValueChange={(v) => updateJoin(i, { leftTable: v, leftColumn: "" })}
                        >
                          <SelectTrigger className="h-7 font-mono text-[10px]">
                            <SelectValue placeholder="table" />
                          </SelectTrigger>
                          <SelectContent>
                            {prepTables(cfg)
                              .slice(
                                0,
                                prepTables(cfg).indexOf(j.table) === -1
                                  ? undefined
                                  : prepTables(cfg).indexOf(j.table),
                              )
                              .map((t) => (
                                <SelectItem key={t} value={t} className="font-mono text-xs">
                                  {t}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={j.leftColumn || undefined}
                          onValueChange={(v) => updateJoin(i, { leftColumn: v })}
                        >
                          <SelectTrigger className="h-7 font-mono text-[10px]">
                            <SelectValue placeholder="key" />
                          </SelectTrigger>
                          <SelectContent>
                            {columnsOf(j.leftTable).map((c) => (
                              <SelectItem key={c} value={c} className="font-mono text-xs">
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">=</span>
                        <Select
                          value={j.rightColumn || undefined}
                          onValueChange={(v) => updateJoin(i, { rightColumn: v })}
                        >
                          <SelectTrigger className="h-7 flex-1 font-mono text-[10px]">
                            <SelectValue placeholder={`${j.table} key`} />
                          </SelectTrigger>
                          <SelectContent>
                            {columnsOf(j.table).map((c) => (
                              <SelectItem key={c} value={c} className="font-mono text-xs">
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <TableNode
                      name={j.table}
                      info={tableInfos.find((t) => t.name === j.table)}
                      removable
                      onRemove={() => setCfg((p) => removeTableFromFlow(p, j.table))}
                    />
                  </div>
                ))}
                <p className="w-full text-[10px] text-muted-foreground">
                  Drop another table to add a join.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Column editor */}
        {cfg.base && cfg.columns.length > 0 && (
          <Card className="border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                Output columns
                <span className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={() =>
                      setCfg((p) => ({
                        ...p,
                        columns: p.columns.map((c) => ({ ...c, include: true })),
                      }))
                    }
                  >
                    All
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={() =>
                      setCfg((p) => ({
                        ...p,
                        columns: p.columns.map((c) => ({ ...c, include: false })),
                      }))
                    }
                  >
                    None
                  </Button>
                </span>
              </CardTitle>
              <CardDescription className="text-xs">
                Rename columns and set their type — Location, Integer, Date, Currency… Values that
                can't be converted become null (you'll see a count when saving).
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="max-h-72 overflow-y-auto rounded-md border border-border/50">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      <th className="sticky top-0 w-8 bg-muted px-2 py-1.5" />
                      <th className="sticky top-0 bg-muted px-2 py-1.5">Source</th>
                      <th className="sticky top-0 bg-muted px-2 py-1.5">Output name</th>
                      <th className="sticky top-0 bg-muted px-2 py-1.5">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfg.columns.map((c) => (
                      <tr key={c.key} className="border-t border-border/40">
                        <td className="px-2 py-1">
                          <Checkbox
                            checked={c.include}
                            onCheckedChange={(v) =>
                              setCfg((p) => ({
                                ...p,
                                columns: p.columns.map((x) =>
                                  x.key === c.key ? { ...x, include: Boolean(v) } : x,
                                ),
                              }))
                            }
                          />
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
                          {c.table}.{c.column}
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            value={c.outputName}
                            disabled={!c.include}
                            onChange={(e) =>
                              setCfg((p) => ({
                                ...p,
                                columns: p.columns.map((x) =>
                                  x.key === c.key ? { ...x, outputName: e.target.value } : x,
                                ),
                              }))
                            }
                            className="h-7 w-40 font-mono text-[11px]"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Select
                            value={c.type}
                            disabled={!c.include}
                            onValueChange={(v) =>
                              setCfg((p) => ({
                                ...p,
                                columns: p.columns.map((x) =>
                                  x.key === c.key ? { ...x, type: v as PrepColumnType } : x,
                                ),
                              }))
                            }
                          >
                            <SelectTrigger className="h-7 w-32 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(
                                Object.entries(PREP_TYPE_META) as [
                                  PrepColumnType,
                                  (typeof PREP_TYPE_META)[PrepColumnType],
                                ][]
                              ).map(([value, meta]) => (
                                <SelectItem key={value} value={value} className="text-xs">
                                  {meta.label}
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
            </CardContent>
          </Card>
        )}

        {/* Result preview */}
        {cfg.base && (
          <Card className="border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5">
                  <ArrowDown className="h-4 w-4 text-primary" /> Result preview
                </span>
                {preview.kind === "ok" && (
                  <span className="text-[10px] font-normal text-muted-foreground">
                    {preview.total.toLocaleString()} rows total · showing first{" "}
                    {preview.rows.length}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {(preview.kind === "invalid" || preview.kind === "error") && (
                <p
                  className={`rounded border px-2 py-1.5 text-[11px] ${
                    preview.kind === "error"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {preview.error}
                </p>
              )}
              {preview.kind === "ok" && (
                <>
                  {Object.keys(preview.failures).length > 0 && (
                    <p className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
                      Some previewed values can't be converted and show as null:{" "}
                      {Object.entries(preview.failures)
                        .map(([c, n]) => `${c} (${n})`)
                        .join(", ")}
                    </p>
                  )}
                  <div className="max-h-80 overflow-auto rounded-md border border-border/50">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          {preview.columns.map((c) => (
                            <th
                              key={c}
                              className="sticky top-0 bg-muted px-2 py-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
                            >
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, i) => (
                          <tr key={i} className="border-t border-border/40">
                            {preview.columns.map((c) => (
                              <td
                                key={c}
                                className="whitespace-nowrap px-2 py-1 font-mono text-[10px]"
                              >
                                {row[c] === null || row[c] === undefined ? (
                                  <span className="text-muted-foreground">null</span>
                                ) : typeof row[c] === "number" ? (
                                  fmtBiNumber(row[c])
                                ) : (
                                  String(row[c])
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {sql && (
                <Collapsible open={showSql} onOpenChange={setShowSql}>
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded border border-border/50 bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                    <Code2 className="h-2.5 w-2.5" /> View generated SQL
                    <ChevronDown
                      className={`ml-auto h-2.5 w-2.5 transition-transform ${showSql ? "rotate-180" : ""}`}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-1 whitespace-pre-wrap break-all rounded border border-border/50 bg-muted/30 p-2 font-mono text-[10px]">
                      {sql}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <WarehouseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        token={token}
        userId={user?.id ?? null}
        onImported={() => void reloadDatasets()}
      />
    </div>
  );
}

function TableNode({
  name,
  info,
  isBase = false,
  removable,
  onRemove,
}: {
  name: string;
  info?: PrepTableInfo;
  isBase?: boolean;
  removable: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="w-44 rounded-lg border border-border bg-card p-2 shadow-sm">
      <div className="flex items-center gap-1.5">
        <Table2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={name}>
          {name}
        </span>
        <button
          type="button"
          className={`shrink-0 rounded p-0.5 ${
            removable
              ? "text-muted-foreground hover:text-destructive"
              : "cursor-not-allowed text-muted-foreground/30"
          }`}
          title={removable ? "Remove from canvas" : "Remove the joined tables first"}
          onClick={() => removable && onRemove()}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {isBase ? "Base table · " : ""}
        {info ? `${info.columns.length} columns` : "missing"}
      </p>
    </div>
  );
}

function WarehouseImportDialog({
  open,
  onOpenChange,
  token,
  userId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string | null;
  userId: string | null;
  onImported: () => void;
}) {
  const listWarehousesFn = useServerFn(listWarehouseConnections);
  const [warehouses, setWarehouses] = useState<WarehouseConnectionSummary[] | null>(null);
  const [connId, setConnId] = useState<string>("");
  const [tables, setTables] = useState<WarehouseTable[] | "loading" | "error" | null>(null);
  const [tableKey, setTableKey] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    setWarehouses(null);
    setConnId("");
    setTables(null);
    setTableKey("");
    listWarehousesFn({ data: { access_token: token } }).then((res) => {
      setWarehouses(res.ok ? res.connections.filter((c) => c.is_active) : []);
    });
  }, [open, token, listWarehousesFn]);

  useEffect(() => {
    if (!connId || !token) return;
    setTables("loading");
    setTableKey("");
    fetchWarehouseSchema(token, connId)
      .then(setTables)
      .catch((e) => {
        setTables("error");
        toast.error((e as Error).message);
      });
  }, [connId, token]);

  async function handleImport() {
    if (!token || !userId || !connId || !tableKey) return;
    const [schema, name] = tableKey.split("||");
    setBusy(true);
    try {
      const res = await runWarehouseQuery(
        token,
        connId,
        `SELECT * FROM ${schema}.${name} LIMIT 1000`,
      );
      if (res.rows.length === 0) throw new Error("The table returned no rows");
      const conn = warehouses?.find((w) => w.id === connId);
      const dataset = await saveDataset({
        userId,
        tableName: safeTableName(`${schema}_${name}`),
        sourceFilename: `warehouse:${conn?.name ?? connId}`,
        rows: res.rows,
        columns: res.columns.map((c) => ({
          name: c,
          type: typeof res.rows[0]?.[c] === "number" ? ("number" as const) : ("string" as const),
        })),
      });
      toast.success(
        `Imported ${dataset.row_count.toLocaleString()} rows as "${dataset.name}"` +
          (res.capped ? " (capped snapshot)" : ""),
      );
      onImported();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import a warehouse table</DialogTitle>
          <DialogDescription>
            Pulls a snapshot (up to 1,000 rows) of an external warehouse table into your local
            datasets so it can be joined in the prep canvas.
          </DialogDescription>
        </DialogHeader>
        {warehouses === null ? (
          <Skeleton className="h-9 w-full" />
        ) : warehouses.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No active warehouse connections. Add one under Integrations → Data Warehouses.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Connection</Label>
              <Select value={connId || undefined} onValueChange={setConnId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a connection" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} — {WAREHOUSE_LABELS[w.provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {connId && (
              <div className="space-y-1.5">
                <Label>Table</Label>
                {tables === "loading" || tables === null ? (
                  <Skeleton className="h-9 w-full" />
                ) : tables === "error" ? (
                  <p className="text-xs text-destructive">Could not load the schema.</p>
                ) : (
                  <Select value={tableKey || undefined} onValueChange={setTableKey}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a table" />
                    </SelectTrigger>
                    <SelectContent>
                      {tables.map((t) => (
                        <SelectItem
                          key={`${t.schema}||${t.name}`}
                          value={`${t.schema}||${t.name}`}
                          className="font-mono text-xs"
                        >
                          {t.schema}.{t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleImport()} disabled={busy || !tableKey}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import snapshot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
