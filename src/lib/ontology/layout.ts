// Where object types sit on the model canvas when nobody has placed them.
//
// Deterministic, so a model laid out today lays out the same tomorrow and in a
// test: each connected group of types is arranged in columns by link distance
// from its most-linked type (the hub, usually the thing the business is
// about), the hub's neighbours in the next column, and so on, each column
// sorted by name. Groups are stacked top to bottom, largest first. Types the
// user has already placed keep their place.
import type { OntologySpec } from "@/lib/ontology/spec";

export const NODE_W = 240;
export const NODE_H = 120;
const COL_GAP = 120;
const ROW_GAP = 48;
const GROUP_GAP = 96;

export function autoLayout(
  spec: OntologySpec,
  opts: { keepPlaced?: boolean } = {},
): Map<string, { x: number; y: number }> {
  const names = spec.objectTypes.map((t) => t.name);
  const adj = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const l of spec.linkTypes) {
    const a = names.find((n) => n.toLowerCase() === l.from.toLowerCase());
    const b = names.find((n) => n.toLowerCase() === l.to.toLowerCase());
    if (!a || !b || a === b) continue;
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  for (const t of spec.objectTypes) {
    if (t.extends) {
      const sup = names.find((n) => n.toLowerCase() === t.extends!.toLowerCase());
      if (sup && sup !== t.name) {
        adj.get(t.name)!.add(sup);
        adj.get(sup)!.add(t.name);
      }
    }
  }

  // Connected groups, largest first, then by name for ties.
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const n of [...names].sort()) {
    if (seen.has(n)) continue;
    const group: string[] = [];
    const queue = [n];
    seen.add(n);
    while (queue.length) {
      const cur = queue.shift()!;
      group.push(cur);
      for (const m of [...adj.get(cur)!].sort())
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
    }
    groups.push(group);
  }
  groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  const out = new Map<string, { x: number; y: number }>();
  let top = 0;
  for (const group of groups) {
    const hub = [...group].sort(
      (a, b) => adj.get(b)!.size - adj.get(a)!.size || a.localeCompare(b),
    )[0];
    const depth = new Map<string, number>([[hub, 0]]);
    const queue = [hub];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const m of [...adj.get(cur)!].sort())
        if (!depth.has(m)) {
          depth.set(m, depth.get(cur)! + 1);
          queue.push(m);
        }
    }
    const columns = new Map<number, string[]>();
    for (const n of group) {
      const d = depth.get(n) ?? 0;
      columns.set(d, [...(columns.get(d) ?? []), n]);
    }
    const tallest = Math.max(...[...columns.values()].map((c) => c.length));
    const height = tallest * NODE_H + (tallest - 1) * ROW_GAP;
    for (const [d, col] of columns) {
      col.sort();
      const colHeight = col.length * NODE_H + (col.length - 1) * ROW_GAP;
      col.forEach((n, i) => {
        out.set(n, {
          x: d * (NODE_W + COL_GAP),
          y: top + (height - colHeight) / 2 + i * (NODE_H + ROW_GAP),
        });
      });
    }
    top += height + GROUP_GAP;
  }

  if (opts.keepPlaced) {
    for (const t of spec.objectTypes) if (t.position) out.set(t.name, t.position);
  }
  return out;
}
