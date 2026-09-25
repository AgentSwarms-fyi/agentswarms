// Sheets version history, the server half shared by the version functions
// and the grid save (which takes an automatic version): a workbook's sheets
// as saved, and taking a version of them. Kept out of the *.functions files
// so nothing here reaches a browser bundle.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";

export type VersionKind = "auto" | "named" | "before_restore";

export type SnapshotTab = {
  name: string;
  kind: "grid" | "table";
  position: number;
  grid: Json;
  table_config: Json | null;
};

/** The workbook's sheets as saved, in order. */
export async function snapshotOf(workbookId: string): Promise<SnapshotTab[]> {
  const { data, error } = await supabaseAdmin
    .from("sheet_tabs")
    .select("name, kind, position, grid, table_config")
    .eq("workbook_id", workbookId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not read the sheets: ${error.message}`);
  return (data ?? []) as SnapshotTab[];
}

/**
 * Take a version. Automatic ones are skipped when the last is younger than
 * the interval, and pruned past the maximum (named ones are kept).
 */
export async function takeVersion(
  workbookId: string,
  userId: string,
  kind: VersionKind,
  label: string | null,
): Promise<{ taken: boolean }> {
  const settings = await getPlatformResources();
  if (kind === "auto") {
    const { data: last } = await supabaseAdmin
      .from("sheet_workbook_versions")
      .select("created_at")
      .eq("workbook_id", workbookId)
      .eq("kind", "auto")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const age = last ? Date.now() - Date.parse(last.created_at) : Infinity;
    if (age < settings.sheetsVersionIntervalMinutes * 60_000) return { taken: false };
  }
  const tabs = await snapshotOf(workbookId);
  const text = JSON.stringify(tabs);
  const { error } = await supabaseAdmin.from("sheet_workbook_versions").insert({
    workbook_id: workbookId,
    user_id: userId,
    created_by: userId,
    kind,
    label,
    snapshot: tabs as unknown as Json,
    sheet_count: tabs.length,
    size_bytes: text.length,
  });
  if (error) throw new Error(`Could not save the version: ${error.message}`);
  if (kind === "auto") {
    const { data: autos } = await supabaseAdmin
      .from("sheet_workbook_versions")
      .select("id")
      .eq("workbook_id", workbookId)
      .eq("kind", "auto")
      .order("created_at", { ascending: false });
    const extra = (autos ?? []).slice(settings.sheetsVersionsMax).map((v) => v.id);
    if (extra.length) await supabaseAdmin.from("sheet_workbook_versions").delete().in("id", extra);
  }
  return { taken: true };
}
