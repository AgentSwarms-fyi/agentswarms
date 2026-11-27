// Where a node added from the palette lands on the swarm canvas.
//
// A clicked node went to a random spot in a fixed area of the canvas's own
// coordinates, wherever the canvas had been panned or zoomed, so on a moved
// canvas it appeared out of sight. A dropped node ignored pan and zoom too, and
// did not land under the pointer. Now a clicked node lands in the middle of
// what you can see, and a dropped one under the pointer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { NEW_NODE_HALF, STACK_STEP, clickedNodeCorner, nodeCornerAt } from "@/lib/canvasPlacement";

describe("a new node's place", () => {
  it("is centred on the point it is given", () => {
    expect(nodeCornerAt({ x: 1000, y: 600 })).toEqual({
      x: 1000 - NEW_NODE_HALF.x,
      y: 600 - NEW_NODE_HALF.y,
    });
  });

  it("for a click, is the middle of the view when nothing is there", () => {
    const far = [
      { x: 0, y: 0 },
      { x: 5000, y: 5000 },
    ];
    expect(clickedNodeCorner({ x: 1000, y: 600 }, far)).toEqual(nodeCornerAt({ x: 1000, y: 600 }));
  });

  it("for clicks in a row, steps down-right rather than stacking on the last one", () => {
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 3; i++) placed.push(clickedNodeCorner({ x: 1000, y: 600 }, placed));
    const first = nodeCornerAt({ x: 1000, y: 600 });
    expect(placed).toEqual([
      first,
      { x: first.x + STACK_STEP, y: first.y + STACK_STEP },
      { x: first.x + 2 * STACK_STEP, y: first.y + 2 * STACK_STEP },
    ]);
  });

  it("does not search forever on a crowded canvas", () => {
    const crowd = Array.from({ length: 200 }, (_, i) => ({
      x: 910 + i * STACK_STEP,
      y: 560 + i * STACK_STEP,
    }));
    expect(() => clickedNodeCorner({ x: 1000, y: 600 }, crowd)).not.toThrow();
  });
});

describe("the canvas", () => {
  const canvas = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
  const addNode = canvas.slice(
    canvas.indexOf("const addNode = useCallback("),
    canvas.indexOf("[setNodes, clickedNodeSpot]"),
  );
  const spot = canvas.slice(
    canvas.indexOf("const clickedNodeSpot = useCallback("),
    canvas.indexOf("const addNode = useCallback("),
  );
  const drop = canvas.slice(
    canvas.indexOf("const onDrop = useCallback("),
    canvas.indexOf("[addNode, reactFlow]"),
  );

  it("places a clicked node by the visible canvas, not at random", () => {
    expect(addNode).toContain("position: pos ?? clickedNodeSpot(),");
    expect(addNode).not.toContain("Math.random");
    expect(spot).toContain("canvasAreaRef.current?.getBoundingClientRect()");
    expect(spot).toMatch(
      /reactFlow\.screenToFlowPosition\(\{\s*x: area\.left \+ area\.width \/ 2,\s*y: area\.top \+ area\.height \/ 2,?\s*\}\)/,
    );
    expect(spot).toContain("reactFlow.getNodes().map((n) => n.position)");
  });

  it("measures the area nodes are dropped on", () => {
    expect(canvas).toMatch(
      /ref=\{canvasAreaRef\}\s*className="relative flex-1 min-h-0"\s*onDrop=\{onDrop\}/,
    );
  });

  it("places a dropped node under the pointer, counting pan and zoom", () => {
    expect(drop).toContain(
      "nodeCornerAt(reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))",
    );
    expect(drop).not.toContain("getBoundingClientRect");
  });
});
