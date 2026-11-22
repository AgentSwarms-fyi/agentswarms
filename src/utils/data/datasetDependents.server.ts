// What is built on a dataset, and the flows that build it.
//
// One reading for the two places that ask: deleting a dataset (what breaks)
// and the dataset's page (what uses it, where it comes from). They used to be
// two lookups that disagreed. Run with the caller's own client, so row-level
// security limits it to the caller's own objects.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  dashboardsUsingTable,
  type DatasetDependents,
  type FlowDependent,
} from "@/lib/datasetDependents";

export type { DatasetDependents, FlowDependent };

export async function computeDatasetDependents(
  sb: SupabaseClient<Database>,
  tableId: string,
  tableName: string,
): Promise<DatasetDependents> {
  const [{ data: flows }, { data: models }, { data: dashboards }, { count: metricCount }] =
    await Promise.all([
      sb
        .from("user_prep_flows")
        .select(
          "id, name, config, output_table_id, refresh_enabled, refresh_interval_minutes, last_refresh_at, last_refresh_error",
        ),
      sb.from("semantic_models").select("id, name, source_table, source_kind, table_id"),
      // `pages` too: the top-level widgets only mirror page 1 (R510).
      sb.from("bi_dashboards").select("id, name, widgets, pages"),
      sb
        .from("user_saved_metrics")
        .select("id", { head: true, count: "exact" })
        .eq("table_id", tableId),
    ]);

  const flowsUsing: { id: string; name: string }[] = [];
  const flowsProducing: FlowDependent[] = [];
  for (const f of flows ?? []) {
    if (f.output_table_id === tableId) {
      flowsProducing.push({
        id: f.id,
        name: f.name,
        refreshEnabled: f.refresh_enabled,
        refreshEveryMinutes: f.refresh_interval_minutes,
        lastRefreshAt: f.last_refresh_at,
        lastRefreshError: f.last_refresh_error,
      });
      continue;
    }
    // The config holds base/joins/append-step table names.
    const cfg = f.config as { base?: string; joins?: { table?: string }[]; steps?: unknown[] };
    const names = new Set<string>();
    if (typeof cfg?.base === "string") names.add(cfg.base);
    for (const j of cfg?.joins ?? []) if (j?.table) names.add(j.table);
    for (const s of (cfg?.steps ?? []) as { kind?: string; table?: string }[]) {
      if (s?.kind === "append" && s.table) names.add(s.table);
    }
    if (names.has(tableName)) flowsUsing.push({ id: f.id, name: f.name });
  }

  // By the id the model keeps, or (for models made before it kept one) by name.
  const semanticModels = (models ?? [])
    .filter(
      (m) =>
        m.table_id === tableId || (m.source_kind === "data_table" && m.source_table === tableName),
    )
    .map((m) => ({ id: m.id, name: m.name }));

  return {
    flowsUsing,
    flowsProducing,
    semanticModels,
    dashboards: dashboardsUsingTable(dashboards ?? [], tableName),
    savedMetrics: metricCount ?? 0,
  };
}
