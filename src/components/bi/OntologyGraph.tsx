// Renderer for the ONTOLOGY visual — an interactive, multi-layer knowledge
// map of the data estate. Pure SVG (no foreignObject) so html2canvas/PDF
// export and both themes keep working; positions come from a d3-force
// simulation run synchronously (fixed ticks → deterministic, no jank).
//
// Two levels of detail:
//   collapsed — compact entity cards (name, source, counts) with typed,
//               labelled edges between entities;
//   expanded  — drill into any card (the ⊞ control or "Expand all"): tables
//               unfold into their field list (key markers, semantic-type
//               chips), knowledge bases unfold into their documents, and
//               join edges re-anchor to the exact key field row on each
//               side, ER-diagram style. The layout reflows around expanded
//               cards.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Scan,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  OntologyCategory,
  OntologyEntity,
  OntologyRelation,
  OntologySpec,
} from "@/lib/biOntology";

// Tableau-10 hexes — consistent with the chart palette, fixed across themes.
const DOMAIN_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#b07aa1",
  "#76b7b2",
  "#e15759",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

const CATEGORY_META: Record<OntologyCategory, { color: string; label: string; glyph: string }> = {
  master: { color: "#4e79a7", label: "Master data", glyph: "M" },
  transaction: { color: "#e15759", label: "Transactions", glyph: "T" },
  event: { color: "#f28e2b", label: "Events", glyph: "E" },
  reference: { color: "#76b7b2", label: "Reference", glyph: "R" },
  metric: { color: "#59a14f", label: "Metrics", glyph: "Σ" },
  document: { color: "#b07aa1", label: "Documents", glyph: "D" },
  concept: { color: "#0ea5e9", label: "Concepts", glyph: "◆" },
};

const EDGE_META: Record<OntologyRelation["kind"], { color: string; dash?: string; label: string }> =
  {
    join: { color: "#4e79a7", label: "Join key" },
    lineage: { color: "#9c755f", dash: "2 3", label: "Prep lineage" },
    semantic: { color: "#d97706", dash: "6 4", label: "AI-inferred" },
    knowledge: { color: "#0ea5e9", dash: "1 3", label: "Knowledge triple" },
  };

/** SUBJECT —predicate→ OBJECT wording for a relation (SPO triple). */
function predicateOf(rel: OntologyRelation): string {
  return rel.predicate || rel.label.toLowerCase().replace(/\s+/g, "_");
}

/** Field-chip tint by semantic tag (falls back to the raw type). */
const FIELD_TAG_COLORS: Record<string, string> = {
  location: "#76b7b2",
  currency: "#59a14f",
  percent: "#59a14f",
  number: "#59a14f",
  category: "#b07aa1",
  date: "#f28e2b",
  datetime: "#f28e2b",
  id: "#4e79a7",
  identifier: "#4e79a7",
  boolean: "#9c755f",
  document: "#b07aa1",
};

const CARD_W = 168;
const CARD_H = 64;
const XCARD_W = 238; // expanded card width
const XHEADER_H = 56; // header zone inside an expanded card
const ROW_H = 15; // one field/document row
const MAX_ROWS = 24;

type Node = SimulationNodeDatum & { id: string; entity: OntologyEntity; w: number; h: number };
type LayoutEdge = {
  rel: OntologyRelation;
  mx: number;
  my: number;
  path: string;
};

function nodeDims(e: OntologyEntity, expanded: boolean): { w: number; h: number } {
  // Concepts render as compact knowledge-graph pills, not table cards.
  if (e.sourceKind === "concept") {
    return { w: Math.max(84, Math.min(150, e.name.length * 6.6 + 34)), h: 32 };
  }
  const rows = Math.min(e.fields.length, MAX_ROWS);
  if (!expanded || rows === 0) return { w: CARD_W, h: CARD_H };
  return { w: XCARD_W, h: XHEADER_H + 8 + rows * ROW_H + 8 };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtCount(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Point where the segment from n's centre towards `other` leaves n's card. */
function rectAnchor(n: Node, other: Node): { x: number; y: number } {
  const dx = other.x! - n.x!;
  const dy = other.y! - n.y!;
  if (dx === 0 && dy === 0) return { x: n.x!, y: n.y! };
  const sx = dx === 0 ? Infinity : n.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : n.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: n.x! + dx * s, y: n.y! + dy * s };
}

/** Row index of a key field on an expanded card (−1 when not shown). */
function fieldRowIndex(e: OntologyEntity, key: string): number {
  return e.fields.slice(0, MAX_ROWS).findIndex((f) => f.name.toLowerCase() === key.toLowerCase());
}

/** Edge endpoint — the key field's row on expanded cards, card border otherwise. */
function anchorFor(
  n: Node,
  other: Node,
  key: string | undefined,
  expanded: Set<string>,
): { x: number; y: number } {
  if (key && expanded.has(n.id)) {
    const idx = fieldRowIndex(n.entity, key);
    if (idx >= 0) {
      const side = (other.x ?? 0) >= (n.x ?? 0) ? 1 : -1;
      return {
        x: n.x! + (side * n.w) / 2,
        y: n.y! - n.h / 2 + XHEADER_H + 8 + idx * ROW_H + ROW_H / 2,
      };
    }
  }
  return rectAnchor(n, other);
}

function computeLayout(spec: OntologySpec, expanded: Set<string>) {
  const ids = new Set(spec.entities.map((e) => e.id));
  const relations = spec.relations.filter((r) => ids.has(r.from) && ids.has(r.to));

  // Domain cluster centres on a grid sized to the domain count.
  const domains = spec.domains.length > 0 ? spec.domains : ["General"];
  const cols = Math.max(1, Math.ceil(Math.sqrt(domains.length)));
  const centers = new Map<string, { x: number; y: number }>();
  domains.forEach((d, i) => {
    centers.set(d, { x: (i % cols) * 470, y: Math.floor(i / cols) * 380 });
  });
  const centerOf = (domain: string) => centers.get(domain) ?? { x: 0, y: 0 };

  const nodes: Node[] = spec.entities.map((e, i) => {
    const c = centerOf(e.domain);
    const { w, h } = nodeDims(e, expanded.has(e.id));
    // Deterministic ring seed around the domain centre (golden angle).
    const angle = (i * 2.399963) % (Math.PI * 2);
    return {
      id: e.id,
      entity: e,
      w,
      h,
      x: c.x + Math.cos(angle) * 60,
      y: c.y + Math.sin(angle) * 60,
    };
  });
  const links: (SimulationLinkDatum<Node> & { rel: OntologyRelation })[] = relations.map((r) => ({
    source: r.from,
    target: r.to,
    rel: r,
  }));

  const sim = forceSimulation(nodes)
    .force(
      "link",
      forceLink<Node, SimulationLinkDatum<Node>>(links)
        .id((n) => n.id)
        .distance((l) => {
          const s = l.source as Node;
          const t = l.target as Node;
          return 120 + (s.w + t.w) / 2 + (s.h + t.h) / 4;
        })
        .strength(0.3),
    )
    .force("charge", forceManyBody().strength(-520))
    .force(
      "collide",
      forceCollide<Node>((n) => Math.hypot(n.w, n.h) / 2 + 14),
    )
    .force("x", forceX<Node>((n) => centerOf(n.entity.domain).x).strength(0.16))
    .force("y", forceY<Node>((n) => centerOf(n.entity.domain).y).strength(0.16))
    .stop();
  for (let i = 0; i < 260; i++) sim.tick();

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = relations.map((r) => {
    const a = nodeById.get(r.from)!;
    const b = nodeById.get(r.to)!;
    const p1 = anchorFor(a, b, r.keys?.from, expanded);
    const p2 = anchorFor(b, a, r.keys?.to, expanded);
    // Slight perpendicular bow so parallel edges and labels don't overlap.
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(34, len * 0.14);
    const cx = mx - (dy / len) * bow;
    const cy = my + (dx / len) * bow;
    return {
      rel: r,
      mx: 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x,
      my: 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y,
      path: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`,
    };
  });

  // Domain hulls: padded bounding box of member cards.
  const hulls = domains
    .map((d, i) => {
      const members = nodes.filter((n) => n.entity.domain === d);
      if (members.length === 0) return null;
      const minX = Math.min(...members.map((n) => n.x! - n.w / 2)) - 26;
      const maxX = Math.max(...members.map((n) => n.x! + n.w / 2)) + 26;
      const minY = Math.min(...members.map((n) => n.y! - n.h / 2)) - 34;
      const maxY = Math.max(...members.map((n) => n.y! + n.h / 2)) + 22;
      return {
        domain: d,
        color: DOMAIN_COLORS[i % DOMAIN_COLORS.length],
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
        count: members.length,
      };
    })
    .filter((h): h is NonNullable<typeof h> => h !== null);

  const allX = [...nodes.map((n) => n.x! - n.w / 2), ...hulls.map((h) => h.x)];
  const allX2 = [...nodes.map((n) => n.x! + n.w / 2), ...hulls.map((h) => h.x + h.w)];
  const allY = [...nodes.map((n) => n.y! - n.h / 2), ...hulls.map((h) => h.y)];
  const allY2 = [...nodes.map((n) => n.y! + n.h / 2), ...hulls.map((h) => h.y + h.h)];
  const bbox =
    nodes.length > 0
      ? {
          x: Math.min(...allX),
          y: Math.min(...allY),
          w: Math.max(...allX2) - Math.min(...allX),
          h: Math.max(...allY2) - Math.min(...allY),
        }
      : { x: 0, y: 0, w: 1, h: 1 };

  const neighbors = new Map<string, Set<string>>();
  for (const n of nodes) neighbors.set(n.id, new Set([n.id]));
  for (const r of relations) {
    neighbors.get(r.from)?.add(r.to);
    neighbors.get(r.to)?.add(r.from);
  }

  // Field rows that participate in a visible join — tinted on expanded cards.
  const rowTints = new Map<string, string>(); // `${entityId}|${lower(field)}` → color
  for (const r of relations) {
    if (!r.keys) continue;
    rowTints.set(`${r.from}|${r.keys.from.toLowerCase()}`, EDGE_META[r.kind].color);
    rowTints.set(`${r.to}|${r.keys.to.toLowerCase()}`, EDGE_META[r.kind].color);
  }

  return { nodes, edges, hulls, bbox, neighbors, rowTints };
}

export function OntologyGraph({
  spec,
  large = false,
  fill = false,
}: {
  spec: OntologySpec;
  large?: boolean;
  fill?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [active, setActive] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [activeEdge, setActiveEdge] = useState<number | null>(null);
  // Edges are click-to-pin like nodes, so the SPO triple panel stays open
  // for inspection (hover alone is useless on touch and for reading).
  const [pinnedEdge, setPinnedEdge] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isFull, setIsFull] = useState(false);
  const dragRef = useRef<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  const layout = useMemo(() => computeLayout(spec, expanded), [spec, expanded]);

  const expandableIds = useMemo(
    () => spec.entities.filter((e) => e.fields.length > 0).map((e) => e.id),
    [spec.entities],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Measure synchronously so the first paint (and html2canvas clones)
    // never waits on an observer callback; the observer tracks resizes.
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // isFull is a dependency because entering fullscreen PORTALS this subtree
    // to document.body: React builds new DOM nodes, so an observer bound with
    // [] would keep watching the old, now-detached element — which reports
    // 0x0 — and the canvas would render nothing at all. Re-running rebinds it
    // to the node that is actually on screen.
  }, [isFull]);

  const fit = useMemo(() => {
    if (size.w === 0 || size.h === 0) return { x: 0, y: 0, k: 1 };
    const pad = 24;
    const k = Math.min(
      (size.w - pad * 2) / layout.bbox.w,
      (size.h - pad * 2) / layout.bbox.h,
      1.05,
    );
    return {
      k,
      x: (size.w - layout.bbox.w * k) / 2 - layout.bbox.x * k,
      y: (size.h - layout.bbox.h * k) / 2 - layout.bbox.y * k,
    };
  }, [size, layout.bbox]);

  // Re-fit whenever the container size, the spec or the drill level changes.
  useEffect(() => setView(fit), [fit]);

  // Esc leaves fullscreen. Without it the only way out is the button, which is
  // not where anyone looks first — every other fullscreen surface on the web
  // exits on Esc.
  useEffect(() => {
    if (!isFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFull]);

  const focusId = pinned ?? active;
  const hood = focusId ? layout.neighbors.get(focusId) : null;
  const pinnedRel = pinnedEdge !== null ? layout.edges[pinnedEdge]?.rel : null;
  const dimNode = (id: string) =>
    pinnedRel ? !(pinnedRel.from === id || pinnedRel.to === id) : hood ? !hood.has(id) : false;
  const dimEdge = (r: OntologyRelation, i: number) =>
    pinnedEdge !== null
      ? i !== pinnedEdge
      : hood
        ? !(focusId === r.from || focusId === r.to)
        : false;

  const zoomBy = (f: number) =>
    setView((v) => {
      const k = Math.max(0.15, Math.min(3, v.k * f));
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allExpanded = expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id));

  const focused = focusId ? layout.nodes.find((n) => n.id === focusId) : null;
  const sources = useMemo(() => new Set(spec.entities.map((e) => e.source)), [spec.entities]);
  const usedCategories = useMemo(
    () => [...new Set(spec.entities.map((e) => e.category))],
    [spec.entities],
  );
  const usedKinds = useMemo(
    () => [...new Set(layout.edges.map((e) => e.rel.kind))],
    [layout.edges],
  );

  const heightClass = fill ? "h-full" : large ? "h-[60vh]" : "h-64";

  if (spec.entities.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-xs text-muted-foreground",
          heightClass,
        )}
      >
        The ontology has no entities — rebuild it after connecting data.
      </div>
    );
  }

  const tree = (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        // An overlay rather than the Fullscreen API: this graph also renders
        // inside embedded dashboards in an iframe, where requestFullscreen
        // needs an allowfullscreen attribute on a host page we do not control.
        isFull ? "fixed inset-0 z-50 h-auto bg-background p-4 shadow-2xl" : heightClass,
      )}
    >
      {/* Summary strip */}
      <div className="flex shrink-0 items-start justify-between gap-3 px-1 pb-1.5">
        <p
          className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground"
          title={spec.summary}
        >
          {spec.summary}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant="outline" className="h-4 px-1.5 text-[9px] tabular-nums">
            {spec.entities.length} entities
          </Badge>
          <Badge variant="outline" className="h-4 px-1.5 text-[9px] tabular-nums">
            {layout.edges.length} links
          </Badge>
          <Badge variant="outline" className="h-4 px-1.5 text-[9px] tabular-nums">
            {sources.size} sources
          </Badge>
          {spec.aiEnriched && (
            <Badge className="h-4 bg-primary/10 px-1.5 text-[9px] text-primary hover:bg-primary/10">
              AI-built
            </Badge>
          )}
        </div>
      </div>
      {spec.notes.length > 0 && (
        <p className="shrink-0 px-1 pb-1 text-[10px] text-amber-600 dark:text-amber-400">
          {spec.notes.join(" ")}
        </p>
      )}

      {/* Canvas */}
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-muted/20"
      >
        {size.w > 0 && (
          <svg
            width={size.w}
            height={size.h}
            className="block cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerDown={(e) => {
              // No capture yet — capturing on pointerdown retargets the
              // pointerup away from cards, which kills click-to-pin and the
              // drill-in toggles. Capture starts once a real drag moves.
              dragRef.current = {
                x: e.clientX,
                y: e.clientY,
                vx: view.x,
                vy: view.y,
                moved: false,
                pointerId: e.pointerId,
              };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
                d.moved = true;
                (e.currentTarget as SVGSVGElement).setPointerCapture(d.pointerId);
              }
              if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
            }}
            onPointerUp={() => {
              const d = dragRef.current;
              dragRef.current = null;
              if (d && !d.moved) {
                setPinned(null); // background click unpins
                setPinnedEdge(null);
              }
            }}
          >
            <defs>
              {Object.entries(EDGE_META).map(([kind, m]) => (
                <marker
                  key={kind}
                  id={`onto-arrow-${kind}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={m.color} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* Domain hulls */}
              {layout.hulls.map((h) => (
                <g key={h.domain} opacity={hood ? 0.5 : 1}>
                  <rect
                    x={h.x}
                    y={h.y}
                    width={h.w}
                    height={h.h}
                    rx={20}
                    fill={h.color}
                    fillOpacity={0.06}
                    stroke={h.color}
                    strokeOpacity={0.28}
                    strokeWidth={1.2}
                  />
                  <text
                    x={h.x + 14}
                    y={h.y + 18}
                    fontSize={11}
                    fontWeight={700}
                    fill={h.color}
                    style={{ letterSpacing: "0.08em", textTransform: "uppercase" }}
                  >
                    {h.domain}
                  </text>
                  <text x={h.x + 14} y={h.y + 30} fontSize={8.5} fill={h.color} fillOpacity={0.75}>
                    {h.count} entit{h.count === 1 ? "y" : "ies"}
                  </text>
                </g>
              ))}

              {/* Edges — each one is a subject —predicate→ object triple;
                  click to pin it and read the full SPO detail panel. */}
              {layout.edges.map((e, i) => {
                const m = EDGE_META[e.rel.kind] ?? EDGE_META.semantic;
                const dim = dimEdge(e.rel, i);
                const parts = [predicateOf(e.rel)];
                if (e.rel.keys) parts.push(e.rel.keys.from);
                if (e.rel.cardinality) parts.push(e.rel.cardinality);
                const labelText = truncate(parts.join(" · "), 34);
                const lw = labelText.length * 4.6 + 10;
                const isActive = activeEdge === i || pinnedEdge === i;
                return (
                  <g
                    key={i}
                    className="cursor-pointer"
                    opacity={dim ? 0.12 : e.rel.confidence === "high" || isActive ? 1 : 0.8}
                    onPointerEnter={() => setActiveEdge(i)}
                    onPointerLeave={() => setActiveEdge((cur) => (cur === i ? null : cur))}
                    onPointerUp={(ev) => {
                      if (dragRef.current?.moved) return;
                      ev.stopPropagation();
                      dragRef.current = null;
                      setPinned(null);
                      setPinnedEdge((cur) => (cur === i ? null : i));
                    }}
                  >
                    {/* Wide invisible stroke so the thin edge is hover/clickable */}
                    <path d={e.path} fill="none" stroke="transparent" strokeWidth={14} />
                    <path
                      d={e.path}
                      fill="none"
                      stroke={m.color}
                      strokeWidth={isActive ? 2.2 : 1.4}
                      strokeDasharray={m.dash}
                      markerEnd={`url(#onto-arrow-${e.rel.kind})`}
                    />
                    {!dim && (
                      <g transform={`translate(${e.mx} ${e.my})`}>
                        <rect
                          x={-lw / 2}
                          y={-8}
                          width={lw}
                          height={15}
                          rx={7.5}
                          fill="var(--card)"
                          stroke={pinnedEdge === i ? m.color : "var(--border)"}
                          strokeWidth={pinnedEdge === i ? 1.2 : 0.8}
                        />
                        <text
                          textAnchor="middle"
                          y={3.5}
                          fontSize={8.5}
                          fill="var(--muted-foreground)"
                          style={{ fontFamily: "ui-monospace, monospace" }}
                        >
                          {labelText}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Entity cards */}
              {layout.nodes.map((n) => {
                const e = n.entity;
                const cat = CATEGORY_META[e.category] ?? CATEGORY_META.master;
                const isFocus = focusId === n.id;
                const isOpen = expanded.has(n.id);
                const rows = isOpen ? e.fields.slice(0, MAX_ROWS) : [];
                const left = n.x! - n.w / 2;
                const top = n.y! - n.h / 2;
                const isKb = e.sourceKind === "knowledge";
                // Concepts (knowledge-graph entities) render as compact pills —
                // visually a knowledge graph layer over the table cards.
                if (e.sourceKind === "concept") {
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${left} ${top})`}
                      opacity={dimNode(n.id) ? 0.18 : 1}
                      className="cursor-pointer"
                      onPointerEnter={() => setActive(n.id)}
                      onPointerLeave={() => setActive(null)}
                      onPointerUp={(ev) => {
                        if (dragRef.current?.moved) return;
                        ev.stopPropagation();
                        dragRef.current = null;
                        setPinnedEdge(null);
                        setPinned((p) => (p === n.id ? null : n.id));
                      }}
                    >
                      <rect
                        width={n.w}
                        height={n.h}
                        rx={n.h / 2}
                        fill="var(--card)"
                        stroke={isFocus ? cat.color : "var(--border)"}
                        strokeWidth={isFocus ? 1.8 : 1}
                        style={{ filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.12))" }}
                      />
                      <circle cx={15} cy={n.h / 2} r={4.5} fill={cat.color} fillOpacity={0.9} />
                      <text
                        x={25}
                        y={n.h / 2 + 3.5}
                        fontSize={10}
                        fontWeight={600}
                        fill="var(--foreground)"
                      >
                        {truncate(e.name, 18)}
                      </text>
                      {e.conceptType && (
                        <text
                          x={25}
                          y={n.h - 4}
                          fontSize={6.5}
                          fill={cat.color}
                          style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}
                        >
                          {truncate(e.conceptType, 20)}
                        </text>
                      )}
                    </g>
                  );
                }
                return (
                  <g
                    key={n.id}
                    transform={`translate(${left} ${top})`}
                    opacity={dimNode(n.id) ? 0.18 : 1}
                    className="cursor-pointer"
                    onPointerEnter={() => setActive(n.id)}
                    onPointerLeave={() => setActive(null)}
                    onPointerUp={(ev) => {
                      if (dragRef.current?.moved) return;
                      ev.stopPropagation();
                      dragRef.current = null;
                      setPinnedEdge(null);
                      setPinned((p) => (p === n.id ? null : n.id));
                    }}
                  >
                    <rect
                      width={n.w}
                      height={n.h}
                      rx={10}
                      fill="var(--card)"
                      stroke={isFocus ? cat.color : "var(--border)"}
                      strokeWidth={isFocus ? 1.8 : 1}
                      style={{ filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.12))" }}
                    />
                    <rect x={0} y={6} width={3.5} height={n.h - 12} rx={1.75} fill={cat.color} />
                    {/* Category glyph disc */}
                    <circle cx={19} cy={17} r={8.5} fill={cat.color} fillOpacity={0.15} />
                    <text
                      x={19}
                      y={20.5}
                      textAnchor="middle"
                      fontSize={9.5}
                      fontWeight={700}
                      fill={cat.color}
                    >
                      {cat.glyph}
                    </text>
                    <text x={33} y={16} fontSize={11} fontWeight={600} fill="var(--foreground)">
                      {truncate(e.name, isOpen ? 26 : 18)}
                    </text>
                    <text
                      x={33}
                      y={27.5}
                      fontSize={8}
                      fill="var(--muted-foreground)"
                      style={{ fontFamily: "ui-monospace, monospace" }}
                    >
                      {truncate(e.table, isOpen ? 38 : 26)}
                    </text>
                    {/* Source badge + counts */}
                    <rect
                      x={11}
                      y={37}
                      width={e.source.length * 4.4 + 10}
                      height={13}
                      rx={6.5}
                      fill="var(--muted)"
                    />
                    <text
                      x={16}
                      y={46.5}
                      fontSize={7.5}
                      fontWeight={600}
                      fill="var(--muted-foreground)"
                    >
                      {e.source}
                    </text>
                    <text
                      x={e.source.length * 4.4 + 27}
                      y={46.5}
                      fontSize={8}
                      fill="var(--muted-foreground)"
                    >
                      {isKb
                        ? `${fmtCount(e.rowCount)} docs`
                        : `${fmtCount(e.rowCount)} rows · ${e.columnCount} cols`}
                    </text>

                    {/* Drill-in toggle (only when there is something inside) */}
                    {e.fields.length > 0 && (
                      <g
                        transform={`translate(${n.w - 20} 7)`}
                        onPointerUp={(ev) => {
                          ev.stopPropagation();
                          dragRef.current = null;
                          toggleExpand(n.id);
                        }}
                      >
                        <title>{isOpen ? "Collapse" : "Drill in"}</title>
                        <rect
                          width={13}
                          height={13}
                          rx={3.5}
                          fill="var(--muted)"
                          stroke="var(--border)"
                          strokeWidth={0.8}
                        />
                        <line
                          x1={3.5}
                          y1={6.5}
                          x2={9.5}
                          y2={6.5}
                          stroke="var(--muted-foreground)"
                          strokeWidth={1.3}
                          strokeLinecap="round"
                        />
                        {!isOpen && (
                          <line
                            x1={6.5}
                            y1={3.5}
                            x2={6.5}
                            y2={9.5}
                            stroke="var(--muted-foreground)"
                            strokeWidth={1.3}
                            strokeLinecap="round"
                          />
                        )}
                      </g>
                    )}

                    {/* Expanded: field / document rows */}
                    {isOpen && rows.length > 0 && (
                      <g>
                        <line
                          x1={8}
                          y1={XHEADER_H}
                          x2={n.w - 8}
                          y2={XHEADER_H}
                          stroke="var(--border)"
                          strokeWidth={1}
                        />
                        {rows.map((f, ri) => {
                          const y = XHEADER_H + 8 + ri * ROW_H;
                          const isKey = e.keyColumns.includes(f.name);
                          const tint = layout.rowTints.get(`${n.id}|${f.name.toLowerCase()}`);
                          const tag = f.semantic ?? f.type;
                          const tagColor = FIELD_TAG_COLORS[tag] ?? "var(--muted-foreground)";
                          return (
                            <g key={f.name + ri} transform={`translate(0 ${y})`}>
                              {tint && (
                                <rect
                                  x={6}
                                  y={0.5}
                                  width={n.w - 12}
                                  height={ROW_H - 1}
                                  rx={4}
                                  fill={tint}
                                  fillOpacity={0.1}
                                />
                              )}
                              {isKey ? (
                                <circle cx={16} cy={ROW_H / 2} r={2.6} fill="#eab308" />
                              ) : (
                                <circle
                                  cx={16}
                                  cy={ROW_H / 2}
                                  r={1.6}
                                  fill="var(--muted-foreground)"
                                  fillOpacity={0.5}
                                />
                              )}
                              <text
                                x={24}
                                y={ROW_H / 2 + 3}
                                fontSize={8.5}
                                fill="var(--foreground)"
                                style={{ fontFamily: isKb ? undefined : "ui-monospace, monospace" }}
                              >
                                {truncate(f.name, isKb ? 32 : 22)}
                              </text>
                              <text
                                x={n.w - 10}
                                y={ROW_H / 2 + 3}
                                textAnchor="end"
                                fontSize={7.5}
                                fontWeight={600}
                                fill={tagColor}
                              >
                                {isKb ? "doc" : truncate(tag, 10)}
                              </text>
                            </g>
                          );
                        })}
                        {e.fields.length > MAX_ROWS && (
                          <text
                            x={24}
                            y={XHEADER_H + 8 + MAX_ROWS * ROW_H + 10}
                            fontSize={7.5}
                            fill="var(--muted-foreground)"
                          >
                            +{e.fields.length - MAX_ROWS} more
                          </text>
                        )}
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {/* Zoom + drill controls */}
        <div className="absolute right-2 top-2 flex flex-col gap-1" data-html2canvas-ignore>
          <Button
            variant="outline"
            size="icon"
            className="h-6 w-6 bg-card"
            onClick={() => zoomBy(1.3)}
            title="Zoom in"
          >
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-6 w-6 bg-card"
            onClick={() => zoomBy(1 / 1.3)}
            title="Zoom out"
          >
            <Minus className="h-3 w-3" />
          </Button>
          {/* Scan, not Maximize2: this frames the graph, it does not go
              fullscreen. The fullscreen glyph belongs to the button below, and
              having both on one control is what made this read as broken. */}
          <Button
            variant="outline"
            size="icon"
            className="h-6 w-6 bg-card"
            onClick={() => setView(fit)}
            title="Fit to view"
          >
            <Scan className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-6 w-6 bg-card"
            onClick={() => setIsFull((v) => !v)}
            title={isFull ? "Exit fullscreen (Esc)" : "Fullscreen"}
          >
            {isFull ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </Button>
          {expandableIds.length > 0 && (
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6 bg-card"
              onClick={() => setExpanded(allExpanded ? new Set() : new Set(expandableIds))}
              title={allExpanded ? "Collapse all" : "Expand all — show fields and documents"}
            >
              {allExpanded ? (
                <ChevronsDownUp className="h-3 w-3" />
              ) : (
                <ChevronsUpDown className="h-3 w-3" />
              )}
            </Button>
          )}
        </div>

        {/* Detail panel for the hovered / pinned entity — includes its triples */}
        {focused &&
          pinnedEdge === null &&
          (() => {
            const nameOf = (id: string) => layout.nodes.find((n) => n.id === id)?.entity.name ?? id;
            const triples = layout.edges
              .filter((e) => e.rel.from === focused.id || e.rel.to === focused.id)
              .slice(0, 5);
            const total = layout.edges.filter(
              (e) => e.rel.from === focused.id || e.rel.to === focused.id,
            ).length;
            const ent = focused.entity;
            return (
              <div className="pointer-events-none absolute bottom-2 left-2 z-10 w-64 rounded-lg border border-border bg-popover/95 p-2.5 shadow-lg backdrop-blur">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: (CATEGORY_META[ent.category] ?? CATEGORY_META.master).color,
                    }}
                  />
                  <span className="truncate text-xs font-semibold text-popover-foreground">
                    {ent.name}
                  </span>
                  <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                    {ent.sourceKind === "concept" && ent.conceptType
                      ? ent.conceptType
                      : (CATEGORY_META[ent.category] ?? CATEGORY_META.master).label}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                  {ent.sourceKind === "concept"
                    ? `Knowledge graph · ${ent.source}${ent.rowCount ? ` · ${ent.rowCount} mention${ent.rowCount === 1 ? "" : "s"}` : ""}`
                    : `${ent.table} · ${ent.source} · ${ent.domain}`}
                </p>
                {ent.description && (
                  <p className="mt-1 text-[10px] leading-snug text-popover-foreground/90">
                    {ent.description}
                  </p>
                )}
                {ent.keyColumns.length > 0 && (
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    Keys: <span className="font-mono">{ent.keyColumns.join(", ")}</span>
                  </p>
                )}
                {triples.length > 0 && (
                  <div className="mt-1.5 border-t border-border/60 pt-1">
                    <p className="text-[8px] uppercase tracking-wider text-muted-foreground">
                      Triples
                    </p>
                    {triples.map((e, i) => {
                      const out = e.rel.from === focused.id;
                      const other = nameOf(out ? e.rel.to : e.rel.from);
                      return (
                        <p key={i} className="truncate text-[9.5px] text-popover-foreground/90">
                          <span className="text-muted-foreground">{out ? "→" : "←"}</span>{" "}
                          <span
                            className="font-mono"
                            style={{ color: (EDGE_META[e.rel.kind] ?? EDGE_META.semantic).color }}
                          >
                            {predicateOf(e.rel)}
                          </span>{" "}
                          {other}
                        </p>
                      );
                    })}
                    {total > triples.length && (
                      <p className="text-[8.5px] text-muted-foreground">
                        +{total - triples.length} more — click edges to inspect
                      </p>
                    )}
                  </div>
                )}
                {!expanded.has(focused.id) && ent.fields.length > 0 && (
                  <p className="mt-1 text-[9px] italic text-muted-foreground/80">
                    Use the ⊞ on the card to drill into{" "}
                    {ent.sourceKind === "knowledge" ? "its documents" : "its fields"}.
                  </p>
                )}
              </div>
            );
          })()}

        {/* SPO detail panel for the clicked (pinned) or hovered relationship */}
        {(pinnedEdge !== null || !focused) &&
          (() => {
            const idx = pinnedEdge ?? activeEdge;
            if (idx === null || !layout.edges[idx]) return null;
            const rel = layout.edges[idx].rel;
            const nameOf = (id: string) => layout.nodes.find((n) => n.id === id)?.entity.name ?? id;
            const m = EDGE_META[rel.kind] ?? EDGE_META.semantic;
            return (
              <div className="pointer-events-none absolute bottom-2 left-2 z-10 w-72 rounded-lg border border-border bg-popover/95 p-2.5 shadow-lg backdrop-blur">
                {/* The triple, spelled out — subject, predicate, object */}
                <div className="grid grid-cols-[52px_1fr] gap-x-2 gap-y-0.5 text-[10px]">
                  <span className="text-[8px] uppercase tracking-wider text-muted-foreground leading-4">
                    Subject
                  </span>
                  <span className="truncate font-semibold text-popover-foreground">
                    {nameOf(rel.from)}
                  </span>
                  <span className="text-[8px] uppercase tracking-wider text-muted-foreground leading-4">
                    Predicate
                  </span>
                  <span className="truncate font-mono" style={{ color: m.color }}>
                    {predicateOf(rel)}
                  </span>
                  <span className="text-[8px] uppercase tracking-wider text-muted-foreground leading-4">
                    Object
                  </span>
                  <span className="truncate font-semibold text-popover-foreground">
                    {nameOf(rel.to)}
                  </span>
                </div>
                <p className="mt-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                  {m.label} · “{rel.label}”{rel.cardinality ? ` · ${rel.cardinality}` : ""} ·{" "}
                  {rel.confidence} confidence
                </p>
                {rel.keys && (
                  <p className="mt-1 font-mono text-[9px] text-muted-foreground">
                    {rel.keys.from} → {rel.keys.to}
                  </p>
                )}
                {rel.evidence && (
                  <p className="mt-1 text-[10px] italic leading-snug text-popover-foreground/90">
                    “{rel.evidence}”
                  </p>
                )}
                {pinnedEdge !== null && (
                  <p className="mt-1 text-[8.5px] text-muted-foreground/80">
                    Pinned — click the background to release.
                  </p>
                )}
              </div>
            );
          })()}
      </div>

      {/* Legend */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 pt-1.5">
        {usedCategories.map((c) => {
          const m = CATEGORY_META[c] ?? CATEGORY_META.master;
          return (
            <span key={c} className="flex items-center gap-1 text-[9px] text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: m.color }} />
              {m.label}
            </span>
          );
        })}
        <span className="mx-0.5 h-3 w-px bg-border" />
        {usedKinds.map((k) => {
          const m = EDGE_META[k];
          return (
            <span key={k} className="flex items-center gap-1 text-[9px] text-muted-foreground">
              <svg width="18" height="6" className="shrink-0">
                <line
                  x1="0"
                  y1="3"
                  x2="18"
                  y2="3"
                  stroke={m.color}
                  strokeWidth="1.5"
                  strokeDasharray={m.dash}
                />
              </svg>
              {m.label}
            </span>
          );
        })}
        <span className="mx-0.5 h-3 w-px bg-border" />
        <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#eab308" }} />
          Key column
        </span>
      </div>
    </div>
  );

  // Fullscreen renders through a portal on document.body. Without it the
  // overlay is trapped by the widget card's `backdrop-filter`, which — like a
  // transform — makes that card the containing block for `position: fixed`, so
  // `inset-0` sized the overlay to the card instead of the viewport.
  if (isFull && typeof document !== "undefined") {
    return createPortal(tree, document.body);
  }
  return tree;
}
