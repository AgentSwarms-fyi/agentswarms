// The neighbourhood of one object: what it links to, and what those link to,
// as nodes and edges for the Graph tab. Pure apart from `run`, which the
// server function points at the governed lakehouse and the tests at DuckDB.
//
// Found from the UI (R433), and why this is shaped the way it is:
//   - it asked once per object and per link, a dozen queries for two steps
//     out from one customer. It now asks once per type and link at each step
//     (compileLinkedBatch), whatever the number of objects;
//   - it drew a line only from an object someone expanded, so an order line
//     and its product, both on screen, had nothing between them. Every link
//     among the objects shown is now drawn, the caller's earlier objects
//     included (`known`), one query per link (compileLinkPairs);
//   - "some links have more objects than shown" said nothing about which; each
//     capped object and link is named;
//   - a link that could not be followed was dropped without a word; it is
//     reported.
import {
  CompileError,
  compileGetObject,
  compileLinkPairs,
  compileLinkedBatch,
  type ColumnMeta,
  type CompileOpts,
  type Scalar,
} from "@/lib/ontology/compile";
import {
  findObjectType,
  linkReading,
  linksOf,
  titleOf,
  type LinkType,
  type ObjectType,
  type OntologySpec,
} from "@/lib/ontology/spec";

/** One value of a result row (what the server function carries back). */
export type GraphCell = string | number | boolean | null;
export type GraphRow = Record<string, GraphCell>;

export type GraphNode = {
  id: string;
  objectType: string;
  key: Record<string, GraphCell>;
  title: string;
  /** Steps from the object the walk started at. */
  depth: number;
  /** The node it was reached from, for laying it out beside that node. */
  parent?: string;
};
export type GraphEdge = {
  from: string;
  to: string;
  link: string;
  /** How the link reads from its `from` end: "placed by". */
  label: string;
  /** How it reads from the other end: "orders". */
  inverseLabel: string;
};
/** An object with more neighbours over a link than were drawn. */
export type CappedLink = { node: string; link: string; label: string };
/** A link the walk could not follow, and why (a hidden key, a missing table). */
export type SkippedLink = { link: string; label: string; error: string };

export type Neighborhood = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  capped: boolean;
  cappedLinks: CappedLink[];
  skipped: SkippedLink[];
};

export type GraphRunner = (
  sql: string,
  columns: ColumnMeta[] | null,
  rowCap: number,
) => Promise<GraphRow[]>;

export const GRAPH_MAX_DEPTH = 3;
export const GRAPH_MAX_NODES = 150;
/** At most this many already-drawn objects are checked for links among them. */
export const GRAPH_MAX_KNOWN = 300;

/** A node's id: its type and its key, in the key's own order. */
export function nodeId(objectType: string, key: Record<string, unknown>): string {
  return `${objectType}:${JSON.stringify(key)}`;
}

export function keyOfRow(t: ObjectType, row: GraphRow, prefix = ""): Record<string, GraphCell> {
  return Object.fromEntries(t.primaryKey.map((k) => [k, row[`${prefix}${k}`] ?? null]));
}

export function titleOfRow(t: ObjectType, row: GraphRow): string {
  const tp = t.titleProperty;
  const v = tp ? row[tp] : null;
  if (v !== null && v !== undefined && v !== "") return String(v);
  return t.primaryKey.map((k) => String(row[k] ?? "")).join(" · ") || titleOf(t);
}

const label = (l: { name: string; label?: string }) => l.label ?? l.name.replace(/_/g, " ");
const inverseLabel = (l: LinkType) =>
  l.inverseLabel ?? linkReading(l, "inverse").replace(/_/g, " ");

const errorText = (e: unknown) =>
  e instanceof CompileError ? e.message : ((e as Error)?.message ?? String(e)).slice(0, 300);

export async function neighborhood(args: {
  spec: OntologySpec;
  objectType: string;
  key: Record<string, Scalar>;
  depth: number;
  perLink: number;
  /** Objects the caller already shows: links between them and these are drawn too. */
  known?: { objectType: string; key: Record<string, GraphCell> }[];
  maxNodes?: number;
  opts: CompileOpts;
  run: GraphRunner;
}): Promise<Neighborhood | { notFound: true }> {
  const { spec, opts, run } = args;
  const depth = Math.max(1, Math.min(GRAPH_MAX_DEPTH, Math.trunc(args.depth)));
  const maxNodes = args.maxNodes ?? GRAPH_MAX_NODES;
  const start = findObjectType(spec, args.objectType);
  if (!start) throw new CompileError(`Unknown object type ${args.objectType}`);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const cappedLinks: CappedLink[] = [];
  const skipped = new Map<string, SkippedLink>();
  let capped = false;
  const addEdge = (from: string, to: string, link: LinkType) =>
    edges.set(`${from}|${link.name}|${to}`, {
      from,
      to,
      link: link.name,
      label: label(link),
      inverseLabel: inverseLabel(link),
    });

  const got = compileGetObject(spec, start.name, args.key, opts);
  const rootRows = await run(got.sql, got.columns, 1);
  if (!rootRows.length) return { notFound: true };
  const rootKey = keyOfRow(start, rootRows[0]);
  const root: GraphNode = {
    id: nodeId(start.name, rootKey),
    objectType: start.name,
    key: rootKey,
    title: titleOfRow(start, rootRows[0]),
    depth: 0,
  };
  nodes.set(root.id, root);

  let frontier: GraphNode[] = [root];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: GraphNode[] = [];
    // One query per type on the frontier and link, not per object.
    const byType = new Map<string, GraphNode[]>();
    for (const n of frontier) byType.set(n.objectType, [...(byType.get(n.objectType) ?? []), n]);
    for (const [typeName, group] of byType) {
      const t = findObjectType(spec, typeName)!;
      for (const { link, direction, other } of linksOf(spec, t.name)) {
        const ot = findObjectType(spec, other);
        if (!ot?.source) continue;
        if (nodes.size >= maxNodes) {
          capped = true;
          break;
        }
        let rows: GraphRow[];
        try {
          const c = compileLinkedBatch(
            spec,
            t.name,
            group.map((n) => n.key as Record<string, Scalar | null>),
            { link: linkReading(link, direction), direction },
            args.perLink,
            opts,
          );
          rows = await run(c.sql, c.columns, group.length * (args.perLink + 1));
        } catch (e) {
          skipped.set(link.name, { link: link.name, label: label(link), error: errorText(e) });
          continue;
        }
        const seenPerFrom = new Map<string, number>();
        for (const r of rows) {
          const fromId = nodeId(t.name, keyOfRow(t, r, "__from_"));
          const count = (seenPerFrom.get(fromId) ?? 0) + 1;
          seenPerFrom.set(fromId, count);
          if (count > args.perLink) {
            // The one more than asked for: there are more than shown.
            capped = true;
            // Named as it reads from that object: a customer's "orders".
            cappedLinks.push({
              node: fromId,
              link: link.name,
              label: direction === "forward" ? label(link) : inverseLabel(link),
            });
            continue;
          }
          const key = keyOfRow(ot, r);
          const id = nodeId(ot.name, key);
          if (!nodes.has(id)) {
            if (nodes.size >= maxNodes) {
              capped = true;
              continue;
            }
            const node: GraphNode = {
              id,
              objectType: ot.name,
              key,
              title: titleOfRow(ot, r),
              depth: d,
              parent: fromId,
            };
            nodes.set(id, node);
            next.push(node);
          }
          const [from, to] = direction === "forward" ? [fromId, id] : [id, fromId];
          addEdge(from, to, link);
        }
      }
    }
    frontier = next;
  }

  // Every link among the objects shown: these and the ones the caller has.
  const all = new Map<string, { objectType: string; key: Record<string, GraphCell> }>();
  for (const n of nodes.values()) all.set(n.id, n);
  for (const k of (args.known ?? []).slice(0, GRAPH_MAX_KNOWN)) {
    const t = findObjectType(spec, k.objectType);
    if (!t) continue;
    const key = Object.fromEntries(t.primaryKey.map((p) => [p, k.key[p] ?? null]));
    all.set(nodeId(t.name, key), { objectType: t.name, key });
  }
  const byType = new Map<string, Record<string, GraphCell>[]>();
  for (const n of all.values())
    byType.set(n.objectType, [...(byType.get(n.objectType) ?? []), n.key]);
  for (const link of spec.linkTypes) {
    const a = findObjectType(spec, link.from);
    const b = findObjectType(spec, link.to);
    if (!a?.source || !b?.source) continue;
    const fromKeys = byType.get(a.name);
    const toKeys = byType.get(b.name);
    if (!fromKeys?.length || !toKeys?.length) continue;
    try {
      const c = compileLinkPairs(
        spec,
        link.name,
        fromKeys as Record<string, Scalar | null>[],
        toKeys as Record<string, Scalar | null>[],
        opts,
      );
      const rows = await run(c.sql, c.columns, fromKeys.length * toKeys.length);
      for (const r of rows) {
        const from = nodeId(a.name, keyOfRow(a, r, "a_"));
        const to = nodeId(b.name, keyOfRow(b, r, "b_"));
        if (all.has(from) && all.has(to)) addEdge(from, to, link);
      }
    } catch (e) {
      if (!skipped.has(link.name))
        skipped.set(link.name, { link: link.name, label: label(link), error: errorText(e) });
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    capped,
    cappedLinks,
    skipped: [...skipped.values()],
  };
}
