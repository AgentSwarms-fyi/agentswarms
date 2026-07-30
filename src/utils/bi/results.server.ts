// Server-side access to bi_widget_results (the widget-data store split out of
// the dashboard document). Two callers:
//   - the scheduled refresh, writing fresh snapshots;
//   - the anonymous surfaces (public share, embeds), which hydrate with the
//     service role because their viewers have no session for RLS to evaluate.
// The merge itself is the same pure helper the client uses, so owner, grantee
// and anonymous viewers all see identical merge semantics.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { mergePagesResults, mergeWidgetResults, type WidgetResultRow } from "@/lib/biDashboards";

/** Load one dashboard's stored results (service role — caller gates access). */
export async function fetchWidgetResultsAdmin(dashboardId: string): Promise<WidgetResultRow[]> {
  const { data, error } = await supabaseAdmin
    .from("bi_widget_results")
    .select("widget_id, columns, rows, truncated, refreshed_at")
    .eq("dashboard_id", dashboardId);
  if (error) throw new Error(error.message);
  return (data ?? []) as WidgetResultRow[];
}

/**
 * Merge stored results into a dashboard row's widgets/pages, in place on a
 * copy. Best-effort: on any failure the caller keeps the document's own rows,
 * which is the pre-split behaviour.
 */
export async function hydrateDashboardAdmin<T extends { id?: string; widgets: Json; pages: Json }>(
  dashboardId: string,
  row: T,
): Promise<T> {
  try {
    const results = await fetchWidgetResultsAdmin(dashboardId);
    if (results.length === 0) return row;
    return {
      ...row,
      widgets: mergeWidgetResults(row.widgets, results) as Json,
      pages: mergePagesResults(row.pages, results) as Json,
    };
  } catch {
    return row;
  }
}

/** Upsert refreshed snapshots for a dashboard's widgets (service role). */
export async function upsertWidgetResultsAdmin(
  dashboardId: string,
  ownerId: string,
  widgets: {
    id?: string;
    kind?: string;
    columns?: string[];
    rows?: Record<string, unknown>[];
    truncated?: boolean;
    refreshed_at?: string;
  }[],
): Promise<void> {
  const payload = widgets
    .filter((w) => w.kind === "chart" && typeof w.id === "string" && Array.isArray(w.rows))
    .map((w) => ({
      dashboard_id: dashboardId,
      widget_id: w.id as string,
      user_id: ownerId,
      columns: (w.columns ?? []) as unknown as Json,
      rows: (w.rows ?? []) as unknown as Json,
      truncated: Boolean(w.truncated),
      refreshed_at: w.refreshed_at ?? new Date().toISOString(),
    }));
  if (payload.length === 0) return;
  const { error } = await supabaseAdmin
    .from("bi_widget_results")
    .upsert(payload, { onConflict: "dashboard_id,widget_id" });
  if (error) throw new Error(error.message);
}
