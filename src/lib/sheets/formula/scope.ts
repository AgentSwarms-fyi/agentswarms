// The names a formula gives itself (R328): LET's names and a LAMBDA's
// parameters, each known only in the calculation that follows it. The
// evaluator binds them as it goes; the walkers that read a formula without
// computing it (unknown functions, what a file's formula computes here, the
// file's _xlpm. prefix) take them from here.

import type { Node } from "./parser";

/** A LAMBDA parameter's name, lower-cased: x, or [x] for one a call may leave out. */
export function paramName(p: Node): string | null {
  if (p.k === "name") return p.name.toLowerCase();
  if (p.k === "struct" && !p.table && !p.thisRow && !p.endColumn) return p.column.toLowerCase();
  return null;
}

/**
 * Visit every node with the names in scope there, lower-cased. Where a LET
 * gives a name or a LAMBDA takes a parameter, the node is visited with
 * `binding` set: the place a name is given, not a use of it.
 */
export function walkScoped(
  node: Node,
  visit: (n: Node, scope: ReadonlySet<string>, binding: boolean) => void,
  scope: ReadonlySet<string> = new Set(),
): void {
  visit(node, scope, false);
  const down = (n: Node, s: ReadonlySet<string> = scope) => walkScoped(n, visit, s);
  switch (node.k) {
    case "call": {
      const a = node.args;
      if (node.name === "LET" && a.length >= 3 && a.length % 2 === 1) {
        // Each value sees the names before it; the calculation sees them all.
        const inner = new Set(scope);
        for (let i = 0; i + 1 < a.length; i += 2) {
          const b = a[i];
          if (b.k === "name") visit(b, inner, true);
          else down(b, inner);
          down(a[i + 1], inner);
          if (b.k === "name") inner.add(b.name.toLowerCase());
        }
        down(a[a.length - 1], inner);
        return;
      }
      if (node.name === "LAMBDA" && a.length) {
        const inner = new Set(scope);
        for (const p of a.slice(0, -1)) {
          const name = paramName(p);
          if (name) {
            visit(p, scope, true);
            inner.add(name);
          } else down(p);
        }
        down(a[a.length - 1], inner);
        return;
      }
      a.forEach((x) => down(x));
      return;
    }
    case "invoke":
      down(node.fn);
      node.args.forEach((x) => down(x));
      return;
    case "unary":
    case "percent":
    case "single":
      down(node.arg);
      return;
    case "bin":
      down(node.left);
      down(node.right);
      return;
    case "array":
      node.rows.forEach((r) => r.forEach((x) => down(x)));
      return;
    default:
      return;
  }
}
