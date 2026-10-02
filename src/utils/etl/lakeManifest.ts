// What an ETL run may do in the lakehouse, and nothing else.
//
// Built when the sandbox fetches its environment and pinned on its session;
// the app then serves the sandbox these reads and loads by node id
// (src/utils/lakehouse/sandboxLake.server.ts), never SQL the sandbox sends.
import { isCatalogAsset, unwrapSourceConfig } from "@/utils/etl/catalogAsset";
import { lakehouseSourceSql, type EtlNode } from "@/utils/etl/codegen";
import { CONTINUOUS_SCHEDULE, exactlyOnceEligible } from "@/utils/etl/continuous";
import type { LakeManifest } from "@/utils/lakehouse/sandboxLake.server";

type Node = { id: string; kind: string; config: unknown; label?: string };

/** A source's config as the compiler sees it: a catalog asset is what it resolved to. */
function effective(n: Node): Record<string, unknown> {
  const c = n.config as { type?: string };
  return (
    n.kind === "source" && isCatalogAsset(c as never) ? unwrapSourceConfig(c as never) : c
  ) as Record<string, unknown>;
}

export function etlLakeManifest(
  pipeline: { id: string; schedule?: string | null },
  graph: { nodes?: Node[] } | null | undefined,
  opts?: { skipTargets?: boolean },
): LakeManifest | null {
  const nodes = (graph?.nodes ?? []).filter((n) => effective(n).type === "lakehouse");
  if (!nodes.length) return null;
  const label = (n: Node) => (n as EtlNode).label || n.id;
  return {
    reads: Object.fromEntries(
      nodes
        .filter((n) => n.kind === "source")
        .map((n) => [n.id, { label: label(n), sql: lakehouseSourceSql(label(n), effective(n)) }]),
    ),
    writes: opts?.skipTargets
      ? {}
      : Object.fromEntries(
          nodes
            .filter((n) => n.kind === "target")
            .map((n) => {
              const c = n.config as {
                schema?: string;
                table?: string;
                write_mode?: string;
                primary_key?: string[];
              };
              return [
                n.id,
                {
                  label: label(n),
                  schema: c.schema ?? "",
                  table: c.table ?? "",
                  mode:
                    c.write_mode === "merge"
                      ? ("upsert" as const)
                      : c.write_mode === "replace"
                        ? ("replace" as const)
                        : ("append" as const),
                  primaryKey: c.primary_key ?? [],
                },
              ];
            }),
        ),
    // Exactly-once: the run's positions commit with its loads, for this
    // pipeline's own sources only.
    ...(pipeline.schedule === CONTINUOUS_SCHEDULE && exactlyOnceEligible(graph as never)
      ? {
          cursors: {
            pipelineId: pipeline.id,
            nodes: (graph?.nodes ?? []).filter((n) => n.kind === "source").map((n) => n.id),
          },
        }
      : {}),
  };
}
