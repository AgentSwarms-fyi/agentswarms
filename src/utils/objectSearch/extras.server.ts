// What the object index needs beyond one table read with the reader's own
// client: names sealed under their owner's key, and the shares only the server
// can list. One place, because search and the assistant both read the index
// and must find the same things for the same person.
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { ObjectEntry } from "@/lib/objectKinds";
import { readSharedDatasets } from "@/lib/sharedDatasetList";
import { openAnalystTitle } from "@/utils/chat/sealedThreads.server";
import { INDEX_CAP, type IndexExtras } from "@/utils/objectSearch/sources.server";
import { sharedWithMe } from "@/utils/sheets/access.server";

/**
 * Kinds whose stored name is sealed under the owner's key, and how each is
 * opened. A saved analysis's title is sealed with its turns; the row was
 * already read with the caller's own token, so this opens only their own.
 */
export const SEALED_NAMES = {
  analysis: (row: { id: string; name: string }) =>
    openAnalystTitle({ id: row.id, title: row.name }),
};

/** Workbooks shared with `userId`. Shares are a server-only table. */
export async function sharedWorkbookEntries(userId: string): Promise<ObjectEntry[]> {
  const shared = await sharedWithMe(userId);
  if (!shared.size) return [];
  const { data, error } = await supabaseAdmin
    .from("sheet_workbooks")
    .select("id, name, description, updated_at, user_id")
    .in("id", [...shared.keys()])
    .neq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(INDEX_CAP);
  if (error) throw new Error(error.message);
  return (data ?? []).map((w) => ({
    kind: "workbook" as const,
    id: w.id,
    name: w.name,
    detail: w.description ?? undefined,
    updatedAt: w.updated_at,
    mine: false,
  }));
}

/**
 * Everything loadObjectIndex needs for one signed-in reader. `sb` must carry
 * that reader's own token: the index is scoped by row-level security, and the
 * extras assume the rows were read as them.
 */
export function indexExtrasFor(sb: SupabaseClient<Database>, userId: string): IndexExtras {
  return {
    // Masked shares are absent from a direct read of the table; the
    // function returns every share. `null` means the database predates it.
    sharedDatasets: async () => (await readSharedDatasets(sb)) ?? [],
    sharedWorkbooks: () => sharedWorkbookEntries(userId),
    openName: SEALED_NAMES,
  };
}
