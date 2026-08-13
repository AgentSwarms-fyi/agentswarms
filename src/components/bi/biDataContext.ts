// Shared "connected data" context handed to the BI widget dialogs by the
// project editor: local AlaSQL datasets + external warehouse connections,
// with a uniform way to run SQL against either.
import type { DatasetMeta, QueryResult } from "@/lib/sqlEngine";
import type { SavedMetric, SemanticEntry } from "@/lib/biAgent";
import type { BiWidgetSource } from "@/lib/biDashboards";
import type { SemanticQuery } from "@/lib/semanticLayer";
import type { WarehouseConnectionSummary, WarehouseTable } from "@/utils/warehouse/types";

/** A governed semantic model, as the builder's metric source offers it. */
export type MetricModelOption = {
  name: string;
  label: string | null;
  dimensions: Array<{ name: string; type?: string }>;
  metrics: Array<{ name: string; agg: string; format?: string; currency?: string }>;
  /**
   * Shared with the viewer under a restrictive policy (row filters or field
   * masks). Enforcement lives server-side; this flag exists so the picker can
   * SAY the numbers will be a scoped view before the first preview runs.
   */
  scoped?: boolean;
};

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
  /**
   * Governed metric source (Semantic Layer). Both are provided together by
   * the project editor; their presence is what makes the builder offer
   * "Governed metrics" as a data source.
   */
  listMetricModels?: () => Promise<MetricModelOption[]>;
  runMetric?: (query: SemanticQuery) => Promise<{
    columns: string[];
    rows: Record<string, unknown>[];
    sql: string;
    rollup?: string;
    /** Present when a share policy scoped the rows — disclosed on the preview. */
    access_note?: string;
  }>;
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
