// "Data preparation" tab of the BI Workspace — a step-based, self-serve data
// pipeline in the spirit of Tableau Prep / Power Query:
//
//   1. Combine   — drag tables onto the canvas to build a join graph
//   2. Shape     — pick/rename/retype columns (Columns), then apply an ordered,
//                  reorderable list of transform Steps: calculated fields,
//                  filters, summarize, append/union, pivot, unpivot, split,
//                  remove duplicates, find & replace
//   3. Output    — watch the result + column profile update live, then
//                  materialise it as a reusable local dataset (+ saved flow),
//                  optionally refreshed on a schedule
//
// Every step compiles to one layered read-only SELECT (see lib/dataPrep.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowLeftRight,
  ArrowUp,
  Calculator,
  ChevronDown,
  Clock,
  Code2,
  Columns3,
  Combine,
  Copy,
  Database,
  Filter as FilterIcon,
  FolderOpen,
  GripVertical,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Rows3,
  Scissors,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  makeStep,
  parsePrepConfig,
  prepStepLabel,
  profilePrepColumns,
  setPrepRefreshSchedule,
  stepInputColumns,
  PREP_AGG_FNS,
  PREP_FILTER_OPS,
  PREP_FUNCTIONS,
  PREP_JOIN_TYPES,
  PREP_SAVE_ROW_CAP,
  PREP_STEP_KINDS,
  PREP_TYPE_META,
  prepTables,
  removeTableFromFlow,
  runAndSavePrep,
  savePrepFlow,
  syncColumns,
  validatePrepConfig,
  type PrepAggFn,
  type PrepColProfile,
  type PrepColumnType,
  type PrepFilter,
  type PrepFilterOp,
  type PrepFlowConfig,
  type PrepFlowRow,
  type PrepJoinType,
  type PrepMeasure,
  type PrepSchemaCol,
  type PrepStep,
  type PrepStepKind,
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

const STEP_ICON: Record<PrepStepKind, React.ComponentType<{ className?: string }>> = {
  calc: Calculator,
  filter: FilterIcon,
  aggregate: Sigma,
  append: ArrowDownUp,
  pivot: LayoutGrid,
  unpivot: ArrowLeftRight,
  split: Scissors,
  dedupe: Copy,
  replace: Repeat,
};

const REFRESH_INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Hourly" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
];

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
  const [scheduleOpen, setScheduleOpen] = useState(false);
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
  const currentFlow = useMemo(() => flows.find((f) => f.id === flowId) ?? null, [flows, flowId]);

  const reloadDatasets = useCallback(async () => {
    try {
      setDatasets(await hydrateFromSupabase());
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
      const id = await savePrepFlow({ id: flowId, userId: user.id, name: flowName.trim(), cfg });
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
    if (info) addTable(info);
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

  // ── Step actions ────────────────────────────────────────────────────
  function addStep(kind: PrepStepKind) {
    setCfg((p) => ({ ...p, steps: [...p.steps, makeStep(kind, effectiveOutputColumns(p))] }));
    setShapeTab("steps");
  }
  function updateStep(index: number, next: PrepStep) {
    setCfg((p) => ({ ...p, steps: p.steps.map((s, i) => (i === index ? next : s)) }));
  }
  function removeStep(index: number) {
    setCfg((p) => ({ ...p, steps: p.steps.filter((_, i) => i !== index) }));
  }
  function moveStep(index: number, dir: -1 | 1) {
    setCfg((p) => {
      const j = index + dir;
      if (j < 0 || j >= p.steps.length) return p;
      const steps = [...p.steps];
      [steps[index], steps[j]] = [steps[j], steps[index]];
      return { ...p, steps };
    });
  }
  // Distinct values of a column at a given step boundary (for the pivot step).
  const detectPivotValues = useCallback(
    (index: number, column: string): string[] => {
      try {
        const upto: PrepFlowConfig = { ...cfg, steps: cfg.steps.slice(0, index) };
        const res = runQueryUnlimited(buildPrepSql(upto), PREP_SAVE_ROW_CAP);
        const set = new Set<string>();
        for (const r of res.rows) {
          const v = r[column];
          if (v !== null && v !== undefined && v !== "") set.add(String(v));
        }
        return [...set].sort().slice(0, 50);
      } catch {
        return [];
      }
    },
    [cfg],
  );

  const sql = cfg.base && validatePrepConfig(cfg).ok ? buildPrepSql(cfg) : null;
  const includedCount = cfg.columns.filter((c) => c.include).length;

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
            {flowId && currentFlow?.output_table_id && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setScheduleOpen(true)}
                title="Schedule automatic refresh"
              >
                <Clock className="h-3.5 w-3.5" />
                {currentFlow.refresh_enabled ? "Scheduled" : "Schedule"}
              </Button>
            )}
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
                  filter, summarize, pivot and more.
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
                desc="Choose columns and types, then apply an ordered pipeline of transforms."
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
                  <TabsTrigger value="steps" className="gap-1.5 text-xs">
                    <Wand2 className="h-3.5 w-3.5" /> Steps
                    {cfg.steps.length > 0 && (
                      <Badge variant="secondary" className="ml-0.5 px-1 text-[9px]">
                        {cfg.steps.length}
                      </Badge>
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
                <TabsContent value="steps">
                  <StepsEditor
                    cfg={cfg}
                    datasets={datasets ?? []}
                    onAdd={addStep}
                    onUpdate={updateStep}
                    onRemove={removeStep}
                    onMove={moveStep}
                    detectPivotValues={detectPivotValues}
                  />
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
      <ScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        flow={currentFlow}
        onSaved={() =>
          listPrepFlows()
            .then(setFlows)
            .catch(() => {})
        }
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

// ── Columns editor (source projection + profiling) ────────────────────────

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
                  <TypeSelect
                    value={c.type}
                    disabled={!c.include}
                    onChange={(v) =>
                      setCfg((p) => ({
                        ...p,
                        columns: p.columns.map((x) => (x.key === c.key ? { ...x, type: v } : x)),
                      }))
                    }
                  />
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

function TypeSelect({
  value,
  disabled,
  onChange,
  className,
}: {
  value: PrepColumnType;
  disabled?: boolean;
  onChange: (v: PrepColumnType) => void;
  className?: string;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(v) => onChange(v as PrepColumnType)}>
      <SelectTrigger className={className ?? "h-7 w-32 text-[11px]"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(
          Object.entries(PREP_TYPE_META) as [
            PrepColumnType,
            (typeof PREP_TYPE_META)[PrepColumnType],
          ][]
        ).map(([v, meta]) => (
          <SelectItem key={v} value={v} className="text-xs">
            {meta.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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

// ── Steps pipeline ────────────────────────────────────────────────────────

function StepsEditor({
  cfg,
  datasets,
  onAdd,
  onUpdate,
  onRemove,
  onMove,
  detectPivotValues,
}: {
  cfg: PrepFlowConfig;
  datasets: DatasetMeta[];
  onAdd: (kind: PrepStepKind) => void;
  onUpdate: (index: number, next: PrepStep) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  detectPivotValues: (index: number, column: string) => string[];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Transforms run top to bottom. Reorder with the arrows — each step works on the result of
          the one above.
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
              <Plus className="h-3.5 w-3.5" /> Add step
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {PREP_STEP_KINDS.map((k) => {
              const Icon = STEP_ICON[k.kind];
              return (
                <DropdownMenuItem key={k.kind} onClick={() => onAdd(k.kind)} className="gap-2">
                  <Icon className="h-3.5 w-3.5 text-primary" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{k.label}</p>
                    <p className="text-[10px] text-muted-foreground">{k.hint}</p>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {cfg.steps.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 py-10 text-center">
          <Wand2 className="mx-auto mb-1 h-6 w-6 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No transform steps yet. Add a calculated field, filter, summary, pivot and more.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {cfg.steps.map((step, i) => (
            <StepCard
              key={step.id}
              step={step}
              index={i}
              total={cfg.steps.length}
              inputCols={stepInputColumns(cfg, i)}
              datasets={datasets}
              onUpdate={(next) => onUpdate(i, next)}
              onRemove={() => onRemove(i)}
              onMove={(dir) => onMove(i, dir)}
              detectPivotValues={detectPivotValues}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StepCard({
  step,
  index,
  total,
  inputCols,
  datasets,
  onUpdate,
  onRemove,
  onMove,
  detectPivotValues,
}: {
  step: PrepStep;
  index: number;
  total: number;
  inputCols: PrepSchemaCol[];
  datasets: DatasetMeta[];
  onUpdate: (next: PrepStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  detectPivotValues: (index: number, column: string) => string[];
}) {
  const Icon = STEP_ICON[step.kind];
  const names = inputCols.map((c) => c.name);
  return (
    <div className="rounded-md border border-border/60">
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-2.5 py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-semibold text-primary">
          {index + 1}
        </span>
        <Icon className="h-3.5 w-3.5 text-primary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{prepStepLabel(step)}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          disabled={index === 0}
          title="Move up"
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          disabled={index === total - 1}
          title="Move down"
          onClick={() => onMove(1)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          title="Remove step"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="p-2.5">
        {step.kind === "calc" && <CalcStepEditor step={step} columns={names} onUpdate={onUpdate} />}
        {step.kind === "filter" && (
          <FilterStepEditor step={step} columns={names} onUpdate={onUpdate} />
        )}
        {step.kind === "aggregate" && (
          <AggregateStepEditor step={step} columns={names} onUpdate={onUpdate} />
        )}
        {step.kind === "append" && (
          <AppendStepEditor
            step={step}
            inputCols={inputCols}
            datasets={datasets}
            onUpdate={onUpdate}
          />
        )}
        {step.kind === "pivot" && (
          <PivotStepEditor
            step={step}
            columns={inputCols}
            onUpdate={onUpdate}
            detect={(col) => detectPivotValues(index, col)}
          />
        )}
        {step.kind === "unpivot" && (
          <UnpivotStepEditor step={step} columns={names} onUpdate={onUpdate} />
        )}
        {step.kind === "split" && (
          <SplitStepEditor step={step} columns={names} onUpdate={onUpdate} />
        )}
        {step.kind === "dedupe" && (
          <DedupeStepEditor step={step} columns={names} onUpdate={onUpdate} />
        )}
        {step.kind === "replace" && (
          <ReplaceStepEditor step={step} columns={names} onUpdate={onUpdate} />
        )}
      </div>
    </div>
  );
}

// ── Individual step editors ───────────────────────────────────────────────

function ColumnPicker({
  value,
  columns,
  placeholder = "column",
  onChange,
  className,
}: {
  value: string;
  columns: string[];
  placeholder?: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={className ?? "h-7 w-44 font-mono text-[11px]"}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {columns.map((c) => (
          <SelectItem key={c} value={c} className="font-mono text-xs">
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChipToggle({
  columns,
  selected,
  onToggle,
}: {
  columns: string[];
  selected: string[];
  onToggle: (col: string, on: boolean) => void;
}) {
  if (columns.length === 0)
    return <p className="text-[11px] text-muted-foreground">No columns available.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {columns.map((c) => {
        const on = selected.includes(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onToggle(c, !on)}
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
  );
}

function CalcStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "calc" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  function insert(text: string, caretInParens = false) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? step.expr.length;
    const end = el.selectionEnd ?? step.expr.length;
    const next = step.expr.slice(0, start) + text + step.expr.slice(end);
    onUpdate({ ...step, expr: next });
    const paren = text.indexOf("(");
    const caret = caretInParens && paren >= 0 ? start + paren + 1 : start + text.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={step.name}
          onChange={(e) => onUpdate({ ...step, name: e.target.value })}
          placeholder="field_name"
          className="h-7 w-44 font-mono text-[11px]"
        />
        <TypeSelect value={step.type} onChange={(v) => onUpdate({ ...step, type: v })} />
      </div>
      <Textarea
        ref={ref}
        value={step.expr}
        onChange={(e) => onUpdate({ ...step, expr: e.target.value })}
        placeholder="e.g. ROUND(`amount` / `qty`, 2)"
        className="min-h-[56px] font-mono text-[11px]"
        spellCheck={false}
      />
      <div className="rounded-md border border-border/50 bg-muted/30 p-2">
        {columns.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {columns.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => insert("`" + c + "`")}
                className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] hover:border-primary/50 hover:bg-primary/5"
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {PREP_FUNCTIONS.flatMap((g) => g.fns).map((fn) => (
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
    </div>
  );
}

function FilterStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "filter" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  function update(id: string, patch: Partial<PrepFilter>) {
    onUpdate({
      ...step,
      conditions: step.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        {step.conditions.length > 1 ? (
          <Select
            value={step.combine}
            onValueChange={(v) => onUpdate({ ...step, combine: v as "AND" | "OR" })}
          >
            <SelectTrigger className="h-7 w-32 text-[11px]">
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
        ) : (
          <span className="text-[11px] text-muted-foreground">Keep rows where</span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 text-[10px]"
          onClick={() =>
            onUpdate({
              ...step,
              conditions: [
                ...step.conditions,
                { id: crypto.randomUUID(), column: columns[0] ?? "", op: "=", value: "" },
              ],
            })
          }
        >
          <Plus className="h-3 w-3" /> Condition
        </Button>
      </div>
      {step.conditions.map((f) => {
        const op = PREP_FILTER_OPS.find((o) => o.value === f.op);
        return (
          <div key={f.id} className="flex flex-wrap items-center gap-1.5">
            <ColumnPicker
              value={f.column}
              columns={columns}
              onChange={(v) => update(f.id, { column: v })}
            />
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
                className="h-7 w-36 text-[11px]"
              />
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() =>
                onUpdate({ ...step, conditions: step.conditions.filter((c) => c.id !== f.id) })
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function defaultMeasureName(fn: PrepAggFn, col: string): string {
  return fn === "count" ? "row_count" : `${fn}_${col}`;
}

function AggregateStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "aggregate" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  function updateMeasure(id: string, patch: Partial<PrepMeasure>) {
    onUpdate({
      ...step,
      measures: step.measures.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  }
  return (
    <div className="space-y-2.5">
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Group by
        </p>
        <ChipToggle
          columns={columns}
          selected={step.groupBy}
          onToggle={(col, on) =>
            onUpdate({
              ...step,
              groupBy: on ? [...step.groupBy, col] : step.groupBy.filter((g) => g !== col),
            })
          }
        />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Measures
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 text-[10px]"
            onClick={() => {
              const col = columns[0] ?? "";
              onUpdate({
                ...step,
                measures: [
                  ...step.measures,
                  {
                    id: crypto.randomUUID(),
                    fn: "sum",
                    column: col,
                    name: defaultMeasureName("sum", col),
                  },
                ],
              });
            }}
          >
            <Plus className="h-3 w-3" /> Measure
          </Button>
        </div>
        {step.measures.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No measures — add Sum, Average, Count, Min or Max.
          </p>
        ) : (
          <div className="space-y-1.5">
            {step.measures.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={m.fn}
                  onValueChange={(v) => {
                    const fn = v as PrepAggFn;
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
                  <ColumnPicker
                    value={m.column}
                    columns={columns}
                    onChange={(v) => {
                      const auto = defaultMeasureName(m.fn, m.column);
                      updateMeasure(m.id, {
                        column: v,
                        name: m.name === auto ? defaultMeasureName(m.fn, v) : m.name,
                      });
                    }}
                  />
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
                  onClick={() =>
                    onUpdate({ ...step, measures: step.measures.filter((x) => x.id !== m.id) })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AppendStepEditor({
  step,
  inputCols,
  datasets,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "append" }>;
  inputCols: PrepSchemaCol[];
  datasets: DatasetMeta[];
  onUpdate: (next: PrepStep) => void;
}) {
  const chosen = datasets.find((d) => d.name === step.table);
  const chosenCols = new Set(chosen?.columns.map((c) => c.name) ?? []);
  const matched = inputCols.filter((c) => chosenCols.has(c.name)).length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={step.table || undefined}
          onValueChange={(v) => {
            const d = datasets.find((x) => x.name === v);
            onUpdate({ ...step, table: v, columns: d?.columns.map((c) => c.name) ?? [] });
          }}
        >
          <SelectTrigger className="h-7 w-56 font-mono text-[11px]">
            <SelectValue placeholder="dataset to append" />
          </SelectTrigger>
          <SelectContent>
            {datasets.map((d) => (
              <SelectItem key={d.id} value={d.name} className="font-mono text-xs">
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={step.mode}
          onValueChange={(v) => onUpdate({ ...step, mode: v as "all" | "distinct" })}
        >
          <SelectTrigger className="h-7 w-40 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              Keep all rows
            </SelectItem>
            <SelectItem value="distinct" className="text-xs">
              Unique rows only
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Rows are matched by column name; {matched} of {inputCols.length} columns align
        {chosen ? "" : " once you pick a dataset"}. Unmatched columns become empty.
      </p>
    </div>
  );
}

function PivotStepEditor({
  step,
  columns,
  onUpdate,
  detect,
}: {
  step: Extract<PrepStep, { kind: "pivot" }>;
  columns: PrepSchemaCol[];
  onUpdate: (next: PrepStep) => void;
  detect: (column: string) => string[];
}) {
  const names = columns.map((c) => c.name);
  return (
    <div className="space-y-2.5">
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Keep as rows (group by)
        </p>
        <ChipToggle
          columns={names}
          selected={step.group}
          onToggle={(col, on) =>
            onUpdate({
              ...step,
              group: on ? [...step.group, col] : step.group.filter((g) => g !== col),
            })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Columns from</span>
        <ColumnPicker
          value={step.pivotColumn}
          columns={names}
          placeholder="pivot column"
          onChange={(v) => onUpdate({ ...step, pivotColumn: v, values: detect(v) })}
        />
        <span className="text-[10px] text-muted-foreground">values,</span>
        <Select value={step.agg} onValueChange={(v) => onUpdate({ ...step, agg: v as PrepAggFn })}>
          <SelectTrigger className="h-7 w-32 text-[11px]">
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
        {aggNeedsColumn(step.agg) && (
          <>
            <span className="text-[10px] text-muted-foreground">of</span>
            <ColumnPicker
              value={step.valueColumn}
              columns={names}
              placeholder="value column"
              onChange={(v) => onUpdate({ ...step, valueColumn: v })}
            />
          </>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Pivot values ({step.values.length})
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            disabled={!step.pivotColumn}
            onClick={() => onUpdate({ ...step, values: detect(step.pivotColumn) })}
          >
            <RefreshCw className="mr-1 h-2.5 w-2.5" /> Detect
          </Button>
        </div>
        {step.values.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Pick a pivot column and detect its values (up to 50).
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {step.values.map((v) => (
              <span
                key={v}
                className="flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px]"
              >
                {v}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onUpdate({ ...step, values: step.values.filter((x) => x !== v) })}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UnpivotStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "unpivot" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  return (
    <div className="space-y-2.5">
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Columns to unpivot (become rows)
        </p>
        <ChipToggle
          columns={columns.filter((c) => !step.keep.includes(c))}
          selected={step.value}
          onToggle={(col, on) =>
            onUpdate({
              ...step,
              value: on ? [...step.value, col] : step.value.filter((v) => v !== col),
            })
          }
        />
      </div>
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Keep as-is
        </p>
        <ChipToggle
          columns={columns.filter((c) => !step.value.includes(c))}
          selected={step.keep}
          onToggle={(col, on) =>
            onUpdate({
              ...step,
              keep: on ? [...step.keep, col] : step.keep.filter((k) => k !== col),
            })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Name column</span>
        <Input
          value={step.nameField}
          onChange={(e) => onUpdate({ ...step, nameField: e.target.value })}
          className="h-7 w-32 font-mono text-[11px]"
        />
        <span className="text-[10px] text-muted-foreground">Value column</span>
        <Input
          value={step.valueField}
          onChange={(e) => onUpdate({ ...step, valueField: e.target.value })}
          className="h-7 w-32 font-mono text-[11px]"
        />
      </div>
    </div>
  );
}

function SplitStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "split" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Split</span>
        <ColumnPicker
          value={step.column}
          columns={columns}
          onChange={(v) => onUpdate({ ...step, column: v })}
        />
        <span className="text-[10px] text-muted-foreground">on</span>
        <Input
          value={step.delimiter}
          onChange={(e) => onUpdate({ ...step, delimiter: e.target.value })}
          placeholder="delimiter"
          className="h-7 w-20 font-mono text-[11px]"
        />
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Checkbox
            checked={step.keepOriginal}
            onCheckedChange={(v) => onUpdate({ ...step, keepOriginal: Boolean(v) })}
          />
          keep original
        </label>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Into columns
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={() =>
              onUpdate({ ...step, into: [...step.into, `part_${step.into.length + 1}`] })
            }
          >
            <Plus className="mr-0.5 h-2.5 w-2.5" /> Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {step.into.map((name, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={name}
                onChange={(e) =>
                  onUpdate({
                    ...step,
                    into: step.into.map((n, j) => (j === i ? e.target.value : n)),
                  })
                }
                className="h-7 w-28 font-mono text-[11px]"
              />
              {step.into.length > 1 && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onUpdate({ ...step, into: step.into.filter((_, j) => j !== i) })}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DedupeStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "dedupe" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {step.columns.length === 0
          ? "Removing fully-duplicate rows. Pick columns to dedupe on a subset (keeps the first match)."
          : "Keeping the first row for each unique combination of:"}
      </p>
      <ChipToggle
        columns={columns}
        selected={step.columns}
        onToggle={(col, on) =>
          onUpdate({
            ...step,
            columns: on ? [...step.columns, col] : step.columns.filter((c) => c !== col),
          })
        }
      />
    </div>
  );
}

function ReplaceStepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: Extract<PrepStep, { kind: "replace" }>;
  columns: string[];
  onUpdate: (next: PrepStep) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">In</span>
      <ColumnPicker
        value={step.column}
        columns={columns}
        onChange={(v) => onUpdate({ ...step, column: v })}
      />
      <Select
        value={step.mode}
        onValueChange={(v) => onUpdate({ ...step, mode: v as "substring" | "exact" })}
      >
        <SelectTrigger className="h-7 w-36 text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="substring" className="text-xs">
            replace text
          </SelectItem>
          <SelectItem value="exact" className="text-xs">
            replace whole value
          </SelectItem>
        </SelectContent>
      </Select>
      <Input
        value={step.find}
        onChange={(e) => onUpdate({ ...step, find: e.target.value })}
        placeholder="find"
        className="h-7 w-28 text-[11px]"
      />
      <span className="text-[10px] text-muted-foreground">→</span>
      <Input
        value={step.replaceWith}
        onChange={(e) => onUpdate({ ...step, replaceWith: e.target.value })}
        placeholder="replace with"
        className="h-7 w-28 text-[11px]"
      />
    </div>
  );
}

// ── Table node (canvas) ────────────────────────────────────────────────────

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

// ── Schedule dialog ─────────────────────────────────────────────────────────

function ScheduleDialog({
  open,
  onOpenChange,
  flow,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  flow: PrepFlowRow | null;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(1440);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && flow) {
      setEnabled(Boolean(flow.refresh_enabled));
      setIntervalMin(flow.refresh_interval_minutes ?? 1440);
    }
  }, [open, flow]);

  async function save() {
    if (!flow) return;
    setBusy(true);
    try {
      await setPrepRefreshSchedule({
        id: flow.id,
        enabled,
        intervalMinutes: enabled ? intervalMin : null,
      });
      toast.success(enabled ? "Scheduled refresh on" : "Scheduled refresh off");
      onSaved();
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
          <DialogTitle>Scheduled refresh</DialogTitle>
          <DialogDescription>
            Re-run this flow automatically on the server and overwrite its output dataset with fresh
            results.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Automatic refresh</p>
              <p className="text-[11px] text-muted-foreground">
                Uses your stored datasets — no browser needed.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          {enabled && (
            <div className="space-y-1.5">
              <Label className="text-xs">Frequency</Label>
              <Select value={String(intervalMin)} onValueChange={(v) => setIntervalMin(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFRESH_INTERVALS.map((r) => (
                    <SelectItem key={r.minutes} value={String(r.minutes)}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {flow?.last_refresh_at && (
            <p className="text-[11px] text-muted-foreground">
              Last refreshed {new Date(flow.last_refresh_at).toLocaleString()}
              {flow.last_refresh_error ? ` — last error: ${flow.last_refresh_error}` : ""}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Warehouse / DB import ────────────────────────────────────────────────────

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
