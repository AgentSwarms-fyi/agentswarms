// Editing a visual ETL graph: the rules a canvas edit has to obey.
//
// Kept out of the route so they can be tested as rules rather than as a
// rendered component, and so the canvas and anything else that edits a graph
// (a template, an import, a generator) agree on them.
import type { EtlNode } from "@/utils/etl/codegen";

/** Horizontal gap between a node and the one added after it. */
export const CHAIN_DX = 300;

/**
 * Should a newly added node continue from the selected one?
 *
 * WHY THIS EXISTS. Adding a node dropped it on a fixed column and left it
 * unconnected, so building a ten-step pipeline meant nine hand-drags between
 * 8px handles, over nodes that began overlapping at the seventh (the old
 * position cycled every six). For a builder whose whole point is pipelines
 * with many steps, the sample templates were the only practical way to get a
 * long graph.
 *
 * The rules here are the compiler's own, so an automatic edge can never build
 * a graph that will not compile:
 *   - a SOURCE has nothing upstream, so it is never chained TO;
 *   - a TARGET has nothing downstream, so it is never chained FROM;
 *   - with nothing selected there is no "after", so the node lands as before.
 *
 * A node that cannot chain still lands, unconnected, and the canvas's own
 * validation says what is missing — the behaviour before this existed.
 */
export function shouldChain(kind: EtlNode["kind"], from: EtlNode | null | undefined): boolean {
  if (!from) return false;
  if (kind === "source") return false;
  return from.kind !== "target";
}

/** Where a node goes: after the node it continues from, or on its own column. */
export function placeNode(
  kind: EtlNode["kind"],
  from: EtlNode | null | undefined,
  nodeCount: number,
): { x: number; y: number } {
  if (shouldChain(kind, from)) {
    return { x: (from!.position?.x ?? 80) + CHAIN_DX, y: from!.position?.y ?? 80 };
  }
  return {
    x: kind === "source" ? 80 : kind === "target" ? 640 : 360,
    y: 80 + (nodeCount % 6) * 90,
  };
}
