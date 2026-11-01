// The Graph tab's layout, merging, paths and relationships (graphView.ts).
// R433, from the UI: expanding an order put its lines and products round the
// whole ring about the customer, on the far side of it, and expanding a second
// order stacked its objects exactly on top of the first's.
import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "@/lib/ontology/graph";
import { displayTitle, type ObjectType } from "@/lib/ontology/spec";
import {
  hideNode,
  layoutGraph,
  mergeGraph,
  NODE_HEIGHT,
  nodeWidth,
  relationshipsOf,
  shortestPath,
  type XY,
} from "@/lib/ontology/graphView";

const node = (id: string, depth: number, parent?: string, title = id): GraphNode => ({
  id,
  objectType: id.replace(/\d+$/, ""),
  key: { id },
  title,
  depth,
  ...(parent ? { parent } : {}),
});
const INVERSE: Record<string, string> = {
  placed_by: "orders",
  order: "lines",
  contains: "ordered in",
};
const edge = (from: string, to: string, link: string, label = link): GraphEdge => ({
  from,
  to,
  link,
  label,
  inverseLabel: INVERSE[link] ?? `${link} of`,
});
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * No two pills overlap, read as what they are: rectangles as wide as their
 * title and NODE_HEIGHT tall, centred on their position.
 */
function expectNoOverlap(nodes: GraphNode[], pos: Map<string, XY>) {
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const pa = pos.get(a.id)!;
      const pb = pos.get(b.id)!;
      const clearX = Math.abs(pa.x - pb.x) >= (nodeWidth(a.title) + nodeWidth(b.title)) / 2;
      const clearY = Math.abs(pa.y - pb.y) >= NODE_HEIGHT;
      expect(clearX || clearY, `${a.id} and ${b.id} overlap`).toBe(true);
    }
}

// A customer with three orders; then one order's lines and products; then another's.
const customer = node("Customer1", 0, undefined, "Ava Byrne");
const orders = [1271, 1344, 1493].map((n) => node(`Order${n}`, 1, "Customer1", String(n)));
const step1 = {
  nodes: [customer, ...orders],
  edges: orders.map((o) => edge(o.id, "Customer1", "placed_by", "placed by")),
};
const childrenOf = (order: string, lines: number[], products: number[]) => ({
  nodes: [
    node(order, 0),
    ...lines.map((l) => node(`OrderLine${l}`, 1, order, String(l))),
    ...products.map((p) => node(`Product${p}`, 1, order, `Product number ${p}`)),
  ],
  edges: [
    ...lines.map((l) => edge(`OrderLine${l}`, order, "order")),
    ...products.map((p) => edge(order, `Product${p}`, "contains")),
    ...lines.map((l, i) => edge(`OrderLine${l}`, `Product${products[i]}`, "product")),
  ],
});

describe("the layout", () => {
  it("starts with the object at the centre and its neighbours round it, apart", () => {
    const pos = layoutGraph(step1.nodes, step1.edges, new Map());
    expect(pos.get("Customer1")).toEqual({ x: 0, y: 0 });
    expectNoOverlap(step1.nodes, pos);
    for (const o of orders) expect(dist(pos.get(o.id)!, { x: 0, y: 0 })).toBeGreaterThan(100);
  });

  it("puts an expanded object's neighbours beside it, and moves nothing already drawn", () => {
    const pos1 = layoutGraph(step1.nodes, step1.edges, new Map());
    const g2 = mergeGraph(
      step1,
      childrenOf("Order1271", [271, 871, 1471], [29, 34, 39]),
      "Order1271",
    );
    const pos2 = layoutGraph(g2.nodes, g2.edges, pos1);
    for (const n of step1.nodes) expect(pos2.get(n.id)).toEqual(pos1.get(n.id));
    const parent = pos2.get("Order1271")!;
    for (const n of g2.nodes.filter((x) => x.parent === "Order1271")) {
      const here = pos2.get(n.id)!;
      // Nearer its own order than the customer or either other order: beside
      // it, not on the far side of the graph.
      expect(dist(here, parent), n.id).toBeLessThan(dist(here, pos2.get("Order1344")!));
      expect(dist(here, parent), n.id).toBeLessThan(dist(here, pos2.get("Order1493")!));
      expect(dist(here, parent), n.id).toBeLessThan(dist(here, { x: 0, y: 0 }) + 1);
    }
    expectNoOverlap(g2.nodes, pos2);
  });

  it("expanding a second object stacks nothing on the first's", () => {
    const pos1 = layoutGraph(step1.nodes, step1.edges, new Map());
    const g2 = mergeGraph(
      step1,
      childrenOf("Order1271", [271, 871, 1471], [29, 34, 39]),
      "Order1271",
    );
    const pos2 = layoutGraph(g2.nodes, g2.edges, pos1);
    const g3 = mergeGraph(g2, childrenOf("Order1344", [344, 944], [17, 25]), "Order1344");
    const pos3 = layoutGraph(g3.nodes, g3.edges, pos2);
    expectNoOverlap(g3.nodes, pos3);
    for (const n of g2.nodes) expect(pos3.get(n.id)).toEqual(pos2.get(n.id));
  });

  it("keeps a three-step graph of over a hundred objects apart", () => {
    // Three steps out from a customer drew 125 objects in the UI.
    const nodes: GraphNode[] = [customer];
    const edges: GraphEdge[] = [];
    for (let o = 0; o < 6; o++) {
      const order = node(`Order${o}`, 1, "Customer1", String(1000 + o));
      nodes.push(order);
      edges.push(edge(order.id, "Customer1", "placed_by"));
      for (let l = 0; l < 6; l++) {
        const line = node(`OrderLine${o * 10 + l}`, 2, order.id, `Order line ${o * 100 + l}`);
        nodes.push(line);
        edges.push(edge(line.id, order.id, "order"));
        for (let p = 0; p < 2; p++) {
          const product = node(`Product${o}_${l}_${p}`, 3, line.id, `Glacier Sunglasses ${p}`);
          nodes.push(product);
          edges.push(edge(line.id, product.id, "product"));
        }
      }
    }
    expect(nodes.length).toBeGreaterThan(100);
    expectNoOverlap(nodes, layoutGraph(nodes, edges, new Map()));
  });

  it("keeps apart the objects of two neighbours expanded side by side", () => {
    // Two orders drawn close together, each with a full fan: the fans meet,
    // and only the collision force keeps their objects off each other.
    const placed = new Map<string, XY>([
      ["Customer1", { x: 0, y: 0 }],
      ["OrderA", { x: -40, y: -210 }],
      ["OrderB", { x: 40, y: -210 }],
    ]);
    const base = {
      nodes: [customer, node("OrderA", 1, "Customer1", "17"), node("OrderB", 1, "Customer1", "18")],
      edges: [edge("OrderA", "Customer1", "placed_by"), edge("OrderB", "Customer1", "placed_by")],
    };
    const fan = (order: string) => ({
      nodes: [
        node(order, 0),
        ...[1, 2, 3, 4, 5, 6].map((i) =>
          node(`OrderLine${order}${i}`, 1, order, `Order line ${order} ${i}`),
        ),
      ],
      edges: [1, 2, 3, 4, 5, 6].map((i) => edge(`OrderLine${order}${i}`, order, "order")),
    });
    const g1 = mergeGraph(base, fan("OrderA"), "OrderA");
    const p1 = layoutGraph(g1.nodes, g1.edges, placed);
    const g2 = mergeGraph(g1, fan("OrderB"), "OrderB");
    const p2 = layoutGraph(g2.nodes, g2.edges, p1);
    expectNoOverlap(g2.nodes, p2);
  });

  it("fits new objects in among a crowd of objects already drawn", () => {
    // The space above an order is already full of pinned objects (a grid of
    // the customer's other orders); the order's new lines have to settle
    // between them without landing on any.
    const placed = new Map<string, XY>([
      ["Customer1", { x: 0, y: 0 }],
      ["OrderP", { x: 0, y: -210 }],
    ]);
    const base: { nodes: GraphNode[]; edges: GraphEdge[] } = {
      nodes: [customer, node("OrderP", 1, "Customer1", "Order P")],
      edges: [edge("OrderP", "Customer1", "placed_by")],
    };
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 5; col++) {
        const id = `Order${row}${col}`;
        const at = { x: -480 + col * 240, y: -420 - row * 170 };
        placed.set(id, at);
        base.nodes.push(node(id, 1, "Customer1", `Pinned order ${row}${col}`));
        base.edges.push(edge(id, "Customer1", "placed_by"));
      }
    const fan = {
      nodes: [
        node("OrderP", 0),
        ...[1, 2, 3, 4, 5, 6].map((i) => node(`OrderLineP${i}`, 1, "OrderP", `Order line ${i}`)),
      ],
      edges: [1, 2, 3, 4, 5, 6].map((i) => edge(`OrderLineP${i}`, "OrderP", "order")),
    };
    const g = mergeGraph(base, fan, "OrderP");
    expectNoOverlap(g.nodes, layoutGraph(g.nodes, g.edges, placed));
  });

  it("is the same every time for the same graph", () => {
    const a = layoutGraph(step1.nodes, step1.edges, new Map());
    const b = layoutGraph(step1.nodes, step1.edges, new Map());
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("places objects with no drawn parent without looping", () => {
    const loose = [node("A", 2, "Gone"), node("B", 3, "A"), node("C", 2, "Elsewhere")];
    const pos = layoutGraph(loose, [], new Map([["Root", { x: 0, y: 0 }]]));
    expect(pos.size).toBe(3);
  });
});

describe("merging a walk into what is shown", () => {
  it("counts depth from where the graph started, and keeps what was there", () => {
    const g = mergeGraph(step1, childrenOf("Order1271", [271], [29]), "Order1271");
    expect(g.nodes.find((n) => n.id === "OrderLine271")?.depth).toBe(2);
    expect(g.nodes.find((n) => n.id === "Order1271")?.depth).toBe(1);
    expect(g.nodes.find((n) => n.id === "Customer1")?.depth).toBe(0);
    expect(g.edges).toHaveLength(3 + 3);
    // Merging the same walk again adds nothing.
    expect(mergeGraph(g, childrenOf("Order1271", [271], [29]), "Order1271").edges).toHaveLength(6);
  });
});

describe("paths and relationships", () => {
  const g = mergeGraph(step1, childrenOf("Order1271", [271, 871], [29, 34]), "Order1271");

  it("finds the shortest path either way along the links, with which way each reads", () => {
    const p = shortestPath(g.edges, "Customer1", "Product29")!;
    expect(p.nodes).toEqual(["Customer1", "Order1271", "Product29"]);
    expect(p.steps.map((s) => [s.edge.link, s.forward])).toEqual([
      ["placed_by", false], // the order is placed by the customer: read backwards
      ["contains", true],
    ]);
    expect(shortestPath(g.edges, "Customer1", "Customer1")).toEqual({
      nodes: ["Customer1"],
      steps: [],
    });
    expect(shortestPath(g.edges, "Customer1", "Nowhere")).toBeNull();
  });

  it("groups an object's relationships by link and direction", () => {
    expect(relationshipsOf(g.edges, "Order1271")).toEqual([
      { link: "contains", label: "contains", outgoing: true, others: ["Product29", "Product34"] },
      { link: "placed_by", label: "placed by", outgoing: true, others: ["Customer1"] },
      { link: "order", label: "lines", outgoing: false, others: ["OrderLine271", "OrderLine871"] },
    ]);
    // From the customer's side the same link reads as her orders.
    expect(relationshipsOf(g.edges, "Customer1")).toEqual([
      {
        link: "placed_by",
        label: "orders",
        outgoing: false,
        others: ["Order1271", "Order1344", "Order1493"],
      },
    ]);
  });

  it("hides an object and whatever only it joined to the rest", () => {
    const h = hideNode(g, "Order1271", "Customer1");
    expect(h.nodes.map((n) => n.id).sort()).toEqual(["Customer1", "Order1344", "Order1493"]);
    expect(h.edges.every((e) => e.from !== "Order1271" && e.to !== "Order1271")).toBe(true);
    // The start object stays.
    expect(hideNode(g, "Customer1", "Customer1")).toBe(g);
  });
});

describe("an object's title as people read it", () => {
  it("says what a bare number numbers, and leaves a name alone", () => {
    const line = { name: "OrderLine", label: "Order line" } as ObjectType;
    expect(displayTitle(line, "271")).toBe("Order line 271");
    expect(displayTitle(line, "1,063")).toBe("Order line 1,063");
    expect(displayTitle({ name: "Customer" } as ObjectType, "Ava Byrne")).toBe("Ava Byrne");
    expect(displayTitle(undefined, "271")).toBe("271");
  });
});
