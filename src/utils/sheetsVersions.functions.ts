// Sheets version history: take a version of a workbook (its sheets as they
// are saved), list them, open one as a new workbook, and restore one (after
// taking a version of what is there now, so a restore can be undone).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  snapshotOf,
  takeVersion,
  type SnapshotTab,
  type VersionKind,
} from "@/utils/sheets/versions.server";
import { requireAccess } from "@/utils/sheets/access.server";
import { beforeRestoreLabel, copyName, utcShown, type VersionRef } from "@/lib/sheets/versionNames";
import { callerFailure } from "@/utils/callerLookup.server";

type Fail = { ok: false; error: string };

export type VersionSummary = {
  id: string;
  label: string | null;
  kind: VersionKind;
  created_at: string;
  sheet_count: number;
  size_bytes: number;
};

async function caller(token: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: callerFailure(error, "Not signed in") };
  return { ok: true, userId: data.user.id };
}

// Versions are the owner's and their editors': a version holds every sheet
// and every row, so a viewer (who may be shown less) gets none of them.
async function workbookName(id: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("sheet_workbooks")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the workbook: ${error.message}`);
  return data?.name ?? "Workbook";
}

const base = z.object({ access_token: z.string().min(1), workbook_id: z.string().uuid() });
// The version's time as the browser shows it, for the names written from it.
const pick = base.extend({
  version_id: z.string().uuid(),
  shown: z.string().trim().min(1).max(80).optional(),
});

export const sheetsVersionsList = createServerFn({ method: "POST" })
  .validator((input: unknown) => base.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; versions: VersionSummary[] } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const got = await requireAccess(who.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    const { data: rows, error } = await supabaseAdmin
      .from("sheet_workbook_versions")
      .select("id, label, kind, created_at, sheet_count, size_bytes")
      .eq("workbook_id", data.workbook_id)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return { ok: false, error: `Could not read the versions: ${error.message}` };
    return { ok: true, versions: (rows ?? []) as VersionSummary[] };
  });

export const sheetsVersionSave = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    base.extend({ label: z.string().trim().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const got = await requireAccess(who.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    try {
      await takeVersion(data.workbook_id, got.access.ownerId, "named", data.label, who.userId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

async function versionOf(workbookId: string, versionId: string) {
  const { data, error } = await supabaseAdmin
    .from("sheet_workbook_versions")
    .select("id, label, kind, created_at, snapshot, names")
    .eq("id", versionId)
    .eq("workbook_id", workbookId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the version: ${error.message}`);
  return data;
}

/**
 * Restore: what is there now is kept as a version first, then the sheets
 * are replaced by the version's (new ids; the page reloads the workbook).
 */
export const sheetsVersionRestore = createServerFn({ method: "POST" })
  .validator((input: unknown) => pick.parse(input))
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const got = await requireAccess(who.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    const ownerId = got.access.ownerId;
    try {
      const v = await versionOf(data.workbook_id, data.version_id);
      if (!v) return { ok: false, error: "That version no longer exists" };
      const shown = data.shown ?? utcShown(v.created_at);
      await takeVersion(
        data.workbook_id,
        ownerId,
        "before_restore",
        beforeRestoreLabel(v as VersionRef, shown),
        who.userId,
      );
      const tabs = v.snapshot as unknown as SnapshotTab[];
      if (!Array.isArray(tabs) || !tabs.length)
        return { ok: false, error: "That version has no sheets" };
      // Replace: delete, then insert the version's sheets. A failed insert
      // puts the sheets taken just before back.
      const before = await snapshotOf(data.workbook_id);
      const del = await supabaseAdmin
        .from("sheet_tabs")
        .delete()
        .eq("workbook_id", data.workbook_id);
      if (del.error) return { ok: false, error: `Could not restore: ${del.error.message}` };
      const rows = (list: SnapshotTab[]) =>
        list.map((t, i) => ({
          workbook_id: data.workbook_id,
          user_id: ownerId,
          name: t.name,
          kind: t.kind,
          position: i,
          grid: t.grid,
          table_config: t.table_config,
        }));
      const ins = await supabaseAdmin.from("sheet_tabs").insert(rows(tabs));
      if (ins.error) {
        await supabaseAdmin.from("sheet_tabs").insert(rows(before));
        return { ok: false, error: `Could not restore: ${ins.error.message}` };
      }
      // The version's names come back with its sheets; one taken before
      // names existed leaves them as they are (R148).
      await supabaseAdmin
        .from("sheet_workbooks")
        .update({
          updated_at: new Date().toISOString(),
          ...(v.names ? { names: v.names } : {}),
        })
        .eq("id", data.workbook_id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** Open a version as a new workbook, leaving this one as it is. */
export const sheetsVersionOpenCopy = createServerFn({ method: "POST" })
  .validator((input: unknown) => pick.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; workbook_id: string } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const got = await requireAccess(who.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    try {
      const wb = { name: await workbookName(data.workbook_id) };
      const v = await versionOf(data.workbook_id, data.version_id);
      if (!v) return { ok: false, error: "That version no longer exists" };
      const tabs = v.snapshot as unknown as SnapshotTab[];
      const shown = data.shown ?? utcShown(v.created_at);
      const name = copyName(wb.name, v as VersionRef, shown);
      const { data: created, error } = await supabaseAdmin
        .from("sheet_workbooks")
        .insert({
          user_id: who.userId,
          name,
          description: `A copy of the version of ${shown}`,
          names: v.names ?? [],
        })
        .select("id")
        .single();
      if (error || !created)
        return { ok: false, error: `Could not create the copy: ${error?.message}` };
      const ins = await supabaseAdmin.from("sheet_tabs").insert(
        tabs.map((t, i) => ({
          workbook_id: created.id,
          user_id: who.userId,
          name: t.name,
          kind: t.kind,
          position: i,
          grid: t.grid,
          table_config: t.table_config,
        })),
      );
      if (ins.error) {
        await supabaseAdmin.from("sheet_workbooks").delete().eq("id", created.id);
        return { ok: false, error: `Could not create the copy: ${ins.error.message}` };
      }
      return { ok: true, workbook_id: created.id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
