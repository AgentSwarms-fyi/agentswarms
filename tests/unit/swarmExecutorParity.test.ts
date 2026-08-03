// The canvas and the deployment must be the same swarm.
//
// Two executors walk the same graph: swarmRuntime.ts drives the canvas, where
// people build and test, and swarmExecute.server.ts runs headless for the
// public API, schedules and deployed swarms. If they disagree, "it worked when
// I tried it" and "it is wrong in production" are the same swarm — and nobody
// goes looking, because the canvas run is the evidence.
//
// swarmExecute.server says the intent plainly: "Graph semantics live in ONE
// place, shared with the canvas runtime, so the deployed run can't quietly mean
// something different from the one you tested." This checks that claim.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  clampIters,
  FOREACH_DEFAULT_ITEMS,
  FOREACH_MAX_ITEMS,
  LOOP_DEFAULT_ITERS,
  LOOP_MAX_ITERS,
  MAX_SUBSWARM_DEPTH,
  MAX_RETRIES,
} from "@/lib/swarmGraph";

const canvas = readFileSync("src/lib/swarmRuntime.ts", "utf8");
const server = readFileSync("src/utils/swarmExecute.server.ts", "utf8");

const NODE_KINDS = [
  "tool",
  "condition",
  "router",
  "loop",
  "foreach",
  "merge",
  "input",
  "output",
  "http",
  "function",
  "set_var",
  "extract",
  "evaluate",
  "retrieve",
  "approval",
  "subswarm",
];

describe("both executors handle the same node kinds", () => {
  it("has no kind only one of them knows about", () => {
    // A kind the canvas runs and the server does not is a swarm that works in
    // the builder and silently does nothing once deployed.
    for (const kind of NODE_KINDS) {
      const inCanvas = new RegExp(`kind === "${kind}"`).test(canvas);
      const inServer = new RegExp(`kind === "${kind}"`).test(server);
      expect(inCanvas, `${kind} missing from the canvas runtime`).toBe(true);
      expect(inServer, `${kind} missing from the server executor`).toBe(true);
    }
  });
});

describe("iteration bounds are shared, not written out twice", () => {
  // These were bare literals in both files — Math.min(maxIters ?? 3, 6) in one
  // and again in the other. They agreed when checked, but nothing made them,
  // and a loop that runs six times while you watch and three times when
  // deployed is a difference nobody thinks to look for.
  it("clamps to a floor of 1, the node's value, then the ceiling", () => {
    expect(clampIters(undefined, LOOP_DEFAULT_ITERS, LOOP_MAX_ITERS)).toBe(LOOP_DEFAULT_ITERS);
    expect(clampIters(4, LOOP_DEFAULT_ITERS, LOOP_MAX_ITERS)).toBe(4);
    expect(clampIters(999, LOOP_DEFAULT_ITERS, LOOP_MAX_ITERS)).toBe(LOOP_MAX_ITERS);
    expect(clampIters(0, LOOP_DEFAULT_ITERS, LOOP_MAX_ITERS)).toBe(1);
    expect(clampIters(-5, LOOP_DEFAULT_ITERS, LOOP_MAX_ITERS)).toBe(1);
  });

  it("keeps 0 as a real request rather than falling back to the default", () => {
    // `?? ` not `||`: a node set to 0 means "as few as possible", which clamps
    // to 1. Coercing it to the default would run it three times instead.
    expect(clampIters(0, 3, 6)).toBe(1);
    expect(clampIters(0, 25, 100)).toBe(1);
  });

  it("uses the same ceilings for for-each", () => {
    expect(clampIters(undefined, FOREACH_DEFAULT_ITEMS, FOREACH_MAX_ITEMS)).toBe(25);
    expect(clampIters(5_000, FOREACH_DEFAULT_ITEMS, FOREACH_MAX_ITEMS)).toBe(100);
  });

  it("is called by both executors instead of re-deriving the arithmetic", () => {
    for (const [name, src] of [
      ["canvas", canvas],
      ["server", server],
    ] as const) {
      expect(src, `${name} does not use clampIters`).toContain("clampIters(");
      expect(src, `${name} re-derives an iteration clamp inline`).not.toMatch(
        /Math\.min\((?:node\.data|d)\.maxIters/,
      );
    }
  });
});

describe("the bounds that stop a swarm running forever", () => {
  it("caps nesting, iterations and retries at sane values", () => {
    // Asserted as ranges, not exact numbers: the point is that a ceiling
    // exists and is small, not that it is any particular figure.
    expect(MAX_SUBSWARM_DEPTH).toBeGreaterThan(0);
    expect(MAX_SUBSWARM_DEPTH).toBeLessThanOrEqual(10);
    expect(LOOP_MAX_ITERS).toBeGreaterThanOrEqual(LOOP_DEFAULT_ITERS);
    expect(FOREACH_MAX_ITEMS).toBeGreaterThanOrEqual(FOREACH_DEFAULT_ITEMS);
    expect(MAX_RETRIES).toBeLessThanOrEqual(10);
  });

  it("enforces the nesting depth in the executor that can recurse", () => {
    // Only the server executor runs sub-swarms headlessly, and unbounded
    // recursion there is a self-calling swarm consuming the account.
    expect(server).toContain("depth >= MAX_SUBSWARM_DEPTH");
  });
});

describe("graph semantics come from one module", () => {
  it("the server imports them rather than reimplementing", () => {
    // Each of these decides what the graph MEANS: which nodes run at a level,
    // how a branch prunes the rest, whether a failure stops the run, and how
    // a judge's answer becomes an edge.
    //
    // Checked against the IMPORT BLOCKS, not the whole file. A first version
    // asserted the name appeared anywhere in the source, which a call site
    // satisfies on its own — so deleting the import and defining a local copy
    // would have passed.
    const imported = new Set(
      [...server.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/lib\/swarm(?:Runtime|Graph)"/g)]
        .flatMap((m) => m[1].split(","))
        .map((s) => s.replace(/^\s*type\s+/, "").trim())
        .filter(Boolean),
    );
    for (const fn of [
      "topoLevels",
      "gatherInputs",
      "decideYesNo",
      "interpolate",
      "resolveStatePath",
      "SkipTracker",
      "canContinueOnError",
      "retryPolicyOf",
    ]) {
      expect(imported.has(fn), `${fn} is not imported from the shared modules`).toBe(true);
    }
  });

  it("defines the yes/no judge in exactly one place", () => {
    expect(canvas).toContain("export function decideYesNo");
    expect(server, "the server has its own copy of the judge").not.toContain(
      "function decideYesNo",
    );
  });
});
