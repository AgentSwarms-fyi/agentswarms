// The datasets shared with the signed-in user, as the database lets them see
// them (R491).
//
// user_data_tables.columns is the OWNER's column list. Until migration
// 20261115000000 a grantee's own JWT read that row directly, so the names of
// the columns a grant masks reached every listing built from it: the SQL page's
// table list and its chat prompt, BI, the swarm canvas. The migration stops the
// direct read for a share with a mask and adds shared_datasets(), which returns
// every share with its columns through the grants' mask.
//
// Every read that LISTS datasets with the caller's own client (the browser, or
// a server function holding the user's JWT) does the same two things: its own
// direct read (own datasets, samples, and shares with nothing masked) and this
// one, merged by id, the function's row winning.
//
// Before the migration has run the function is not there. That is not an
// error: the direct read still returns every share then, and `null` here tells
// the caller its shared rows carry the owner's columns, which it must not show.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

export type SharedDataset = Database["public"]["Functions"]["shared_datasets"]["Returns"][number];

/** True when an error says the function is not in the database (yet). */
export function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // PostgREST's own code, and Postgres's undefined_function, for when the
  // schema cache is fresher than the error.
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

/**
 * Every dataset shared with the caller, each with its columns through the mask
 * of the grants that apply to them. `null` when the database predates
 * shared_datasets(). Any other failure throws: a failed list is not an empty
 * one, and reading it as empty would hide every share without a word.
 */
export async function readSharedDatasets(
  sb: SupabaseClient<Database>,
): Promise<SharedDataset[] | null> {
  const { data, error } = await sb.rpc("shared_datasets");
  if (!error) return (data ?? []) as SharedDataset[];
  if (isMissingFunction(error)) return null;
  throw new Error(`could not list the datasets shared with you: ${error.message}`);
}

/**
 * A direct read of user_data_tables with the shares put right: every row of
 * `shared` replaces the direct row with its id, and the rest are added. With
 * `shared` null (the database predates the function) the direct read is
 * returned as it is, shares and all.
 */
export function mergeSharedDatasets<D extends { id: string }, S extends { id: string }>(
  direct: D[],
  shared: S[] | null,
): Array<D | S> {
  if (!shared) return direct;
  const byFunction = new Set(shared.map((s) => s.id));
  return [...direct.filter((d) => !byFunction.has(d.id)), ...shared];
}

/**
 * The columns to list for a dataset shared with the viewer, given the rows
 * shared_dataset_rows() (or the server's restrictSharedDataset) returned.
 *
 * `masked`: `columns` came through the database's mask (shared_datasets()), so
 * it is the list whether or not any row came back. Otherwise it is the OWNER's
 * list, from a database older than 20261115000000, and only a column present
 * in the masked rows may be named: with no rows, none. That case used to fall
 * back to the owner's whole list, which is how a share whose row filter admits
 * nothing named every column its mask hides.
 */
export function sharedColumns<C extends { name: string }>(
  columns: C[],
  rows: Record<string, unknown>[],
  masked: boolean,
): C[] {
  if (rows.length > 0) return columns.filter((c) => Object.hasOwn(rows[0], c.name));
  return masked ? columns : [];
}

/**
 * Whether a dataset is shared with `viewerId`: neither a sample nor theirs.
 * The predicate every reader of a shared dataset uses.
 */
export function isSharedWith(
  t: { user_id: string | null; is_sample: boolean | null },
  viewerId: string | null | undefined,
): boolean {
  return !t.is_sample && !!viewerId && t.user_id !== viewerId;
}
