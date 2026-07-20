// Shared "connected data" context handed to the BI widget dialogs by the
// project editor: local AlaSQL datasets + external warehouse connections,
// with a uniform way to run SQL against either.
import type { DatasetMeta, QueryResult } from "@/lib/sqlEngine";
import type { SavedMetric, SemanticEntry } from "@/lib/biAgent";
import type { BiWidgetSource } from "@/lib/biDashboards";
import type { WarehouseConnectionSummary, WarehouseTable } from "@/utils/warehouse/types";

export type BiDataContext = {
  userId: string | null;
  datasets: DatasetMeta[];
  /** Names of datasets produced by data-prep flows (badged in pickers). */
  preparedTables?: Set<string>;
  /** Preferred text model for generative features (null = server default). */
  model?: string | null;
  onModelChange?: (model: string | null) => void;
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  warehouses: WarehouseConnectionSummary[];
  whTables: Record<string, WarehouseTable[] | "loading" | "error">;
  /** Lazily load a warehouse connection's table list into whTables. */
  ensureSchema: (connectionId: string) => void;
  /** Run read-only SQL against a widget source (local engine or warehouse). */
  runSql: (source: BiWidgetSource, sql: string) => Promise<QueryResult>;
};

export function sourceFromKey(
  key: string,
  warehouses: WarehouseConnectionSummary[],
): BiWidgetSource {
  if (key === "local") return { kind: "local" };
  const conn = warehouses.find((w) => w.id === key);
  return {
    kind: "warehouse",
    connection_id: key,
    connection_name: conn?.name ?? "warehouse",
    provider: conn?.provider ?? "unknown",
  };
}

export function keyFromSource(source: BiWidgetSource | undefined): string {
  return source && source.kind === "warehouse" ? source.connection_id : "local";
}
