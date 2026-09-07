// One graph, two compilers.
//
// The pandas compiler is what every pipeline has always used and its output is
// pinned byte-for-byte by its tests; it does not know the Spark engine exists.
// The Spark compiler imports the pandas compiler's helpers and re-emits the
// nodes it runs on the driver. This module is the only place the two meet, so
// adding an engine is a case here and nowhere else — and importing either
// compiler directly is still fine for code that has already chosen one.
import { compileGraph, requirementsFor, type EtlGraph } from "@/utils/etl/codegen";
import {
  ETL_ENGINES,
  compileSparkGraph,
  sparkRequirementsFor,
  type EtlEngine,
} from "@/utils/etl/sparkCodegen";

export { ETL_ENGINES, type EtlEngine };

/** The engine a stored value names, with anything unknown read as the default. */
export function engineOf(value: unknown): EtlEngine {
  return value === "spark" ? "spark" : "pandas";
}

export function compilePipeline(graph: EtlGraph, engine: EtlEngine): string {
  return engine === "spark" ? compileSparkGraph(graph) : compileGraph(graph);
}

export function pipelineRequirements(graph: EtlGraph, engine: EtlEngine): string {
  return engine === "spark" ? sparkRequirementsFor(graph) : requirementsFor(graph);
}
