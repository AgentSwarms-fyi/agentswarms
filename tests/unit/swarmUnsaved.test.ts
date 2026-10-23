// Unsaved edits on the swarm canvas (R270). The canvas set a flag on every
// render that changed its nodes — the load among them — so closing a swarm
// nobody had touched asked "Leave site?"; it guarded the tab but not a link or
// the Gallery button; and Fullscreen was a second tree, so switching reloaded
// the swarm from the database and dropped every unsaved edit.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import type { SwarmNodeData } from "@/lib/swarmRuntime";
import { canvasForm } from "@/lib/swarmVersions";

const node = (id: string, x: number, data: Record<string, unknown> = {}): Node<SwarmNodeData> =>
  ({
    id,
    type: "swarm",
    position: { x, y: 0 },
    data: { kind: "agent", label: id, ...data },
  }) as unknown as Node<SwarmNodeData>;
const nodes = [node("a", 0), node("b", 200)];
const edges: Edge[] = [{ id: "e1", source: "a", target: "b" }];

describe("canvasForm", () => {
  const base = canvasForm("Echo", nodes, edges);

  it("is the same for what React Flow and a run add, which Save does not keep", () => {
    const touched = nodes.map((n, i) => ({
      ...n,
      selected: i === 0,
      dragging: false,
      measured: { width: 180, height: 60 },
      data: { ...n.data, status: "done", lastOutput: "hello" },
    })) as Node<SwarmNodeData>[];
    const styled = edges.map((e) => ({ ...e, style: { stroke: "red" }, animated: true }));
    expect(canvasForm("Echo", touched, styled)).toBe(base);
  });

  it("does not depend on the order an object's keys were written in", () => {
    const reordered = nodes.map(
      (n) =>
        ({
          data: { label: n.data.label, kind: n.data.kind },
          position: n.position,
          type: n.type,
          id: n.id,
        }) as unknown as Node<SwarmNodeData>,
    );
    expect(canvasForm("Echo", reordered, edges)).toBe(base);
  });

  it("changes with anything Save keeps", () => {
    for (const [what, form] of [
      ["the name", canvasForm("Echo 2", nodes, edges)],
      ["a position", canvasForm("Echo", [node("a", 10), nodes[1]], edges)],
      ["a node's settings", canvasForm("Echo", [node("a", 0, { model: "gpt" }), nodes[1]], edges)],
      ["a node", canvasForm("Echo", [...nodes, node("c", 400)], edges)],
      ["an edge", canvasForm("Echo", nodes, [])],
      ["an edge's label", canvasForm("Echo", nodes, [{ ...edges[0], label: "yes" }])],
    ] as const) {
      expect(form, what).not.toBe(base);
    }
  });
});

describe("the canvas", () => {
  const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/swarms.tsx"), "utf8");

  it("no longer keeps a flag that every render of the nodes set", () => {
    expect(src).not.toContain("dirtyRef");
  });

  it("records what was loaded and what a save sent", () => {
    expect(src).toContain("setSavedAs(canvasForm(row.name, loadedNodes, loadedEdges));");
    expect(src).toContain("const sent = canvasForm(swarmName, nodes, edges);");
    expect(src.match(/setSavedAs\(sent\);/g)).toHaveLength(2);
  });

  it("asks before a link, the Gallery button or a closing tab drops unsaved edits", () => {
    expect(src).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) => !\(await mayDiscard\("Leaving the canvas drops them\."\)\),\s*enableBeforeUnload: unsaved,\s*disabled: !unsaved,\s*\}\);/,
    );
    expect(src).toMatch(
      /async function mayDiscard\(what: string\): Promise<boolean> \{\s*if \(!unsaved\) return true;/,
    );
  });

  it("draws the canvas in one tree, so Fullscreen does not reload it", () => {
    const page = src.slice(src.indexOf("function SwarmsPage()"));
    expect(page.match(/<SwarmsCanvas\b/g)).toHaveLength(1);
  });
});
