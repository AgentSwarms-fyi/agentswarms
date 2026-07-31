// Visual ReactFlow canvas for a single swarm run.
// Mirrors the original swarm topology but colors each node by run status
// and shows quick metrics inline. Click a node/edge to inspect.
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export type TraceCanvasStep = {
  id: string;
  node_id: string;
  node_label: string | null;
  node_kind: string;
  status: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error_message: string | null;
};

export type TraceCanvasEdge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  bytes: number;
};

type SwarmSnapshot = {
  nodes?: Array<{
    id: string;
    position?: { x: number; y: number };
    data?: { label?: string; kind?: string };
  }>;
  edges?: Array<{ id?: string; source: string; target: string; label?: string }>;
} | null;

const STATUS_BORDER: Record<string, string> = {
  success: "border-emerald-500/60",
  error: "border-red-500/70",
  skipped: "border-muted-foreground/30",
  awaiting_approval: "border-amber-500/60",
  running: "border-amber-500/60",
};
const STATUS_BG: Record<string, string> = {
  success: "bg-emerald-500/10",
  error: "bg-red-500/10",
  skipped: "bg-muted/30",
  awaiting_approval: "bg-amber-500/10",
  running: "bg-amber-500/10",
};

export function TraceFlowCanvas({
  snapshot,
  steps,
  edges,
  onSelectStep,
}: {
  snapshot: SwarmSnapshot;
  steps: TraceCanvasStep[];
  edges: TraceCanvasEdge[];
  onSelectStep: (step: TraceCanvasStep) => void;
}) {
  const stepByNodeId = useMemo(() => {
    const m = new Map<string, TraceCanvasStep>();
    steps.forEach((s) => m.set(s.node_id, s));
    return m;
  }, [steps]);

  const { rfNodes, rfEdges } = useMemo(() => {
    // Source of truth: snapshot if present, else derive from steps + edges.
    const snapNodes =
      snapshot?.nodes ??
      steps.map((s, i) => ({
        id: s.node_id,
        position: { x: 60 + (i % 4) * 240, y: 60 + Math.floor(i / 4) * 140 },
        data: { label: s.node_label ?? s.node_id, kind: s.node_kind },
      }));
    const snapEdges =
      snapshot?.edges ??
      edges.map((e) => ({
        id: `${e.source_node_id}->${e.target_node_id}`,
        source: e.source_node_id,
        target: e.target_node_id,
      }));

    const rfNodes: RFNode[] = snapNodes.map((n) => {
      const step = stepByNodeId.get(n.id);
      const status = step?.status ?? "skipped";
      const label = step?.node_label ?? n.data?.label ?? n.id;
      const kind = step?.node_kind ?? n.data?.kind ?? "node";
      return {
        id: n.id,
        position: n.position ?? { x: 0, y: 0 },
        data: {
          label: (
            <div
              className={`min-w-[180px] rounded-md border-2 ${STATUS_BORDER[status] ?? "border-border"} ${STATUS_BG[status] ?? "bg-muted/20"} p-2 text-left cursor-pointer`}
              onClick={() => step && onSelectStep(step)}
              title={step?.error_message ?? ""}
            >
              <div className="text-[11px] font-semibold truncate">{label}</div>
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-0.5">
                {kind} · {status}
              </div>
              {step && (
                <div className="text-[10px] font-mono text-muted-foreground mt-1">
                  {step.latency_ms}ms · {step.tokens_in}/{step.tokens_out}t · $
                  {Number(step.cost_usd).toFixed(4)}
                </div>
              )}
            </div>
          ),
        },
        type: "default",
        draggable: false,
        selectable: true,
        style: { background: "transparent", border: "none", padding: 0, width: "auto" },
      };
    });

    // Track edges that actually fired during the run.
    const firedKey = new Set(edges.map((e) => `${e.source_node_id}->${e.target_node_id}`));

    const rfEdges: RFEdge[] = snapEdges.map((e) => {
      const key = `${e.source}->${e.target}`;
      const fired = firedKey.has(key);
      const targetStep = stepByNodeId.get(e.target);
      const errored = targetStep?.status === "error";
      return {
        id: e.id ?? key,
        source: e.source,
        target: e.target,
        animated: fired && !errored,
        style: {
          stroke: errored
            ? "var(--destructive)"
            : fired
              ? "var(--primary)"
              : "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
          strokeWidth: fired ? 2.5 : 1.5,
          strokeDasharray: fired ? undefined : "4 4",
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: errored
            ? "var(--destructive)"
            : fired
              ? "var(--primary)"
              : "var(--muted-foreground)",
        },
      };
    });

    return { rfNodes, rfEdges };
  }, [snapshot, steps, edges, stepByNodeId, onSelectStep]);

  return (
    <div className="h-[600px] w-full rounded-md border border-border bg-muted/10">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-background" />
      </ReactFlow>
    </div>
  );
}
