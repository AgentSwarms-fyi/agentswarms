// ETL Pipelines — extract, transform and load on the sandboxed runtime.
//
// One route, master → detail in local state. The visual builder is a real DAG
// canvas (XYFlow, same engine as the swarm canvas): any number of sources,
// transforms that join and branch, any number of targets — configured in a
// side panel, with the compiled Python one toggle away. Code mode is a
// full-height editor with AI generate/refine through the shared
// provider+model picker, so IAM model rules apply here exactly as in BI.
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Code2,
  Copy,
  Database as DatabaseIcon,
  Eye,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
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
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import { listCatalogSources, type CatalogSource } from "@/lib/dataCatalog";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import {
  AGG_FNS,
  compileGraph,
  codeTemplate,
  dbFamily,
  nativeWarehouseTarget,
  normalizeGraph,
  requirementsFor,
  starterGraph,
  type EtlGraph,
  type EtlNode,
  type EtlSourceConfig,
  type EtlTargetConfig,
  type EtlTransformConfig,
  type QualityRule,
} from "@/utils/etl/codegen";
import { getLakehouseOverview } from "@/utils/lakehouse.functions";
import { ETL_TEMPLATES } from "@/lib/etlTemplates";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import type { WarehouseConnectionSummary } from "@/utils/warehouse/types";
import {
  cancelEtlRunFn,
  deleteEtlPipeline,
  duplicateEtlPipeline,
  getEtlOverview,
  getEtlPipeline,
  getEtlRunLogs,
  listEtlPipelines,
  listEtlRuns,
  getEtlPreview,
  listEtlVersions,
  previewEtlNode,
  type EtlPreviewResult,
  restoreEtlVersion,
  rotateEtlTriggerToken,
  type EtlVersionSummary,
  runEtlPipeline,
  saveEtlPipeline,
  type EtlRecentRun,
  type EtlRunSummary,
} from "@/utils/etl.functions";

export const Route = createFileRoute("/_authenticated/etl")({
  component: EtlPage,
});

// ── Shared bits ─────────────────────────────────────────────────────────────

const RUN_STATUS_STYLE: Record<string, string> = {
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  queued: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  retrying: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  cancelled: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">never ran</span>;
  return (
    <Badge variant="outline" className={cn("border-0 capitalize", RUN_STATUS_STYLE[status])}>
      {(status === "running" || status === "retrying") && (
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      )}
      {status}
    </Badge>
  );
}

function fmtWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Page ────────────────────────────────────────────────────────────────────

type OverviewData = Awaited<ReturnType<typeof getEtlOverview>>;
type OverviewPipeline = OverviewData["pipelines"][number];

function EtlPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";

  const overviewFn = useServerFn(getEtlOverview);
  const [data, setData] = useState<OverviewData | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setData(await overviewFn({ data: { access_token: token } }));
    } catch (e) {
      toast.error(`Couldn't load pipelines: ${(e as Error).message}`);
    }
  }, [token, overviewFn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live dashboard: refresh while anything is running.
  useEffect(() => {
    if (!data || data.stats.running_now === 0) return;
    const t = setInterval(() => void reload(), 6000);
    return () => clearInterval(t);
  }, [data, reload]);

  if (openId) {
    return (
      <PipelineEditor
        id={openId}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
      />
    );
  }

  const stats = data?.stats;
  const rate = stats?.success_rate_7d;

  return (
    <div className="w-full space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Workflow className="h-6 w-6" /> ETL Pipelines
          </h1>
          <p className="text-sm text-muted-foreground">
            Move data from APIs, databases, warehouses and files into destinations your catalog, BI
            and agents can query — visually, in Python, or generated with AI.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> New pipeline
        </Button>
      </div>

      {/* ── Health strip ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Pipelines" value={data ? String(data.pipelines.length) : "—"} />
        <StatCard
          label="Scheduled"
          value={
            data
              ? String(data.pipelines.filter((x) => x.is_active && x.schedule !== "manual").length)
              : "—"
          }
          hint="active, on a clock"
        />
        <StatCard
          label="Running now"
          value={stats ? String(stats.running_now) : "—"}
          tone={stats && stats.running_now > 0 ? "info" : undefined}
        />
        <StatCard label="Runs · 7d" value={stats ? String(stats.runs_7d) : "—"} />
        <StatCard
          label="Success rate · 7d"
          value={rate === null || rate === undefined ? "—" : `${Math.round(rate * 100)}%`}
          tone={
            rate === null || rate === undefined
              ? undefined
              : rate >= 0.9
                ? "good"
                : rate >= 0.5
                  ? "warn"
                  : "bad"
          }
          hint={stats ? `${stats.succeeded_7d} ok · ${stats.failed_7d} failed` : undefined}
        />
        <StatCard
          label="Rows loaded · 7d"
          value={stats ? stats.rows_loaded_7d.toLocaleString() : "—"}
        />
        <StatCard
          label="Runtime · 7d"
          value={stats ? fmtRuntime(stats.runtime_ms_7d) : "—"}
          hint="sandbox time across pipelines"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        {/* ── Pipelines ── */}
        <div className="min-w-0 space-y-2">
          {data === null ? (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          ) : data.pipelines.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No pipelines yet. Create one — assemble it on the canvas, write the Python yourself,
                or let a model draft it from a brief.
              </CardContent>
            </Card>
          ) : (
            data.pipelines.map((p) => (
              <PipelineRow
                key={p.id}
                p={p}
                pulse={data.per_pipeline[p.id]}
                onOpen={() => setOpenId(p.id)}
                onChanged={reload}
              />
            ))
          )}
        </div>

        {/* ── Recent runs ── */}
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data === null ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : data.recent_runs.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">
                Nothing has run yet — every run lands here with its status, duration and rows.
              </p>
            ) : (
              <div className="divide-y">
                {data.recent_runs.map((r) => (
                  <RecentRunRow key={r.id} r={r} onOpen={() => setOpenId(r.pipeline_id)} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <NewPipelineDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setOpenId(id);
        }}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn" | "bad" | "info";
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "text-red-600 dark:text-red-400"
          : tone === "info"
            ? "text-sky-600 dark:text-sky-400"
            : "";
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", toneCls)}>{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

const DOT_STYLE: Record<string, string> = {
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-muted-foreground/40",
  running: "bg-sky-500 animate-pulse",
  queued: "bg-amber-500",
  retrying: "bg-amber-500 animate-pulse",
};

/** CI-style pulse: one dot per recent run, oldest to newest. */
function RunDots({ pulse }: { pulse?: { recent: string[]; success_rate: number | null } }) {
  if (!pulse?.recent.length) {
    return <span className="text-[11px] text-muted-foreground">no runs yet</span>;
  }
  return (
    <span className="flex items-center gap-1" title="Recent runs, oldest → newest">
      {[...pulse.recent].reverse().map((status, i) => (
        <span
          key={i}
          className={cn("h-2 w-2 rounded-full", DOT_STYLE[status] ?? "bg-muted-foreground/40")}
          title={status}
        />
      ))}
      {pulse.success_rate !== null && (
        <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
          {Math.round(pulse.success_rate * 100)}%
        </span>
      )}
    </span>
  );
}

/** Human runtime: 47s, 12m 3s, 1h 12m. */
function fmtRuntime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function scheduleLabel(p: OverviewPipeline): string {
  if (p.schedule === "cron") {
    return `cron ${p.cron_expr ?? "?"}${p.timezone ? ` (${p.timezone})` : ""}`;
  }
  return p.schedule;
}

function RecentRunRow({ r, onOpen }: { r: EtlRecentRun; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/50"
    >
      <StatusChip status={r.status} />
      <span className="min-w-0 flex-1 truncate">{r.pipeline_name}</span>
      <span className="text-xs text-muted-foreground">
        {fmtDuration(r.started_at, r.finished_at)}
      </span>
      {r.rows_loaded > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {r.rows_loaded.toLocaleString()} rows
        </span>
      )}
      <span className="text-xs text-muted-foreground">{fmtWhen(r.created_at)}</span>
    </button>
  );
}

function PipelineRow({
  p,
  pulse,
  onOpen,
  onChanged,
}: {
  p: OverviewPipeline;
  pulse?: {
    recent: string[];
    success_rate: number | null;
    runtime_ms_7d: number;
    rows_7d: number;
  };
  onOpen: () => void;
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const runFn = useServerFn(runEtlPipeline);
  const deleteFn = useServerFn(deleteEtlPipeline);
  const duplicateFn = useServerFn(duplicateEtlPipeline);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await runFn({ data: { access_token: session?.access_token ?? "", id: p.id } });
      if (res.ok) toast.success("Run started");
      else toast.error(res.error ?? "Run did not start");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{p.name}</span>
            <Badge variant="outline" className="capitalize">
              {p.mode === "visual" ? (
                <Workflow className="mr-1 h-3 w-3" />
              ) : (
                <Code2 className="mr-1 h-3 w-3" />
              )}
              {p.mode}
            </Badge>
            {!p.is_active && <Badge variant="outline">paused</Badge>}
            {p.run_after && (
              <Badge variant="outline" title="Starts when another pipeline succeeds">
                chained
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>schedule: {scheduleLabel(p)}</span>
            <span>last run: {fmtWhen(p.last_run_at)}</span>
            {p.schedule !== "manual" && p.is_active && <span>next: {fmtWhen(p.next_run_at)}</span>}
            {(p.retry_count ?? 0) > 0 && <span>retries: {p.retry_count}</span>}
            {pulse && pulse.runtime_ms_7d > 0 && (
              <span title="Sandbox runtime attributed to this pipeline, last 7 days">
                runtime 7d: {fmtRuntime(pulse.runtime_ms_7d)}
              </span>
            )}
            {pulse && pulse.rows_7d > 0 && <span>rows 7d: {pulse.rows_7d.toLocaleString()}</span>}
          </div>
          <div className="mt-1.5">
            <RunDots pulse={pulse} />
          </div>
        </button>
        <StatusChip status={p.last_run_status} />
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={runNow} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            <span className="ml-1 hidden sm:inline">Run</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Duplicate — a manual-schedule copy for staging or promotion"
            onClick={async () => {
              try {
                const res = await duplicateFn({
                  data: { access_token: session?.access_token ?? "", id: p.id },
                });
                toast.success(`Created "${res.name}"`);
                onChanged();
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{p.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The pipeline and its run history are removed. Data already loaded into the destination
              is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await deleteFn({
                  data: { access_token: session?.access_token ?? "", id: p.id },
                });
                toast.success("Pipeline deleted");
                onChanged();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── New pipeline ────────────────────────────────────────────────────────────

function NewPipelineDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { session } = useAuth();
  const saveFn = useServerFn(saveEtlPipeline);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"visual" | "code">("visual");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const template = ETL_TEMPLATES.find((t) => t.id === templateId);
      const res = await saveFn({
        data: {
          access_token: session?.access_token ?? "",
          name: name.trim(),
          mode: template ? template.mode : mode,
          ...(template
            ? {
                description: template.description,
                requirements: template.requirements,
                ...(template.mode === "visual"
                  ? { graph: template.graph as unknown as Record<string, unknown> }
                  : { source_code: template.source_code }),
              }
            : mode === "visual"
              ? { graph: starterGraph() as unknown as Record<string, unknown> }
              : { source_code: codeTemplate() }),
        },
      });
      onCreated(res.id);
      setName("");
      setTemplateId(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
          <DialogDescription>
            Start on the canvas and eject to code any time, or go straight to Python.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="etl-name">Name</Label>
            <Input
              id="etl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="orders_daily"
              onKeyDown={(e) => e.key === "Enter" && void create()}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["visual", "Visual canvas", Workflow, "Sources → transforms → targets"],
                ["code", "Code", Code2, "Hand-written or AI-generated Python"],
              ] as const
            ).map(([value, label, Icon, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setTemplateId(null);
                }}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  mode === value && !templateId
                    ? "border-primary bg-primary/5"
                    : "hover:border-primary/40",
                )}
              >
                <Icon className="mb-1 h-4 w-4" />
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{hint}</div>
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              …or start from a sample pipeline (uses the bundled demo datasets)
            </Label>
            <div className="max-h-56 space-y-1.5 overflow-auto pr-1">
              {ETL_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(templateId === t.id ? null : t.id)}
                  className={cn(
                    "w-full rounded-lg border p-2.5 text-left transition-colors",
                    templateId === t.id ? "border-primary bg-primary/5" : "hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {t.mode === "visual" ? (
                      <Workflow className="h-3.5 w-3.5" />
                    ) : (
                      <Code2 className="h-3.5 w-3.5" />
                    )}
                    {t.name}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Editor shell ────────────────────────────────────────────────────────────

type EditorPipeline = {
  id: string;
  name: string;
  description: string | null;
  mode: "visual" | "code";
  source_code: string;
  graph: EtlGraph | null;
  requirements: string;
  secret_refs: string;
  dest_catalog_source_id: string | null;
  schedule: "manual" | "hourly" | "daily" | "weekly" | "cron";
  cron_expr: string | null;
  timezone: string | null;
  retry_count: number;
  alerts: { on_failure: boolean; on_success: boolean; on_recovery: boolean } | null;
  allow_concurrent: boolean;
  default_params: Record<string, unknown> | null;
  run_after: string | null;
  is_active: boolean;
  timeout_minutes: number;
};

function PipelineEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const getFn = useServerFn(getEtlPipeline);
  const saveFn = useServerFn(saveEtlPipeline);
  const runFn = useServerFn(runEtlPipeline);

  const [p, setP] = useState<EditorPipeline | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("build");

  const reloadPipeline = useCallback(() => {
    // The session hydrates a beat after first render; firing with an empty
    // token would bounce the editor back to the list with a zod error.
    if (!token) return;
    void (async () => {
      try {
        const res = await getFn({ data: { access_token: token, id } });
        const row = res.pipeline;
        setP({
          id: row.id,
          name: row.name,
          description: row.description,
          mode: row.mode as "visual" | "code",
          source_code: row.source_code,
          graph: normalizeGraph(row.graph),
          requirements: row.requirements,
          secret_refs: row.secret_refs,
          dest_catalog_source_id: row.dest_catalog_source_id,
          schedule: row.schedule as EditorPipeline["schedule"],
          cron_expr: row.cron_expr,
          timezone: row.timezone,
          retry_count: row.retry_count ?? 0,
          alerts: (row as { alerts?: EditorPipeline["alerts"] }).alerts ?? {
            on_failure: true,
            on_success: false,
            on_recovery: true,
          },
          allow_concurrent: row.allow_concurrent ?? false,
          default_params: (row.default_params as Record<string, unknown> | null) ?? null,
          run_after: row.run_after,
          is_active: row.is_active,
          timeout_minutes: row.timeout_minutes,
        });
      } catch (e) {
        toast.error((e as Error).message);
        onBack();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);
  useEffect(() => {
    reloadPipeline();
  }, [reloadPipeline]);

  const patch = (updates: Partial<EditorPipeline>) => {
    setP((prev) => (prev ? { ...prev, ...updates } : prev));
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
    if (!p) return false;
    setSaving(true);
    try {
      const res = await saveFn({
        data: {
          access_token: token,
          id: p.id,
          name: p.name,
          description: p.description ?? undefined,
          mode: p.mode,
          source_code: p.source_code,
          graph:
            p.mode === "visual" && p.graph
              ? (p.graph as unknown as Record<string, unknown>)
              : undefined,
          requirements: p.requirements,
          secret_refs: p.secret_refs,
          dest_catalog_source_id: p.dest_catalog_source_id,
          schedule: p.schedule,
          cron_expr: p.cron_expr,
          timezone: p.timezone,
          retry_count: p.retry_count,
          alerts: p.alerts ?? undefined,
          allow_concurrent: p.allow_concurrent,
          default_params: p.default_params,
          run_after: p.run_after,
          is_active: p.is_active,
          timeout_minutes: p.timeout_minutes,
        },
      });
      setP((prev) => (prev ? { ...prev, source_code: res.source_code } : prev));
      setDirty(false);
      if (res.compile_error) {
        toast.warning(`Saved — but the graph can't run yet: ${res.compile_error}`);
      } else {
        toast.success("Saved");
      }
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const [paramsOpen, setParamsOpen] = useState(false);

  const runNow = async (params?: Record<string, unknown>) => {
    if (!p) return;
    if (dirty && !(await save())) return;
    setRunning(true);
    try {
      const res = await runFn({ data: { access_token: token, id: p.id, params } });
      if (res.ok) {
        toast.success("Run started");
        setTab("runs");
      } else toast.error(res.error ?? "Run did not start");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (!p) {
    return (
      <div className="w-full space-y-3 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Pipelines
          </Button>
          <Input
            value={p.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="h-9 w-56 font-medium"
          />
          <Badge variant="outline" className="capitalize">
            {p.mode}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={save} disabled={saving || !dirty}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
          </Button>
          <Button onClick={() => runNow()} disabled={running}>
            {running ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            Run now
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="Run with parameters"
            onClick={() => setParamsOpen(true)}
            disabled={running}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <RunParamsDialog
        open={paramsOpen}
        defaults={p.default_params}
        onClose={() => setParamsOpen(false)}
        onRun={(params) => {
          setParamsOpen(false);
          void runNow(params);
        }}
      />

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="build" className="mt-3 min-h-0 flex-1">
          {p.mode === "visual" ? (
            <CanvasBuilder
              pipelineId={p.id}
              graph={p.graph ?? starterGraph()}
              onChange={(graph) => patch({ graph, requirements: requirementsFor(graph) })}
              onEject={(code) => {
                patch({ mode: "code", source_code: code });
                toast.info("Ejected to code — the canvas no longer applies.");
              }}
            />
          ) : (
            <CodeBuilder p={p} onPatch={patch} />
          )}
        </TabsContent>
        <TabsContent value="runs" className="mt-3 min-h-0 flex-1 overflow-auto">
          <RunsTab pipelineId={p.id} />
        </TabsContent>
        <TabsContent value="settings" className="mt-3 min-h-0 flex-1 overflow-auto">
          <SettingsTab p={p} onPatch={patch} onDeleted={onBack} onRestored={reloadPipeline} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Run with parameters — the backfill door. Whatever JSON is entered reaches
 * entrypoint(inputs) merged over the pipeline's default params, and is pinned
 * on the run row so a re-run of "July 3-9" is forever attributable.
 */
function RunParamsDialog({
  open,
  defaults,
  onClose,
  onRun,
}: {
  open: boolean;
  defaults: Record<string, unknown> | null;
  onClose: () => void;
  onRun: (params: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) {
      setText(
        JSON.stringify(defaults ?? { start_date: "2026-08-01", end_date: "2026-08-07" }, null, 2),
      );
    }
  }, [open, defaults]);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run with parameters</DialogTitle>
          <DialogDescription>
            Delivered to entrypoint(inputs) on top of the pipeline defaults — the standard way to
            backfill a window or rerun one partition.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                  throw new Error("Parameters must be a JSON object");
                }
                onRun(parsed);
              } catch (e) {
                toast.error(`Invalid JSON: ${(e as Error).message}`);
              }
            }}
          >
            <Play className="mr-1 h-4 w-4" /> Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Canvas builder ──────────────────────────────────────────────────────────

const SOURCE_TYPES = [
  { type: "object_storage", label: "Object storage files" },
  { type: "database", label: "Database / warehouse" },
  { type: "http_api", label: "HTTP API (JSON)" },
  { type: "platform_dataset", label: "Platform dataset" },
  { type: "lakehouse", label: "Lakehouse table" },
  { type: "ingest", label: "Streamed rows (push)" },
  { type: "python", label: "Custom Python" },
] as const;

const TRANSFORM_TYPES = [
  { type: "filter", label: "Filter rows" },
  { type: "select", label: "Select columns" },
  { type: "rename", label: "Rename columns" },
  { type: "derive", label: "Derive column" },
  { type: "join", label: "Join" },
  { type: "union", label: "Union" },
  { type: "aggregate", label: "Aggregate" },
  { type: "sort", label: "Sort" },
  { type: "dedupe", label: "Deduplicate" },
  { type: "fill_nulls", label: "Fill nulls" },
  { type: "drop_nulls", label: "Drop nulls" },
  { type: "limit", label: "Limit rows" },
  { type: "quality_gate", label: "Quality gate" },
  { type: "sql", label: "SQL" },
  { type: "python", label: "Custom Python" },
] as const;

const TARGET_TYPES = [
  { type: "object_storage", label: "Object storage" },
  { type: "database", label: "Database / warehouse" },
  { type: "lakehouse", label: "Lakehouse table" },
  { type: "http_api", label: "HTTP API (reverse ETL)" },
] as const;

function typeLabel(node: EtlNode): string {
  const t = (node.config as { type: string }).type;
  const all = [...SOURCE_TYPES, ...TRANSFORM_TYPES, ...TARGET_TYPES] as readonly {
    type: string;
    label: string;
  }[];
  return all.find((x) => x.type === t)?.label ?? t;
}

function defaultNodeConfig(
  kind: EtlNode["kind"],
  type: string,
): EtlSourceConfig | EtlTransformConfig | EtlTargetConfig {
  if (kind === "source") {
    switch (type) {
      case "object_storage":
        return { type, path: "raw/*.csv", format: "csv" };
      case "database":
        return { type, mode: "table", table: "" };
      case "http_api":
        return { type, url: "https://", records_path: "" };
      default:
        return { type: "python", code: "return [{'id': 1}]" };
    }
  }
  if (kind === "target") {
    if (type === "http_api") {
      return { type: "http_api", url: "https://", method: "POST", batch_size: 500 };
    }
    if (type === "lakehouse") {
      return { type: "lakehouse", schema: "", table: "", write_mode: "replace" };
    }
    return type === "database"
      ? { type: "database", dataset: "public", table: "etl_output", write_mode: "replace" }
      : {
          type: "object_storage",
          dataset: "etl",
          table: "output",
          format: "parquet",
          write_mode: "replace",
        };
  }
  switch (type) {
    case "platform_dataset":
      return { type, table_id: "" };
    case "ingest":
      return { type };
    case "lakehouse":
      return { type, schema: "", mode: "table", table: "" };
    case "filter":
      return { type, expr: "amount > 0" };
    case "select":
      return { type, columns: [] };
    case "rename":
      return { type, mapping: {} };
    case "derive":
      return { type, column: "total", expr: "price * quantity" };
    case "join":
      return { type, how: "inner", left_on: ["id"], right_on: ["id"] };
    case "union":
      return { type };
    case "aggregate":
      return { type, group_by: [], aggs: [{ column: "id", fn: "count", as: "rows" }] };
    case "sort":
      return { type, by: [], descending: false };
    case "dedupe":
      return { type };
    case "fill_nulls":
      return { type, value: "0" };
    case "drop_nulls":
      return { type };
    case "limit":
      return { type, n: 1000 };
    case "sql":
      return { type, query: "SELECT * FROM t" };
    case "quality_gate":
      return { type, rules: [{ check: "not_null", column: "id", severity: "fail" }] };
    default:
      return { type: "python", code: "# df is the input frame\nreturn df" };
  }
}

/**
 * Run this node on sampled sources in the sandbox and show the frame it
 * produces. Polls the preview session until it lands; the pipeline itself is
 * untouched (no loads, no watermark movement).
 */
/** Lakehouse schemas the signed-in user can reach (owned + IAM-granted). */
function LakehouseSchemaPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (schema: string) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const overviewFn = useServerFn(getLakehouseOverview);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (!token) return;
    void overviewFn({ data: { access_token: token } })
      .then((res) => {
        setEnabled(res.enabled);
        setSchemas(res.schemas.map((sch) => sch.name));
      })
      .catch(() => setSchemas([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (!enabled) {
    return (
      <p className="text-[11px] text-red-500">
        The lakehouse isn&apos;t configured on this deployment — this node can&apos;t run.
      </p>
    );
  }
  return (
    <Field label="Lakehouse schema">
      <Select value={value} onValueChange={onPick}>
        <SelectTrigger className="h-8">
          <SelectValue placeholder="Choose a schema" />
        </SelectTrigger>
        <SelectContent>
          {schemas.map((sch) => (
            <SelectItem key={sch} value={sch}>
              {sch}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Datasets already on the platform: uploads, prep outputs, connector syncs. */
function PlatformDatasetPicker({
  tableId,
  onPick,
}: {
  tableId: string;
  onPick: (t: { id: string; name: string }) => void;
}) {
  const [tables, setTables] = useState<{ id: string; name: string; parquet_rows: number | null }[]>(
    [],
  );
  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("user_data_tables")
        .select("id, name, parquet_rows")
        .order("name");
      setTables((data ?? []) as typeof tables);
    })();
  }, []);
  return (
    <Field label="Dataset">
      <Select
        value={tableId}
        onValueChange={(v) => {
          const t = tables.find((x) => x.id === v);
          if (t) onPick({ id: t.id, name: t.name });
        }}
      >
        <SelectTrigger className="h-8">
          <SelectValue placeholder="Choose a dataset" />
        </SelectTrigger>
        <SelectContent>
          {tables.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
              {t.parquet_rows != null ? ` (${t.parquet_rows} rows)` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function NodePreview({ pipelineId, nodeId }: { pipelineId: string; nodeId: string }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const startFn = useServerFn(previewEtlNode);
  const pollFn = useServerFn(getEtlPreview);
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [result, setResult] = useState<EtlPreviewResult["preview"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const run = async () => {
    setState("running");
    setError(null);
    setResult(null);
    setOpen(true);
    try {
      const { session_id } = await startFn({
        data: { access_token: token, pipeline_id: pipelineId, node_id: nodeId },
      });
      const startedAt = Date.now();
      for (;;) {
        if (cancelled.current) return;
        if (Date.now() - startedAt > 180_000) throw new Error("Preview timed out after 3 minutes");
        await new Promise((r) => setTimeout(r, 2500));
        const res = await pollFn({ data: { access_token: token, session_id } });
        if (res.status === "succeeded" && res.preview) {
          setResult(res.preview);
          setState("done");
          return;
        }
        if (["error", "stopped"].includes(res.status)) {
          throw new Error(res.error ?? "Preview failed");
        }
      }
    } catch (e) {
      if (cancelled.current) return;
      setError((e as Error).message);
      setState("failed");
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={run}>
        <Eye className="mr-1 h-3.5 w-3.5" /> Preview data
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Data preview
              {result ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {result.rows.length} of {result.total_sampled} sampled row(s)
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>
          {state === "running" && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Running sampled preview in the sandbox…
            </div>
          )}
          {state === "failed" && (
            <div className="whitespace-pre-wrap py-4 font-mono text-xs text-red-500">{error}</div>
          )}
          {state === "done" && result && (
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} className="px-2 py-1.5 text-left font-medium">
                        {c.name}
                        <span className="ml-1 font-normal text-muted-foreground">{c.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-t">
                      {result.columns.map((c) => (
                        <td key={c.name} className="max-w-56 truncate px-2 py-1 font-mono">
                          {r[c.name] === null || r[c.name] === undefined ? (
                            <span className="text-muted-foreground">∅</span>
                          ) : (
                            String(r[c.name])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const QUALITY_CHECK_OPTIONS: { value: QualityRule["check"]; label: string }[] = [
  { value: "not_null", label: "Not null" },
  { value: "unique", label: "Unique" },
  { value: "range", label: "In range" },
  { value: "regex", label: "Matches regex" },
  { value: "allowed_values", label: "Allowed values" },
  { value: "row_count_min", label: "Min row count" },
];

/** Per-gate rule list: check, column/params, and what a violation does. */
function QualityRulesEditor({
  rules,
  onChange,
}: {
  rules: QualityRule[];
  onChange: (rules: QualityRule[]) => void;
}) {
  const patch = (i: number, p: Partial<QualityRule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">Rules</div>
      {rules.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-md border p-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Select
              value={r.check}
              onValueChange={(v) => patch(i, { check: v as QualityRule["check"] })}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUALITY_CHECK_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={r.severity}
              onValueChange={(v) => patch(i, { severity: v as QualityRule["severity"] })}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fail">Fail the run</SelectItem>
                <SelectItem value="warn">Warn and continue</SelectItem>
                <SelectItem value="drop">Drop bad rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {r.check !== "row_count_min" && (
            <Input
              placeholder="column"
              className="h-7 font-mono text-xs"
              value={r.column ?? ""}
              onChange={(e) => patch(i, { column: e.target.value })}
            />
          )}
          {(r.check === "range" || r.check === "row_count_min") && (
            <div className="grid grid-cols-2 gap-1.5">
              <Input
                type="number"
                placeholder="min"
                className="h-7 font-mono text-xs"
                value={r.min ?? ""}
                onChange={(e) =>
                  patch(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
              {r.check === "range" && (
                <Input
                  type="number"
                  placeholder="max"
                  className="h-7 font-mono text-xs"
                  value={r.max ?? ""}
                  onChange={(e) =>
                    patch(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              )}
            </div>
          )}
          {r.check === "regex" && (
            <Input
              placeholder="^[A-Z]{2}-\\d+$"
              className="h-7 font-mono text-xs"
              value={r.pattern ?? ""}
              onChange={(e) => patch(i, { pattern: e.target.value })}
            />
          )}
          {r.check === "allowed_values" && (
            <Input
              placeholder="comma,separated,values"
              className="h-7 font-mono text-xs"
              value={(r.values ?? []).join(", ")}
              onChange={(e) =>
                patch(i, {
                  values: e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full text-xs text-muted-foreground"
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
          >
            Remove rule
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={() => onChange([...rules, { check: "not_null", column: "", severity: "fail" }])}
      >
        Add rule
      </Button>
    </div>
  );
}

const NODE_STYLE: Record<EtlNode["kind"], { ring: string; chip: string; icon: typeof Shuffle }> = {
  source: {
    ring: "border-emerald-500/50",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    icon: ArrowUpFromLine,
  },
  transform: {
    ring: "border-sky-500/50",
    chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    icon: Shuffle,
  },
  target: {
    ring: "border-violet-500/50",
    chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    icon: ArrowDownToLine,
  },
};

type FlowData = { node: EtlNode };

function EtlFlowNode({ data, selected }: NodeProps) {
  const node = (data as FlowData).node;
  const style = NODE_STYLE[node.kind];
  const Icon = style.icon;
  return (
    <div
      className={cn(
        "min-w-40 rounded-lg border-2 bg-card px-3 py-2 shadow-sm",
        style.ring,
        selected && "ring-2 ring-primary",
      )}
    >
      {node.kind !== "source" && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2">
        <span className={cn("rounded p-1", style.chip)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{node.label || node.id}</div>
          <div className="truncate text-[10px] text-muted-foreground">{typeLabel(node)}</div>
        </div>
      </div>
      {node.kind !== "target" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const NODE_TYPES = { etl: EtlFlowNode };

function CanvasBuilder({
  graph,
  pipelineId,
  onChange,
  onEject,
}: {
  graph: EtlGraph;
  pipelineId: string;
  onChange: (g: EtlGraph) => void;
  onEject: (code: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const compiled = useMemo(() => {
    try {
      return { ok: true as const, code: compileGraph(graph) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [graph]);

  // XYFlow in controlled mode sends `dimensions` (and other) changes that MUST
  // be applied back to the node array, or every node stays visibility:hidden
  // waiting to be measured. So the flow nodes live in their own state fed
  // through applyNodeChanges, and the graph is synced FROM that state for the
  // pieces it owns (positions, removals) — while a structural change in the
  // graph (add node, config edit) rebuilds the state, preserving measurements.
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  useEffect(() => {
    setFlowNodes((prev) =>
      graph.nodes.map((n) => {
        const old = prev.find((f) => f.id === n.id);
        return {
          ...(old ?? {}),
          id: n.id,
          type: "etl",
          position: n.position ?? old?.position ?? { x: 100, y: 100 },
          data: { node: n },
          selected: n.id === selectedId,
        } as FlowNode;
      }),
    );
  }, [graph.nodes, selectedId]);

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        animated: true,
      })),
    [graph.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setFlowNodes((nds) => applyNodeChanges(changes, nds));
      const removed = new Set(
        changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id),
      );
      const moved = changes.filter(
        (c): c is Extract<NodeChange, { type: "position" }> =>
          c.type === "position" && Boolean(c.position),
      );
      if (!removed.size && !moved.length) return;
      const positions = new Map(moved.map((c) => [c.id, c.position!]));
      const next: EtlGraph = {
        nodes: graph.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)),
        edges: graph.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)),
      };
      if (removed.size && selectedId && removed.has(selectedId)) setSelectedId(null);
      onChange(next);
    },
    [graph, onChange, selectedId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = new Set(
        changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id),
      );
      if (!removed.size) return;
      onChange({ ...graph, edges: graph.edges.filter((e) => !removed.has(e.id)) });
    },
    [graph, onChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      if (graph.edges.some((e) => e.from === conn.source && e.to === conn.target)) return;
      onChange({
        ...graph,
        edges: [
          ...graph.edges,
          { id: `e${Date.now().toString(36)}`, from: conn.source, to: conn.target },
        ],
      });
    },
    [graph, onChange],
  );

  const addNode = (kind: EtlNode["kind"], type: string, label: string) => {
    const nextNum =
      graph.nodes.reduce((max, n) => {
        const m = /^n(\d+)$/.exec(n.id);
        return m ? Math.max(max, Number(m[1])) : max;
      }, 0) + 1;
    const id = `n${nextNum}`;
    const x = kind === "source" ? 80 : kind === "target" ? 640 : 360;
    const y = 80 + (graph.nodes.length % 6) * 90;
    onChange({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id, kind, label, config: defaultNodeConfig(kind, type), position: { x, y } },
      ],
    });
    setSelectedId(id);
  };

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const updateSelected = (config: EtlNode["config"], label?: string) => {
    if (!selected) return;
    onChange({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === selected.id ? { ...n, config, ...(label !== undefined ? { label } : {}) } : n,
      ),
    });
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border">
        <div className="absolute left-2 top-2 z-10 flex gap-1">
          <AddMenu label="Source" items={SOURCE_TYPES} onPick={(t, l) => addNode("source", t, l)} />
          <AddMenu
            label="Transform"
            items={TRANSFORM_TYPES}
            onPick={(t, l) => addNode("transform", t, l)}
          />
          <AddMenu label="Target" items={TARGET_TYPES} onPick={(t, l) => addNode("target", t, l)} />
        </div>
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <Button
            size="sm"
            variant={showCode ? "default" : "outline"}
            onClick={() => setShowCode((v) => !v)}
          >
            <Code2 className="mr-1 h-3 w-3" /> Code
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!compiled.ok) {
                toast.error(`Fix the graph first: ${compiled.error}`);
                return;
              }
              onEject(compiled.code);
            }}
          >
            Eject to code
          </Button>
        </div>
        {!compiled.ok && (
          <div className="absolute bottom-2 left-2 right-2 z-10 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            {compiled.error}
          </div>
        )}
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          onEdgeDoubleClick={(_, edge) =>
            onChange({ ...graph, edges: graph.edges.filter((e) => e.id !== edge.id) })
          }
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          proOptions={{ hideAttribution: true }}
          colorMode={isDark ? "dark" : "light"}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {showCode && (
        <div className="w-[30rem] shrink-0 overflow-hidden rounded-lg border">
          <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Generated Python — exactly what a run executes
          </div>
          <div className="h-[calc(100%-2rem)] overflow-auto">
            <CodeMirror
              value={compiled.ok ? compiled.code : `# ${compiled.error}\n`}
              extensions={[python()]}
              theme={isDark ? vscodeDark : vscodeLight}
              editable={false}
              basicSetup={{ lineNumbers: true, foldGutter: false }}
            />
          </div>
        </div>
      )}

      {selected && !showCode && (
        <div className="w-80 shrink-0 overflow-auto rounded-lg border p-3">
          <NodePanel
            node={selected}
            graph={graph}
            pipelineId={pipelineId}
            onChange={updateSelected}
            onDelete={() => {
              onChange({
                nodes: graph.nodes.filter((n) => n.id !== selected.id),
                edges: graph.edges.filter((e) => e.from !== selected.id && e.to !== selected.id),
              });
              setSelectedId(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function AddMenu({
  label,
  items,
  onPick,
}: {
  label: string;
  items: readonly { type: string; label: string }[];
  onPick: (type: string, label: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-3 w-3" /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {items.map((it) => (
          <DropdownMenuItem key={it.type} onClick={() => onPick(it.type, it.label)}>
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Node config panel ───────────────────────────────────────────────────────

function csv(list: string[] | undefined): string {
  return (list ?? []).join(", ");
}
function unCsv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function NodePanel({
  node,
  graph,
  pipelineId,
  onChange,
  onDelete,
}: {
  node: EtlNode;
  graph: EtlGraph;
  pipelineId: string;
  onChange: (config: EtlNode["config"], label?: string) => void;
  onDelete: () => void;
}) {
  const { session } = useAuth();
  const [storageSources, setStorageSources] = useState<CatalogSource[]>([]);
  const [connections, setConnections] = useState<WarehouseConnectionSummary[]>([]);
  const listConnFn = useServerFn(listWarehouseConnections);

  const c = node.config as { type: string } & Record<string, unknown>;
  const needsStorage = c.type === "object_storage";
  const needsDb = c.type === "database";

  useEffect(() => {
    if (needsStorage) {
      listCatalogSources()
        .then((all) => setStorageSources(all.filter((s) => s.kind === "object_storage")))
        .catch(() => {});
    }
    if (needsDb && session?.access_token) {
      listConnFn({ data: { access_token: session.access_token } })
        .then((res) => {
          if (res.ok) setConnections(res.connections);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsStorage, needsDb, node.id]);

  const set = (updates: Record<string, unknown>) =>
    onChange({ ...node.config, ...updates } as EtlNode["config"]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="capitalize">
          {node.kind} · {typeLabel(node)}
        </Badge>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div>
        <Label className="text-xs">Label</Label>
        <Input
          value={node.label ?? ""}
          onChange={(e) => onChange(node.config, e.target.value)}
          className="h-8"
        />
      </div>
      <NodePreview pipelineId={pipelineId} nodeId={node.id} />

      {needsStorage && (
        <div>
          <Label className="text-xs">Bucket (Data Catalog storage source)</Label>
          <Select
            value={(c.catalog_source_id as string) ?? ""}
            onValueChange={(v) => set({ catalog_source_id: v || undefined })}
          >
            <SelectTrigger className="h-8">
              <SelectValue
                placeholder={node.kind === "target" ? "Pipeline destination" : "Choose a bucket"}
              />
            </SelectTrigger>
            <SelectContent>
              {storageSources.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {node.kind === "target" && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Empty = the pipeline destination chosen under Settings.
            </p>
          )}
        </div>
      )}
      {needsDb && (
        <div>
          <Label className="text-xs">Connection</Label>
          <Select
            value={(c.connection_id as string) ?? ""}
            onValueChange={(v) => {
              const conn = connections.find((x) => x.id === v);
              set({ connection_id: v || undefined, provider: conn?.provider });
            }}
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Choose a connection" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.name} ({x.provider})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {typeof c.provider === "string" &&
            c.provider &&
            !dbFamily(c.provider) &&
            !(node.kind === "target" && nativeWarehouseTarget(c.provider)) && (
              <p className="mt-1 text-[11px] text-red-500">
                {c.provider} connections aren&apos;t supported{" "}
                {node.kind === "target"
                  ? "as pipeline targets this release."
                  : "as pipeline sources this release — stage through object storage instead."}
              </p>
            )}
          {typeof c.provider === "string" &&
            node.kind === "target" &&
            nativeWarehouseTarget(c.provider) && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Loads through the warehouse&apos;s native bulk path.
              </p>
            )}
        </div>
      )}

      {c.type === "lakehouse" && (
        <>
          <LakehouseSchemaPicker
            value={(c.schema as string) ?? ""}
            onPick={(schema) => set({ schema })}
          />
          {node.kind === "source" ? (
            <>
              <Field label="Read">
                <Select
                  value={(c.mode as string) ?? "table"}
                  onValueChange={(v) => set({ mode: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="table">Whole table</SelectItem>
                    <SelectItem value="query">SQL query</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {c.mode === "query" ? (
                <Field label="Query (schema-qualified)">
                  <Textarea
                    rows={3}
                    className="font-mono text-xs"
                    value={(c.query as string) ?? ""}
                    onChange={(e) => set({ query: e.target.value })}
                    placeholder="SELECT * FROM analytics.orders WHERE amount > 100"
                  />
                </Field>
              ) : (
                <Field label="Table">
                  <Input
                    className="h-8 font-mono text-xs"
                    value={(c.table as string) ?? ""}
                    onChange={(e) => set({ table: e.target.value.toLowerCase() })}
                    placeholder="orders"
                  />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="Table">
                <Input
                  className="h-8 font-mono text-xs"
                  value={(c.table as string) ?? ""}
                  onChange={(e) => set({ table: e.target.value.toLowerCase() })}
                  placeholder="orders"
                />
              </Field>
              <Field label="Write mode">
                <Select
                  value={(c.write_mode as string) ?? "replace"}
                  onValueChange={(v) => set({ write_mode: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="replace">Replace</SelectItem>
                    <SelectItem value="append">Append</SelectItem>
                    <SelectItem value="merge">Merge (upsert)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {c.write_mode === "merge" && (
                <Field label="Primary key columns">
                  <Input
                    className="h-8 font-mono text-xs"
                    value={csv(c.primary_key as string[])}
                    onChange={(e) => set({ primary_key: unCsv(e.target.value) })}
                    placeholder="id"
                  />
                </Field>
              )}
            </>
          )}
          <p className="text-[11px] text-muted-foreground">
            Writes commit to the lakehouse as ACID snapshots. The pipeline owner must have access to
            the schema — share it from Admin → IAM.
          </p>
        </>
      )}
      {c.type === "ingest" && node.kind === "source" && (
        <p className="text-[11px] text-muted-foreground">
          Drains rows pushed to <span className="font-mono">POST /api/etl/ingest</span> with this
          pipeline&apos;s trigger token (Settings → External trigger). Each run loads everything
          received since the last run — push, then trigger a run for near-real-time.
        </p>
      )}
      {c.type === "platform_dataset" && node.kind === "source" && (
        <PlatformDatasetPicker
          tableId={(c.table_id as string) ?? ""}
          onPick={(t) => set({ table_id: t.id, table_name: t.name })}
        />
      )}
      {c.type === "object_storage" && node.kind === "source" && (
        <>
          <Field label="Path or glob">
            <Input
              className="h-8 font-mono text-xs"
              value={c.path as string}
              onChange={(e) => set({ path: e.target.value })}
              placeholder="raw/orders/*.csv"
            />
          </Field>
          <Field label="Format">
            <Select value={c.format as string} onValueChange={(v) => set({ format: v })}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["csv", "tsv", "json", "jsonl", "parquet", "xlsx"].map((f) => (
                  <SelectItem key={f} value={f}>
                    {f.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
      {c.type === "database" && node.kind === "source" && (
        <>
          <Field label="Read">
            <Select value={c.mode as string} onValueChange={(v) => set({ mode: v })}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="table">Whole table</SelectItem>
                <SelectItem value="query">SQL query</SelectItem>
                <SelectItem value="cdc">Change data capture</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {c.mode === "table" || c.mode === "cdc" ? (
            <Field label="Table">
              <Input
                className="h-8 font-mono text-xs"
                value={(c.table as string) ?? ""}
                onChange={(e) => set({ table: e.target.value })}
                placeholder="schema.orders"
              />
            </Field>
          ) : (
            <Field label="Query">
              <Textarea
                rows={4}
                className="font-mono text-xs"
                value={(c.query as string) ?? ""}
                onChange={(e) => set({ query: e.target.value })}
                placeholder="SELECT * FROM orders WHERE created_at > now() - interval '1 day'"
              />
            </Field>
          )}
          {c.mode === "cdc" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">Initial snapshot</div>
                  <div className="text-[11px] text-muted-foreground">
                    Full table read on the first run, before changes stream.
                  </div>
                </div>
                <Switch
                  checked={(c.initial_snapshot as boolean | undefined) !== false}
                  onCheckedChange={(v) => set({ initial_snapshot: v })}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Reads a PostgreSQL logical-replication slot (wal2json) the engine creates and
                manages. Rows carry _cdc_action / _cdc_deleted / _cdc_lsn; a merge target with
                primary keys applies updates and deletes automatically.
              </p>
            </>
          )}
        </>
      )}
      {(c.type === "database" || c.type === "object_storage") &&
        node.kind === "source" &&
        c.mode !== "cdc" && (
          <Field label="Incremental cursor column (optional)">
            <Input
              className="h-8 font-mono text-xs"
              value={
                ((c.incremental as { cursor_column?: string } | undefined)?.cursor_column as
                  | string
                  | undefined) ?? ""
              }
              onChange={(e) =>
                set({
                  incremental: e.target.value.trim()
                    ? { cursor_column: e.target.value.trim() }
                    : undefined,
                })
              }
              placeholder="updated_at"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Only rows above the stored watermark load; the engine advances it after each
              successful run.
            </p>
          </Field>
        )}
      {c.type === "http_api" && (
        <>
          <Field label="URL">
            <Input
              className="h-8 font-mono text-xs"
              value={c.url as string}
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
          <Field label="Records path (optional)">
            <Input
              className="h-8 font-mono text-xs"
              value={(c.records_path as string) ?? ""}
              onChange={(e) => set({ records_path: e.target.value })}
              placeholder="data.items"
            />
          </Field>
        </>
      )}
      {c.type === "python" && (
        <Field label={node.kind === "source" ? "Body of extract()" : "Body — df in, df out"}>
          <Textarea
            rows={6}
            className="font-mono text-xs"
            value={c.code as string}
            onChange={(e) => set({ code: e.target.value })}
          />
        </Field>
      )}
      {c.type === "filter" && (
        <Field label="Condition (query syntax)">
          <Input
            className="h-8 font-mono text-xs"
            value={c.expr as string}
            onChange={(e) => set({ expr: e.target.value })}
            placeholder="amount > 0 and country == 'DE'"
          />
        </Field>
      )}
      {c.type === "select" && (
        <Field label="Columns to keep (comma-separated)">
          <Input
            className="h-8 font-mono text-xs"
            value={csv(c.columns as string[])}
            onChange={(e) => set({ columns: unCsv(e.target.value) })}
          />
        </Field>
      )}
      {c.type === "rename" && (
        <Field label="old:new, comma-separated">
          <Input
            className="h-8 font-mono text-xs"
            value={Object.entries((c.mapping as Record<string, string>) ?? {})
              .map(([a, b]) => `${a}:${b}`)
              .join(", ")}
            onChange={(e) => {
              const mapping: Record<string, string> = {};
              for (const pair of e.target.value.split(",")) {
                const [from, to] = pair.split(":").map((x) => x.trim());
                if (from && to) mapping[from] = to;
              }
              set({ mapping });
            }}
          />
        </Field>
      )}
      {c.type === "derive" && (
        <>
          <Field label="New column">
            <Input
              className="h-8 font-mono text-xs"
              value={c.column as string}
              onChange={(e) => set({ column: e.target.value })}
            />
          </Field>
          <Field label="Expression">
            <Input
              className="h-8 font-mono text-xs"
              value={c.expr as string}
              onChange={(e) => set({ expr: e.target.value })}
              placeholder="price * quantity"
            />
          </Field>
        </>
      )}
      {c.type === "join" && (
        <>
          <Field label="Join type">
            <Select value={c.how as string} onValueChange={(v) => set({ how: v })}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["inner", "left", "right", "outer"].map((h) => (
                  <SelectItem key={h} value={h}>
                    {h}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Left side">
            <Select
              value={(c.left_node as string) ?? ""}
              onValueChange={(v) => set({ left_node: v || undefined })}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder="First connected input" />
              </SelectTrigger>
              <SelectContent>
                {graph.edges
                  .filter((e) => e.to === node.id)
                  .map((e) => {
                    const up = graph.nodes.find((n) => n.id === e.from);
                    return (
                      <SelectItem key={e.from} value={e.from}>
                        {up?.label || e.from}
                      </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Left keys (comma-separated)">
            <Input
              className="h-8 font-mono text-xs"
              value={csv(c.left_on as string[])}
              onChange={(e) => set({ left_on: unCsv(e.target.value) })}
            />
          </Field>
          <Field label="Right keys">
            <Input
              className="h-8 font-mono text-xs"
              value={csv(c.right_on as string[])}
              onChange={(e) => set({ right_on: unCsv(e.target.value) })}
            />
          </Field>
        </>
      )}
      {c.type === "aggregate" && (
        <>
          <Field label="Group by (comma-separated)">
            <Input
              className="h-8 font-mono text-xs"
              value={csv(c.group_by as string[])}
              onChange={(e) => set({ group_by: unCsv(e.target.value) })}
            />
          </Field>
          <Field label="Aggregations (col:fn:as per line)">
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={((c.aggs as { column: string; fn: string; as: string }[]) ?? [])
                .map((a) => `${a.column}:${a.fn}:${a.as}`)
                .join("\n")}
              onChange={(e) => {
                const aggs = e.target.value
                  .split("\n")
                  .map((line) => {
                    const [column, fn, as] = line.split(":").map((x) => x.trim());
                    return column && fn && as ? { column, fn, as } : null;
                  })
                  .filter(Boolean);
                set({ aggs });
              }}
              placeholder={"amount:sum:total_amount\nid:count:orders"}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">Functions: {AGG_FNS.join(", ")}</p>
        </>
      )}
      {c.type === "sort" && (
        <>
          <Field label="Sort by (comma-separated)">
            <Input
              className="h-8 font-mono text-xs"
              value={csv(c.by as string[])}
              onChange={(e) => set({ by: unCsv(e.target.value) })}
            />
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={Boolean(c.descending)}
              onCheckedChange={(v) => set({ descending: v })}
            />
            Descending
          </label>
        </>
      )}
      {(c.type === "dedupe" || c.type === "drop_nulls") && (
        <Field label="Columns (empty = whole row)">
          <Input
            className="h-8 font-mono text-xs"
            value={csv(c.columns as string[])}
            onChange={(e) => set({ columns: unCsv(e.target.value) })}
          />
        </Field>
      )}
      {c.type === "fill_nulls" && (
        <>
          <Field label="Fill value">
            <Input
              className="h-8 font-mono text-xs"
              value={(c.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
            />
          </Field>
          <Field label="Columns (empty = all)">
            <Input
              className="h-8 font-mono text-xs"
              value={csv(c.columns as string[])}
              onChange={(e) => set({ columns: unCsv(e.target.value) })}
            />
          </Field>
        </>
      )}
      {c.type === "limit" && (
        <Field label="Max rows">
          <Input
            type="number"
            className="h-8 font-mono text-xs"
            value={c.n as number}
            onChange={(e) => set({ n: Number(e.target.value) || 0 })}
          />
        </Field>
      )}
      {c.type === "quality_gate" && (
        <QualityRulesEditor
          rules={(c.rules as QualityRule[]) ?? []}
          onChange={(rules) => set({ rules })}
        />
      )}
      {c.type === "sql" && (
        <Field label="SQL (input frame is table t)">
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={c.query as string}
            onChange={(e) => set({ query: e.target.value })}
          />
        </Field>
      )}

      {node.kind === "target" && c.type === "http_api" && (
        <>
          <Field label="URL">
            <Input
              className="h-8 font-mono text-xs"
              value={(c.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://api.example.com/records"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Method">
              <Select
                value={(c.method as string) ?? "POST"}
                onValueChange={(v) => set({ method: v })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["POST", "PUT", "PATCH"].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Rows per request">
              <Input
                type="number"
                className="h-8 font-mono text-xs"
                value={(c.batch_size as number) ?? 500}
                onChange={(e) => set({ batch_size: Number(e.target.value) || 500 })}
              />
            </Field>
          </div>
          <Field label="Wrap key (optional)">
            <Input
              className="h-8 font-mono text-xs"
              value={(c.wrap_key as string) ?? ""}
              onChange={(e) => set({ wrap_key: e.target.value })}
              placeholder="records"
            />
          </Field>
          <Field label="Bearer token env var (optional)">
            <Input
              className="h-8 font-mono text-xs"
              value={(c.auth_env as string) ?? ""}
              onChange={(e) => set({ auth_env: e.target.value.trim() || undefined })}
              placeholder="MY_API_TOKEN"
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            Bind the env var to a secret under Settings → secret bindings; it is sent as a Bearer
            Authorization header and scrubbed from logs.
          </p>
        </>
      )}
      {node.kind === "target" && c.type !== "http_api" && c.type !== "lakehouse" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label={c.type === "database" ? "Schema" : "Dataset"}>
              <Input
                className="h-8 font-mono text-xs"
                value={c.dataset as string}
                onChange={(e) => set({ dataset: e.target.value })}
              />
            </Field>
            <Field label="Table">
              <Input
                className="h-8 font-mono text-xs"
                value={c.table as string}
                onChange={(e) => set({ table: e.target.value })}
              />
            </Field>
          </div>
          {c.type === "object_storage" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Table format">
                <Select
                  value={(c.table_format as string) ?? "none"}
                  onValueChange={(v) =>
                    set(
                      v === "none"
                        ? { table_format: "none" }
                        : { table_format: v, format: "parquet" },
                    )
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Plain files</SelectItem>
                    <SelectItem value="delta">Delta Lake</SelectItem>
                    <SelectItem value="iceberg">Iceberg</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="File format">
                <Select
                  value={c.format as string}
                  onValueChange={(v) => set({ format: v })}
                  disabled={c.table_format === "delta" || c.table_format === "iceberg"}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["parquet", "csv", "jsonl"].map((f) => (
                      <SelectItem key={f} value={f}>
                        {f.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Write mode">
            <Select value={c.write_mode as string} onValueChange={(v) => set({ write_mode: v })}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="replace">Replace</SelectItem>
                <SelectItem value="append">Append</SelectItem>
                <SelectItem value="merge">Merge (upsert)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {c.write_mode === "merge" && (
            <Field label="Primary key columns">
              <Input
                className="h-8 font-mono text-xs"
                value={csv(c.primary_key as string[])}
                onChange={(e) => set({ primary_key: unCsv(e.target.value) })}
                placeholder="id"
              />
            </Field>
          )}
          <Field label="Schema drift">
            <Select
              value={(c.schema_policy as string) ?? "evolve"}
              onValueChange={(v) => set({ schema_policy: v })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="evolve">Evolve silently</SelectItem>
                <SelectItem value="warn">Warn on drift</SelectItem>
                <SelectItem value="strict">Fail on drift</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

// ── Code builder + AI ───────────────────────────────────────────────────────

function CodeBuilder({
  p,
  onPatch,
}: {
  p: EditorPipeline;
  onPatch: (u: Partial<EditorPipeline>) => void;
}) {
  const { session } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [brief, setBrief] = useState("");
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState("");

  const generate = async (refine: boolean) => {
    if (!brief.trim()) {
      toast.error(refine ? "Describe the change to make" : "Describe what the pipeline should do");
      return;
    }
    setGenerating(true);
    setNotes("");
    try {
      const parsed = parseModelChoice(modelChoice);
      const res = await fetch("/api/etl/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({
          brief,
          ...(refine ? { current_code: p.source_code } : {}),
          ...(parsed ? { provider: parsed.provider, model: parsed.model } : {}),
        }),
      });
      const out = (await res.json()) as {
        code?: string;
        requirements?: string;
        notes?: string;
        error?: string;
      };
      if (!res.ok || !out.code) throw new Error(out.error ?? "Generation failed");
      onPatch({
        source_code: out.code,
        ...(out.requirements ? { requirements: out.requirements } : {}),
      });
      setNotes(out.notes ?? "");
      setBrief("");
      toast.success(refine ? "Code refined — review and save" : "Draft ready — review and save");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border">
        <CodeMirror
          value={p.source_code}
          onChange={(v) => onPatch({ source_code: v })}
          extensions={[python()]}
          theme={isDark ? vscodeDark : vscodeLight}
          height="100%"
          style={{ height: "100%" }}
        />
      </div>
      <div className="flex w-80 shrink-0 flex-col gap-3 overflow-auto">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1 text-sm">
              <Sparkles className="h-4 w-4" /> AI assist
            </CardTitle>
            <CardDescription className="text-xs">
              Drafts follow the runtime contract — credentials from the environment, never in code.
              You review before anything runs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              placeholder="e.g. Pull the public GitHub events API, keep PushEvents, load as a table called github_pushes"
            />
            <BiModelSelect value={modelChoice} onChange={setModelChoice} allowUnset />
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" onClick={() => generate(false)} disabled={generating}>
                {generating ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 h-3 w-3" />
                )}
                Generate
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => generate(true)}
                disabled={generating || !p.source_code.trim()}
              >
                <RefreshCw className="mr-1 h-3 w-3" /> Refine current
              </Button>
            </div>
            {notes && (
              <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{notes}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Requirements</CardTitle>
            <CardDescription className="text-xs">
              Python packages installed in the sandbox before the run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={p.requirements}
              onChange={(e) => onPatch({ requirements: e.target.value })}
              rows={5}
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Runs tab ────────────────────────────────────────────────────────────────

/** The line worth reading first: a traceback's LAST line names the error. */
function lastErrorLine(err: string): string {
  const lines = err
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? err;
}

function RunsTab({ pipelineId }: { pipelineId: string }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(listEtlRuns);
  const logsFn = useServerFn(getEtlRunLogs);
  const cancelFn = useServerFn(cancelEtlRunFn);
  const [runs, setRuns] = useState<EtlRunSummary[] | null>(null);
  const [logsOf, setLogsOf] = useState<{ id: string; logs: string; error: string | null } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const res = await listFn({ data: { access_token: token, pipeline_id: pipelineId } });
      setRuns(res.runs);
    } catch {
      setRuns((prev) => prev ?? []);
    }
  }, [token, pipelineId, listFn]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!runs?.some((r) => ["running", "queued", "retrying"].includes(r.status))) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [runs, load]);

  // Live log tail: while the dialog shows a running run, refresh its logs —
  // the sandbox posts partials every few seconds, so a long job narrates
  // itself instead of going dark until the end.
  useEffect(() => {
    if (!logsOf) return;
    const row = runs?.find((r) => r.id === logsOf.id);
    if (!row || !["running", "queued", "retrying"].includes(row.status)) return;
    const t = setInterval(() => {
      void logsFn({ data: { access_token: token, run_id: logsOf.id } })
        .then((res) => setLogsOf({ id: logsOf.id, logs: res.logs, error: res.error }))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [logsOf, runs, token, logsFn]);

  return (
    <Card>
      <CardContent className="p-0">
        {runs === null ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : runs.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No runs yet. “Run now” starts one; a schedule or the trigger endpoint starts the rest.
          </p>
        ) : (
          <div className="divide-y">
            {runs.map((r) => {
              const metrics = (r.metrics ?? {}) as {
                rows_loaded?: number;
                targets?: { target: string; rows: number }[];
              };
              return (
                <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                  <StatusChip status={r.status} />
                  <span className="text-muted-foreground">{fmtWhen(r.created_at)}</span>
                  <Badge variant="outline" className="capitalize">
                    {r.trigger}
                  </Badge>
                  {(r.attempt ?? 1) > 1 && (
                    <Badge variant="outline" title="Retried after failure">
                      attempt {r.attempt}
                    </Badge>
                  )}
                  {r.status === "retrying" && r.retry_at && (
                    <span className="text-xs text-muted-foreground">
                      next try {fmtWhen(r.retry_at)}
                    </span>
                  )}
                  {r.params != null && (
                    <Badge
                      variant="outline"
                      title={JSON.stringify(r.params)}
                      className="cursor-help"
                    >
                      params
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {fmtDuration(r.started_at, r.finished_at)}
                  </span>
                  {typeof metrics.rows_loaded === "number" && (
                    <span className="text-xs text-muted-foreground">
                      {metrics.rows_loaded.toLocaleString()} rows
                      {metrics.targets?.length ? ` → ${metrics.targets.length} target(s)` : ""}
                    </span>
                  )}
                  {r.error && (
                    <span className="max-w-xs truncate text-xs text-red-500">
                      {lastErrorLine(r.error)}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {["running", "queued", "retrying"].includes(r.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await cancelFn({ data: { access_token: token, run_id: r.id } });
                          void load();
                        }}
                      >
                        <Square className="mr-1 h-3 w-3" /> Cancel
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const res = await logsFn({
                          data: { access_token: token, run_id: r.id },
                        });
                        setLogsOf({ id: r.id, logs: res.logs, error: res.error });
                      }}
                    >
                      Logs
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      <Dialog open={Boolean(logsOf)} onOpenChange={(v) => !v && setLogsOf(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Run logs</DialogTitle>
            <DialogDescription>
              Sandbox output with secret values scrubbed — streamed live while the run executes,
              final on completion.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs">
            {logsOf?.logs || "(no output captured)"}
            {logsOf?.error ? `\n\n--- error ---\n${logsOf.error}` : ""}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Settings tab ────────────────────────────────────────────────────────────

/** Version history: one row per meaningful save, restore is one click. */
function VersionHistoryCard({
  pipelineId,
  onRestored,
}: {
  pipelineId: string;
  onRestored: () => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(listEtlVersions);
  const restoreFn = useServerFn(restoreEtlVersion);
  const [versions, setVersions] = useState<EtlVersionSummary[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listFn({ data: { access_token: token, pipeline_id: pipelineId } });
      setVersions(res.versions);
    } catch {
      /* the card stays empty; settings still work */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pipelineId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Version history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {versions.length === 0 && (
          <div className="text-xs text-muted-foreground">Versions appear after the next save.</div>
        )}
        {versions.map((v, i) => (
          <div
            key={v.version_no}
            className="flex items-center justify-between rounded-md border px-2 py-1.5"
          >
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline">v{v.version_no}</Badge>
              <span className="text-muted-foreground">
                {new Date(v.created_at).toLocaleString()}
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {v.mode}
              </Badge>
              {i === 0 && <span className="text-[10px] text-muted-foreground">current</span>}
            </div>
            {i !== 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(v.version_no);
                  try {
                    await restoreFn({
                      data: {
                        access_token: token,
                        pipeline_id: pipelineId,
                        version_no: v.version_no,
                      },
                    });
                    toast.success(`Restored v${v.version_no}`);
                    await load();
                    onRestored();
                  } catch (e) {
                    toast.error((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Restore
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SettingsTab({
  p,
  onPatch,
  onDeleted,
  onRestored,
}: {
  p: EditorPipeline;
  onPatch: (u: Partial<EditorPipeline>) => void;
  onDeleted: () => void;
  onRestored: () => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const rotateFn = useServerFn(rotateEtlTriggerToken);
  const deleteFn = useServerFn(deleteEtlPipeline);
  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [triggerToken, setTriggerToken] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [chainCandidates, setChainCandidates] = useState<{ id: string; name: string }[]>([]);
  const [paramsText, setParamsText] = useState(() =>
    p.default_params ? JSON.stringify(p.default_params, null, 2) : "",
  );
  const listPipelinesFn = useServerFn(listEtlPipelines);

  useEffect(() => {
    listCatalogSources()
      .then((all) => setSources(all.filter((s) => s.kind === "object_storage")))
      .catch(() => {});
    if (token) {
      listPipelinesFn({ data: { access_token: token } })
        .then((res) =>
          setChainCandidates(
            res.pipelines.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, name: x.name })),
          ),
        )
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="grid max-w-6xl gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Run configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Description</Label>
            <Textarea
              value={p.description ?? ""}
              onChange={(e) => onPatch({ description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Schedule</Label>
              <Select
                value={p.schedule}
                onValueChange={(schedule) =>
                  onPatch({ schedule: schedule as EditorPipeline["schedule"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual only</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="cron">Cron expression</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Timeout (minutes)</Label>
              <Input
                type="number"
                value={p.timeout_minutes}
                onChange={(e) => onPatch({ timeout_minutes: Number(e.target.value) || 30 })}
              />
            </div>
          </div>
          {p.schedule === "cron" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Cron (min hour day month weekday)</Label>
                <Input
                  className="font-mono"
                  value={p.cron_expr ?? ""}
                  onChange={(e) => onPatch({ cron_expr: e.target.value })}
                  placeholder="0 6 * * 1-5"
                />
              </div>
              <div>
                <Label className="text-xs">Timezone (IANA)</Label>
                <Input
                  value={p.timezone ?? ""}
                  onChange={(e) => onPatch({ timezone: e.target.value || null })}
                  placeholder="Europe/Berlin (empty = UTC)"
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Retries on failure</Label>
              <Select
                value={String(p.retry_count)}
                onValueChange={(v) => onPatch({ retry_count: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n === 0 ? "None (fail fast)" : `${n} × exponential backoff`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Backoff doubles from 1 minute. A runtime that was briefly down counts as a retryable
                failure.
              </p>
            </div>
            <div>
              <Label className="text-xs">Run after (chaining)</Label>
              <Select
                value={p.run_after ?? "none"}
                onValueChange={(v) => onPatch({ run_after: v === "none" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— none —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— none —</SelectItem>
                  {chainCandidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Starts this pipeline when the selected one succeeds. Cycles are refused at save.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border p-2">
            <div>
              <p className="text-sm">Allow concurrent runs</p>
              <p className="text-xs text-muted-foreground">
                Off (default): a new start is refused while a run is queued, running or waiting on a
                retry — append targets double-load under overlap.
              </p>
            </div>
            <Switch
              checked={p.allow_concurrent}
              onCheckedChange={(allow_concurrent) => onPatch({ allow_concurrent })}
            />
          </div>
          <div>
            <Label className="text-xs">Default parameters (JSON, sent to entrypoint)</Label>
            <Textarea
              value={paramsText}
              onChange={(e) => {
                setParamsText(e.target.value);
                try {
                  const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : null;
                  onPatch({ default_params: parsed });
                } catch {
                  /* keep typing; save uses the last valid value */
                }
              }}
              rows={3}
              className="font-mono text-xs"
              placeholder='{"lookback_days": 7}'
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-2">
            <div>
              <p className="text-sm">Active</p>
              <p className="text-xs text-muted-foreground">
                Paused pipelines skip their schedule and refuse the trigger endpoint.
              </p>
            </div>
            <Switch checked={p.is_active} onCheckedChange={(is_active) => onPatch({ is_active })} />
          </div>
          <div>
            <Label className="text-xs">Default destination (storage source)</Label>
            <Select
              value={p.dest_catalog_source_id ?? "none"}
              onValueChange={(v) => onPatch({ dest_catalog_source_id: v === "none" ? null : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a bucket" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Used by storage targets that don&apos;t pick their own bucket, and by code-mode
              pipelines (as the documented environment variables). Re-crawled after every successful
              run so new tables appear in the Data Catalog. Add buckets under Data Catalog →
              Sources.
            </p>
          </div>
          <div>
            <Label className="text-xs">Secret bindings (KEY={"{{secret:NAME}}"} per line)</Label>
            <Textarea
              value={p.secret_refs}
              onChange={(e) => onPatch({ secret_refs: e.target.value })}
              rows={3}
              className="font-mono text-xs"
              placeholder={"API_TOKEN={{secret:MY_API_TOKEN}}"}
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1 text-sm">
              <DatabaseIcon className="h-4 w-4" /> External trigger
            </CardTitle>
            <CardDescription className="text-xs">
              POST /api/etl/run with this bearer token starts a run — from a swarm http node, n8n,
              CI, anywhere.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {triggerToken ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                  {triggerToken}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(triggerToken);
                    toast.success("Copied — it is not shown again");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The token is shown once at mint. Rotating invalidates the previous one.
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const res = await rotateFn({ data: { access_token: token, id: p.id } });
                  setTriggerToken(res.token);
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Mint / rotate token
            </Button>
            <pre className="overflow-auto rounded-md bg-muted p-2 text-xs">
              {`curl -X POST ${typeof window !== "undefined" ? window.location.origin : ""}/api/etl/run \\
  -H "Authorization: Bearer etl_…" \\
  -H "Content-Type: application/json" \\
  -d '{"pipeline_id": "${p.id}"}'`}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Alerts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Delivered in-app and to every notification channel connected on the Integrations page
              (Slack, Teams, Discord, webhooks).
            </p>
            {(
              [
                ["on_failure", "Run fails", "After every retry is exhausted."],
                ["on_recovery", "Run recovers", "First success after a failure."],
                ["on_success", "Every success", "Noisy on tight schedules — off by default."],
              ] as const
            ).map(([key, label, hint]) => (
              <div key={key} className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">{label}</div>
                  <div className="text-[11px] text-muted-foreground">{hint}</div>
                </div>
                <Switch
                  checked={p.alerts?.[key] ?? (key === "on_success" ? false : true)}
                  onCheckedChange={(v) =>
                    onPatch({
                      alerts: {
                        on_failure: p.alerts?.on_failure ?? true,
                        on_success: p.alerts?.on_success ?? false,
                        on_recovery: p.alerts?.on_recovery ?? true,
                        [key]: v,
                      },
                    })
                  }
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <VersionHistoryCard pipelineId={p.id} onRestored={onRestored} />

        <Card className="border-red-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Danger zone</CardTitle>
          </CardHeader>
          <CardContent>
            <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1 h-4 w-4" /> Delete pipeline
            </Button>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{p.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The pipeline and its run history are removed. Loaded data is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await deleteFn({ data: { access_token: token, id: p.id } });
                toast.success("Pipeline deleted");
                onDeleted();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
