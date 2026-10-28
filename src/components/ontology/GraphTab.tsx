// The neighbourhood of one object, drawn: what it links to, and what those
// link to. Click a node to grow the graph from it; open it for its details.
// Capped per link and in total, and it says when it was capped, so a hub
// with ten thousand orders draws as a hub, not as a hairball.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Info, Loader2, Maximize, Network, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ObjectPanel } from "@/components/ontology/ExploreTab";
import { useOntology } from "@/components/ontology/OntologyContext";
import { iconOf, toneOf } from "@/components/ontology/theme";
import {
  ontologyNeighborhood,
  ontologyObjects,
  type GraphEdge,
  type GraphNode,
} from "@/utils/ontologyData.functions";
import { findObjectType, pluralTitleOf } from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

type GNodeData = { node: GraphNode; root: boolean };

function GNode({ data }: NodeProps<Node<GNodeData>>) {
  const o = useOntology();
  const t = findObjectType(o.spec, data.node.objectType);
  const tone = toneOf(t);
  const Icon = iconOf(t);
  return (
    <div
      className={cn(
        "flex max-w-[200px] items-center gap-2 rounded-full border-2 bg-card px-3 py-1.5 shadow-sm",
        data.root ? "border-primary ring-4 ring-primary/15" : tone.ring,
      )}
      title={`${data.node.objectType}: ${data.node.title}`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          tone.soft,
          tone.ink,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="truncate text-xs font-medium">{data.node.title}</span>
    </div>
  );
}

const nodeTypes = { obj: GNode };

/** Rings by depth; each ring spread evenly, grouped by type so a type's objects sit together. */
function radial(nodes: GraphNode[], placed: Map<string, { x: number; y: number }>) {
  const out = new Map(placed);
  const byDepth = new Map<number, GraphNode[]>();
  for (const n of nodes)
    if (!out.has(n.id)) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
  for (const [depth, ring] of byDepth) {
    ring.sort((a, b) => a.objectType.localeCompare(b.objectType) || a.title.localeCompare(b.title));
    const r = depth === 0 ? 0 : 220 * depth + Math.max(0, ring.length - 12) * 6;
    ring.forEach((n, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, ring.length) - Math.PI / 2;
      out.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    });
  }
  return out;
}

export function GraphTab() {
  const o = useOntology();
  const nbFn = useServerFn(ontologyNeighborhood);
  const objectsFn = useServerFn(ontologyObjects);
  const bound = o.spec.objectTypes.filter((t) => t.source);
  const initial =
    o.focus?.kind === "object" ? { objectType: o.focus.objectType, key: o.focus.key } : null;
  const [root, setRoot] = useState<{ objectType: string; key: Record<string, unknown> } | null>(
    initial,
  );
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [positions, setPositions] = useState(new Map<string, { x: number; y: number }>());
  const [capped, setCapped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ objectType: string; key: Record<string, unknown> } | null>(
    null,
  );
  // Picking a starting object.
  const [pickType, setPickType] = useState(bound[0]?.name ?? "");
  const [pickQ, setPickQ] = useState("");
  const [candidates, setCandidates] = useState<{ key: Record<string, unknown>; title: string }[]>(
    [],
  );

  const grow = async (
    from: { objectType: string; key: Record<string, unknown> },
    reset: boolean,
    depth = 1,
  ) => {
    setBusy(true);
    try {
      const res = await nbFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          objectType: from.objectType,
          key: from.key as Record<string, string | number | boolean>,
          depth,
          perLink: 8,
        },
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setCapped(res.capped);
      const base = reset ? [] : nodes;
      const fromId = `${from.objectType}:${JSON.stringify(from.key)}`;
      const anchorDepth = base.find((n) => n.id === fromId)?.depth ?? 0;
      const merged = new Map(base.map((n) => [n.id, n]));
      for (const n of res.nodes)
        if (!merged.has(n.id)) merged.set(n.id, { ...n, depth: n.depth + anchorDepth });
      const nextNodes = [...merged.values()];
      const edgeMap = new Map((reset ? [] : edges).map((e) => [`${e.from}|${e.link}|${e.to}`, e]));
      for (const e of res.edges) edgeMap.set(`${e.from}|${e.link}|${e.to}`, e);
      setNodes(nextNodes);
      setEdges([...edgeMap.values()]);
      setPositions((p) => radial(nextNodes, reset ? new Map() : p));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (root) void grow(root, true);
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (root || !pickType) return;
    const id = setTimeout(async () => {
      const res = await objectsFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          query: {
            objectType: pickType,
            ...(pickQ.trim() ? { search: pickQ.trim() } : {}),
            limit: 12,
          },
          count: false,
        },
      });
      const t = findObjectType(o.spec, pickType);
      if (res.ok && t) {
        setCandidates(
          res.rows.map((r) => ({
            key: Object.fromEntries(t.primaryKey.map((k) => [k, r[k]])),
            title: String(
              (t.titleProperty ? r[t.titleProperty] : null) ??
                t.primaryKey.map((k) => r[k]).join(" · "),
            ),
          })),
        );
      }
    }, 250);
    return () => clearTimeout(id);
  }, [pickType, pickQ, root, objectsFn, o.tokenRef, o.id, o.spec]);

  const rfNodes = useMemo(
    (): Node<GNodeData>[] =>
      nodes.map((n) => ({
        id: n.id,
        type: "obj",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n, root: n.depth === 0 },
      })),
    [nodes, positions],
  );
  const rfEdges = useMemo(
    (): Edge[] =>
      edges.map((e) => ({
        id: `${e.from}|${e.link}|${e.to}`,
        source: e.from,
        target: e.to,
        label: e.label,
        type: "straight",
        style: { strokeWidth: 1.2 },
        labelStyle: { fontSize: 10 },
        labelBgStyle: { fill: "var(--card)" },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      })),
    [edges],
  );

  if (!root) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 rounded-xl border border-border bg-card p-6">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Network className="h-4 w-4 text-primary" /> Start from an object
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick one object; the graph shows everything it links to, and grows from any node you
            click.
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={pickType} onValueChange={setPickType}>
            <SelectTrigger className="w-48" aria-label="Object type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {bound.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {pluralTitleOf(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={pickQ}
              onChange={(e) => setPickQ(e.target.value)}
              placeholder="Search"
              className="pl-8"
              aria-label="Search objects"
            />
          </div>
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {candidates.map((c, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setRoot({ objectType: pickType, key: c.key })}
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                {c.title}
              </button>
            </li>
          ))}
          {!candidates.length && (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">No objects</li>
          )}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="outline" onClick={() => setRoot(null)}>
          Start from another object
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void grow(root, true, 2)}
          disabled={busy}
        >
          <Maximize className="mr-1 h-3.5 w-3.5" /> Two steps out
        </Button>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="text-xs text-muted-foreground">
          {nodes.length} objects · {edges.length} links. Click a node to grow from it; double-click
          to open it.
        </span>
        {capped && (
          <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <Info className="h-3.5 w-3.5" /> Some links have more objects than shown
          </span>
        )}
      </div>
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
          {error}
        </p>
      )}
      <div className="h-[min(70vh,720px)] min-h-[420px] overflow-hidden rounded-xl border border-border bg-background">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) =>
            void grow(
              {
                objectType: (n.data as GNodeData).node.objectType,
                key: (n.data as GNodeData).node.key,
              },
              false,
            )
          }
          onNodeDoubleClick={(_, n) =>
            setOpen({
              objectType: (n.data as GNodeData).node.objectType,
              key: (n.data as GNodeData).node.key,
            })
          }
          nodesConnectable={false}
          fitView
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <ObjectPanel target={open} onClose={() => setOpen(null)} onNavigate={setOpen} />
    </div>
  );
}
