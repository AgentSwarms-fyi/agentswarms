// Adding a node to a visual pipeline continues from the one you are on.
//
// Before this, every added node landed on a fixed column and arrived
// unconnected, so a ten-step pipeline was nine hand-drags between two 8px
// handles — over nodes that began overlapping at the seventh, because the
// vertical position cycled every six. For a builder whose subject is
// pipelines with many steps, the sample templates were the only practical way
// to get a long graph, which is a strange thing for a canvas to be true of.
//
// The rules below are the COMPILER's rules, restated where the canvas can use
// them, so an automatic edge can never produce a graph that will not compile.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CHAIN_DX, placeNode, shouldChain } from "@/lib/etlGraphEdit";
import { analyzeGraph, type EtlNode } from "@/utils/etl/codegen";

const node = (over: Partial<EtlNode>): EtlNode =>
  ({
    id: "n1",
    kind: "transform",
    label: "t",
    config: { type: "filter", expr: "x > 0" },
    position: { x: 400, y: 120 },
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("what continues from what", () => {
  it("continues a transform or a target from the selected node", () => {
    const src = node({ kind: "source" });
    expect(shouldChain("transform", src)).toBe(true);
    expect(shouldChain("target", src)).toBe(true);
    expect(shouldChain("transform", node({ kind: "transform" }))).toBe(true);
  });

  it("never continues INTO a source: it has nothing upstream", () => {
    expect(shouldChain("source", node({ kind: "source" }))).toBe(false);
    expect(shouldChain("source", node({ kind: "transform" }))).toBe(false);
  });

  it("never continues FROM a target: it has nothing downstream", () => {
    expect(shouldChain("transform", node({ kind: "target" }))).toBe(false);
    expect(shouldChain("target", node({ kind: "target" }))).toBe(false);
  });

  it("does nothing when nothing is selected", () => {
    expect(shouldChain("transform", null)).toBe(false);
    expect(shouldChain("target", undefined)).toBe(false);
  });
});

describe("where the node lands", () => {
  it("puts a continued node beside the one it continues from", () => {
    const from = node({ kind: "source", position: { x: 260, y: 512 } });
    expect(placeNode("transform", from, 3)).toEqual({ x: 260 + CHAIN_DX, y: 512 });
  });

  it("keeps the old columns for a node that cannot continue", () => {
    // Unchanged behaviour, deliberately: a source still starts on the left,
    // and an unchained node still walks down the six-row cycle.
    expect(placeNode("source", node({ kind: "transform" }), 0)).toEqual({ x: 80, y: 80 });
    expect(placeNode("target", null, 2)).toEqual({ x: 640, y: 260 });
  });
});

describe("a graph built this way compiles", () => {
  it("source → filter → aggregate → target, wired only by the rules", () => {
    // The point of the rules: follow them blindly and the compiler accepts
    // the result. Built here the way the canvas builds it — append a node,
    // append the edge the rule allows, select the new node, repeat.
    const steps: { kind: EtlNode["kind"]; config: Record<string, unknown>; label: string }[] = [
      {
        kind: "source",
        label: "orders",
        config: { type: "lakehouse", schema: "analytics", mode: "table", table: "revenue_facts" },
      },
      { kind: "transform", label: "big", config: { type: "filter", expr: "net_usd > 0" } },
      {
        kind: "transform",
        label: "by region",
        config: {
          type: "aggregate",
          group_by: ["region"],
          aggs: [{ column: "net_usd", fn: "sum", as: "revenue" }],
        },
      },
      {
        kind: "target",
        label: "out",
        config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "replace" },
      },
    ];
    const nodes: EtlNode[] = [];
    const edges: { id: string; from: string; to: string }[] = [];
    let selected: EtlNode | null = null;
    steps.forEach((step, i) => {
      const id = `n${i + 1}`;
      const fresh = {
        id,
        kind: step.kind,
        label: step.label,
        config: step.config,
        position: placeNode(step.kind, selected, nodes.length),
      } as EtlNode;
      if (shouldChain(step.kind, selected)) {
        edges.push({ id: `e${i}`, from: selected!.id, to: id });
      }
      nodes.push(fresh);
      selected = fresh;
    });
    expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(["n1->n2", "n2->n3", "n3->n4"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => analyzeGraph({ nodes, edges } as any)).not.toThrow();
    // And the nodes do not sit on top of each other, which is what the old
    // six-row cycle did from the seventh node on.
    const spots = new Set(nodes.map((n) => `${n.position?.x},${n.position?.y}`));
    expect(spots.size).toBe(nodes.length);
  });
});

// ── The New pipeline dialog keeps no draft across dismissals ────────────────
//
// Found by using it: a template was chosen, the dialog was dismissed by a
// mis-aimed click on the overlay, and on reopening the tile was still
// highlighted. Clicking the tile you want is what anybody does — and the tile
// TOGGLES, so that click deselected it. The pipeline was created from the
// blank starter graph under the name chosen for the sample: two nodes where
// the sample has ten, and nothing said so.
//
// Radix unmounts the dialog's content but not the component that owns the
// state, so `open` alone resets nothing. The create path already cleared both
// fields; only the dismiss path did not.
describe("the New pipeline dialog's draft", () => {
  it("is cleared on dismiss, the same fields the create path clears", () => {
    const page = readFileSync("src/routes/_authenticated/etl.tsx", "utf8");
    const at = page.indexOf("const dismiss = () => {");
    expect(at, "the dismiss handler was renamed; re-anchor this test").toBeGreaterThan(-1);
    const body = page.slice(at, at + 220);
    expect(body).toContain('setName("")');
    expect(body).toContain("setTemplateId(null)");
    expect(body).toContain("onClose()");
    // Both ways out of the dialog go through it: the overlay/Escape path and
    // the Cancel button. Leaving either on the bare onClose brings the trap
    // back for that route only, which is worse than having it on both.
    expect(page).toContain("onOpenChange={(v) => !v && dismiss()}");
    expect(page).toContain('<Button variant="outline" onClick={dismiss}>');
  });
});
