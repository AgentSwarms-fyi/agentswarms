// What the Graph tab does with a neighbourhood once it has it: where each
// object goes, how a new walk merges into what is shown, the path between two
// objects, and an object's relationships. Pure, so it is tested without a
// browser.
//
// Found from the UI (R433): the layout put every new object on a ring around
// the starting object, spread round the whole circle, so an order's lines
// landed on the far side of the customer, edges crossed through the middle,
// and expanding a second order stacked its lines exactly on top of the
// first's. Objects already drawn now stay put, new ones start beside the
// object they were reached from, and a short force simulation keeps every
// pair apart.
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

import type { GraphEdge, GraphNode } from "@/lib/ontology/graph";

export type XY = { x: number; y: number };

/** About how wide a node's pill is drawn: an icon, padding and its title. */
export function nodeWidth(title: string): number {
  return Math.min(200, 58 + title.length * 6.6);
}

/** How tall a node's pill is drawn. */
export const NODE_HEIGHT = 34;

/** Room each node keeps around its centre, wider for long titles. */
const radiusOf = (title: string) => nodeWidth(title) / 2 + 10;

/** Clear space kept between two pills. */
const GAP = 8;

const RING = 210;
const FAN = (Math.PI * 2) / 3;

type SimNode = SimulationNodeDatum & { id: string; r: number; hw: number; hh: number };

/**
 * Positions for every node. Placed ones keep theirs. A new node starts beside
 * the node it was reached from, fanned out on the side away from that node's
 * own parent (or round the whole circle from the start object), and then a
 * force simulation moves only the new nodes until nothing overlaps.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  placed: Map<string, XY>,
  // More objects take longer to settle: 240 steps for a handful, up to 600.
  ticks = Math.min(600, 200 + nodes.length * 3),
): Map<string, XY> {
  const pos = new Map<string, XY>();
  for (const n of nodes) {
    const p = placed.get(n.id);
    if (p) pos.set(n.id, p);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fresh = nodes.filter((n) => !pos.has(n.id)).sort((a, b) => a.depth - b.depth);

  // How far out each new node's fan was laid: its link to its parent keeps it.
  const ringOf = new Map<string, number>();
  // Children of each placed parent, so a parent's fan is split evenly.
  const kids = new Map<string, GraphNode[]>();
  const orphans: GraphNode[] = [];
  for (const n of fresh) {
    if (n.depth === 0 && !pos.size) {
      pos.set(n.id, { x: 0, y: 0 });
      continue;
    }
    const parent = n.parent ?? edgeNeighbour(edges, n.id, (id) => id !== n.id);
    if (parent) kids.set(parent, [...(kids.get(parent) ?? []), n]);
    else orphans.push(n);
  }
  // Objects with nothing drawn to start beside: a ring of their own.
  orphans.forEach((n, i) => {
    const a = (Math.PI * 2 * i) / Math.max(1, orphans.length);
    pos.set(n.id, { x: Math.cos(a) * RING * (n.depth + 1), y: Math.sin(a) * RING * (n.depth + 1) });
  });
  // Breadth first from the parents already placed, so a parent placed in this
  // pass seeds its own children. A parent that never gets placed (its own
  // parent is not shown) starts at the centre, once.
  const queue = [...kids.keys()].filter((k) => pos.has(k));
  const waiting = [...kids.keys()].filter((k) => !pos.has(k));
  const done = new Set<string>();
  for (let guard = 0; (queue.length || waiting.length) && guard < 10_000; guard++) {
    if (!queue.length) {
      const k = waiting.shift()!;
      if (!pos.has(k)) pos.set(k, { x: 0, y: 0 });
      queue.push(k);
    }
    const parentId = queue.shift()!;
    if (done.has(parentId) || !pos.has(parentId)) continue;
    done.add(parentId);
    const from = pos.get(parentId)!;
    const list = (kids.get(parentId) ?? []).sort(
      (a, b) => a.objectType.localeCompare(b.objectType) || a.title.localeCompare(b.title),
    );
    const grand = byId.get(parentId)?.parent;
    const g = grand ? pos.get(grand) : undefined;
    const outward =
      g && (from.x !== g.x || from.y !== g.y)
        ? Math.atan2(from.y - g.y, from.x - g.x)
        : from.x || from.y
          ? Math.atan2(from.y, from.x)
          : null;
    const spread = outward === null ? Math.PI * 2 : FAN;
    const base = outward === null ? -Math.PI / 2 : outward - spread / 2;
    // Far enough out that the fan's arc holds every child side by side.
    const arc = list.reduce((w, n) => w + 2 * radiusOf(n.title), 0);
    const ring = Math.max(RING, arc / spread);
    list.forEach((n, i) => {
      const a =
        outward === null
          ? base + (spread * i) / Math.max(1, list.length)
          : base + (spread * (i + 0.5)) / list.length;
      pos.set(n.id, { x: from.x + Math.cos(a) * ring, y: from.y + Math.sin(a) * ring });
      ringOf.set(n.id, ring);
      if (kids.has(n.id)) queue.push(n.id);
    });
  }
  for (const n of nodes) if (!pos.has(n.id)) pos.set(n.id, { x: 0, y: 0 });

  // Separate: only new nodes move, the start object never does, and each new
  // node is held near where it was seeded so the fan beside its parent
  // survives; the simulation only has to settle overlaps. Without that hold
  // the links pulled a fan in round its parent's far side (R433, measured).
  const seed = new Map(pos);
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent]));
  const sim: SimNode[] = nodes.map((n) => {
    const p = pos.get(n.id)!;
    const pinned = placed.has(n.id) || (n.depth === 0 && !placed.size);
    return {
      id: n.id,
      r: radiusOf(n.title),
      hw: nodeWidth(n.title) / 2,
      hh: NODE_HEIGHT / 2,
      x: p.x,
      y: p.y,
      ...(pinned ? { fx: p.x, fy: p.y } : {}),
    };
  });
  if (sim.some((s) => s.fx === undefined)) {
    const ids = new Set(sim.map((s) => s.id));
    const links: SimulationLinkDatum<SimNode>[] = edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ source: e.from, target: e.to }));
    const s = forceSimulation(sim)
      .force(
        "link",
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
          .id((d) => d.id)
          .distance((l) => {
            const a = l.source as SimNode;
            const b = l.target as SimNode;
            const fan =
              (parentOf.get(a.id) === b.id && ringOf.get(a.id)) ||
              (parentOf.get(b.id) === a.id && ringOf.get(b.id));
            return fan || Math.max(RING * 0.8, (a.r + b.r) * 1.1);
          })
          .strength(0.3),
      )
      .force("x", forceX<SimNode>((d) => seed.get(d.id)?.x ?? 0).strength(0.12))
      .force("y", forceY<SimNode>((d) => seed.get(d.id)?.y ?? 0).strength(0.12))
      .force("charge", forceManyBody<SimNode>().strength(-420).distanceMax(700))
      .force("collide", rectCollide())
      .stop();
    for (let i = 0; i < ticks; i++) s.tick();
  }
  return new Map(sim.map((s) => [s.id, { x: s.x ?? 0, y: s.y ?? 0 }]));
}

/**
 * Keeps pills apart as what they are, wide and short rectangles. A circle as
 * wide as a pill (d3's forceCollide) left no room between two rows of pinned
 * objects 170 apart, where a 34-pixel pill fits easily (measured). Each
 * overlapping pair is pushed apart along the axis it overlaps least. An object
 * already drawn is pinned (d3 holds it where it is), so the other takes the
 * whole push and gets clear in fewer steps.
 */
function rectCollide() {
  let nodes: SimNode[] = [];
  function force() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const aPinned = a.fx !== undefined && a.fx !== null;
        const bPinned = b.fx !== undefined && b.fx !== null;
        if (aPinned && bPinned) continue;
        const dx = b.x! + b.vx! - (a.x! + a.vx!);
        const dy = b.y! + b.vy! - (a.y! + a.vy!);
        const ox = a.hw + b.hw + GAP - Math.abs(dx);
        const oy = a.hh + b.hh + GAP - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const [sa, sb] = aPinned ? [0, 1] : bPinned ? [1, 0] : [0.5, 0.5];
        if (ox < oy) {
          const dir = dx === 0 ? (i % 2 ? 1 : -1) : Math.sign(dx);
          a.vx! -= dir * ox * sa;
          b.vx! += dir * ox * sb;
        } else {
          const dir = dy === 0 ? (j % 2 ? 1 : -1) : Math.sign(dy);
          a.vy! -= dir * oy * sa;
          b.vy! += dir * oy * sb;
        }
      }
    }
  }
  force.initialize = (n: SimNode[]) => {
    nodes = n;
  };
  return force;
}

function edgeNeighbour(
  edges: GraphEdge[],
  id: string,
  ok: (other: string) => boolean,
): string | undefined {
  for (const e of edges) {
    if (e.from === id && ok(e.to)) return e.to;
    if (e.to === id && ok(e.from)) return e.from;
  }
  return undefined;
}

/**
 * A walk's result merged into what is shown. Depths are counted from the
 * object the graph started at: a walk from an object two steps out puts its
 * neighbours three steps out. What is already shown keeps its depth.
 */
export function mergeGraph(
  shown: { nodes: GraphNode[]; edges: GraphEdge[] },
  walk: { nodes: GraphNode[]; edges: GraphEdge[] },
  anchorId: string | null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const anchorDepth = anchorId ? (shown.nodes.find((n) => n.id === anchorId)?.depth ?? 0) : 0;
  const nodes = new Map(shown.nodes.map((n) => [n.id, n]));
  for (const n of walk.nodes)
    if (!nodes.has(n.id)) nodes.set(n.id, { ...n, depth: n.depth + anchorDepth });
  const edges = new Map(shown.edges.map((e) => [`${e.from}|${e.link}|${e.to}`, e]));
  for (const e of walk.edges) edges.set(`${e.from}|${e.link}|${e.to}`, e);
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * The shortest path between two objects over the links shown, in either
 * direction: the objects on it, and each step's link and which way it points.
 */
export function shortestPath(
  edges: GraphEdge[],
  from: string,
  to: string,
): { nodes: string[]; steps: { edge: GraphEdge; forward: boolean }[] } | null {
  if (from === to) return { nodes: [from], steps: [] };
  const adj = new Map<string, { other: string; edge: GraphEdge; forward: boolean }[]>();
  const add = (a: string, b: string, edge: GraphEdge, forward: boolean) =>
    adj.set(a, [...(adj.get(a) ?? []), { other: b, edge, forward }]);
  for (const e of edges) {
    add(e.from, e.to, e, true);
    add(e.to, e.from, e, false);
  }
  const prev = new Map<string, { at: string; edge: GraphEdge; forward: boolean }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) break;
    for (const s of adj.get(at) ?? []) {
      if (seen.has(s.other)) continue;
      seen.add(s.other);
      prev.set(s.other, { at, edge: s.edge, forward: s.forward });
      queue.push(s.other);
    }
  }
  if (!prev.has(to)) return null;
  const nodes = [to];
  const steps: { edge: GraphEdge; forward: boolean }[] = [];
  for (let cur = to; cur !== from;) {
    const p = prev.get(cur)!;
    steps.unshift({ edge: p.edge, forward: p.forward });
    nodes.unshift(p.at);
    cur = p.at;
  }
  return { nodes, steps };
}

/**
 * An object's relationships among those shown, grouped by link and
 * direction, each named as it reads from this object: an order is "placed
 * by" Ava Byrne, Ava Byrne has "orders".
 */
export function relationshipsOf(
  edges: GraphEdge[],
  id: string,
): { link: string; label: string; outgoing: boolean; others: string[] }[] {
  const groups = new Map<
    string,
    { link: string; label: string; outgoing: boolean; others: string[] }
  >();
  for (const e of edges) {
    const outgoing = e.from === id;
    if (!outgoing && e.to !== id) continue;
    const k = `${e.link}|${outgoing}`;
    // Read from this object's side: a customer's orders, an order's customer.
    const g = groups.get(k) ?? {
      link: e.link,
      label: outgoing ? e.label : e.inverseLabel,
      outgoing,
      others: [],
    };
    g.others.push(outgoing ? e.to : e.from);
    groups.set(k, g);
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.outgoing) - Number(a.outgoing) || a.label.localeCompare(b.label),
  );
}

/**
 * Hide an object, and any object only it connected to the rest: what is left
 * stays one connected picture around the start.
 */
export function hideNode(
  shown: { nodes: GraphNode[]; edges: GraphEdge[] },
  id: string,
  rootId: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (id === rootId) return shown;
  const edges = shown.edges.filter((e) => e.from !== id && e.to !== id);
  const reach = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of edges) {
      const other = e.from === at ? e.to : e.to === at ? e.from : null;
      if (other && !reach.has(other)) {
        reach.add(other);
        queue.push(other);
      }
    }
  }
  return {
    nodes: shown.nodes.filter((n) => reach.has(n.id)),
    edges: edges.filter((e) => reach.has(e.from) && reach.has(e.to)),
  };
}
