// Data & BI → Workflows: one graph over work that kept its own clocks.
//
// The canvas is the same @xyflow/react surface the ETL builder uses, so the
// gesture an operator already knows — drag from a handle to join two steps,
// double-click an arrow to remove it — is the gesture here. What differs is
// what a node IS: not a step inside one pipeline, but a whole pipeline, model
// build, retrain, notebook, swarm, dashboard refresh, or the control flow that
// decides which of them happen.
//
// Layout: the palette is a COLUMN down the left, grouped by what a family of
// steps is for. It was a row of buttons above the canvas, which stopped
// working the moment there were more than about six kinds — fifteen buttons
// wrapped over three lines, pushed the canvas down the screen, and said
// nothing about which of them belonged together.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  applyNodeChanges,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  KeyRound,
  Loader2,
  MinusCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Trash2,
  Workflow as WorkflowIcon,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { StepInspector } from "@/components/workflows/StepInspector";
import { WorkflowPalette } from "@/components/workflows/WorkflowPalette";
import { KIND_STYLE, stepRunLink } from "@/components/workflows/nodeStyles";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import {
  NODE_KIND_LABEL,
  autoLayout,
  newNodeId,
  parentsOf,
  referencedParams,
  topoOrder,
  validateWorkflow,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowNodeState,
  type WorkflowParam,
} from "@/lib/workflows";
import {
  workflowCandidates,
  workflowCreate,
  workflowDelete,
  workflowGet,
  workflowRerun,
  workflowRevokeToken,
  workflowRotateToken,
  workflowRunCancel,
  workflowRunGet,
  workflowRunNow,
  workflowRunsList,
  workflowSave,
  workflowsList,
  type WorkflowCandidates,
  type WorkflowNodeRunDto,
  type WorkflowRunDto,
  type WorkflowRowDto,
} from "@/utils/workflows.functions";

/** Below this many saved workflows, a search box is furniture rather than help. */
const WORKFLOW_SEARCH_FROM = 5;

export const Route = createFileRoute("/_authenticated/workflows")({
  head: () => ({
    meta: [
      { title: "Workflows — AgentSwarms" },
      {
        name: "description",
        content:
          "One graph over pipelines, models, retrains, notebooks and swarms, with branching, retries, approvals and an API trigger.",
      },
    ],
  }),
  component: WorkflowsPage,
});

/** The run's colours, kept apart from the kind's so both can show at once. */
const STATE_STYLE: Record<WorkflowNodeState, { ring: string; label: string; icon: typeof Play }> = {
  pending: { ring: "border-muted-foreground/30", label: "waiting", icon: CircleDashed },
  running: { ring: "border-primary", label: "running", icon: Loader2 },
  succeeded: { ring: "border-emerald-500", label: "succeeded", icon: CheckCircle2 },
  failed: { ring: "border-destructive", label: "failed", icon: XCircle },
  skipped: { ring: "border-amber-500", label: "skipped", icon: MinusCircle },
};

type FlowData = { node: WorkflowNode; state?: WorkflowNodeState; attempt?: number };

function WorkflowFlowNode({ data, selected }: NodeProps) {
  const { node, state, attempt } = data as FlowData;
  const kind = KIND_STYLE[node.kind];
  const Icon = kind.icon;
  const run = state ? STATE_STYLE[state] : null;
  const RunIcon = run?.icon;
  return (
    <div
      className={cn(
        "min-w-48 rounded-lg border-2 bg-card px-3 py-2 shadow-sm",
        run ? run.ring : kind.ring,
        selected && "ring-2 ring-primary",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className={cn("rounded p-1", kind.chip)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {node.label || NODE_KIND_LABEL[node.kind]}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {NODE_KIND_LABEL[node.kind]}
            {node.retries ? ` · ${node.retries} retries` : ""}
            {node.continueOnFailure ? " · continues on failure" : ""}
          </div>
        </div>
        {attempt && attempt > 1 ? (
          <Badge variant="outline" className="shrink-0 text-[9px]">
            try {attempt}
          </Badge>
        ) : null}
        {RunIcon && run ? (
          <RunIcon
            className={cn("h-3.5 w-3.5 shrink-0", state === "running" && "animate-spin")}
            aria-label={run.label}
          />
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { workflow: WorkflowFlowNode };

function WorkflowsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(workflowsList);
  const getFn = useServerFn(workflowGet);
  const createFn = useServerFn(workflowCreate);
  const deleteFn = useServerFn(workflowDelete);
  const saveFn = useServerFn(workflowSave);
  const runFn = useServerFn(workflowRunNow);
  const rerunFn = useServerFn(workflowRerun);
  const runsFn = useServerFn(workflowRunsList);
  const runGetFn = useServerFn(workflowRunGet);
  const cancelFn = useServerFn(workflowRunCancel);
  const candidatesFn = useServerFn(workflowCandidates);
  const rotateFn = useServerFn(workflowRotateToken);
  const revokeFn = useServerFn(workflowRevokeToken);

  const [workflows, setWorkflows] = useState<WorkflowRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listQuery, setListQuery] = useState("");
  const [settings, setSettings] = useState({
    name: "",
    schedule: "manual",
    cronExpr: "",
    timezone: "UTC",
    overlap: "skip",
    notifyOn: "failure",
    timeoutMinutes: 720,
    isActive: true,
    hasToken: false,
  });
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [], params: [] });
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runParams, setRunParams] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<WorkflowCandidates>({
    pipelines: [],
    mlSchedules: [],
    notebooks: [],
    swarms: [],
    prepFlows: [],
    dashboards: [],
    monitors: [],
    workflows: [],
    models: [],
    secrets: [],
  });
  const [runs, setRuns] = useState<WorkflowRunDto[]>([]);
  const [openRun, setOpenRun] = useState<{
    run: WorkflowRunDto;
    nodes: WorkflowNodeRunDto[];
  } | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    const res = await listFn({ data: { accessToken: token } });
    if (!res.ok) toast.error(res.error);
    else {
      setWorkflows(res.workflows);
      setSelectedId((cur) => cur ?? res.workflows[0]?.id ?? null);
    }
    setLoading(false);
  }, [listFn, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void candidatesFn({ data: { accessToken: token, exclude: selectedId ?? undefined } }).then(
      (res) => {
        // FOUND FROM THE UI. The server excludes the workflow being edited, but
        // a reply for the PREVIOUS selection could still land after this one
        // and put the open workflow back in its own sub-workflow picker. The
        // save refuses it either way; offering it at all is the bug.
        if (!live || !res.ok) return;
        setCandidates({ ...res, workflows: res.workflows.filter((w) => w.id !== selectedId) });
      },
    );
    return () => {
      live = false;
    };
  }, [candidatesFn, token, selectedId]);

  const loadRuns = useCallback(
    async (id: string) => {
      const res = await runsFn({ data: { accessToken: token, workflowId: id } });
      if (res.ok) setRuns(res.runs);
    },
    [runsFn, token],
  );

  useEffect(() => {
    if (!token || !selectedId) return;
    // FOUND FROM THE UI. Picking a workflow while the previous one is still
    // loading used to leave whichever response landed LAST in the editor, so
    // you could be looking at one workflow's graph under another's name — and
    // Save would then write it over. A newer selection cancels the older read.
    let live = true;
    void (async () => {
      const res = await getFn({ data: { accessToken: token, id: selectedId } });
      if (!live) return;
      if (!res.ok) return toast.error(res.error);
      const w = res.workflow;
      setSettings({
        name: w.name,
        schedule: w.schedule,
        cronExpr: w.cron_expr ?? "",
        timezone: w.timezone ?? "UTC",
        overlap: w.overlap,
        notifyOn: w.notify_on,
        timeoutMinutes: w.timeout_minutes,
        isActive: w.is_active,
        hasToken: w.has_trigger_token,
      });
      setGraph(autoLayout((w.graph ?? { nodes: [], edges: [] }) as unknown as WorkflowGraph));
      setNodeId(null);
      setOpenRun(null);
      setMintedToken(null);
      void loadRuns(selectedId);
    })();
    return () => {
      live = false;
    };
  }, [getFn, token, selectedId, loadRuns]);

  // While a run is live, keep asking. The server nudges the run along on read,
  // so this is what makes a manual run visibly move rather than sit still.
  useEffect(() => {
    if (!openRun || openRun.run.state !== "running") return;
    const t = setInterval(() => {
      void runGetFn({ data: { accessToken: token, runId: openRun.run.id } }).then((res) => {
        if (res.ok) setOpenRun({ run: res.run, nodes: res.nodes });
        if (res.ok && res.run.state !== "running" && selectedId) {
          void loadRuns(selectedId);
          // The card carries the last run's status, so it goes stale the
          // moment this run ends unless the list is reloaded too.
          void reload();
        }
      });
    }, 3000);
    return () => clearInterval(t);
  }, [openRun, runGetFn, token, selectedId, loadRuns, reload]);

  const statesByNode = useMemo(() => {
    const out: Record<string, { state: WorkflowNodeState; attempt: number }> = {};
    for (const n of openRun?.nodes ?? []) {
      out[n.node_id] = { state: n.state as WorkflowNodeState, attempt: n.attempt };
    }
    return out;
  }, [openRun]);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;
  // The search box only appears once the list is long enough to need it, so
  // the filter must only APPLY while it is on screen.
  //
  // FOUND FROM THE UI. Deleting workflows until the list dropped back below
  // the threshold took the box away and left its text still filtering: "0 of
  // 4", no rows, and nothing left to clear it with.
  const searchable = workflows.length > WORKFLOW_SEARCH_FROM;
  const shownWorkflows = useMemo(() => {
    const q = searchable ? listQuery.trim().toLowerCase() : "";
    if (!q) return workflows;
    return workflows.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.schedule.toLowerCase().includes(q) ||
        (w.cron_expr ?? "").toLowerCase().includes(q),
    );
  }, [workflows, listQuery, searchable]);
  const node = graph.nodes.find((n) => n.id === nodeId) ?? null;
  const declared = graph.params ?? [];
  const undeclared = referencedParams(graph).filter((p) => !declared.some((d) => d.name === p));

  const addNode = (kind: WorkflowNodeKind) => {
    const n: WorkflowNode = {
      id: newNodeId(),
      kind,
      // Deliberately unnamed: picking what it runs is what names it, and a
      // default label would block that and leave four steps all called
      // "SQL models".
      label: "",
      models: kind === "sql_models" ? [] : undefined,
      waitSeconds: kind === "wait" ? 60 : undefined,
      http: kind === "http" ? { method: "POST", url: "" } : undefined,
      x: 60 + graph.nodes.length * 40,
      y: 60 + (graph.nodes.length % 5) * 90,
    };
    setGraph((g) => ({ ...g, nodes: [...g.nodes, n] }));
    setNodeId(n.id);
  };

  const patchNode = (patch: Partial<WorkflowNode>) => {
    if (!nodeId) return;
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
    }));
  };

  async function save() {
    if (!selectedId) return;
    const invalid = validateWorkflow({ name: settings.name, graph });
    if (invalid) return toast.error(invalid);
    setSaving(true);
    try {
      const res = await saveFn({
        data: {
          accessToken: token,
          id: selectedId,
          name: settings.name,
          schedule: settings.schedule as "manual" | "hourly" | "daily" | "weekly" | "cron",
          cronExpr: settings.cronExpr || null,
          timezone: settings.timezone || null,
          overlap: settings.overlap as "skip" | "queue",
          notifyOn: settings.notifyOn as "never" | "failure" | "always",
          timeoutMinutes: settings.timeoutMinutes,
          isActive: settings.isActive,
          nodes: graph.nodes,
          edges: graph.edges,
          params: graph.params ?? [],
        },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Saved");
        void reload();
      }
    } finally {
      setSaving(false);
    }
  }

  async function startRun(params: Record<string, string>) {
    if (!selectedId) return;
    setRunning(true);
    try {
      const res = await runFn({ data: { accessToken: token, id: selectedId, params } });
      if (!res.ok) return toast.error(res.error);
      toast.success("Run started");
      const detail = await runGetFn({ data: { accessToken: token, runId: res.runId } });
      if (detail.ok) setOpenRun({ run: detail.run, nodes: detail.nodes });
      void loadRuns(selectedId);
    } finally {
      setRunning(false);
    }
  }

  async function removeWorkflow(w: WorkflowRowDto) {
    const ok = await confirmAsk({
      title: `Delete "${w.name}"?`,
      body: "The graph and its run history go with it. The pipelines, models and notebooks it orchestrated are untouched.",
      actionLabel: "Delete workflow",
    });
    if (!ok) return;
    const res = await deleteFn({ data: { accessToken: token, id: w.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Workflow deleted");
    setSelectedId(null);
    setRuns([]);
    setOpenRun(null);
    setGraph({ nodes: [], edges: [], params: [] });
    setNodeId(null);
    void reload();
  }

  if (loading) return <Skeleton className="m-6 h-96" />;

  return (
    <div className="flex h-canvas w-full min-h-0 flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
          <WorkflowIcon className="h-6 w-6 text-primary" /> Workflows
        </h1>
        <p className="hidden max-w-lg text-xs text-muted-foreground xl:block">
          One graph over the pipelines, models, retrains, notebooks and swarms you already have.
          Branch on a parameter, retry a flaky step, wait for a person.
        </p>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New workflow
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[248px_1fr_300px]">
        {/* Left: the saved workflows, then the palette.
            The list is deliberately CAPPED rather than allowed to grow: an
            unbounded list pushes the palette off the bottom of the card, so
            the twentieth workflow you save is the one that hides the buttons
            you need to edit it. Five rows and a search box instead. */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            <div className="flex shrink-0 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Workflows
                </p>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {shownWorkflows.length === workflows.length
                    ? workflows.length || ""
                    : `${shownWorkflows.length} of ${workflows.length}`}
                </span>
              </div>

              {/* The search appears once the list is long enough to need it —
                  a filter box above two rows is furniture, not help. */}
              {searchable ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={listQuery}
                    onChange={(e) => setListQuery(e.target.value)}
                    placeholder="Search workflows"
                    aria-label="Search workflows"
                    className="h-7 pl-7 text-xs"
                  />
                </div>
              ) : null}

              {workflows.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  No workflows yet. Create one and drop in the work you already run.
                </p>
              ) : null}
              {workflows.length > 0 && shownWorkflows.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  No workflow is called anything like that.
                </p>
              ) : null}

              <div className="max-h-[218px] space-y-1 overflow-y-auto overflow-x-hidden">
                {shownWorkflows.map((w) => (
                  <div
                    key={w.id}
                    className={cn(
                      "flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs",
                      selectedId === w.id && "border-primary bg-primary/5",
                    )}
                  >
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setSelectedId(w.id)}
                    >
                      <span className="block truncate font-medium">{w.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {w.schedule === "cron" ? w.cron_expr : w.schedule}
                        {w.last_run_at
                          ? ` · ${formatDistanceToNow(new Date(w.last_run_at), { addSuffix: true })}`
                          : " · never run"}
                      </span>
                    </button>
                    {w.last_run_status ? (
                      <Badge
                        variant={w.last_run_status === "failed" ? "destructive" : "outline"}
                        className="shrink-0 text-[9px]"
                      >
                        {w.last_run_status}
                      </Badge>
                    ) : null}
                    <button
                      title="Delete workflow"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void removeWorkflow(w)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {selected ? (
              <div className="flex min-h-0 flex-1 flex-col border-t pt-2">
                <p className="shrink-0 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Add a step
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                  <WorkflowPalette onAdd={addNode} />
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Centre: the graph. */}
        <div className="flex min-h-0 flex-col gap-2">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-8 w-52 font-medium"
                  value={settings.name}
                  onChange={(e) => setSettings((s) => ({ ...s, name: e.target.value }))}
                />
                <Badge variant="outline" className="text-[10px]">
                  {settings.schedule === "cron" ? settings.cronExpr || "cron" : settings.schedule}
                </Badge>
                {settings.hasToken ? (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <KeyRound className="h-3 w-3" /> API
                  </Badge>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 className="mr-1 h-3.5 w-3.5" /> Settings
                </Button>
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={running}
                    onClick={() => {
                      if (declared.length) {
                        setRunParams(
                          Object.fromEntries(declared.map((p) => [p.name, p.default ?? ""])),
                        );
                        setRunOpen(true);
                      } else {
                        void startRun({});
                      }
                    }}
                  >
                    {running ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="mr-1 h-3.5 w-3.5" />
                    )}
                    Run now
                  </Button>
                  <Button size="sm" disabled={saving} onClick={() => void save()}>
                    {saving ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="mr-1 h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                </div>
              </div>

              {undeclared.length ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                  Used but not declared: {undeclared.join(", ")}. Add them under Settings →
                  Parameters, or they stay as written.
                </p>
              ) : null}

              <WorkflowCanvas
                graph={graph}
                onChange={setGraph}
                selectedId={nodeId}
                onSelect={setNodeId}
                states={statesByNode}
                showingRun={openRun?.run.state ?? null}
              />
            </>
          ) : (
            <Card className="flex flex-1 items-center justify-center">
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                Pick a workflow, or create one.
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: the step, and the runs. */}
        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="p-3">
            <Tabs defaultValue="step">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="step" className="text-xs">
                  Step
                </TabsTrigger>
                <TabsTrigger value="runs" className="text-xs">
                  Runs
                </TabsTrigger>
              </TabsList>

              <TabsContent value="step" className="mt-3">
                {node ? (
                  <StepInspector
                    node={node}
                    candidates={candidates}
                    params={graph.params ?? []}
                    hasParents={parentsOf(graph, node.id).length > 0}
                    onChange={patchNode}
                    onDelete={() => {
                      setGraph((g) => ({
                        ...g,
                        nodes: g.nodes.filter((n) => n.id !== node.id),
                        edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id),
                      }));
                      setNodeId(null);
                    }}
                  />
                ) : (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Add a step from the palette, then drag from its right edge to another
                    step&apos;s left edge to say &ldquo;after&rdquo;. Double-click an arrow to
                    remove it. A step with two arrows into it waits for both, unless you change its
                    trigger rule.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="runs" className="mt-3 space-y-2">
                {runs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No runs yet.</p>
                ) : null}
                {runs.map((r) => (
                  <button
                    key={r.id}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px]",
                      openRun?.run.id === r.id && "border-primary bg-primary/5",
                    )}
                    onClick={() =>
                      void runGetFn({ data: { accessToken: token, runId: r.id } }).then((res) => {
                        if (res.ok) setOpenRun({ run: res.run, nodes: res.nodes });
                        else toast.error(res.error);
                      })
                    }
                  >
                    <Badge
                      variant={
                        r.state === "failed"
                          ? "destructive"
                          : r.state === "succeeded"
                            ? "default"
                            : "outline"
                      }
                      className="text-[9px]"
                    >
                      {r.state}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {formatDistanceToNow(new Date(r.started_at), { addSuffix: true })} ·{" "}
                      {r.trigger}
                    </span>
                  </button>
                ))}

                {openRun ? (
                  <RunDetail
                    detail={openRun}
                    onCancel={async () => {
                      const res = await cancelFn({
                        data: { accessToken: token, runId: openRun.run.id },
                      });
                      if (!res.ok) return toast.error(res.error);
                      toast.success("Run cancelled");
                      const again = await runGetFn({
                        data: { accessToken: token, runId: openRun.run.id },
                      });
                      if (again.ok) setOpenRun({ run: again.run, nodes: again.nodes });
                      if (selectedId) void loadRuns(selectedId);
                      void reload();
                    }}
                    onRerun={async (fromFailed) => {
                      const res = await rerunFn({
                        data: { accessToken: token, runId: openRun.run.id, fromFailed },
                      });
                      if (!res.ok) return toast.error(res.error);
                      toast.success(fromFailed ? "Re-running the failed steps" : "Re-running");
                      const detail = await runGetFn({
                        data: { accessToken: token, runId: res.runId },
                      });
                      if (detail.ok) setOpenRun({ run: detail.run, nodes: detail.nodes });
                      if (selectedId) void loadRuns(selectedId);
                    }}
                  />
                ) : null}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>
              A workflow orchestrates work you already have. Nothing new runs here — it decides
              when, and records what happened as one run instead of several.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nightly load and retrain"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!newName.trim()) return toast.error("Give the workflow a name");
                const res = await createFn({
                  data: { accessToken: token, name: newName.trim() },
                });
                if (!res.ok) return toast.error(res.error);
                setCreateOpen(false);
                setNewName("");
                await reload();
                setSelectedId(res.id);
              }}
            >
              Create workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        setSettings={setSettings}
        params={declared}
        onParamsChange={(params) => setGraph((g) => ({ ...g, params }))}
        mintedToken={mintedToken}
        workflowId={selectedId}
        onRotate={async () => {
          if (!selectedId) return;
          const res = await rotateFn({ data: { accessToken: token, id: selectedId } });
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          setMintedToken(res.token);
          setSettings((s) => ({ ...s, hasToken: true }));
          void reload();
        }}
        onRevoke={async () => {
          if (!selectedId) return;
          const res = await revokeFn({ data: { accessToken: token, id: selectedId } });
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          setMintedToken(null);
          setSettings((s) => ({ ...s, hasToken: false }));
          toast.success("Token revoked");
          void reload();
        }}
      />

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run with parameters</DialogTitle>
            <DialogDescription>
              These are pinned onto the run, so what it used stays readable after the defaults
              change.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {declared.map((p) => (
              <div key={p.name} className="space-y-1">
                <Label className="text-xs">
                  {p.name}
                  {p.description ? (
                    <span className="pl-1 font-normal text-muted-foreground">
                      — {p.description}
                    </span>
                  ) : null}
                </Label>
                <Input
                  className="h-8 text-xs"
                  value={runParams[p.name] ?? ""}
                  onChange={(e) => setRunParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRunOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setRunOpen(false);
                void startRun(runParams);
              }}
            >
              Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkflowCanvas({
  graph,
  onChange,
  selectedId,
  onSelect,
  states,
  showingRun,
}: {
  graph: WorkflowGraph;
  onChange: (g: WorkflowGraph) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  states: Record<string, { state: WorkflowNodeState; attempt: number }>;
  showingRun: string | null;
}) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Node state lives here and the graph is synced FROM it, because ReactFlow
  // stores measured dimensions on the node objects and rebuilding them every
  // render throws those away — the same reason the ETL canvas does it.
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  useEffect(() => {
    setFlowNodes((prev) =>
      graph.nodes.map((n) => {
        const old = prev.find((f) => f.id === n.id);
        return {
          ...(old ?? {}),
          id: n.id,
          type: "workflow",
          position: { x: n.x ?? old?.position?.x ?? 100, y: n.y ?? old?.position?.y ?? 100 },
          data: { node: n, state: states[n.id]?.state, attempt: states[n.id]?.attempt },
          selected: n.id === selectedId,
        } as FlowNode;
      }),
    );
  }, [graph.nodes, selectedId, states]);

  const edgeId = (e: WorkflowEdge) => `${e.from}>${e.to}>${e.branch ?? ""}`;

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: edgeId(e),
        source: e.from,
        target: e.to,
        animated: true,
        label: e.branch ? e.branch : undefined,
        labelBgPadding: [4, 2] as [number, number],
        style: e.branch
          ? { stroke: e.branch === "true" ? "#22c55e" : "#f43f5e", strokeWidth: 2 }
          : undefined,
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
      onChange({
        ...graph,
        nodes: graph.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => {
            const m = moved.find((c) => c.id === n.id);
            return m?.position ? { ...n, x: m.position.x, y: m.position.y } : n;
          }),
        edges: graph.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)),
      });
    },
    [graph, onChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = new Set(
        changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id),
      );
      if (!removed.size) return;
      onChange({ ...graph, edges: graph.edges.filter((e) => !removed.has(edgeId(e))) });
    },
    [graph, onChange],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const from = graph.nodes.find((n) => n.id === c.source);
      // A condition's arrows carry a side. The first one out is the true
      // branch and the second the false one, which is the order somebody
      // draws them in and saves a second click.
      const existing = graph.edges.filter((e) => e.from === c.source);
      const branch =
        from?.kind === "condition"
          ? existing.some((e) => e.branch === "true")
            ? ("false" as const)
            : ("true" as const)
          : undefined;
      if (
        graph.edges.some((e) => e.from === c.source && e.to === c.target && e.branch === branch)
      ) {
        return;
      }
      const next: WorkflowEdge[] = [...graph.edges, { from: c.source, to: c.target, branch }];
      // ONLY the cycle check here. FOUND FROM THE UI: this ran the whole
      // validator, so drawing an arrow was refused because some unrelated
      // step further up the canvas had not been filled in yet — which is
      // exactly the order people build a graph in. A cycle is different: it
      // is caused by THIS arrow, and the arrow is under the cursor now and
      // will not be later.
      if (!topoOrder({ ...graph, edges: next })) {
        toast.error("These steps would form a loop, so the workflow could never finish");
        return;
      }
      onChange({ ...graph, edges: next });
    },
    [graph, onChange],
  );

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onEdgeDoubleClick={(_, edge) =>
          onChange({ ...graph, edges: graph.edges.filter((e) => edgeId(e) !== edge.id) })
        }
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode={isDark ? "dark" : "light"}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        {graph.nodes.length > 6 ? <MiniMap pannable zoomable className="!bg-card" /> : null}
      </ReactFlow>
      {showingRun ? (
        <Badge variant="outline" className="absolute right-2 top-2 z-10 bg-card text-[10px]">
          Showing run · {showingRun}
        </Badge>
      ) : null}
      {graph.nodes.length === 0 ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          Pick a step from the palette to begin.
        </p>
      ) : null}
    </div>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  settings,
  setSettings,
  params,
  onParamsChange,
  mintedToken,
  workflowId,
  onRotate,
  onRevoke,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: {
    schedule: string;
    cronExpr: string;
    timezone: string;
    overlap: string;
    notifyOn: string;
    timeoutMinutes: number;
    isActive: boolean;
    hasToken: boolean;
    name: string;
  };
  setSettings: React.Dispatch<React.SetStateAction<typeof settings>>;
  params: WorkflowParam[];
  onParamsChange: (p: WorkflowParam[]) => void;
  mintedToken: string | null;
  workflowId: string | null;
  onRotate: () => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workflow settings</DialogTitle>
          <DialogDescription>
            When it runs, what it takes as input, and who can start it from outside.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Schedule</Label>
              <Select
                value={settings.schedule}
                onValueChange={(v) => setSettings((s) => ({ ...s, schedule: v }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="cron">Cron expression</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-end gap-2 pb-1 text-xs">
              <Switch
                checked={settings.isActive}
                onCheckedChange={(v) => setSettings((s) => ({ ...s, isActive: v }))}
              />
              Active
            </label>
          </div>

          {settings.schedule === "cron" ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Expression</Label>
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="0 7 * * 1-5"
                  value={settings.cronExpr}
                  onChange={(e) => setSettings((s) => ({ ...s, cronExpr: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Timezone</Label>
                <Input
                  className="h-8 text-xs"
                  placeholder="Europe/London"
                  value={settings.timezone}
                  onChange={(e) => setSettings((s) => ({ ...s, timezone: e.target.value }))}
                />
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Notify me</Label>
              <Select
                value={settings.notifyOn}
                onValueChange={(v) => setSettings((s) => ({ ...s, notifyOn: v }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="failure">When a run fails</SelectItem>
                  <SelectItem value="always">Every run</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Give up after (minutes)</Label>
              <Input
                className="h-8 text-xs"
                type="number"
                min={1}
                value={settings.timeoutMinutes}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    timeoutMinutes: Math.max(1, Number(e.target.value) || 720),
                  }))
                }
              />
            </div>
          </div>

          <div className="space-y-1 border-t pt-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Parameters</Label>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 text-[11px]"
                onClick={() => onParamsChange([...params, { name: `param_${params.length + 1}` }])}
              >
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
            </div>
            {params.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                None. A declared parameter can be filled at run time and used as{" "}
                <code>{"{{ params.name }}"}</code> in a SQL statement, an HTTP request, a condition
                or a notification.
              </p>
            ) : null}
            {params.map((p, i) => (
              <div key={i} className="flex gap-1">
                <Input
                  className="h-7 w-32 font-mono text-[11px]"
                  value={p.name}
                  onChange={(e) =>
                    onParamsChange(
                      params.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  className="h-7 flex-1 text-[11px]"
                  placeholder="default"
                  value={p.default ?? ""}
                  onChange={(e) =>
                    onParamsChange(
                      params.map((x, j) => (i === j ? { ...x, default: e.target.value } : x)),
                    )
                  }
                />
                <button
                  className="px-1 text-destructive"
                  onClick={() => onParamsChange(params.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <div className="space-y-1 border-t pt-2">
            <Label className="text-xs">Start it from outside</Label>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A bearer token for <code>POST /api/workflows/run</code>. Shown once — it is stored as
              a hash, so a lost token is rotated rather than recovered.
            </p>
            {mintedToken ? (
              <Textarea
                readOnly
                rows={2}
                className="font-mono text-[11px]"
                value={mintedToken}
                onFocus={(e) => e.currentTarget.select()}
              />
            ) : null}
            {mintedToken && workflowId ? (
              <Textarea
                readOnly
                rows={4}
                className="font-mono text-[10px]"
                value={`curl -X POST "$APP_ORIGIN/api/workflows/run" \\\n  -H "Authorization: Bearer ${mintedToken}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"workflow_id":"${workflowId}"}'`}
              />
            ) : null}
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => void onRotate()}>
                <KeyRound className="mr-1 h-3.5 w-3.5" />
                {settings.hasToken ? "Rotate token" : "Create token"}
              </Button>
              {settings.hasToken ? (
                <Button size="sm" variant="ghost" onClick={() => void onRevoke()}>
                  Revoke
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunDetail({
  detail,
  onCancel,
  onRerun,
}: {
  detail: { run: WorkflowRunDto; nodes: WorkflowNodeRunDto[] };
  onCancel: () => void;
  onRerun: (fromFailed: boolean) => void;
}) {
  const failed = detail.nodes.some((n) => n.state === "failed");
  return (
    <div className="space-y-1 border-t pt-2">
      <div className="flex flex-wrap items-center gap-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          This run
        </p>
        {detail.run.state === "running" ? (
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-[11px]" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <div className="ml-auto flex gap-1">
            {failed ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[11px]"
                onClick={() => onRerun(true)}
              >
                <RotateCcw className="mr-1 h-3 w-3" /> From failed
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[11px]"
              onClick={() => onRerun(false)}
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Re-run
            </Button>
          </div>
        )}
      </div>
      {detail.nodes.map((n) => {
        const style = STATE_STYLE[n.state as WorkflowNodeState] ?? STATE_STYLE.pending;
        const Icon = style.icon;
        const kind = KIND_STYLE[n.kind as WorkflowNodeKind];
        const KindIcon = kind?.icon;
        const output = n.output as Record<string, unknown> | null;
        const link = stepRunLink(n.kind as WorkflowNodeKind, n.target_run_id);
        return (
          <div key={n.id} className="rounded-md border px-2 py-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              {KindIcon ? (
                <span className={cn("rounded p-0.5", kind.chip)}>
                  <KindIcon className="h-3 w-3" />
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate font-medium">{n.label}</span>
              {n.attempt > 1 ? (
                <Badge variant="outline" className="text-[9px]">
                  try {n.attempt}
                </Badge>
              ) : null}
              {n.branch ? (
                <Badge variant="secondary" className="text-[9px]">
                  {n.branch}
                </Badge>
              ) : null}
              <Icon className={cn("h-3 w-3", n.state === "running" && "animate-spin")} />
            </div>
            {output && Object.keys(output).length ? (
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                {Object.entries(output)
                  .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                  .join("  ")}
              </p>
            ) : null}
            {n.error ? <p className="mt-0.5 text-destructive">{n.error}</p> : null}
            {link ? (
              <a
                href={link.href}
                className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                title={`Run ${n.target_run_id}`}
              >
                <ExternalLink className="h-2.5 w-2.5" />
                {link.label}
                <span className="font-mono opacity-60">
                  {String(n.target_run_id)
                    .replace(/^(retrain|batch_predict):/, "")
                    .slice(0, 8)}
                </span>
              </a>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
