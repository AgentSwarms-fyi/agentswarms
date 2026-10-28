// The model as a picture: object types as cards, links as labelled arrows.
//
// Drag a type to place it (the position is saved with the model, so everyone
// sees the same picture); click one to open it; click a link to edit it. A
// link's label reads the way the business says it ("placed by") with its
// cardinality (N:1), and a link that needs a join table is dashed. A type
// that is not bound to a table, or has problems, says so on its card.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  Database,
  KeyRound,
  LayoutGrid,
  Maximize2,
  Sigma,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { autoLayout, NODE_W } from "@/lib/ontology/layout";
import { allProperties, titleOf, type ObjectType, type OntologySpec } from "@/lib/ontology/spec";
import type { Issue } from "@/lib/ontology/validate";
import { iconOf, toneOf } from "@/components/ontology/theme";
import { cn } from "@/lib/utils";

type TypeNodeData = {
  type: ObjectType;
  props: number;
  problems: number;
  selected: boolean;
  rows?: number | null;
};

const CARD: Record<string, string> = {
  many_to_one: "N:1",
  one_to_one: "1:1",
  one_to_many: "1:N",
  many_to_many: "N:N",
};

const TypeNode = memo(function TypeNode({ data }: NodeProps<Node<TypeNodeData>>) {
  const t = data.type;
  const tone = toneOf(t);
  const Icon = iconOf(t);
  return (
    <div
      className={cn(
        "rounded-xl border-2 bg-card shadow-sm transition-shadow",
        data.selected ? "border-primary shadow-lg" : tone.ring,
      )}
      style={{ width: NODE_W }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/40"
      />
      <div className={cn("flex items-center gap-2 rounded-t-[10px] px-3 py-2", tone.soft)}>
        <span
          className={cn("flex h-7 w-7 items-center justify-center rounded-lg bg-card", tone.ink)}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-semibold", tone.ink)}>{titleOf(t)}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">{t.name}</p>
        </div>
        {t.status === "certified" && (
          <span className="rounded bg-emerald-500/15 px-1 text-[9px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">
            certified
          </span>
        )}
        {t.status === "deprecated" && (
          <span className="rounded bg-rose-500/15 px-1 text-[9px] font-semibold uppercase text-rose-700 dark:text-rose-300">
            deprecated
          </span>
        )}
      </div>
      <div className="space-y-1 px-3 py-2 text-[11px] text-muted-foreground">
        <p className="flex items-center gap-1.5 truncate">
          {t.source ? (
            <>
              <Database className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{t.source.table}</span>
              {t.source.filter && (
                <span className="rounded bg-muted px-1 text-[9px]">filtered</span>
              )}
            </>
          ) : (
            <>
              <Unplug className="h-3 w-3 shrink-0 text-amber-600" />
              <span className="text-amber-700 dark:text-amber-400">Not bound to a table</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <KeyRound className="h-3 w-3" />
            {t.primaryKey.join(", ") || "no key"}
          </span>
          <span>{data.props} props</span>
          <span className="flex items-center gap-0.5">
            <Sigma className="h-3 w-3" />
            {t.metrics.length}
          </span>
        </div>
        {data.problems > 0 && (
          <p className="flex items-center gap-1 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3 w-3" /> {data.problems} problem
            {data.problems === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
});

const nodeTypes = { objectType: TypeNode };

export function ModelCanvas(props: {
  spec: OntologySpec;
  issues: Issue[];
  selected?: string | null;
  canEdit: boolean;
  onSelectType?: (name: string) => void;
  onSelectLink?: (from: string, name: string) => void;
  onMove?: (positions: Map<string, { x: number; y: number }>) => void;
  className?: string;
}) {
  const { spec, issues } = props;
  const [nodes, setNodes] = useState<Node<TypeNodeData>[]>([]);
  const fallback = useMemo(() => autoLayout(spec, { keepPlaced: true }), [spec]);

  const built = useMemo((): Node<TypeNodeData>[] => {
    return spec.objectTypes.map((t) => ({
      id: t.name,
      type: "objectType",
      position: t.position ?? fallback.get(t.name) ?? { x: 0, y: 0 },
      data: {
        type: t,
        props: allProperties(spec, t).length,
        problems: issues.filter(
          (i) => i.level === "error" && i.path.startsWith(`objectTypes.${t.name}`),
        ).length,
        selected: props.selected === t.name,
      },
    }));
  }, [spec, issues, fallback, props.selected]);

  useEffect(() => setNodes(built), [built]);

  const edges = useMemo((): Edge[] => {
    const out: Edge[] = spec.linkTypes.map((l) => ({
      id: `link:${l.from}.${l.name}`,
      source:
        spec.objectTypes.find((t) => t.name.toLowerCase() === l.from.toLowerCase())?.name ?? l.from,
      target:
        spec.objectTypes.find((t) => t.name.toLowerCase() === l.to.toLowerCase())?.name ?? l.to,
      label: `${l.label ?? l.name.replace(/_/g, " ")} · ${CARD[l.cardinality]}`,
      type: "smoothstep",
      animated: false,
      style: {
        strokeWidth: 1.6,
        strokeDasharray: l.join.kind === "join_table" ? "6 4" : undefined,
      },
      labelStyle: { fontSize: 11, fontWeight: 500 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
      labelBgStyle: { fill: "var(--card)", fillOpacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      data: { from: l.from, name: l.name },
    }));
    for (const t of spec.objectTypes) {
      if (!t.extends) continue;
      out.push({
        id: `extends:${t.name}`,
        source: t.name,
        target:
          spec.objectTypes.find((s) => s.name.toLowerCase() === t.extends!.toLowerCase())?.name ??
          t.extends,
        label: "is a",
        type: "straight",
        style: { strokeWidth: 1.2, strokeDasharray: "2 3" },
        labelStyle: { fontSize: 10, fontStyle: "italic" },
        labelBgStyle: { fill: "var(--card)" },
        markerEnd: { type: MarkerType.Arrow, width: 14, height: 14 },
      });
    }
    return out;
  }, [spec]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<TypeNodeData>>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );

  const onDragStop = (dragged: Node<TypeNodeData>[]) => {
    if (!props.canEdit || !props.onMove) return;
    const moved = new Map(dragged.map((n) => [n.id, n.position]));
    props.onMove(
      new Map(
        nodes.map((n) => {
          const p = moved.get(n.id) ?? n.position;
          return [n.id, { x: Math.round(p.x), y: Math.round(p.y) }];
        }),
      ),
    );
  };

  const relayout = () => {
    const pos = autoLayout(spec);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    if (props.canEdit && props.onMove) props.onMove(pos);
  };

  if (!spec.objectTypes.length) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-10 text-center",
          props.className,
        )}
      >
        <LayoutGrid className="mb-2 h-6 w-6 text-muted-foreground" />
        <p className="font-medium">No object types yet</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Add the first kind of thing the business deals in under Model, and bind it to a table.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-background",
        props.className,
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, __, dragged) => onDragStop(dragged)}
        onNodeClick={(_, n) => props.onSelectType?.(n.id)}
        onEdgeClick={(_, e) => {
          const d = e.data as { from?: string; name?: string } | undefined;
          if (d?.from && d.name) props.onSelectLink?.(d.from, d.name);
        }}
        nodesDraggable={props.canEdit}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <MiniMap
          pannable
          zoomable
          className="!bg-card"
          nodeColor={(n) => toneOf((n.data as TypeNodeData).type).stroke}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="absolute right-3 top-3 flex gap-1.5">
        {props.canEdit && (
          <Button
            size="sm"
            variant="secondary"
            onClick={relayout}
            title="Arrange the types by how they link"
          >
            <LayoutGrid className="mr-1 h-3.5 w-3.5" /> Arrange
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            document
              .querySelector(".react-flow__controls-fitview")
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
          }
          title="Fit the whole model in view"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
