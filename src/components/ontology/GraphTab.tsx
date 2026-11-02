// The neighbourhood of one object, drawn: what it links to, and what those
// link to, up to three steps out. Click an object to see its relationships;
// double-click (or Expand) to grow the graph from it; Shift-click a second
// object for the path between them. Capped per link and in total, and it
// says where: a hub with ten thousand orders draws as a hub, not a hairball.
//
// Reworked in R433, from the UI: new objects were spread round a ring about
// the start, so an order's lines landed on the far side of the customer and a
// second expansion stacked objects on top of the first's; a link between two
// objects on screen was drawn only if one of them had been expanded; a click
// always grew the graph and a double-click grew it twice. The walk is in
// src/lib/ontology/graph.ts, the layout and paths in graphView.ts.
//
// R434, also from the UI: the selected object's panel floated over the
// canvas's left third, hiding the objects under it, and the wheel zoomed the
// canvas, so a page scrolled with the pointer over it stopped dead. The panel
// sits beside the canvas now, and saying how to read the graph when nothing
// is selected; the wheel scrolls the page, Ctrl + scroll or a pinch zooms.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowRight,
  Crosshair,
  EyeOff,
  Info,
  Loader2,
  Maximize,
  Network,
  PanelRightOpen,
  Plus,
  Route,
  Search,
  Tags,
  X,
} from "lucide-react";
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
  type SkippedLink,
} from "@/utils/ontologyData.functions";
import { GRAPH_MAX_DEPTH, GRAPH_MAX_KNOWN } from "@/lib/ontology/graph";
import {
  hideNode,
  layoutGraph,
  mergeGraph,
  NODE_HEIGHT,
  nodeWidth,
  relationshipsOf,
  shortestPath,
  type XY,
} from "@/lib/ontology/graphView";
import {
  allProperties,
  displayTitle,
  findObjectType,
  pluralTitleOf,
  propertyTitle,
  titleOf,
} from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

type Target = { objectType: string; key: Record<string, unknown> };
type Shown = { nodes: GraphNode[]; edges: GraphEdge[] };

type GNodeData = {
  node: GraphNode;
  root: boolean;
  expanded: boolean;
  selected: boolean;
  dimmed: boolean;
  capped: boolean;
};

function GNode({ data }: NodeProps<Node<GNodeData>>) {
  const o = useOntology();
  const t = findObjectType(o.spec, data.node.objectType);
  const tone = toneOf(t);
  const Icon = iconOf(t);
  return (
    <div
      className={cn(
        "relative flex max-w-[200px] items-center gap-2 rounded-full border-2 bg-card px-3 py-1.5 shadow-sm transition-opacity",
        data.root ? "border-primary ring-4 ring-primary/15" : tone.ring,
        !data.expanded && !data.root && "border-dashed",
        data.selected && "ring-4 ring-primary/40",
        data.dimmed && "opacity-30",
      )}
      title={`${t ? titleOf(t) : data.node.objectType}: ${data.node.title}${data.expanded ? "" : " · double-click to expand"}`}
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
      <span className="truncate text-xs font-medium">{displayTitle(t, data.node.title)}</span>
      {data.capped && (
        <span
          className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1 text-[9px] font-semibold leading-4 text-white"
          aria-label="Has more links than shown"
        >
          more
        </span>
      )}
    </div>
  );
}

const nodeTypes = { obj: GNode };

/** Up to this many links, every one is labelled; past it, those in focus. */
const LABELLED_EDGES = 24;

/** Frame the whole graph again whenever it grows, so new objects are not drawn off-screen. */
function FitOnGrow(props: { count: number; fitKey: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (props.count === 0) return;
    const id = requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [props.count, props.fitKey, fitView]);
  return null;
}

const edgeKey = (e: GraphEdge) => `${e.from}|${e.link}|${e.to}`;

/** The side panel when nothing is selected: how to read and drive the graph. */
function GraphHelp() {
  return (
    <div className="space-y-3">
      <p className="font-semibold">Reading the graph</p>
      <dl className="space-y-2 text-xs">
        {(
          [
            ["Click", "an object to see its relationships here, its neighbours lit."],
            ["Double-click", "or Expand to draw what it links to."],
            ["Shift-click", "a second object for the path between the two."],
            ["Drag", "the background to move; Ctrl + scroll, or pinch, to zoom."],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="inline font-medium">{k}</dt>{" "}
            <dd className="inline text-muted-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        A dashed border means an object is not expanded yet; a “more” badge on its corner, that it
        has more links than are drawn. Arrows point the way a link reads forward: an order is placed
        by a customer.
      </p>
    </div>
  );
}

export function GraphTab() {
  const o = useOntology();
  const nbFn = useServerFn(ontologyNeighborhood);
  const objectsFn = useServerFn(ontologyObjects);
  const bound = o.spec.objectTypes.filter((t) => t.source);
  const initial: Target | null =
    o.focus?.kind === "object" ? { objectType: o.focus.objectType, key: o.focus.key } : null;
  const [root, setRoot] = useState<Target | null>(initial);
  const [steps, setSteps] = useState(1);
  const [shown, setShown] = useState<Shown>({ nodes: [], edges: [] });
  const [positions, setPositions] = useState(new Map<string, XY>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [cappedBy, setCappedBy] = useState(new Map<string, string[]>());
  const [skipped, setSkipped] = useState<SkippedLink[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [allLabels, setAllLabels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Target | null>(null);
  const [fitKey, setFitKey] = useState(0);
  // The walk reads what is shown when it returns, not when it was asked for.
  const shownRef = useRef(shown);
  const posRef = useRef(positions);
  const busyRef = useRef(false);
  useEffect(() => {
    shownRef.current = shown;
    posRef.current = positions;
  }, [shown, positions]);

  // A plain wheel over the canvas scrolls the page; say how to zoom instead.
  const [wheelHint, setWheelHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    setWheelHint(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setWheelHint(false), 1500);
  };
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  // Picking a starting object.
  const [pickType, setPickType] = useState(bound[0]?.name ?? "");
  const [pickQ, setPickQ] = useState("");
  const [pickBusy, setPickBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<
    { key: Record<string, unknown>; title: string; detail: string }[]
  >([]);

  const walk = useCallback(
    async (from: Target, mode: { reset: boolean; depth: number }) => {
      // One walk at a time: two at once would each merge into the same picture.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const before: Shown = mode.reset ? { nodes: [], edges: [] } : shownRef.current;
        const res = await nbFn({
          data: {
            access_token: o.tokenRef.current,
            id: o.id,
            objectType: from.objectType,
            key: from.key as Record<string, string | number | boolean>,
            depth: mode.depth,
            perLink: 8,
            known: before.nodes
              .slice(0, GRAPH_MAX_KNOWN)
              .map((n) => ({ objectType: n.objectType, key: n.key })),
          },
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setError(null);
        const start = res.nodes.find((n) => n.depth === 0)?.id ?? null;
        const merged = mergeGraph(before, res, mode.reset ? null : start);
        // Sized by the title as drawn ("Order line 271", not "271"), or
        // the layout leaves too little room between them.
        const pos = layoutGraph(
          merged.nodes.map((n) => ({
            ...n,
            title: displayTitle(findObjectType(o.spec, n.objectType), n.title),
          })),
          merged.edges,
          mode.reset ? new Map() : posRef.current,
        );
        shownRef.current = merged;
        posRef.current = pos;
        setShown(merged);
        setPositions(pos);
        // The objects this walk expanded: every one short of its last step.
        setExpanded((prev) => {
          const next = new Set(mode.reset ? [] : prev);
          for (const n of res.nodes) if (n.depth < mode.depth) next.add(n.id);
          return next;
        });
        setCappedBy((prev) => {
          const next = new Map(mode.reset ? [] : prev);
          for (const c of res.cappedLinks)
            next.set(c.node, [...new Set([...(next.get(c.node) ?? []), c.label])]);
          return next;
        });
        setSkipped((prev) => {
          const all = new Map((mode.reset ? [] : prev).map((s) => [s.link, s]));
          for (const s of res.skipped) all.set(s.link, s);
          return [...all.values()];
        });
        if (mode.reset) {
          setSelected(start);
          setPathTo(null);
        }
        setFitKey((k) => k + 1);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [nbFn, o.tokenRef, o.id, o.spec],
  );

  useEffect(() => {
    if (root) void walk(root, { reset: true, depth: steps });
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (root || !pickType) return;
    let live = true;
    setPickBusy(true);
    const id = setTimeout(async () => {
      try {
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
        if (!live) return;
        const t = findObjectType(o.spec, pickType);
        if (!res.ok) {
          // It said "No objects" when the lookup failed (R433).
          setPickError(res.error);
          setCandidates([]);
          return;
        }
        setPickError(null);
        if (!t) return;
        // Two customers called Liam Kowalski looked the same (R433): each
        // row shows its key and one more value to tell them apart.
        const extra = allProperties(o.spec, t).find(
          (p) => p.name !== t.titleProperty && !t.primaryKey.includes(p.name),
        );
        setCandidates(
          res.rows.map((r) => ({
            key: Object.fromEntries(t.primaryKey.map((k) => [k, r[k]])),
            title: displayTitle(
              t,
              String(
                (t.titleProperty ? r[t.titleProperty] : null) ??
                  t.primaryKey.map((k) => r[k]).join(" · "),
              ),
            ),
            detail: [
              ...t.primaryKey.map((k) => {
                const p = allProperties(o.spec, t).find((x) => x.name === k);
                return `${p ? propertyTitle(p) : k} ${String(r[k])}`;
              }),
              ...(extra && r[extra.name] !== null && r[extra.name] !== undefined
                ? [String(r[extra.name])]
                : []),
            ].join(" · "),
          })),
        );
      } catch (e) {
        if (live) setPickError((e as Error).message);
      } finally {
        if (live) setPickBusy(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [pickType, pickQ, root, objectsFn, o.tokenRef, o.id, o.spec]);

  const byId = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown.nodes]);
  const rootId = shown.nodes.find((n) => n.depth === 0)?.id ?? null;
  const path = useMemo(
    () => (selected && pathTo ? shortestPath(shown.edges, selected, pathTo) : null),
    [selected, pathTo, shown.edges],
  );
  // What is in focus: the path, else the selected object and its neighbours.
  const focus = useMemo(() => {
    if (path) {
      return {
        nodes: new Set(path.nodes),
        edges: new Set(path.steps.map((s) => edgeKey(s.edge))),
      };
    }
    if (!selected) return null;
    const nodes = new Set([selected]);
    const edges = new Set<string>();
    for (const e of shown.edges) {
      if (e.from === selected || e.to === selected) {
        nodes.add(e.from);
        nodes.add(e.to);
        edges.add(edgeKey(e));
      }
    }
    return { nodes, edges };
  }, [path, selected, shown.edges]);

  const rfNodes = useMemo(
    (): Node<GNodeData>[] =>
      shown.nodes.map((n) => {
        // The layout places centres; React Flow places a node's corner.
        const at = positions.get(n.id) ?? { x: 0, y: 0 };
        const w = nodeWidth(displayTitle(findObjectType(o.spec, n.objectType), n.title));
        return {
          id: n.id,
          type: "obj",
          position: { x: at.x - w / 2, y: at.y - NODE_HEIGHT / 2 },
          data: {
            node: n,
            root: n.depth === 0,
            expanded: expanded.has(n.id),
            selected: n.id === selected || n.id === pathTo,
            dimmed: focus ? !focus.nodes.has(n.id) : false,
            capped: cappedBy.has(n.id),
          },
        };
      }),
    [shown.nodes, positions, expanded, selected, pathTo, focus, cappedBy, o.spec],
  );
  const rfEdges = useMemo(
    (): Edge[] =>
      shown.edges.map((e) => {
        const k = edgeKey(e);
        const inFocus = focus?.edges.has(k) ?? false;
        const showLabel =
          allLabels ||
          shown.edges.length <= LABELLED_EDGES ||
          inFocus ||
          e.from === hovered ||
          e.to === hovered;
        return {
          id: k,
          source: e.from,
          target: e.to,
          label: showLabel ? e.label : undefined,
          ariaLabel: `${e.label}: ${e.from} to ${e.to}`,
          type: "straight",
          style: {
            strokeWidth: inFocus ? 2.2 : 1.2,
            stroke: inFocus ? "var(--primary)" : undefined,
            opacity: focus && !inFocus ? 0.2 : 1,
          },
          labelStyle: { fontSize: 10, fontWeight: inFocus ? 600 : 400 },
          labelBgStyle: { fill: "var(--card)" },
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        };
      }),
    [shown.edges, focus, hovered, allLabels],
  );

  const titleFor = (id: string) => {
    const n = byId.get(id);
    return n ? displayTitle(findObjectType(o.spec, n.objectType), n.title) : id;
  };
  const targetOf = (id: string): Target | null => {
    const n = byId.get(id);
    return n ? { objectType: n.objectType, key: n.key } : null;
  };
  const expand = (id: string, depth = 1) => {
    const t = targetOf(id);
    if (t) void walk(t, { reset: false, depth });
  };
  const hide = (id: string) => {
    if (!rootId) return;
    const next = hideNode(shownRef.current, id, rootId);
    shownRef.current = next;
    setShown(next);
    setSelected(null);
    setPathTo(null);
  };

  if (!root) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 rounded-xl border border-border bg-card p-6">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Network className="h-4 w-4 text-primary" /> Start from an object
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick one object; the graph shows what it links to, as many steps out as you choose, and
            grows from any object you expand.
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
        <ul className="divide-y divide-border rounded-lg border border-border" aria-busy={pickBusy}>
          {candidates.map((c, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setRoot({ objectType: pickType, key: c.key })}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                <span className="truncate">{c.title}</span>
                <span className="shrink-0 truncate text-xs text-muted-foreground">{c.detail}</span>
              </button>
            </li>
          ))}
          {pickError ? (
            <li className="px-3 py-4 text-sm text-destructive">{pickError}</li>
          ) : !candidates.length ? (
            <li className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              {pickBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading
                </>
              ) : (
                "No objects"
              )}
            </li>
          ) : null}
        </ul>
      </div>
    );
  }

  const sel = selected ? byId.get(selected) : undefined;
  const selType = sel ? findObjectType(o.spec, sel.objectType) : undefined;
  const rels = sel ? relationshipsOf(shown.edges, sel.id) : [];
  const types = [...new Set(shown.nodes.map((n) => n.objectType))]
    .map((name) => ({
      t: findObjectType(o.spec, name),
      name,
      n: shown.nodes.filter((x) => x.objectType === name).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cappedNames = [...cappedBy.entries()].slice(0, 4);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="outline" onClick={() => setRoot(null)}>
          Start from another object
        </Button>
        <div
          className="flex items-center rounded-md border border-border"
          role="group"
          aria-label="Steps out"
        >
          <span className="px-2 text-xs text-muted-foreground">Steps out</span>
          {Array.from({ length: GRAPH_MAX_DEPTH }, (_, i) => i + 1).map((d) => (
            <button
              key={d}
              type="button"
              disabled={busy}
              aria-pressed={steps === d}
              onClick={() => {
                setSteps(d);
                if (root) void walk(root, { reset: true, depth: d });
              }}
              className={cn(
                "h-8 w-8 border-l border-border text-xs tabular-nums transition-colors",
                steps === d ? "bg-primary text-primary-foreground" : "hover:bg-muted/50",
              )}
            >
              {d}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant={allLabels ? "secondary" : "outline"}
          onClick={() => setAllLabels((v) => !v)}
          aria-pressed={allLabels}
        >
          <Tags className="mr-1 h-3.5 w-3.5" /> All labels
        </Button>
        <Button size="sm" variant="outline" onClick={() => setFitKey((k) => k + 1)}>
          <Maximize className="mr-1 h-3.5 w-3.5" /> Fit
        </Button>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="text-xs text-muted-foreground">
          {shown.nodes.length} objects · {shown.edges.length} links. Click an object for its
          relationships, double-click to expand it, Shift-click another for the path between them.
        </span>
      </div>
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
          {error}
        </p>
      )}
      {(cappedNames.length > 0 || skipped.length > 0) && (
        <div className="space-y-1 text-xs">
          {cappedNames.length > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              <Info className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
              More linked objects than shown (8 per link):{" "}
              {cappedNames.map(([id, labels], i) => (
                <span key={id}>
                  {i > 0 ? "; " : ""}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => setSelected(id)}
                  >
                    {titleFor(id)}
                  </button>{" "}
                  ({labels.join(", ")})
                </span>
              ))}
              {cappedBy.size > cappedNames.length
                ? `; ${cappedBy.size - cappedNames.length} more`
                : ""}
              . Open an object to page through all of them.
            </p>
          )}
          {skipped.map((s) => (
            <p key={s.link} className="text-destructive">
              Could not follow {s.label}: {s.error}
            </p>
          ))}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div
          className="relative h-[min(72vh,760px)] min-h-[440px] overflow-hidden rounded-xl border border-border bg-background"
          onWheel={noteWheel}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(ev, n) => {
              if (ev.shiftKey && selected && selected !== n.id) setPathTo(n.id);
              else {
                setSelected(n.id);
                setPathTo(null);
              }
            }}
            onNodeDoubleClick={(_, n) => expand(n.id)}
            onPaneClick={() => {
              setSelected(null);
              setPathTo(null);
            }}
            onNodeMouseEnter={(_, n) => setHovered(n.id)}
            onNodeMouseLeave={() => setHovered(null)}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <FitOnGrow count={shown.nodes.length} fitKey={fitKey} />
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>

          {/* What each colour is, and how many of each are shown. */}
          <div className="pointer-events-none absolute bottom-3 right-3 flex max-w-[60%] flex-wrap justify-end gap-1.5">
            {types.map(({ t, name, n }) => {
              const tone = toneOf(t);
              const Icon = iconOf(t);
              return (
                <span
                  key={name}
                  className={cn(
                    "flex items-center gap-1 rounded-full border bg-card/90 px-2 py-0.5 text-[11px]",
                    tone.ring,
                  )}
                >
                  <Icon className={cn("h-3 w-3", tone.ink)} />
                  {t ? (n === 1 ? titleOf(t) : pluralTitleOf(t)) : name}
                  <span className="tabular-nums text-muted-foreground">{n}</span>
                </span>
              );
            })}
          </div>

          {wheelHint && (
            <p className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-full bg-foreground/80 px-3 py-1 text-xs text-background">
              Ctrl + scroll, or pinch, to zoom
            </p>
          )}
        </div>

        <aside
          className="space-y-3 overflow-y-auto rounded-xl border border-border bg-card p-3 text-sm lg:h-[min(72vh,760px)] lg:min-h-[440px]"
          aria-label={sel ? "Selected object" : "Reading the graph"}
        >
          {sel ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{displayTitle(selType, sel.title)}</p>
                  <p className="text-xs text-muted-foreground">
                    {selType ? titleOf(selType) : sel.objectType} ·{" "}
                    {sel.depth === 0
                      ? "where the graph starts"
                      : `${sel.depth} step${sel.depth === 1 ? "" : "s"} from ${rootId ? titleFor(rootId) : "the start"}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setPathTo(null);
                  }}
                  aria-label="Clear selection"
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" disabled={busy} onClick={() => expand(sel.id)}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {expanded.has(sel.id) ? "Expand again" : "Expand"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => expand(sel.id, 2)}
                >
                  2 steps
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen(targetOf(sel.id))}
                  aria-label="Open the object"
                >
                  <PanelRightOpen className="mr-1 h-3.5 w-3.5" /> Open
                </Button>
                {sel.depth > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRoot(targetOf(sel.id))}
                    >
                      <Crosshair className="mr-1 h-3.5 w-3.5" /> Start here
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => hide(sel.id)}>
                      <EyeOff className="mr-1 h-3.5 w-3.5" /> Hide
                    </Button>
                  </>
                )}
              </div>

              {path ? (
                <section className="space-y-1.5">
                  <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Route className="h-3.5 w-3.5" /> Path, {path.steps.length} link
                    {path.steps.length === 1 ? "" : "s"}
                  </h3>
                  <ol className="space-y-1 text-xs">
                    <li className="font-medium">{titleFor(path.nodes[0])}</li>
                    {path.steps.map((s, i) => (
                      <li key={i} className="space-y-1">
                        {/* Read in the direction of the walk: a customer's
                          "orders", then an order's "contains". */}
                        <span className="flex items-center gap-1 pl-2 text-muted-foreground">
                          <ArrowRight className="h-3 w-3" />
                          {s.forward ? s.edge.label : s.edge.inverseLabel}
                        </span>
                        <span className="block font-medium">{titleFor(path.nodes[i + 1])}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : pathTo ? (
                <p className="text-xs text-muted-foreground">
                  No path between {titleFor(sel.id)} and {titleFor(pathTo)} among the objects shown.
                  Expand more of the graph to find one.
                </p>
              ) : (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Relationships shown
                  </h3>
                  {rels.length ? (
                    rels.map((r) => (
                      <div key={`${r.link}|${r.outgoing}`} className="space-y-0.5">
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <ArrowRight className="h-3 w-3" />
                          <span className="font-medium text-foreground">{r.label}</span>
                          <span className="tabular-nums">· {r.others.length}</span>
                        </p>
                        <ul className="pl-4 text-xs">
                          {r.others.slice(0, 6).map((id) => (
                            <li key={id}>
                              <button
                                type="button"
                                className="truncate text-left hover:underline"
                                onClick={() => setSelected(id)}
                              >
                                {titleFor(id)}
                              </button>
                            </li>
                          ))}
                          {r.others.length > 6 && (
                            <li className="text-muted-foreground">
                              and {r.others.length - 6} more
                            </li>
                          )}
                        </ul>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      None shown yet. Expand it to see what it links to.
                    </p>
                  )}
                  {cappedBy.has(sel.id) && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      More than shown over {cappedBy.get(sel.id)!.join(", ")}: open it to page
                      through every linked object.
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Each link is named as it reads from this object; on the canvas, an arrow points
                    the way it reads forward (an order is placed by a customer). Shift-click another
                    object for the path between them.
                  </p>
                </section>
              )}
            </>
          ) : (
            <GraphHelp />
          )}
        </aside>
      </div>
      <ObjectPanel target={open} onClose={() => setOpen(null)} onNavigate={setOpen} />
    </div>
  );
}
