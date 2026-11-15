// What a swarm node can reference as `{{name}}` (R495).
//
// The flow state a node reads is built as the run goes: the run's input and
// its start-form fields first, then each step's output under its output
// variable as that step finishes. So what is SET when a node runs is the run's
// own values plus the outputs of the steps that lead into it — not the whole
// canvas. That is the list the inspector offers, nearest step first, so a name
// picked from it is one the node will actually find. A name it does not list
// (state seeded by an API caller, say) can still be typed.
import type { Edge, Node } from "@xyflow/react";

import { outputVarOf, type SwarmNodeData } from "@/lib/swarmRuntime";

export type SwarmTemplateVar = {
  /** The name inside the braces, e.g. `input` or `out_3.summary`. */
  name: string;
  /** Where its value comes from, in a few words. */
  detail: string;
  group: "This run" | "Earlier steps" | "This step";
};

function stepName(n: Node<SwarmNodeData>): string {
  return n.data.label?.trim() || n.data.kind;
}

/**
 * The variables `nodeId` can read: the run's input and start-form fields, the
 * outputs of every step upstream of it (nearest first), and what the node
 * itself adds (a For Each's item and index). Each name once.
 */
export function swarmTemplateVars(
  nodes: Node<SwarmNodeData>[],
  edges: Pick<Edge, "source" | "target">[],
  nodeId: string,
): SwarmTemplateVar[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: SwarmTemplateVar[] = [];
  const seen = new Set<string>();
  const add = (v: SwarmTemplateVar) => {
    if (!v.name || seen.has(v.name)) return;
    seen.add(v.name);
    out.push(v);
  };

  const self = byId.get(nodeId);
  if (self?.data.kind === "foreach") {
    const item = self.data.foreachItemVar?.trim() || "item";
    add({ name: item, detail: "The element this pass works on", group: "This step" });
    add({ name: "index", detail: "Its position, from 0", group: "This step" });
  }

  add({
    name: "input",
    // A loop's prompt is filled with `input` set to what the loop gathered.
    detail:
      self?.data.kind === "loop"
        ? "In this prompt, what the loop's Inputs gathered"
        : "What the run was started with",
    group: "This run",
  });
  for (const n of nodes) {
    if (n.data.kind !== "input") continue;
    for (const f of n.data.inputFields ?? []) {
      const name = f.name?.trim();
      if (!name) continue;
      add({
        name,
        detail: `Start form field${f.label?.trim() ? ` “${f.label.trim()}”` : ""}`,
        group: "This run",
      });
    }
  }

  // Upstream, breadth first from the node, so the step feeding it directly is
  // listed before the ones further back. A cycle is walked once.
  const parents = new Map<string, string[]>();
  for (const e of edges) parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
  const visited = new Set<string>([nodeId]);
  const queue = [...(parents.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...(parents.get(id) ?? []));
    const n = byId.get(id);
    if (!n || n.data.kind === "output") continue;
    const v = outputVarOf(n);
    const step = stepName(n);
    if (n.data.kind === "input") {
      // Its output is the run's input; listed above unless renamed.
      add({ name: v, detail: "What the run was started with", group: "This run" });
      continue;
    }
    add({ name: v, detail: `Output of ${step}`, group: "Earlier steps" });
    if (n.data.kind === "approval") {
      add({
        name: `${v}_approved`,
        detail: `“yes” once ${step} is approved`,
        group: "Earlier steps",
      });
    }
    if (n.data.kind === "set_var") {
      for (const a of n.data.stateAssignments ?? []) {
        const key = a.key?.trim();
        if (key) add({ name: key, detail: `Set by ${step}`, group: "Earlier steps" });
      }
    }
    if (n.data.kind === "extract") {
      for (const f of n.data.extractSchema ?? []) {
        const field = f.name?.trim();
        if (field)
          add({
            name: `${v}.${field}`,
            detail: `${f.type} field from ${step}`,
            group: "Earlier steps",
          });
      }
    }
  }
  return out;
}

/**
 * The names a node can read whole, for pickers that choose a variable rather
 * than insert one (Inputs, a For Each's array). Not a JSON path (`out_3.x` is
 * not a key of the flow state) and not what the node itself defines (a For
 * Each's item exists only inside its own prompt).
 */
export function swarmVarNames(vars: SwarmTemplateVar[]): string[] {
  return vars.filter((v) => v.group !== "This step" && !v.name.includes(".")).map((v) => v.name);
}
