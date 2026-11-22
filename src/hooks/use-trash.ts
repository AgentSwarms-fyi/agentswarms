// Moving things to the trash and getting them back, from the browser.
//
// Every list page deletes through moveToTrash (or a server function that calls
// the same database function), and every one says the same thing afterwards:
// "Moved to the trash", with Undo. Undo, the Trash page and the toast all
// restore through restoreFromTrash, so getting something back works the same
// wherever it starts.
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { ensureObjectIndex } from "@/hooks/use-object-index";
import { isObjectKindId, type ObjectKindId } from "@/lib/objectKinds";
import { trashEntryFromRow, trashErrorText, trashMissing, type TrashEntry } from "@/lib/trash";

export type TrashResult = { ok: true; trashId: string } | { ok: false; error: string };

/** The search index still lists what was just moved, or lacks what came back. */
function refreshIndex() {
  void ensureObjectIndex(true).catch(() => undefined);
}

/**
 * Says that something went to the trash, with Undo. For a delete done on the
 * server, which hands back the trash entry's id; moveToTrash calls it itself.
 * `onRestored` runs after an Undo has put it back, so the page can show it.
 */
export function announceTrashed(name: string, trashId: string, onRestored?: () => void): void {
  refreshIndex();
  toast.success(name ? `Moved “${name}” to the trash` : "Moved to the trash", {
    // Long enough to read the name and reach Undo; the Trash page is there after.
    duration: 8000,
    action: {
      label: "Undo",
      onClick: () => {
        void restoreFromTrash(trashId).then((r) => {
          if (r.ok) {
            toast.success(name ? `“${name}” is back` : "It is back");
            onRestored?.();
          }
        });
      },
    },
  });
}

/**
 * Moves one object to the trash as the signed-in person. The database checks
 * that they own it; nothing is deleted when it says no.
 */
export async function moveToTrash(args: {
  kind: ObjectKindId;
  id: string;
  name: string;
  /** Called after an Undo from the toast has put it back. */
  onRestored?: () => void;
  /** Leave the toast to the caller (it has more to say). */
  quiet?: boolean;
}): Promise<TrashResult> {
  const { data, error } = await supabase.rpc("trash_object", { p_kind: args.kind, p_id: args.id });
  if (error || typeof data !== "string") {
    const text = trashErrorText(error, "move");
    if (!args.quiet) toast.error(text);
    return { ok: false, error: text };
  }
  if (!args.quiet) announceTrashed(args.name, data, args.onRestored);
  else refreshIndex();
  return { ok: true, trashId: data };
}

export type RestoreResult =
  | { ok: true; kind: ObjectKindId; id: string; restored: number; skipped: number }
  | { ok: false; error: string };

/** Puts one trash entry back. Says what went wrong; the caller says what went right. */
export async function restoreFromTrash(trashId: string): Promise<RestoreResult> {
  const { data, error } = await supabase.rpc("restore_trash", { p_trash_id: trashId });
  const out = (data ?? {}) as Record<string, unknown>;
  if (error || !isObjectKindId(out.kind) || typeof out.id !== "string") {
    const text = trashErrorText(error, "restore");
    toast.error(text);
    return { ok: false, error: text };
  }
  refreshIndex();
  const skipped = typeof out.skipped === "number" ? out.skipped : 0;
  if (skipped > 0) {
    // Back, but not all of it: what those rows pointed at was deleted since.
    toast.warning(
      `${skipped} of the things that belonged to it could not come back: what they pointed at has been deleted since.`,
    );
  }
  return {
    ok: true,
    kind: out.kind,
    id: out.id,
    restored: typeof out.restored === "number" ? out.restored : 0,
    skipped,
  };
}

/** Deletes one trash entry for good, or every one with no id. */
export async function deleteFromTrash(trashId?: string): Promise<{ ok: boolean; count: number }> {
  const { data, error } = await supabase.rpc("empty_trash", { p_trash_id: trashId ?? null });
  if (error) {
    toast.error(trashErrorText(error, "delete"));
    return { ok: false, count: 0 };
  }
  return { ok: true, count: typeof data === "number" ? data : 0 };
}

export type TrashList =
  { state: "ok"; entries: TrashEntry[] } | { state: "missing" } | { state: "error"; error: string };

/** What is in the signed-in person's trash, newest first. */
export async function listTrash(): Promise<TrashList> {
  const { data, error } = await supabase.rpc("my_trash");
  if (error) {
    if (trashMissing(error)) return { state: "missing" };
    return { state: "error", error: error.message || "The trash could not be read." };
  }
  const entries = (Array.isArray(data) ? data : [])
    .map((r) => trashEntryFromRow(r, isObjectKindId))
    .filter((e): e is TrashEntry => e !== null);
  return { state: "ok", entries };
}
