// Re-applying a shared dataset's row filter and column mask in TypeScript.
//
// The database enforces this for a user's own JWT via shared_dataset_rows()
// (migration 20260766000000). Server-side paths that read with the SERVICE
// ROLE have RLS switched off, so the restriction has to be applied here or a
// grantee reads past a mask its owner set.
//
// Extracted from the sql_query tool so every service-role reader uses the
// same implementation. Two copies of an access check is two chances to drift,
// and the drift is invisible until someone sees data they should not.
//
// FAILS CLOSED. Any lookup error, or no applicable grant, returns nothing —
// the only safe direction for an access decision.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

export type MaskableColumn = { name: string; type: "number" | "string" | "date" };
export type MaskableRow = Record<string, unknown>;

/** Dataset ids the viewer holds an IAM grant for. */
export async function grantedDatasetIds(
  sb: SupabaseClient<Database>,
  viewerId: string,
): Promise<Set<string>> {
  try {
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    return await resolveGrantedResourceIds(sb, viewerId, "data_table");
  } catch {
    return new Set();
  }
}

/**
 * Apply a shared dataset's grants to rows already loaded with the service role.
 *
 * Mirrors shared_dataset_rows() in SQL and the BI share model: column masks
 * INTERSECT across the viewer's grants (a column is hidden only when EVERY
 * applicable grant hides it) and row filters UNION (any allowing grant admits
 * the row, and one unfiltered grant admits all). A second grant must never
 * reduce access below what the first allowed.
 */
export async function restrictSharedDataset(
  sb: SupabaseClient<Database>,
  tableId: string,
  viewerId: string,
  columns: MaskableColumn[],
  rows: MaskableRow[],
): Promise<{ columns: MaskableColumn[]; rows: MaskableRow[] }> {
  try {
    const { intersectColumnMasks } = await import("@/lib/biDashboards");
    const [{ data: memberships }, { data: grants }] = await Promise.all([
      sb.from("iam_group_members").select("group_id").eq("user_id", viewerId),
      sb
        .from("iam_resource_grants")
        .select("principal_type, principal_id, row_filter, column_mask")
        .eq("resource_type", "data_table")
        .eq("resource_id", tableId),
    ]);
    const groups = new Set((memberships ?? []).map((m) => m.group_id));
    const mine = (grants ?? []).filter(
      (g) =>
        (g.principal_type === "user" && g.principal_id === viewerId) ||
        (g.principal_type === "group" && groups.has(g.principal_id)),
    );
    if (mine.length === 0) return { columns: [], rows: [] };

    const mask = intersectColumnMasks(mine.map((g) => g.column_mask));
    const maskSet = new Set(mask.map((m) => m.toLowerCase()));

    // Row filters: one unfiltered grant admits everything.
    const anyUnfiltered = mine.some((g) => {
      const rf = g.row_filter as { column?: unknown; values?: unknown } | null;
      return !rf || typeof rf.column !== "string" || !Array.isArray(rf.values);
    });
    let keptRows = rows;
    if (!anyUnfiltered) {
      const filters = mine.map((g) => {
        const rf = g.row_filter as { column: string; values: unknown[] };
        return { column: rf.column, values: new Set(rf.values.map((v) => String(v))) };
      });
      keptRows = rows.filter((r) => filters.some((f) => f.values.has(String(r[f.column] ?? ""))));
    }
    if (maskSet.size === 0) return { columns, rows: keptRows };
    return {
      columns: columns.filter((c) => !maskSet.has(c.name.toLowerCase())),
      rows: keptRows.map((r) => {
        const out: MaskableRow = {};
        for (const [k, v] of Object.entries(r)) if (!maskSet.has(k.toLowerCase())) out[k] = v;
        return out;
      }),
    };
  } catch {
    return { columns: [], rows: [] };
  }
}
