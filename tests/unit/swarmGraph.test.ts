// Swarm execution semantics.
//
// swarmGraph.ts exists so the canvas executor and the headless one cannot drift
// apart — it is the single definition of what a swarm graph MEANS. It had no
// tests, which made it a single point of failure rather than a single source of
// truth: a wrong edit here changes the behaviour of every swarm, deployed and
// on-canvas, at once.
//
// The properties worth protecting are the ones whose breakage is quiet:
// execution ORDER, DETERMINISM under parallelism, and whether a failed node may
// be skipped past. A swarm that returns a different answer on Tuesday is far
// worse than one that throws.

import { describe, expect, it } from "vitest";

import {
  canContinueOnError,
  commitLevelWrites,
  DEFAULT_RETRY_DELAY_MS,
  indexEdges,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  retryPolicyOf,
  SkipTracker,
  topoLevelIds,
  type GraphEdge,
} from "@/lib/swarmGraph";

const n = (...ids: string[]) => ids.map((id) => ({ id }));
const e = (id: string, source: string, target: string): GraphEdge => ({ id, source, target });

describe("topoLevelIds", () => {
  it("orders a chain one node per level", () => {
    const levels = topoLevelIds(n("a", "b", "c"), [e("1", "a", "b"), e("2", "b", "c")]);
    expect(levels).toEqual([["a"], ["b"], ["c"]]);
  });

  it("puts independent nodes in the SAME level", () => {
    // This is what makes parallel execution possible; if it regresses, swarms
    // silently serialise and get slower rather than failing.
    const levels = topoLevelIds(n("a", "b", "c"), [e("1", "a", "b"), e("2", "a", "c")]);
    expect(levels[0]).toEqual(["a"]);
    expect(new Set(levels[1])).toEqual(new Set(["b", "c"]));
  });

  it("joins a diamond only after BOTH sides", () => {
    const levels = topoLevelIds(n("a", "b", "c", "d"), [
      e("1", "a", "b"),
      e("2", "a", "c"),
      e("3", "b", "d"),
      e("4", "c", "d"),
    ]);
    expect(levels[0]).toEqual(["a"]);
    expect(new Set(levels[1])).toEqual(new Set(["b", "c"]));
    expect(levels[2]).toEqual(["d"]);
  });

  it("ignores a self-edge — that is a loop node iterating, not a dependency", () => {
    // Treating it as a dependency would make every loop swarm undeployable.
    const levels = topoLevelIds(n("a", "b"), [e("1", "a", "b"), e("loop", "b", "b")]);
    expect(levels).toEqual([["a"], ["b"]]);
  });

  it("refuses a real cycle instead of looping forever", () => {
    expect(() => topoLevelIds(n("a", "b"), [e("1", "a", "b"), e("2", "b", "a")])).toThrow(/cycle/i);
  });

  it("places disconnected nodes in the first level", () => {
    const levels = topoLevelIds(n("a", "lonely"), []);
    expect(new Set(levels[0])).toEqual(new Set(["a", "lonely"]));
  });

  it("includes every node exactly once", () => {
    const nodes = n("a", "b", "c", "d", "e");
    const flat = topoLevelIds(nodes, [e("1", "a", "b"), e("2", "b", "c"), e("3", "a", "d")]).flat();
    expect(flat.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("tolerates an edge naming a node that does not exist", () => {
    // Imported or AI-authored graphs carry anything; a dangling edge must not
    // wedge the ordering pass.
    expect(() => topoLevelIds(n("a"), [e("1", "ghost", "a")])).not.toThrow();
  });
});

describe("retryPolicyOf", () => {
  it("defaults to no retries", () => {
    expect(retryPolicyOf({})).toEqual({ retries: 0, delayMs: DEFAULT_RETRY_DELAY_MS });
  });

  it("clamps to the supported range rather than trusting the graph", () => {
    // A swarm can arrive as JSON from an import or from the AI builder, so the
    // numbers are untrusted input, not configuration.
    expect(retryPolicyOf({ retryCount: 999 }).retries).toBe(MAX_RETRIES);
    expect(retryPolicyOf({ retryCount: -3 }).retries).toBe(0);
    expect(retryPolicyOf({ retryDelayMs: 10_000_000 }).delayMs).toBe(MAX_RETRY_DELAY_MS);
    expect(retryPolicyOf({ retryDelayMs: -1 }).delayMs).toBe(0);
  });

  it("falls back on values that are not numbers at all", () => {
    expect(retryPolicyOf({ retryCount: NaN }).retries).toBe(0);
    expect(retryPolicyOf({ retryCount: null, retryDelayMs: null })).toEqual({
      retries: 0,
      delayMs: DEFAULT_RETRY_DELAY_MS,
    });
    expect(retryPolicyOf({ retryDelayMs: Number.POSITIVE_INFINITY }).delayMs).toBe(
      DEFAULT_RETRY_DELAY_MS,
    );
  });
});

describe("canContinueOnError", () => {
  it("continues past an ordinary node that opted in", () => {
    expect(canContinueOnError({ kind: "agent", onError: "continue" })).toBe(true);
  });

  it("fails by default", () => {
    expect(canContinueOnError({ kind: "agent" })).toBe(false);
    expect(canContinueOnError({ kind: "agent", onError: "fail" })).toBe(false);
  });

  it("NEVER continues past a failed branch node, even if it opted in", () => {
    // A condition that failed chose nothing, so every outgoing edge is still
    // live and both paths would run — an approval branch AND its bypass.
    for (const kind of ["condition", "router"]) {
      expect(canContinueOnError({ kind, onError: "continue" }), kind).toBe(false);
    }
  });

  it("NEVER continues a cancelled or out-of-budget run", () => {
    // Continuing would defeat the limit that stopped the run.
    expect(canContinueOnError({ kind: "agent", onError: "continue" }, { aborted: true })).toBe(
      false,
    );
    expect(canContinueOnError({ kind: "agent", onError: "continue" }, { expired: true })).toBe(
      false,
    );
  });
});

describe("commitLevelWrites", () => {
  const staged = (nodeId: string, writes: [string, string][], output: string | null = null) => ({
    nodeId,
    writes,
    output,
  });

  it("defaults to last-write-wins IN LEVEL ORDER, not completion order", () => {
    // The determinism guarantee: enabling parallelism must not change results.
    // If this reduces in arrival order, the same swarm answers differently on
    // different days depending on which model replied first.
    const { ctx } = commitLevelWrites({}, [
      staged("first", [["k", "1"]]),
      staged("second", [["k", "2"]]),
    ]);
    expect(ctx.k).toBe("2");
  });

  it("supports first / concat / sum reducers", () => {
    const writes = [staged("a", [["k", "10"]]), staged("b", [["k", "5"]])];
    expect(commitLevelWrites({}, writes, { k: "first" }).ctx.k).toBe("10");
    expect(commitLevelWrites({}, writes, { k: "concat" }).ctx.k).toBe("10\n\n5");
    expect(commitLevelWrites({}, writes, { k: "sum" }).ctx.k).toBe("15");
  });

  it("sum ignores non-numeric noise rather than producing NaN", () => {
    const { ctx } = commitLevelWrites({}, [
      staged("a", [["k", "$1,200"]]),
      staged("b", [["k", "not a number"]]),
    ]);
    expect(commitLevelWrites({}, [staged("a", [["k", "$1,200"]])], { k: "sum" }).ctx.k).toBe(
      "1200",
    );
    expect(ctx.k).toBe("not a number"); // default reducer is untouched by this
  });

  it("keeps a node's own last value when it writes the same key twice", () => {
    const { ctx } = commitLevelWrites({}, [
      staged("a", [
        ["k", "one"],
        ["k", "two"],
      ]),
    ]);
    expect(ctx.k).toBe("two");
  });

  it("reports the last output IN LEVEL ORDER, skipping nodes that produced none", () => {
    const { lastOutput } = commitLevelWrites({}, [
      staged("a", [], "from a"),
      staged("b", [], null),
    ]);
    expect(lastOutput).toBe("from a");
  });

  it("leaves keys nobody wrote alone", () => {
    const { ctx } = commitLevelWrites({ existing: "kept" }, [staged("a", [["fresh", "v"]])]);
    expect(ctx.existing).toBe("kept");
    expect(ctx.fresh).toBe("v");
  });

  it("returns a null output when the level produced nothing", () => {
    expect(commitLevelWrites({}, [staged("a", [])]).lastOutput).toBeNull();
    expect(commitLevelWrites({}, []).lastOutput).toBeNull();
  });
});

describe("SkipTracker", () => {
  it("skips a node whose only route in is dead", () => {
    const graph = indexEdges([e("1", "cond", "yes"), e("2", "cond", "no")]);
    const t = new SkipTracker(graph);
    t.killEdges(["2"]); // the branch not taken
    t.propagateSkip(["no"]);
    expect(t.isSkipped("no")).toBe(true);
    expect(t.isSkipped("yes")).toBe(false);
  });

  it("cascades downstream", () => {
    const graph = indexEdges([e("1", "cond", "no"), e("2", "no", "after"), e("3", "after", "end")]);
    const t = new SkipTracker(graph);
    t.killEdges(["1"]);
    t.propagateSkip(["no"]);
    expect([t.isSkipped("no"), t.isSkipped("after"), t.isSkipped("end")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("does NOT skip a join that one live branch still reaches", () => {
    // The "all incoming dead" rule is what makes a diamond work. An "any dead"
    // rule would silently prune half of every branching swarm.
    const graph = indexEdges([
      e("1", "cond", "a"),
      e("2", "cond", "b"),
      e("3", "a", "join"),
      e("4", "b", "join"),
    ]);
    const t = new SkipTracker(graph);
    t.killEdges(["2"]);
    t.propagateSkip(["b"]);
    expect(t.isSkipped("b")).toBe(true);
    expect(t.isSkipped("join")).toBe(false);
  });

  it("terminates on a re-convergent graph", () => {
    // Breadth-first with a visited check; without it this loops forever and
    // takes the whole run with it.
    const graph = indexEdges([
      e("1", "x", "a"),
      e("2", "x", "b"),
      e("3", "a", "j"),
      e("4", "b", "j"),
      e("5", "j", "a"),
    ]);
    const t = new SkipTracker(graph);
    t.killEdges(["1", "2"]);
    expect(() => t.propagateSkip(["a", "b"])).not.toThrow();
  });

  it("treats an edge out of a skipped node as dead", () => {
    const graph = indexEdges([e("1", "cond", "no"), e("2", "no", "after")]);
    const t = new SkipTracker(graph);
    t.killEdges(["1"]);
    t.propagateSkip(["no"]);
    expect(t.isEdgeLive(e("2", "no", "after"))).toBe(false);
    expect(t.liveIncoming("after")).toHaveLength(0);
  });

  it("a node with no incoming edges is skipped when asked directly", () => {
    // `every` over an empty list is true, so a root has no live route in.
    const t = new SkipTracker(indexEdges([]));
    t.propagateSkip(["orphan"]);
    expect(t.isSkipped("orphan")).toBe(true);
  });
});

describe("indexEdges", () => {
  it("indexes both directions", () => {
    const graph = indexEdges([e("1", "a", "b"), e("2", "a", "c"), e("3", "b", "c")]);
    expect(graph.outgoing.get("a")).toHaveLength(2);
    expect(graph.incoming.get("c")).toHaveLength(2);
    expect(graph.incoming.get("a")).toBeUndefined();
  });
});
