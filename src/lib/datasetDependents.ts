// Which dashboards read a dataset: the dashboard half of the impact check
// shown before a dataset is deleted (datasetDependents in
// utils/dataPrep.functions). Pure, so tests feed it stored row shapes.
import { allDashboardWidgets } from "@/lib/biDashboards";

/** What is built on a dataset, and the flows that build it (computeDatasetDependents). */
export type FlowDependent = {
  id: string;
  name: string;
  refreshEnabled?: boolean | null;
  refreshEveryMinutes?: number | null;
  lastRefreshAt?: string | null;
  lastRefreshError?: string | null;
};

export type DatasetDependents = {
  /** Flows that READ this dataset (base, join, or append source). */
  flowsUsing: { id: string; name: string }[];
  /** Flows whose OUTPUT is this dataset — deleting it breaks their refresh. */
  flowsProducing: FlowDependent[];
  semanticModels: { id: string; name: string }[];
  /** Dashboards whose widget SQL mentions the table name. */
  dashboards: { id: string; name: string }[];
  savedMetrics: number;
};

/** Word-boundary match so "orders" doesn't match "orders_archive". */
export function mentionsTable(sql: string, table: string): boolean {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`, "i").test(sql);
}

/**
 * Dashboards with a widget whose SQL mentions the table, on ANY page (R510).
 * The check read only the top-level `widgets`, which mirrors page 1, so a
 * dataset used on page 2 alone was reported as safe to delete.
 */
export function dashboardsUsingTable(
  dashboards: Array<{ id: string; name: string; widgets: unknown; pages?: unknown }>,
  table: string,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const d of dashboards) {
    const hit = (allDashboardWidgets(d) as { sql?: unknown }[]).some(
      (w) => typeof w?.sql === "string" && mentionsTable(w.sql, table),
    );
    if (hit) out.push({ id: d.id, name: d.name });
  }
  return out;
}
