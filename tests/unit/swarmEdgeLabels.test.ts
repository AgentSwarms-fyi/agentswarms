// Saving a swarm must not delete the labels the runtime routes on.
//
// `router` and `condition` are the only two node kinds that branch, and both
// branch by reading `edge.label` — the executor matches "yes"/"no" for a
// condition and a route name for a router. A graph whose labels are gone does
// not degrade; it refuses to start: "Router node has no labeled outgoing
// edges."
//
// Both serializers dropped it. handleSave destructured five edge fields and
// rebuilt the object from them; serializeGraph did the same, so version history
// could not restore a working copy either. Nothing caught it because React Flow
// keeps the label in memory — the canvas looked correct until a reload, and the
// "click an edge to name the route" editor appeared to work while persisting
// nothing.
//
// Found by deploying the shipped Support Copilot template behind an API key:
// the template's three router edges are correctly labelled "product",
// "account" and "sensitive", and the saved swarm had label: null on all three.
import { describe, expect, it } from "vitest";

import { serializeGraph } from "@/lib/swarmVersions";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

type AnyEdge = { id: string; source: string; target: string; label?: unknown };

const nodes = [] as never;

describe("serializeGraph keeps branch labels", () => {
  it("preserves a router's route names", () => {
    const edges = [
      { id: "e2", source: "router", target: "retrieve", label: "product" },
      { id: "e3", source: "router", target: "account", label: "account" },
      { id: "e4", source: "router", target: "approval", label: "sensitive" },
    ] as never;

    const out = serializeGraph(nodes, edges) as { cleanEdges: AnyEdge[] };
    expect(out.cleanEdges.map((e) => e.label)).toEqual(["product", "account", "sensitive"]);
  });

  it("preserves a condition's yes/no", () => {
    const edges = [
      { id: "y", source: "cond", target: "a", label: "yes" },
      { id: "n", source: "cond", target: "b", label: "no" },
    ] as never;

    const out = serializeGraph(nodes, edges) as { cleanEdges: AnyEdge[] };
    expect(out.cleanEdges.map((e) => e.label)).toEqual(["yes", "no"]);
  });

  it("still strips React Flow's transient selection state", () => {
    // The stripping exists for a reason — clicking a node must not create a
    // version. Keeping `label` must not quietly turn that off.
    const edges = [
      { id: "e", source: "a", target: "b", label: "go", selected: true, animated: true },
    ] as never;

    const out = serializeGraph(nodes, edges) as { cleanEdges: Record<string, unknown>[] };
    expect(out.cleanEdges[0].label).toBe("go");
    expect(out.cleanEdges[0]).not.toHaveProperty("selected");
  });
});

describe("shipped templates stay runnable", () => {
  // A router with no labelled outgoing edge cannot run at all, so a template
  // in that state is broken on arrival. Asserted against the real catalogue.
  const branching = SWARM_TEMPLATES.flatMap((t) =>
    (t.nodes as { id: string; type?: string }[])
      .filter((n) => n.type === "router" || n.type === "condition")
      .map((n) => ({ template: t.id, node: n.id, type: n.type })),
  );

  it("has branching nodes to check", () => {
    expect(branching.length).toBeGreaterThan(0);
  });

  it("gives every router and condition node at least one labelled edge out", () => {
    const broken: string[] = [];
    for (const b of branching) {
      const t = SWARM_TEMPLATES.find((x) => x.id === b.template)!;
      const out = (t.edges as AnyEdge[]).filter((e) => e.source === b.node);
      const labelled = out.filter((e) => typeof e.label === "string" && e.label.trim().length > 0);
      if (labelled.length === 0) broken.push(`${b.template} · ${b.type} "${b.node}"`);
    }
    expect(broken, `unrunnable on arrival:\n  ${broken.join("\n  ")}`).toEqual([]);
  });
});
