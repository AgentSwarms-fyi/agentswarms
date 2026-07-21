// Renderer for the ONTOLOGY visual — an interactive knowledge map of the
// data estate. Pure SVG (no foreignObject) so html2canvas/PDF export and
// both themes keep working; positions come from a d3-force simulation run
// synchronously (fixed ticks → deterministic, no animation jank).
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Maximize2, Minus, Plus } from "lucide-react";

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
};

const EDGE_META: Record<OntologyRelation["kind"], { color: string; dash?: string; label: string }> =
  {
    join: { color: "#4e79a7", label: "Join key" },
    lineage: { color: "#9c755f", dash: "2 3", label: "Prep lineage" },
    semantic: { color: "#d97706", dash: "6 4", label: "AI-inferred" },
  };

const CARD_W = 168;
const CARD_H = 64;

type Node = SimulationNodeDatum & { id: string; entity: OntologyEntity };
type LayoutEdge = {
  rel: OntologyRelation;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number;
  my: number;
  path: string;
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtCount(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Point where the segment from the card centre to (tx,ty) leaves the card. */
function rectAnchor(cx: number, cy: number, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : CARD_W / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : CARD_H / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function computeLayout(spec: OntologySpec) {
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
    // Deterministic ring seed around the domain centre.
    const angle = (i * 2.399963) % (Math.PI * 2); // golden angle
    return { id: e.id, entity: e, x: c.x + Math.cos(angle) * 60, y: c.y + Math.sin(angle) * 60 };
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
        .distance(235)
        .strength(0.3),
    )
    .force("charge", forceManyBody().strength(-520))
    .force("collide", forceCollide(Math.hypot(CARD_W, CARD_H) / 2 + 14))
    .force("x", forceX<Node>((n) => centerOf(n.entity.domain).x).strength(0.16))
    .force("y", forceY<Node>((n) => centerOf(n.entity.domain).y).strength(0.16))
    .stop();
  for (let i = 0; i < 260; i++) sim.tick();

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = relations.map((r) => {
    const a = nodeById.get(r.from)!;
    const b = nodeById.get(r.to)!;
    const p1 = rectAnchor(a.x!, a.y!, b.x!, b.y!);
    const p2 = rectAnchor(b.x!, b.y!, a.x!, a.y!);
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
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      mx: (mx + cx) / 2 + (mx - cx) / 2, // quadratic midpoint = 0.25*p1+0.5*c+0.25*p2
      my: (my + cy) / 2 + (my - cy) / 2,
      path: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`,
    };
  });
  // True quadratic midpoints for label placement.
  for (const e of edges) {
    const m = /M ([-\d.]+) ([-\d.]+) Q ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/.exec(e.path);
    if (m) {
      const [x1, y1, cx, cy, x2, y2] = m.slice(1).map(Number);
      e.mx = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
      e.my = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
    }
  }

  // Domain hulls: padded bounding box of member cards.
  const hulls = domains
    .map((d, i) => {
      const members = nodes.filter((n) => n.entity.domain === d);
      if (members.length === 0) return null;
      const minX = Math.min(...members.map((n) => n.x! - CARD_W / 2)) - 26;
      const maxX = Math.max(...members.map((n) => n.x! + CARD_W / 2)) + 26;
      const minY = Math.min(...members.map((n) => n.y! - CARD_H / 2)) - 34;
      const maxY = Math.max(...members.map((n) => n.y! + CARD_H / 2)) + 22;
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

  const allX = [...nodes.map((n) => n.x! - CARD_W / 2), ...hulls.map((h) => h.x)];
  const allX2 = [...nodes.map((n) => n.x! + CARD_W / 2), ...hulls.map((h) => h.x + h.w)];
  const allY = [...nodes.map((n) => n.y! - CARD_H / 2), ...hulls.map((h) => h.y)];
  const allY2 = [...nodes.map((n) => n.y! + CARD_H / 2), ...hulls.map((h) => h.y + h.h)];
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

  return { nodes, edges, hulls, bbox, neighbors };
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
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(
    null,
  );

  const layout = useMemo(() => computeLayout(spec), [spec]);

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
  }, []);

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

  // Re-fit whenever the container size or the spec changes.
  useEffect(() => setView(fit), [fit]);

  const focusId = pinned ?? active;
  const hood = focusId ? layout.neighbors.get(focusId) : null;
  const dimNode = (id: string) => (hood ? !hood.has(id) : false);
  const dimEdge = (r: OntologyRelation) =>
    hood ? !(focusId === r.from || focusId === r.to) : false;

  const zoomBy = (f: number) =>
    setView((v) => {
      const k = Math.max(0.15, Math.min(3, v.k * f));
      // Zoom around the container centre.
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });

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

  return (
    <div className={cn("flex min-h-0 flex-col", heightClass)}>
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
              (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
              dragRef.current = {
                x: e.clientX,
                y: e.clientY,
                vx: view.x,
                vy: view.y,
                moved: false,
              };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
              if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
            }}
            onPointerUp={() => {
              const d = dragRef.current;
              dragRef.current = null;
              if (d && !d.moved) setPinned(null); // background click unpins
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

              {/* Edges */}
              {layout.edges.map((e, i) => {
                const m = EDGE_META[e.rel.kind];
                const dim = dimEdge(e.rel);
                const parts = [e.rel.label];
                if (e.rel.keys) parts.push(e.rel.keys.from);
                if (e.rel.cardinality) parts.push(e.rel.cardinality);
                const labelText = truncate(parts.join(" · "), 34);
                const lw = labelText.length * 4.6 + 10;
                return (
                  <g key={i} opacity={dim ? 0.12 : e.rel.confidence === "high" ? 1 : 0.8}>
                    <path
                      d={e.path}
                      fill="none"
                      stroke={m.color}
                      strokeWidth={1.4}
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
                          stroke="var(--border)"
                          strokeWidth={0.8}
                        />
                        <text
                          textAnchor="middle"
                          y={3.5}
                          fontSize={8.5}
                          fill="var(--muted-foreground)"
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
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x! - CARD_W / 2} ${n.y! - CARD_H / 2})`}
                    opacity={dimNode(n.id) ? 0.18 : 1}
                    className="cursor-pointer"
                    onPointerEnter={() => setActive(n.id)}
                    onPointerLeave={() => setActive(null)}
                    onPointerUp={(ev) => {
                      if (dragRef.current?.moved) return;
                      ev.stopPropagation();
                      dragRef.current = null;
                      setPinned((p) => (p === n.id ? null : n.id));
                    }}
                  >
                    <rect
                      width={CARD_W}
                      height={CARD_H}
                      rx={10}
                      fill="var(--card)"
                      stroke={isFocus ? cat.color : "var(--border)"}
                      strokeWidth={isFocus ? 1.8 : 1}
                      style={{ filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.12))" }}
                    />
                    <rect x={0} y={6} width={3.5} height={CARD_H - 12} rx={1.75} fill={cat.color} />
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
                      {truncate(e.name, 18)}
                    </text>
                    <text
                      x={33}
                      y={27.5}
                      fontSize={8}
                      fill="var(--muted-foreground)"
                      style={{ fontFamily: "ui-monospace, monospace" }}
                    >
                      {truncate(e.table, 26)}
                    </text>
                    {/* Source badge */}
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
                      {e.sourceKind === "knowledge"
                        ? `${fmtCount(e.rowCount)} docs`
                        : `${fmtCount(e.rowCount)} rows · ${e.columnCount} cols`}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {/* Zoom controls */}
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
          <Button
            variant="outline"
            size="icon"
            className="h-6 w-6 bg-card"
            onClick={() => setView(fit)}
            title="Fit to view"
          >
            <Maximize2 className="h-3 w-3" />
          </Button>
        </div>

        {/* Detail panel for the hovered / pinned entity */}
        {focused && (
          <div className="pointer-events-none absolute bottom-2 left-2 z-10 w-64 rounded-lg border border-border bg-popover/95 p-2.5 shadow-lg backdrop-blur">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{
                  background: (CATEGORY_META[focused.entity.category] ?? CATEGORY_META.master)
                    .color,
                }}
              />
              <span className="truncate text-xs font-semibold text-popover-foreground">
                {focused.entity.name}
              </span>
              <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                {(CATEGORY_META[focused.entity.category] ?? CATEGORY_META.master).label}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">
              {focused.entity.table} · {focused.entity.source} · {focused.entity.domain}
            </p>
            {focused.entity.description && (
              <p className="mt-1 text-[10px] leading-snug text-popover-foreground/90">
                {focused.entity.description}
              </p>
            )}
            {focused.entity.keyColumns.length > 0 && (
              <p className="mt-1 text-[9px] text-muted-foreground">
                Keys: <span className="font-mono">{focused.entity.keyColumns.join(", ")}</span>
              </p>
            )}
            {focused.entity.fields.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                {focused.entity.fields.slice(0, 8).map((f) => (
                  <span key={f.name} className="font-mono text-[9px] text-muted-foreground">
                    {f.name}
                    <span className="text-muted-foreground/60">:{f.semantic ?? f.type}</span>
                  </span>
                ))}
                {focused.entity.fields.length > 8 && (
                  <span className="text-[9px] text-muted-foreground/60">
                    +{focused.entity.fields.length - 8} more
                  </span>
                )}
              </div>
            )}
          </div>
        )}
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
      </div>
    </div>
  );
}
