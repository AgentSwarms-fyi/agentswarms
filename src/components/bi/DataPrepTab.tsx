// "Data preparation" tab of the BI Workspace — a step-based, self-serve data
// pipeline in the spirit of Tableau Prep / Power Query:
//
//   1. Combine   — drag tables onto the canvas to build a join graph
//   2. Shape     — pick/rename/retype columns, add calculated fields,
//                  filter rows, and (optionally) summarize with group-bys
//   3. Output    — watch the result + column profile update live, then
//                  materialise it as a reusable local dataset (+ saved flow)
//
// Every step compiles to a single read-only SELECT (see lib/dataPrep.ts) that
// runs in the browser SQL engine, so the whole pipeline previews instantly.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowDown,
  Calculator,
  ChevronDown,
  Code2,
  Columns3,
  Combine,
  Database,
  Filter as FilterIcon,
  FolderOpen,
  GripVertical,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Sigma,
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { fmtBiNumber } from "@/components/bi/BiChartRender";
import {
  addTableToFlow,
  aggNeedsColumn,
  buildPrepSql,
  castRows,
  deletePrepFlow,
  effectiveOutputColumns,
  emptyPrepConfig,
  listPrepFlows,
  parsePrepConfig,
  preAggOutputNames,
  profilePrepColumns,
  PREP_AGG_FNS,
  PREP_FILTER_OPS,
  PREP_FUNCTIONS,
  PREP_JOIN_TYPES,
  PREP_SAVE_ROW_CAP,
  PREP_TYPE_META,
  prepTables,
  reconcileDerived,
  removeTableFromFlow,
  runAndSavePrep,
  savePrepFlow,
  syncColumns,
  validatePrepConfig,
  type PrepAggFn,
  type PrepCalc,
  type PrepColProfile,
  type PrepColumnType,
  type PrepFilter,
  type PrepFilterOp,
  type PrepFlowConfig,
  type PrepFlowRow,
  type PrepJoinType,
  type PrepMeasure,
  type PrepTableInfo,
} from "@/lib/dataPrep";
import {
  hydrateFromSupabase,
  runQueryUnlimited,
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
const PREVIEW_SAMPLE = 1000; // rows pulled for the live preview + profiling
const PREVIEW_DISPLAY = 50; // rows rendered in the preview table

type PreviewState =
  | { kind: "empty" }
  | { kind: "invalid"; error: string }
  | { kind: "error"; error: string }
  | {
      kind: "ok";
      columns: string[];
      rows: Record<string, unknown>[];
      total: number;
      sampled: boolean;
      failures: Record<string, number>;
      profile: Record<string, PrepColProfile>;
    };

type SetCfg = React.Dispatch<React.SetStateAction<PrepFlowConfig>>;

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
  const [shapeTab, setShapeTab] = useState("columns");

  const tableInfos: PrepTableInfo[] = useMemo(
    () => (datasets ?? []).map((d) => ({ name: d.name, columns: d.columns })),
    [datasets],
  );
  const onCanvas = useMemo(() => new Set(prepTables(cfg)), [cfg]);
  const preparedNames = useMemo(
    () => new Set(flows.map((f) => f.output_table_name).filter((n): n is string => Boolean(n))),
    [flows],
  );

  // Columns a calculated field may reference (row-level projection only).
  const baseColumnNames = useMemo(
    () => cfg.columns.filter((c) => c.include).map((c) => c.outputName),
    [cfg.columns],
  );
  // Columns downstream steps (filters, group-by, measures) may reference.
  const downstreamColumns = useMemo(() => preAggOutputNames(cfg), [cfg]);

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
        const res = runQueryUnlimited(buildPrepSql(cfg), PREVIEW_SAMPLE);
        const cast = castRows(res.rows, cfg);
        setPreview({
          kind: "ok",
          columns: cast.columns.map((c) => c.name),
          rows: cast.rows,
          total: res.total,
          sampled: res.capped,
          failures: cast.failures,
          profile: profilePrepColumns(cast.rows, effectiveOutputColumns(cfg)),
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
    setShapeTab("columns");
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
      next = reconcileDerived(syncColumns(next, tableInfos));
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
  const includedCount = cfg.columns.filter((c) => c.include).length;
  const aggActive =
    cfg.aggregate.enabled &&
    (cfg.aggregate.groupBy.length > 0 || cfg.aggregate.measures.length > 0);

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
              Local datasets, plus tables imported from databases &amp; warehouses. Drag onto the
              canvas — or click to add.
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
                No datasets yet — upload CSVs on the Data &amp; SQL page or import from a source
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
          <Database className="h-3.5 w-3.5" /> Import from a source
        </Button>
      </div>

      {/* Main column */}
      <div className="min-w-0 flex-1 space-y-4">
        {/* Toolbar */}
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

        {/* Step 1 — Combine */}
        <Card
          className={`overflow-hidden border-border/60 transition ${dragOver ? "border-primary ring-2 ring-primary/20" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <CardHeader className="pb-2">
            <StepHead
              n={1}
              icon={Combine}
              title="Combine"
              desc="The first table is the base. Drop more tables to join them — keys auto-detect from matching names and stay editable."
            />
          </CardHeader>
          <CardContent
            className="bg-muted/30 p-4"
            style={{
              backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
            }}
          >
            {!cfg.base ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/70 py-14 text-center">
                <Table2 className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">Drag your first table here</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Or click a table in the palette. Then shape it below — add calculated fields,
                  filter rows and summarize.
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

        {/* Step 2 — Shape */}
        {cfg.base && cfg.columns.length > 0 && (
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <StepHead
                n={2}
                icon={Columns3}
                title="Shape"
                desc="Choose columns and types, add calculated fields, filter rows, and summarize."
              />
            </CardHeader>
            <CardContent className="pt-0">
              <Tabs value={shapeTab} onValueChange={setShapeTab}>
                <TabsList className="mb-3">
                  <TabsTrigger value="columns" className="gap-1.5 text-xs">
                    <Columns3 className="h-3.5 w-3.5" /> Columns
                    <Badge variant="secondary" className="ml-0.5 px-1 text-[9px]">
                      {includedCount}
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger value="calc" className="gap-1.5 text-xs">
                    <Calculator className="h-3.5 w-3.5" /> Calculated
                    {cfg.calcs.length > 0 && (
                      <Badge variant="secondary" className="ml-0.5 px-1 text-[9px]">
                        {cfg.calcs.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="filter" className="gap-1.5 text-xs">
                    <FilterIcon className="h-3.5 w-3.5" /> Filters
                    {cfg.filters.conditions.length > 0 && (
                      <Badge variant="secondary" className="ml-0.5 px-1 text-[9px]">
                        {cfg.filters.conditions.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="agg" className="gap-1.5 text-xs">
                    <Sigma className="h-3.5 w-3.5" /> Summarize
                    {aggActive && (
                      <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                    )}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="columns">
                  <ColumnsEditor
                    cfg={cfg}
                    setCfg={setCfg}
                    profile={preview.kind === "ok" ? preview.profile : {}}
                  />
                </TabsContent>
                <TabsContent value="calc">
                  <CalcEditor cfg={cfg} setCfg={setCfg} baseColumns={baseColumnNames} />
                </TabsContent>
                <TabsContent value="filter">
                  <FiltersEditor cfg={cfg} setCfg={setCfg} columns={downstreamColumns} />
                </TabsContent>
                <TabsContent value="agg">
                  <AggregateEditor cfg={cfg} setCfg={setCfg} columns={downstreamColumns} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {/* Step 3 — Output */}
        {cfg.base && (
          <Card className="border-border/60">
            <CardHeader className="pb-2">
              <StepHead
                n={3}
                icon={ArrowDown}
                title="Output"
                desc="Preview and profile update live. Run &amp; save to materialise a reusable dataset."
                right={
                  preview.kind === "ok" ? (
                    <span className="whitespace-nowrap text-[10px] font-normal text-muted-foreground">
                      {preview.total.toLocaleString()} rows · {preview.columns.length} cols
                    </span>
                  ) : undefined
                }
              />
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
                        {preview.rows.slice(0, PREVIEW_DISPLAY).map((row, i) => (
                          <tr
                            key={i}
                            className="border-t border-border/40 transition-colors hover:bg-muted/40"
                          >
                            {preview.columns.map((c) => (
                              <td
                                key={c}
                                className={`whitespace-nowrap px-2 py-1 text-[11px] ${
                                  typeof row[c] === "number" ? "text-right tabular-nums" : ""
                                }`}
                              >
                                {row[c] === null || row[c] === undefined ? (
                                  <span className="text-muted-foreground/60">—</span>
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
                  <p className="text-[10px] text-muted-foreground">
                    Showing first {Math.min(PREVIEW_DISPLAY, preview.rows.length)} of{" "}
                    {preview.total.toLocaleString()} rows.
                    {preview.sampled &&
                      ` Profile based on a ${preview.rows.length.toLocaleString()}-row sample.`}
                  </p>
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

// ── Step header ─────────────────────────────────────────────────────────

function StepHead({
  n,
  icon: Icon,
  title,
  desc,
  right,
}: {
  n: number;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Icon className="h-4 w-4 text-primary" /> {title}
        </CardTitle>
        {desc && <CardDescription className="mt-0.5 text-xs">{desc}</CardDescription>}
      </div>
      {right}
    </div>
  );
}

// ── Columns editor (with profiling) ───────────────────────────────────────

function ColumnsEditor({
  cfg,
  setCfg,
  profile,
}: {
  cfg: PrepFlowConfig;
  setCfg: SetCfg;
  profile: Record<string, PrepColProfile>;
}) {
  function setAll(include: boolean) {
    setCfg((p) => ({ ...p, columns: p.columns.map((c) => ({ ...c, include })) }));
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Rename columns and set their type — values that can't convert become null.
        </p>
        <span className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => setAll(true)}
          >
            All
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => setAll(false)}
          >
            None
          </Button>
        </span>
      </div>
      <div className="max-h-96 overflow-y-auto rounded-md border border-border/50">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-muted-foreground">
              <th className="sticky top-0 w-8 bg-muted px-2 py-1.5" />
              <th className="sticky top-0 bg-muted px-2 py-1.5">Source</th>
              <th className="sticky top-0 bg-muted px-2 py-1.5">Output name</th>
              <th className="sticky top-0 bg-muted px-2 py-1.5">Type</th>
              <th className="sticky top-0 bg-muted px-2 py-1.5">Profile</th>
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
                <td className="px-2 py-1">
                  {c.include ? <ProfileChips p={profile[c.outputName]} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProfileChips({ p }: { p?: PrepColProfile }) {
  if (!p || p.total === 0) return <span className="text-[10px] text-muted-foreground/50">—</span>;
  const nullPct = Math.round((p.nulls / p.total) * 100);
  return (
    <div className="flex flex-wrap gap-1">
      <span
        className={`rounded px-1 py-0.5 text-[9px] ${
          nullPct > 0
            ? "bg-amber-400/15 text-amber-700 dark:text-amber-300"
            : "bg-muted text-muted-foreground"
        }`}
        title={`${p.nulls} of ${p.total} rows are empty`}
      >
        {nullPct}% null
      </span>
      <span
        className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground"
        title="Distinct values in sample"
      >
        {p.distinct.toLocaleString()} distinct
      </span>
      {p.numeric && p.min !== undefined && p.max !== undefined && (
        <span
          className="rounded bg-muted px-1 py-0.5 text-[9px] tabular-nums text-muted-foreground"
          title={p.avg !== undefined ? `avg ${fmtBiNumber(p.avg)}` : undefined}
        >
          {fmtBiNumber(p.min)} – {fmtBiNumber(p.max)}
        </span>
      )}
    </div>
  );
}

// ── Calculated-fields editor ──────────────────────────────────────────────

function freshCalcName(cfg: PrepFlowConfig): string {
  const taken = new Set(preAggOutputNames(cfg).map((n) => n.toLowerCase()));
  let name = "new_field";
  let i = 1;
  while (taken.has(name.toLowerCase())) name = `new_field_${i++}`;
  return name;
}

function CalcEditor({
  cfg,
  setCfg,
  baseColumns,
}: {
  cfg: PrepFlowConfig;
  setCfg: SetCfg;
  baseColumns: string[];
}) {
  const activeRef = useRef<HTMLTextAreaElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  function addCalc() {
    const calc: PrepCalc = {
      id: crypto.randomUUID(),
      name: freshCalcName(cfg),
      expr: "",
      type: "decimal",
    };
    setCfg((p) => ({ ...p, calcs: [...p.calcs, calc] }));
    setActiveId(calc.id);
  }
  function updateCalc(id: string, patch: Partial<PrepCalc>) {
    setCfg((p) => ({ ...p, calcs: p.calcs.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }
  function removeCalc(id: string) {
    setCfg((p) => ({ ...p, calcs: p.calcs.filter((c) => c.id !== id) }));
    if (activeId === id) setActiveId(null);
  }

  // Insert text at the caret of whichever formula box is focused.
  function insert(text: string, caretInParens = false) {
    const el = activeRef.current;
    const calc = cfg.calcs.find((c) => c.id === activeId);
    if (!el || !calc) {
      toast.info("Click into a formula box first");
      return;
    }
    const start = el.selectionStart ?? calc.expr.length;
    const end = el.selectionEnd ?? calc.expr.length;
    const next = calc.expr.slice(0, start) + text + calc.expr.slice(end);
    updateCalc(calc.id, { expr: next });
    const paren = text.indexOf("(");
    const caret = caretInParens && paren >= 0 ? start + paren + 1 : start + text.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Add columns computed from a formula — math, text, date and logic functions over your
          fields.
        </p>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={addCalc}>
          <Plus className="h-3.5 w-3.5" /> Add field
        </Button>
      </div>

      {cfg.calcs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 py-8 text-center">
          <Calculator className="mx-auto mb-1 h-6 w-6 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No calculated fields yet. Example: <code className="font-mono">`revenue` - `cost`</code>{" "}
            or <code className="font-mono">ROUND(`amount` / `qty`, 2)</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {cfg.calcs.map((c) => (
            <div key={c.id} className="rounded-md border border-border/60 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={c.name}
                  onChange={(e) => updateCalc(c.id, { name: e.target.value })}
                  placeholder="field_name"
                  className="h-7 w-44 font-mono text-[11px]"
                />
                <Select
                  value={c.type}
                  onValueChange={(v) => updateCalc(c.id, { type: v as PrepColumnType })}
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
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeCalc(c.id)}
                  title="Remove field"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Textarea
                value={c.expr}
                onFocus={(e) => {
                  activeRef.current = e.currentTarget;
                  setActiveId(c.id);
                }}
                onChange={(e) => updateCalc(c.id, { expr: e.target.value })}
                placeholder="e.g. ROUND(`amount` / `qty`, 2)"
                className="mt-2 min-h-[60px] font-mono text-[11px]"
                spellCheck={false}
              />
            </div>
          ))}
        </div>
      )}

      {/* Insert palette */}
      <div className="rounded-md border border-border/50 bg-muted/30 p-2.5">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Insert into the active formula
        </p>
        {baseColumns.length > 0 && (
          <div className="mb-2">
            <p className="mb-1 text-[10px] text-muted-foreground">Columns</p>
            <div className="flex flex-wrap gap-1">
              {baseColumns.map((col) => (
                <button
                  key={col}
                  type="button"
                  onClick={() => insert("`" + col + "`")}
                  className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] hover:border-primary/50 hover:bg-primary/5"
                >
                  {col}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          {PREP_FUNCTIONS.map((grp) => (
            <div key={grp.group}>
              <p className="mb-1 text-[10px] text-muted-foreground">{grp.group}</p>
              <div className="flex flex-wrap gap-1">
                {grp.fns.map((fn) => (
                  <button
                    key={fn.label}
                    type="button"
                    title={fn.hint}
                    onClick={() => insert(fn.snippet, true)}
                    className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] hover:border-primary/50 hover:bg-primary/5"
                  >
                    {fn.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Filters editor ────────────────────────────────────────────────────────

function FiltersEditor({
  cfg,
  setCfg,
  columns,
}: {
  cfg: PrepFlowConfig;
  setCfg: SetCfg;
  columns: string[];
}) {
  const conds = cfg.filters.conditions;

  function add() {
    const f: PrepFilter = {
      id: crypto.randomUUID(),
      column: columns[0] ?? "",
      op: "=",
      value: "",
    };
    setCfg((p) => ({ ...p, filters: { ...p.filters, conditions: [...p.filters.conditions, f] } }));
  }
  function update(id: string, patch: Partial<PrepFilter>) {
    setCfg((p) => ({
      ...p,
      filters: {
        ...p.filters,
        conditions: p.filters.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    }));
  }
  function remove(id: string) {
    setCfg((p) => ({
      ...p,
      filters: { ...p.filters, conditions: p.filters.conditions.filter((c) => c.id !== id) },
    }));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Keep only rows that match your conditions.</p>
        <div className="flex items-center gap-2">
          {conds.length > 1 && (
            <Select
              value={cfg.filters.combine}
              onValueChange={(v) =>
                setCfg((p) => ({ ...p, filters: { ...p.filters, combine: v as "AND" | "OR" } }))
              }
            >
              <SelectTrigger className="h-7 w-28 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AND" className="text-xs">
                  Match all (AND)
                </SelectItem>
                <SelectItem value="OR" className="text-xs">
                  Match any (OR)
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={add}>
            <Plus className="h-3.5 w-3.5" /> Add filter
          </Button>
        </div>
      </div>

      {conds.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 py-8 text-center">
          <FilterIcon className="mx-auto mb-1 h-6 w-6 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No filters — every row is kept. Add one to narrow the output.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {conds.map((f, i) => {
            const op = PREP_FILTER_OPS.find((o) => o.value === f.op);
            return (
              <div key={f.id} className="flex flex-wrap items-center gap-1.5">
                <span className="w-10 text-right text-[10px] uppercase text-muted-foreground">
                  {i === 0 ? "Where" : cfg.filters.combine}
                </span>
                <Select
                  value={f.column || undefined}
                  onValueChange={(v) => update(f.id, { column: v })}
                >
                  <SelectTrigger className="h-7 w-44 font-mono text-[11px]">
                    <SelectValue placeholder="column" />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c} value={c} className="font-mono text-xs">
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={f.op} onValueChange={(v) => update(f.id, { op: v as PrepFilterOp })}>
                  <SelectTrigger className="h-7 w-36 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREP_FILTER_OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {op?.needsValue && (
                  <Input
                    value={f.value}
                    onChange={(e) => update(f.id, { value: e.target.value })}
                    placeholder="value"
                    className="h-7 w-40 text-[11px]"
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(f.id)}
                  title="Remove filter"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Aggregate / summarize editor ──────────────────────────────────────────

function defaultMeasureName(fn: PrepAggFn, col: string): string {
  return fn === "count" ? "row_count" : `${fn}_${col}`;
}

function AggregateEditor({
  cfg,
  setCfg,
  columns,
}: {
  cfg: PrepFlowConfig;
  setCfg: SetCfg;
  columns: string[];
}) {
  const agg = cfg.aggregate;

  function patchAgg(patch: Partial<typeof agg>) {
    setCfg((p) => ({ ...p, aggregate: { ...p.aggregate, ...patch } }));
  }
  function toggleGroup(col: string, on: boolean) {
    patchAgg({ groupBy: on ? [...agg.groupBy, col] : agg.groupBy.filter((g) => g !== col) });
  }
  function addMeasure() {
    const col = columns[0] ?? "";
    const m: PrepMeasure = {
      id: crypto.randomUUID(),
      fn: "sum",
      column: col,
      name: defaultMeasureName("sum", col),
    };
    patchAgg({ measures: [...agg.measures, m] });
  }
  function updateMeasure(id: string, patch: Partial<PrepMeasure>) {
    patchAgg({ measures: agg.measures.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }
  function removeMeasure(id: string) {
    patchAgg({ measures: agg.measures.filter((m) => m.id !== id) });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
        <div>
          <p className="text-xs font-medium">Summarize the data</p>
          <p className="text-[11px] text-muted-foreground">
            Roll rows up to a grain — group by dimensions and compute measures.
          </p>
        </div>
        <Switch checked={agg.enabled} onCheckedChange={(v) => patchAgg({ enabled: v })} />
      </div>

      {agg.enabled && (
        <>
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Group by
            </p>
            {columns.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No columns available.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {columns.map((c) => {
                  const on = agg.groupBy.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleGroup(c, !on)}
                      className={`rounded border px-2 py-0.5 font-mono text-[10px] transition ${
                        on
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border/60 bg-background hover:border-primary/40"
                      }`}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Measures
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 text-[10px]"
                onClick={addMeasure}
              >
                <Plus className="h-3 w-3" /> Add measure
              </Button>
            </div>
            {agg.measures.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No measures — add Sum, Average, Count, Min or Max.
              </p>
            ) : (
              <div className="space-y-1.5">
                {agg.measures.map((m) => (
                  <div key={m.id} className="flex flex-wrap items-center gap-1.5">
                    <Select
                      value={m.fn}
                      onValueChange={(v) => {
                        const fn = v as PrepAggFn;
                        // keep the auto-name in sync unless the user renamed it
                        const auto = defaultMeasureName(m.fn, m.column);
                        updateMeasure(m.id, {
                          fn,
                          name: m.name === auto ? defaultMeasureName(fn, m.column) : m.name,
                        });
                      }}
                    >
                      <SelectTrigger className="h-7 w-36 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PREP_AGG_FNS.map((a) => (
                          <SelectItem key={a.value} value={a.value} className="text-xs">
                            {a.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {aggNeedsColumn(m.fn) ? (
                      <Select
                        value={m.column || undefined}
                        onValueChange={(v) => {
                          const auto = defaultMeasureName(m.fn, m.column);
                          updateMeasure(m.id, {
                            column: v,
                            name: m.name === auto ? defaultMeasureName(m.fn, v) : m.name,
                          });
                        }}
                      >
                        <SelectTrigger className="h-7 w-44 font-mono text-[11px]">
                          <SelectValue placeholder="column" />
                        </SelectTrigger>
                        <SelectContent>
                          {columns.map((c) => (
                            <SelectItem key={c} value={c} className="font-mono text-xs">
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="w-44 text-[11px] text-muted-foreground">all rows</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">as</span>
                    <Input
                      value={m.name}
                      onChange={(e) => updateMeasure(m.id, { name: e.target.value })}
                      placeholder="measure_name"
                      className="h-7 w-40 font-mono text-[11px]"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeMeasure(m.id)}
                      title="Remove measure"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
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
    <div
      className={`w-48 rounded-lg border bg-card p-2.5 shadow-sm ${
        isBase
          ? "border-primary/40 border-t-2 border-t-primary"
          : "border-border border-t-2 border-t-sky-500/70"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <Table2 className={`h-3.5 w-3.5 shrink-0 ${isBase ? "text-primary" : "text-sky-500"}`} />
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
          <DialogTitle>Import a table from a source</DialogTitle>
          <DialogDescription>
            Pulls a snapshot (up to 1,000 rows) from a connected database or data warehouse into
            your local datasets so it can be combined in the prep canvas.
          </DialogDescription>
        </DialogHeader>
        {warehouses === null ? (
          <Skeleton className="h-9 w-full" />
        ) : warehouses.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No active connections. Add a database or warehouse under Integrations → Data Warehouses.
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
