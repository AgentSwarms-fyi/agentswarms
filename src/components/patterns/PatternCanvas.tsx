// Read-only ReactFlow canvas for an Agentic AI pattern.
// - Drag is allowed (per spec): positions are owned by ReactFlow via
//   useNodesState so user-dragged positions persist across re-renders
// - Connect / select / multi-select / edge edit are all DISABLED
// - Edges are animated (marching ants); active edges in tour use accent stroke
// - When the tour highlight changes, the camera pans/zooms to focus the
//   active nodes so the user doesn't have to scroll the canvas manually.
import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ACCENT_CLASSES, type AgenticPattern } from "@/lib/agenticPatterns";
import { PatternFlowNode, type PatternFlowNodeData } from "./PatternNode";

const nodeTypes = { patternNode: PatternFlowNode };

type Props = {
  pattern: AgenticPattern;
  /** Currently highlighted node ids (empty array = no tour active) */
  activeNodeIds: string[];
  /** Currently highlighted edge ids */
  activeEdgeIds: string[];
};

export function PatternCanvas(props: Props) {
  return (
    <div className="h-full w-full bg-[#e8e6dd]">
      <ReactFlowProvider>
        <PatternCanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}

function PatternCanvasInner({ pattern, activeNodeIds, activeEdgeIds }: Props) {
  const accent = ACCENT_CLASSES[pattern.accent];
  const tourActive = activeNodeIds.length > 0 || activeEdgeIds.length > 0;
  const activeNodeSet = useMemo(() => new Set(activeNodeIds), [activeNodeIds]);
  const activeEdgeSet = useMemo(() => new Set(activeEdgeIds), [activeEdgeIds]);

  const sourceIds = useMemo(() => new Set(pattern.edges.map((e) => e.source)), [pattern.edges]);
  const targetIds = useMemo(() => new Set(pattern.edges.map((e) => e.target)), [pattern.edges]);

  // Build the initial node array from the pattern definition. We hand
  // ownership to ReactFlow via useNodesState so user drags persist.
  const initialNodes: Node<PatternFlowNodeData>[] = useMemo(
    () =>
      pattern.nodes.map((n) => ({
        id: n.id,
        type: "patternNode",
        position: n.position,
        data: {
          node: n,
          accent: pattern.accent,
          highlight: "idle",
          isSource: sourceIds.has(n.id),
          isTarget: targetIds.has(n.id),
        },
        draggable: true,
        selectable: false,
        connectable: false,
      })),
    // pattern.id is enough — when the pattern changes we want a full reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pattern.id],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PatternFlowNodeData>>(initialNodes);

  // Reset nodes when switching pattern.
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  // Update only the .data.highlight field when the tour step changes —
  // do NOT replace position, which would kill the user's drag layout.
  useEffect(() => {
    setNodes((cur) =>
      cur.map((n) => ({
        ...n,
        data: {
          ...n.data,
          highlight: !tourActive ? "idle" : activeNodeSet.has(n.id) ? "active" : "dimmed",
        },
      })),
    );
  }, [tourActive, activeNodeSet, setNodes]);

  // ── Edges ────────────────────────────────────────────────────────────
  // Variant colors (used by branching patterns to differentiate "danger"
  // vs "success" paths regardless of the parent pattern accent).
  const VARIANT_STROKE: Record<"danger" | "success", string> = {
    danger: "#ef4444", // red-500
    success: "#10b981", // emerald-500
  };

  const initialEdges: Edge[] = useMemo(
    () =>
      pattern.edges.map((e) => {
        const baseStroke = e.variant ? VARIANT_STROKE[e.variant] : "#64748b";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          animated: true,
          type: "smoothstep",
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
          labelBgStyle: { fill: "#ffffff", fillOpacity: 0.95 },
          labelStyle: { fill: e.variant ? baseStroke : "#475569", fontSize: 10, fontWeight: 600 },
          style: {
            stroke: baseStroke,
            strokeWidth: 2,
            strokeDasharray: e.dashed ? "8 4" : undefined,
            opacity: 1,
            transition: "all 300ms ease",
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, color: baseStroke },
          // Preserve original visual intent so we can re-derive after style updates.
          data: { dashed: e.dashed ?? false, variant: e.variant ?? null },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pattern.id],
  );

  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  // Restyle edges when the tour highlight changes.
  useEffect(() => {
    setEdges((cur: Edge[]) =>
      cur.map((e: Edge) => {
        const meta = e.data as
          | { dashed?: boolean; variant?: "danger" | "success" | null }
          | undefined;
        const variant = meta?.variant ?? null;
        const baseStroke = variant ? VARIANT_STROKE[variant] : "#64748b";
        const isActive = activeEdgeSet.has(e.id);
        const isDimmed = tourActive && !isActive;
        // Active wins → use accent stroke unless this edge is a variant edge,
        // in which case keep the variant color (but bolden it).
        const stroke = isActive ? (variant ? baseStroke : accent.stroke) : baseStroke;
        const dashed = meta?.dashed ?? false;
        return {
          ...e,
          labelStyle: {
            fill: isActive ? stroke : variant ? baseStroke : "#475569",
            fontSize: 10,
            fontWeight: 600,
          },
          style: {
            stroke,
            strokeWidth: isActive ? 3.5 : 2,
            strokeDasharray: dashed ? "8 4" : undefined,
            opacity: isDimmed ? 0.2 : 1,
            transition: "all 300ms ease",
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, color: stroke },
        };
      }),
    );
  }, [activeEdgeSet, tourActive, accent.stroke, setEdges]);

  // ── Camera pan/zoom to active nodes ──────────────────────────────────
  const { fitView } = useReactFlow();

  useEffect(() => {
    // When tour is inactive, fit the whole graph.
    if (!tourActive) {
      const id = window.setTimeout(() => fitView({ padding: 0.2, duration: 600 }), 50);
      return () => window.clearTimeout(id);
    }
    if (activeNodeIds.length === 0) return;
    // Focus on just the highlighted nodes — small padding so they fill ~half the viewport.
    const id = window.setTimeout(
      () =>
        fitView({
          nodes: activeNodeIds.map((nodeId) => ({ id: nodeId })),
          padding: 0.45,
          duration: 700,
          maxZoom: 1.4,
        }),
      50,
    );
    return () => window.clearTimeout(id);
    // We intentionally key on the joined node ids string so React only re-runs
    // when the *set* of focused nodes changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourActive, activeNodeIds.join("|"), pattern.id]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      panOnDrag
      zoomOnScroll
      zoomOnPinch
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1.5} color="#b8b5a8" />
      <Controls showInteractive={false} className="!bg-white !border-slate-200" />
    </ReactFlow>
  );
}
