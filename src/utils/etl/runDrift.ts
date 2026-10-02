// Whether a pipeline's last run still vouches for what its next run would do.
//
// FOUND IN R183 (sweep item 2, a badge that outlives what it vouched for).
// The pipelines list showed `last_run_status` as the card's chip, and a save
// writes the definition and none of the run stamps. Driven: a pipeline made
// from the reconciliation sample ran ("Succeeded", 309 rows), its target was
// renamed to a table it had never written and saved ("Saved"), and the card
// still read "Succeeded". A visual pipeline is also recompiled by the current
// compiler at every run start (service.server.ts), so an upgrade changes what
// runs next without any edit at all.
//
// Each run stores the program it ran (`etl_runs.source_code`), so the list can
// compare it with the program a run started now would run, the same way the
// run start builds it. No migration: the evidence is already in the rows.
import { normalizeGraph } from "@/utils/etl/codegen";
import { compilePipeline, engineOf } from "@/utils/etl/compile";

export type DriftPipeline = {
  mode: string;
  graph: unknown;
  engine: string | null;
  source_code: string;
};

/**
 * The program a run started now would execute: a visual graph compiled by
 * the current compiler, as the run start does, or the pipeline's own code.
 * Null when the graph no longer compiles, since then no run would start.
 */
export function codeARunWouldRun(p: DriftPipeline): string | null {
  if (p.mode !== "visual") return p.source_code;
  const graph = normalizeGraph(p.graph);
  if (!graph) return p.source_code;
  try {
    return compilePipeline(graph, engineOf(p.engine));
  } catch {
    return null;
  }
}

/**
 * Whether the last finished run ran something other than what the next run
 * would. Null when there is no run to compare with, or its program could not
 * be read: the list then claims nothing either way.
 */
export function changedSinceRun(
  p: DriftPipeline,
  lastRunCode: string | null | undefined,
): boolean | null {
  if (lastRunCode === null || lastRunCode === undefined) return null;
  return codeARunWouldRun(p) !== lastRunCode;
}
