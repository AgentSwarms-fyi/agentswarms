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
  // Deliberately not caught: a failed grants read answered as "none" dropped
  // every shared dataset from a prep flow's or a refresh's source list, and
  // the job then ran over a short list instead of failing with the reason.
  const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
  return await resolveGrantedResourceIds(sb, viewerId, "data_table");
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
    const { applyRowFilters, intersectColumnMasks, mergeGrantRowFilters } =
      await import("@/lib/biDashboards");
    // R239: the fourth and last private copy of this pair of reads. Both of
    // them dropped their errors here, and the catch below turns anything
    // thrown into an EMPTY DATASET — so a blip on either read showed the
    // viewer a table with no rows, which is the same screen they would see if
    // the owner had shared nothing. Nothing was exposed, but "there is nothing
    // here" and "nothing could be read" are different sentences, and only one
    // of them is true. The reader is the only one who can tell them apart, and
    // only if we say which.
    const { readApplicableGrants } = await import("@/utils/iam.server");
    let mine = await readApplicableGrants(sb, viewerId, "data_table", [tableId]);
    if (mine.length === 0) return { columns: [], rows: [] };

    // {{user.<key>}} tokens resolve to THIS viewer's attribute values before
    // the merge — the same resolver, fetch and refusal every other grant
    // surface uses. The refusal is rethrown past the fail-closed catch below:
    // "your region attribute is missing" shown as an EMPTY dataset would read
    // as "there is no data".
    const { attributeKeysInGrants, resolveAttributeGrants } = await import("@/lib/semanticPolicy");
    const keys = attributeKeysInGrants(mine);
    if (keys.length > 0) {
      const { attributesFor } = await import("@/utils/semantic/policy.server");
      mine = resolveAttributeGrants(mine, await attributesFor(viewerId, keys));
    }

    const mask = intersectColumnMasks(mine.map((g) => g.column_mask));
    const maskSet = new Set(mask.map((m) => m.toLowerCase()));

    // Row filters: one unfiltered grant admits everything (mergeGrantRowFilters
    // returns null), and the surviving filters union.
    //
    // This used to merge and apply the filters here, with its own copy of the
    // predicate. The copy was correct and the BI snapshot's was not — a row
    // missing the filter column passed there and was dropped here, so the same
    // grant admitted different rows depending on which surface you opened.
    // Sharing the function is the only version of this that stays true.
    const keptRows = applyRowFilters(rows, mergeGrantRowFilters(mine)) as MaskableRow[];
    if (maskSet.size === 0) return { columns, rows: keptRows };
    return {
      columns: columns.filter((c) => !maskSet.has(c.name.toLowerCase())),
      rows: keptRows.map((r) => {
        const out: MaskableRow = {};
        for (const [k, v] of Object.entries(r)) if (!maskSet.has(k.toLowerCase())) out[k] = v;
        return out;
      }),
    };
  } catch (e) {
    // Two kinds of error must reach the viewer rather than become an empty
    // table. The attribute refusal carries an instruction ("ask an admin to
    // set your region"). A failed GRANT READ (R239) carries the only thing
    // that distinguishes an empty dataset from an unanswered question — shown
    // as emptiness it reads as "the owner shared nothing with me", which is a
    // claim this code is in no position to make. Everything else still fails
    // closed, because a grant we could not apply must not be skipped.
    if (e instanceof Error && e.name === "AttributeRefusalError") throw e;
    if (e instanceof Error && /could not read access grants/i.test(e.message)) throw e;
    return { columns: [], rows: [] };
  }
}
