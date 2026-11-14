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

/**
 * The lower-cased names a viewer's grants on ONE dataset hide.
 *
 * The single definition of the mask, for the rows path (restrictSharedDataset)
 * and the listing path (columnsVisibleTo) alike. Masks INTERSECT: a column is
 * hidden only when every applicable grant hides it. Read from the grants as
 * stored — attribute resolution rewrites row filters, never a column mask.
 */
function maskedColumns(
  grants: { column_mask: unknown }[],
  intersectColumnMasks: (masks: unknown[]) => string[],
): Set<string> {
  return new Set(
    intersectColumnMasks(grants.map((g) => g.column_mask)).map((m) => m.toLowerCase()),
  );
}

/** `columns` minus the masked ones, matched without regard to case. */
function withoutMasked<C extends { name: string }>(columns: C[], mask: Set<string>): C[] {
  return mask.size === 0 ? columns : columns.filter((c) => !mask.has(c.name.toLowerCase()));
}

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

    const maskSet = maskedColumns(mine, intersectColumnMasks);

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
      columns: withoutMasked(columns, maskSet),
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

/** A dataset as a listing has it: who owns it, and the owner's column list. */
export type ListedDataset<C extends { name: string }> = {
  id: string;
  user_id: string | null;
  is_sample: boolean | null;
  columns: C[];
};

/**
 * Each dataset's columns as `viewerId` may see them, for a LISTING — a tool
 * description, a picker, a prompt's schema section — where no rows are read.
 *
 * user_data_tables.columns is the OWNER's column list. Shown to a grantee as it
 * is, it names every column the grant masks: not the values, but in a prompt
 * the names are the leak. The sql_query tool description did exactly that on
 * every turn (R489) while the data path refused to serve those columns.
 *
 * Own datasets and public samples come back unchanged. A dataset SHARED with
 * the viewer (neither a sample nor theirs, the predicate every reader uses)
 * comes back through the same grants and the same mask restrictSharedDataset
 * applies, read once for the whole list. Attribute tokens are not resolved:
 * they rewrite row filters, and a listing reads no rows.
 *
 * FAILS CLOSED, and does not throw. A shared dataset with no applicable grant
 * lists no columns, and so does every shared dataset in the list when the
 * grants cannot be read. Unlike restrictSharedDataset this swallows the read
 * failure: a table named without its columns is still a usable listing, and
 * READING the table goes through restrictSharedDataset, which reports the
 * reason to whoever asked. The failure is logged here.
 */
export async function columnsVisibleTo<C extends { name: string }>(
  sb: SupabaseClient<Database>,
  viewerId: string | null | undefined,
  tables: ListedDataset<C>[],
): Promise<Map<string, C[]>> {
  const out = new Map<string, C[]>();
  const shared: ListedDataset<C>[] = [];
  for (const t of tables) {
    if (t.is_sample || (!!viewerId && t.user_id === viewerId)) {
      out.set(t.id, t.columns);
    } else {
      // Nothing until a grant says otherwise.
      out.set(t.id, []);
      shared.push(t);
    }
  }
  if (shared.length === 0 || !viewerId) return out;
  try {
    const { intersectColumnMasks } = await import("@/lib/biDashboards");
    const { readApplicableGrants } = await import("@/utils/iam.server");
    const grants = await readApplicableGrants(
      sb,
      viewerId,
      "data_table",
      shared.map((t) => t.id),
    );
    for (const t of shared) {
      const mine = grants.filter((g) => g.resource_id === t.id);
      if (mine.length === 0) continue;
      out.set(t.id, withoutMasked(t.columns, maskedColumns(mine, intersectColumnMasks)));
    }
  } catch (e) {
    for (const t of shared) out.set(t.id, []);
    console.warn(
      `[shared-datasets] columns of ${shared.length} shared dataset(s) left out of a listing: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return out;
}
