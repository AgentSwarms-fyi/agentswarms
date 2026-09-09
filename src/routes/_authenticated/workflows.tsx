// Data & BI → Workflows: one graph over work that kept four separate clocks.
//
// The canvas is the same @xyflow/react surface the ETL builder uses, so the
// gesture an operator already knows — drag from a handle to join two steps,
// double-click an arrow to remove it — is the gesture here. What differs is
// what a node IS: not a step inside one pipeline, but a whole pipeline, model
// build, retrain or notebook. And the run view draws its state onto the very
// same graph, because "which step is red" is the only question anybody opens
// a failed run to ask.
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
  Blocks,
  Brain,
  CheckCircle2,
  CircleDashed,
  Loader2,
  MinusCircle,
  NotebookPen,
  Play,
  Plus,
  Save,
  Trash2,
  Waypoints,
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
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import {
  NODE_KIND_LABEL,
  autoLayout,
  newNodeId,
  validateWorkflow,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowNodeState,
} from "@/lib/workflows";
import {
  workflowCandidates,
  workflowCreate,
  workflowDelete,
  workflowGet,
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

export const Route = createFileRoute("/_authenticated/workflows")({
  head: () => ({
    meta: [
      { title: "Workflows — AgentSwarms" },
      {
        name: "description",
        content:
          "One graph over pipelines, SQL models, ML schedules and notebooks, with fan-out, fan-in and a single run history.",
      },
    ],
  }),
  component: WorkflowsPage,
});

const KIND_STYLE: Record<WorkflowNodeKind, { ring: string; chip: string; icon: typeof Waypoints }> =
  {
    pipeline: {
      ring: "border-emerald-500/50",
      chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      icon: Waypoints,
    },
    sql_models: {
      ring: "border-sky-500/50",
      chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      icon: Blocks,
    },
    ml_schedule: {
      ring: "border-violet-500/50",
      chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
      icon: Brain,
    },
    notebook: {
      ring: "border-amber-500/50",
      chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      icon: NotebookPen,
    },
  };

/** The run's colours, kept apart from the kind's so both can show at once. */
const STATE_STYLE: Record<WorkflowNodeState, { ring: string; label: string; icon: typeof Play }> = {
  pending: { ring: "border-muted-foreground/30", label: "waiting", icon: CircleDashed },
  running: { ring: "border-primary", label: "running", icon: Loader2 },
  succeeded: { ring: "border-emerald-500", label: "succeeded", icon: CheckCircle2 },
  failed: { ring: "border-destructive", label: "failed", icon: XCircle },
  skipped: { ring: "border-amber-500", label: "skipped", icon: MinusCircle },
};

type FlowData = { node: WorkflowNode; state?: WorkflowNodeState };

function WorkflowFlowNode({ data, selected }: NodeProps) {
  const { node, state } = data as FlowData;
  const kind = KIND_STYLE[node.kind];
  const Icon = kind.icon;
  const run = state ? STATE_STYLE[state] : null;
  const RunIcon = run?.icon;
  return (
    <div
      className={cn(
        "min-w-44 rounded-lg border-2 bg-card px-3 py-2 shadow-sm",
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
            {node.continueOnFailure ? " · continues on failure" : ""}
          </div>
        </div>
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
  const runsFn = useServerFn(workflowRunsList);
  const runGetFn = useServerFn(workflowRunGet);
  const cancelFn = useServerFn(workflowRunCancel);
  const candidatesFn = useServerFn(workflowCandidates);

  const [workflows, setWorkflows] = useState<WorkflowRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("manual");
  const [isActive, setIsActive] = useState(true);
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [candidates, setCandidates] = useState<WorkflowCandidates>({
    pipelines: [],
    mlSchedules: [],
    notebooks: [],
    models: [],
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
    void candidatesFn({ data: { accessToken: token } }).then((res) => {
      if (res.ok) setCandidates(res);
    });
  }, [candidatesFn, token]);

  const loadRuns = useCallback(
    async (id: string) => {
      const res = await runsFn({ data: { accessToken: token, workflowId: id } });
      if (res.ok) setRuns(res.runs);
    },
    [runsFn, token],
  );

  // Load whichever workflow is selected.
  useEffect(() => {
    if (!token || !selectedId) return;
    void (async () => {
      const res = await getFn({ data: { accessToken: token, id: selectedId } });
      if (!res.ok) return toast.error(res.error);
      const w = res.workflow;
      setName(w.name);
      setSchedule(w.schedule);
      setIsActive(w.is_active);
      setGraph(autoLayout((w.graph ?? { nodes: [], edges: [] }) as unknown as WorkflowGraph));
      setNodeId(null);
      setOpenRun(null);
      void loadRuns(selectedId);
    })();
  }, [getFn, token, selectedId, loadRuns]);

  // While a run is live, keep asking. The server advances the run on read, so
  // this is what makes a manual run visibly move rather than sit still.
  useEffect(() => {
    if (!openRun || openRun.run.state !== "running") return;
    const t = setInterval(() => {
      void runGetFn({ data: { accessToken: token, runId: openRun.run.id } }).then((res) => {
        if (res.ok) setOpenRun({ run: res.run, nodes: res.nodes });
        if (res.ok && res.run.state !== "running" && selectedId) {
          void loadRuns(selectedId);
          // The card in the list carries the last run's status, so it goes
          // stale the moment this run ends unless the list is reloaded too.
          void reload();
        }
      });
    }, 3000);
    return () => clearInterval(t);
  }, [openRun, runGetFn, token, selectedId, loadRuns, reload]);

  const statesByNode = useMemo(() => {
    const out: Record<string, WorkflowNodeState> = {};
    for (const n of openRun?.nodes ?? []) out[n.node_id] = n.state as WorkflowNodeState;
    return out;
  }, [openRun]);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;
  const node = graph.nodes.find((n) => n.id === nodeId) ?? null;

  const addNode = (kind: WorkflowNodeKind) => {
    const n: WorkflowNode = {
      id: newNodeId(),
      kind,
      // Deliberately unnamed: picking what it runs is what names it, and a
      // default label would block that and leave four steps all called
      // "SQL models".
      label: "",
      models: kind === "sql_models" ? [] : undefined,
      x: 80 + graph.nodes.length * 40,
      y: 80 + (graph.nodes.length % 4) * 90,
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
    const invalid = validateWorkflow({ name, graph });
    if (invalid) return toast.error(invalid);
    setSaving(true);
    try {
      const res = await saveFn({
        data: {
          accessToken: token,
          id: selectedId,
          name,
          schedule: schedule as "manual" | "hourly" | "daily" | "weekly",
          isActive,
          nodes: graph.nodes,
          edges: graph.edges,
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

  async function runNow() {
    if (!selectedId) return;
    setRunning(true);
    try {
      const res = await runFn({ data: { accessToken: token, id: selectedId } });
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
    // The right-hand panel was showing this workflow's runs; leaving them up
    // beside an empty list reads as a workflow that is still there.
    setRuns([]);
    setOpenRun(null);
    setGraph({ nodes: [], edges: [] });
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
        <p className="hidden max-w-xl text-xs text-muted-foreground lg:block">
          One graph over the pipelines, model builds, retrains and notebooks you already have. A
          step starts when everything it waits for has succeeded.
        </p>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New workflow
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[220px_1fr_280px]">
        {/* The workflows themselves. */}
        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="space-y-1 p-2">
            {workflows.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                No workflows yet. Create one and drop in the pipelines and models you already run.
              </p>
            ) : null}
            {workflows.map((w) => (
              <div
                key={w.id}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs",
                  selectedId === w.id && "border-primary bg-primary/5",
                )}
              >
                <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(w.id)}>
                  <span className="block truncate font-medium">{w.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {w.schedule === "manual" ? "manual" : w.schedule}
                    {w.last_run_at
                      ? ` · ${formatDistanceToNow(new Date(w.last_run_at), { addSuffix: true })}`
                      : " · never run"}
                  </span>
                </button>
                {w.last_run_status ? (
                  <Badge
                    variant={w.last_run_status === "failed" ? "destructive" : "outline"}
                    className="text-[9px]"
                  >
                    {w.last_run_status}
                  </Badge>
                ) : null}
                <button
                  title="Delete workflow"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void removeWorkflow(w)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* The graph. */}
        <div className="flex min-h-0 flex-col gap-2">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-8 w-56 font-medium"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Select value={schedule} onValueChange={setSchedule}>
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-1.5 text-xs">
                  <Switch checked={isActive} onCheckedChange={setIsActive} /> Active
                </label>
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={running}
                    onClick={() => void runNow()}
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

              <div className="flex flex-wrap gap-1">
                {(Object.keys(NODE_KIND_LABEL) as WorkflowNodeKind[]).map((kind) => {
                  const Icon = KIND_STYLE[kind].icon;
                  return (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => addNode(kind)}
                    >
                      <Icon className="mr-1 h-3 w-3" /> {NODE_KIND_LABEL[kind]}
                    </Button>
                  );
                })}
                {openRun ? (
                  <Badge variant="outline" className="ml-auto self-center text-[10px]">
                    Showing run · {openRun.run.state}
                  </Badge>
                ) : null}
              </div>

              <WorkflowCanvas
                graph={graph}
                onChange={setGraph}
                selectedId={nodeId}
                onSelect={setNodeId}
                states={statesByNode}
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

        {/* The step being edited, and the run history. */}
        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="space-y-3 p-3">
            {node ? (
              <StepEditor
                node={node}
                candidates={candidates}
                onChange={patchNode}
                onDelete={() => {
                  setGraph((g) => ({
                    nodes: g.nodes.filter((n) => n.id !== node.id),
                    edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id),
                  }));
                  setNodeId(null);
                }}
              />
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Add a step, then drag from its right edge to another step&apos;s left edge to say
                &ldquo;after&rdquo;. Double-click an arrow to remove it. A step with two arrows into
                it waits for both.
              </p>
            )}

            <div className="space-y-1 border-t pt-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Runs
              </p>
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
                    {formatDistanceToNow(new Date(r.started_at), { addSuffix: true })} · {r.trigger}
                  </span>
                </button>
              ))}
            </div>

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
                }}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>
              A workflow orchestrates work you already have. Nothing new runs here — it decides
              when, and records what happened as one run instead of four.
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
    </div>
  );
}

function WorkflowCanvas({
  graph,
  onChange,
  selectedId,
  onSelect,
  states,
}: {
  graph: WorkflowGraph;
  onChange: (g: WorkflowGraph) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  states: Record<string, WorkflowNodeState>;
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
          data: { node: n, state: states[n.id] },
          selected: n.id === selectedId,
        } as FlowNode;
      }),
    );
  }, [graph.nodes, selectedId, states]);

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: `${e.from}>${e.to}`,
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
      onChange({
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
      onChange({
        ...graph,
        edges: graph.edges.filter((e) => !removed.has(`${e.from}>${e.to}`)),
      });
    },
    [graph, onChange],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const exists = graph.edges.some((e) => e.from === c.source && e.to === c.target);
      if (exists) return;
      const next: WorkflowEdge[] = [...graph.edges, { from: c.source, to: c.target }];
      // Refuse a loop at the moment it is drawn, rather than at save: the
      // arrow that caused it is under the cursor now and will not be later.
      const invalid = validateWorkflow({ name: "x", graph: { ...graph, edges: next } });
      if (invalid) return toast.error(invalid);
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
          onChange({
            ...graph,
            edges: graph.edges.filter((e) => `${e.from}>${e.to}` !== edge.id),
          })
        }
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode={isDark ? "dark" : "light"}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {graph.nodes.length === 0 ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          Add a step to begin.
        </p>
      ) : null}
    </div>
  );
}

function StepEditor({
  node,
  candidates,
  onChange,
  onDelete,
}: {
  node: WorkflowNode;
  candidates: WorkflowCandidates;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {NODE_KIND_LABEL[node.kind]}
        </p>
        <button className="ml-auto text-destructive" title="Delete step" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">Label</Label>
        <Input
          className="h-7 text-xs"
          placeholder={NODE_KIND_LABEL[node.kind]}
          value={node.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </div>

      {node.kind === "pipeline" ? (
        <Picker
          label="Pipeline"
          value={node.targetId ?? ""}
          options={candidates.pipelines.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v, label) => onChange({ targetId: v, label: node.label || label })}
        />
      ) : null}
      {node.kind === "ml_schedule" ? (
        <Picker
          label="ML schedule"
          value={node.targetId ?? ""}
          options={candidates.mlSchedules.map((s) => ({
            value: s.id,
            label: `${s.name} · ${s.kind === "batch_predict" ? "batch predict" : "retrain"}`,
          }))}
          onChange={(v, label) => onChange({ targetId: v, label: node.label || label })}
        />
      ) : null}
      {node.kind === "notebook" ? (
        <Picker
          label="Notebook"
          value={node.targetId ?? ""}
          options={candidates.notebooks.map((n) => ({ value: n.id, label: n.title }))}
          onChange={(v, label) => onChange({ targetId: v, label: node.label || label })}
        />
      ) : null}
      {node.kind === "sql_models" ? (
        <div className="space-y-1">
          <Label className="text-[11px]">Models (blank = every active model)</Label>
          <Input
            className="h-7 text-xs"
            placeholder="orders_daily, customers"
            value={(node.models ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                models: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className="text-[11px] text-muted-foreground">
            Naming models builds those and their ancestors, which is what a build always does.
            Available: {candidates.models.slice(0, 8).join(", ") || "none yet"}
          </p>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-[11px]">
        <Switch
          checked={Boolean(node.continueOnFailure)}
          onCheckedChange={(v) => onChange({ continueOnFailure: v })}
        />
        Carry on if this step fails
      </label>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Off, a failure here skips everything downstream. On, the workflow continues — for the step
        that refreshes a dashboard, not the one that loads the data.
      </p>
    </div>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string, label: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v, options.find((o) => o.value === v)?.label ?? "")}
      >
        <SelectTrigger className="h-7 text-xs">
          <SelectValue placeholder={`Pick a ${label.toLowerCase()}…`} />
        </SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none" disabled>
              You have none yet
            </SelectItem>
          ) : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RunDetail({
  detail,
  onCancel,
}: {
  detail: { run: WorkflowRunDto; nodes: WorkflowNodeRunDto[] };
  onCancel: () => void;
}) {
  return (
    <div className="space-y-1 border-t pt-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          This run
        </p>
        {detail.run.state === "running" ? (
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-[11px]" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {detail.nodes.map((n) => {
        const style = STATE_STYLE[n.state as WorkflowNodeState] ?? STATE_STYLE.pending;
        const Icon = style.icon;
        return (
          <div key={n.id} className="rounded-md border px-2 py-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <Icon className={cn("h-3 w-3", n.state === "running" && "animate-spin")} />
              <span className="min-w-0 flex-1 truncate font-medium">{n.label}</span>
              <span className="text-muted-foreground">{style.label}</span>
            </div>
            {n.error ? <p className="mt-0.5 text-destructive">{n.error}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
