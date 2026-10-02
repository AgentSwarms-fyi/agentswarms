// A pipeline's status chip vouches only for what its last run ran (R183).
//
// FOUND IN R183 (sweep item 2, a badge that outlives what it vouched for).
// Driven: a pipeline made from the reconciliation sample ran ("Succeeded",
// 309 rows); its "Reconciled" target was pointed at orders_reconciled_r183, a
// table it had never written, and saved; the card still read "Succeeded". A
// save writes the definition and none of the run stamps, and a visual
// pipeline is recompiled by the current compiler at every run start, so an
// upgrade changes what runs next without any edit either.
//
// The comparison runs on the real compiler over the real sample graph.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ETL_TEMPLATES } from "@/lib/etlTemplates";
import type { EtlGraph } from "@/utils/etl/codegen";
import { compilePipeline, engineOf } from "@/utils/etl/compile";
import { changedSinceRun, codeARunWouldRun } from "@/utils/etl/runDrift";

const sample = ETL_TEMPLATES.find((t) => t.id === "reconciliation");
if (!sample?.graph) throw new Error("the reconciliation sample moved; re-anchor this test");
const GRAPH = sample.graph;
const clone = (g: EtlGraph): EtlGraph => JSON.parse(JSON.stringify(g)) as EtlGraph;
const visual = (graph: unknown, engine: string | null = null) => ({
  mode: "visual",
  graph,
  engine,
  source_code: "# the program the last save compiled",
});
const ranNow = (graph: EtlGraph, engine: string | null = null) =>
  compilePipeline(graph, engineOf(engine));

describe("a visual pipeline", () => {
  it("is unchanged since a run of the program the current compiler makes", () => {
    expect(changedSinceRun(visual(GRAPH), ranNow(GRAPH))).toBe(false);
    // What makes the answer trustworthy: the compiler is deterministic.
    expect(ranNow(clone(GRAPH))).toBe(ranNow(GRAPH));
  });

  it("has changed once its target points at another table (the driven edit)", () => {
    const edited = clone(GRAPH);
    const target = edited.nodes.find((n) => n.label === "Reconciled");
    expect(target).toBeTruthy();
    (target!.config as { table: string }).table = "orders_reconciled_r183";
    expect(changedSinceRun(visual(edited), ranNow(GRAPH))).toBe(true);
  });

  it("is compiled for its own engine", () => {
    // Switching the engine is a change: Spark gets another program.
    expect(ranNow(GRAPH, "spark")).not.toBe(ranNow(GRAPH));
    expect(changedSinceRun(visual(GRAPH, "spark"), ranNow(GRAPH, "spark"))).toBe(false);
    expect(changedSinceRun(visual(GRAPH, "spark"), ranNow(GRAPH))).toBe(true);
  });

  it("has changed when the compiler did, with no edit at all", () => {
    expect(changedSinceRun(visual(GRAPH), `${ranNow(GRAPH)}\n# an older compiler`)).toBe(true);
  });

  it("is compared with what a run would compile, not with the program the last save stored", () => {
    // The stored source_code is a cache the run start ignores (R-before: the
    // run recompiles), so a stale cache alone is not a change.
    const p = visual(GRAPH);
    expect(p.source_code).not.toBe(ranNow(GRAPH));
    expect(changedSinceRun(p, ranNow(GRAPH))).toBe(false);
  });

  it("has changed when its graph no longer compiles, since no run would start", () => {
    const broken = clone(GRAPH);
    broken.edges.push({ id: "e-broken", from: broken.nodes[0].id, to: "nowhere" });
    expect(codeARunWouldRun(visual(broken))).toBeNull();
    expect(changedSinceRun(visual(broken), ranNow(GRAPH))).toBe(true);
  });
});

describe("a code pipeline", () => {
  it("is compared by its own program", () => {
    const code = { mode: "code", graph: null, engine: null, source_code: "print('v2')" };
    expect(changedSinceRun(code, "print('v2')")).toBe(false);
    expect(changedSinceRun(code, "print('v1')")).toBe(true);
  });
});

describe("with nothing to compare", () => {
  it("claims nothing", () => {
    expect(changedSinceRun(visual(GRAPH), null)).toBeNull();
    expect(changedSinceRun(visual(GRAPH), undefined)).toBeNull();
  });
});

describe("the overview and the card", () => {
  const fns = readFileSync("src/utils/etl.functions.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/etl.tsx", "utf8");
  const helper = fns.slice(
    fns.indexOf("async function lastRunDrift("),
    fns.indexOf("\n}\n", fns.indexOf("async function lastRunDrift(")),
  );
  const overview = fns.slice(
    fns.indexOf("export const getEtlOverview"),
    fns.indexOf("// ── Create / update"),
  );

  it("compares with the run that wrote the status: the latest that finished", () => {
    expect(helper).toMatch(
      /\.from\("etl_runs"\)\s*\.select\("source_code"\)\s*\.eq\("pipeline_id", p\.id\)\s*\.in\("status", \["succeeded", "failed"\]\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(1\)/,
    );
    expect(helper).toMatch(/if \(!p\.last_run_status\) return drift\.set\(p\.id, null\);/);
    // A read that failed claims nothing, rather than "unchanged".
    expect(helper).toMatch(
      /drift\.set\(p\.id, error \? null : changedSinceRun\(p, run\?\.source_code\)\)/,
    );
  });

  it("reads the definition for this, and leaves it out of the answer", () => {
    expect(overview).toMatch(/last_run_status, [^"]*, graph, source_code, engine"/);
    expect(overview).toMatch(/const drift = await lastRunDrift\(pipelines \?\? \[\]\);/);
    expect(overview).toMatch(/\(\{ graph: _g, source_code: _s, engine: _e, \.\.\.p \}\)/);
    expect(overview).toMatch(/changed_since_last_run: drift\.get\(p\.id\) \?\? null,/);
  });

  it("says so under the chip", () => {
    expect(page).toMatch(
      /<StatusChip status=\{p\.last_run_status\} \/>\s*\{\/\*[^*]*\*\/\}\s*\{p\.changed_since_last_run && \(/,
    );
    expect(page).toContain("changed since this run");
  });
});
