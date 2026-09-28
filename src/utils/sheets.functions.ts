// Server functions behind Data & BI -> Sheets: workbooks, their sheets, and
// saving a grid sheet's cells.
//
// Every write goes through the service role, after the caller's access to
// the workbook is checked (sheets/access.server): the owner and editors may
// change it, a viewer only reads, and some things are the owner's alone. A
// grid save names the version it was read at; a save against a newer version
// is refused as a conflict rather than written over it, so two people (or two
// browser tabs) cannot silently undo each other.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { gridSchema } from "@/utils/sheets/schemas";
import { takeVersion } from "@/utils/sheets/versions.server";
import { previewOfTabs } from "@/utils/sheets/preview.server";
import {
  requireAccess,
  requireTab,
  sharedWithMe,
  sheetShown,
  tabFor,
  type Role,
} from "@/utils/sheets/access.server";
import { previewSchema, type WorkbookPreview } from "@/lib/sheets/preview";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

export type WorkbookSummary = {
  id: string;
  name: string;
  description: string | null;
  updated_at: string;
  created_at: string;
  sheet_count: number;
  /** Its sheets in order, for the gallery's chips and search. */
  sheets: { name: string; kind: "grid" | "table" }[];
  /** The thumbnail kept for it, or null (none yet, or not for this viewer). */
  preview: WorkbookPreview | null;
  /** The caller's part in it: their own, or shared with them to edit or view. */
  role: Role;
  /** Who shared it, for a workbook that is not the caller's own. */
  owner: string | null;
};

/** How the caller sees an open workbook, for the editor's banner and controls. */
export type WorkbookAccessInfo = {
  role: Role;
  /** Set when the owner is looking at the workbook as one of its shares sees it. */
  viewing_as: string | null;
  /** Whose share that is: an email, or a group's name. */
  viewing_as_label: string | null;
  /** Who shared it (not the caller's own). */
  owner: string | null;
  /** Sheets that arrive with only some of their rows. */
  filtered: string[];
  /** How many sheets were left out. */
  hidden: number;
};

/** A kept thumbnail as read back: anything that is not one reads as none. */
function keptPreview(json: unknown): WorkbookPreview | null {
  const one = Array.isArray(json) ? json[0] : json;
  const raw = one && typeof one === "object" && "preview" in one ? one.preview : null;
  const r = previewSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export type SheetTabRow = {
  id: string;
  workbook_id: string;
  name: string;
  kind: "grid" | "table";
  position: number;
  grid: Json;
  table_config: Json | null;
  version: number;
  updated_at: string;
};

export type SheetsLimits = {
  maxCells: number;
  pageRows: number;
  /** Most sheets one file import brings in (SHEETS_IMPORT_MAX_SHEETS). */
  maxImportSheets: number;
  /** Most rows of a table sheet in a download (SHEETS_EXPORT_MAX_ROWS). */
  exportMaxRows: number;
  /** Most rows one Fill with AI works through (SHEETS_AI_FILL_MAX_ROWS). */
  aiFillMaxRows: number;
};

const NAME_RE = /^[^\\/?*[\]:']{1,100}$/;
// Excel's own rules for a sheet name: no \ / ? * [ ] : or leading/trailing ',
// at most 31 characters there; 100 here. A name that looks like a cell
// address (A1, XFD99) would be ambiguous in a formula, so it is refused.
export function sheetNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "A sheet needs a name";
  if (!NAME_RE.test(n)) return "A sheet name cannot contain \\ / ? * [ ] : or '";
  if (/^[A-Za-z]{1,3}\d+$/.test(n)) return `"${n}" looks like a cell address; pick another name`;
  if (/^(true|false)$/i.test(n)) return `"${n}" is a reserved word`;
  return null;
}

const tokenOnly = z.object({ access_token: z.string().min(1) });

async function limits(): Promise<SheetsLimits> {
  const r = await getPlatformResources();
  return {
    maxCells: r.sheetsMaxCells,
    pageRows: r.sheetsPageRows,
    maxImportSheets: r.sheetsImportMaxSheets,
    exportMaxRows: r.sheetsExportMaxRows,
    aiFillMaxRows: r.sheetsAiFillMaxRows,
  };
}

/** An email (or name) to show for each of these accounts. */
async function ownerLabels(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { userLabels } = await import("@/utils/sheets/people.server");
  for (const [id, u] of await userLabels(ids)) out.set(id, u.email ?? u.name ?? "someone");
  return out;
}

type ListedRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  user_id: string;
  sheet_tabs?: { name: string; kind: string; position: number }[];
  sheet_workbook_previews?: unknown;
};

/** The caller's workbooks and the ones shared with them, newest first. */
export const sheetsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenOnly.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; workbooks: WorkbookSummary[]; limits: SheetsLimits } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const cols =
        "id, name, description, created_at, updated_at, user_id, sheet_tabs(name, kind, position), sheet_workbook_previews(preview)";
      const { data: rows, error } = await supabaseAdmin
        .from("sheet_workbooks")
        .select(cols)
        .eq("user_id", caller.userId)
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) return { ok: false, error: `Could not list your workbooks: ${error.message}` };
      // Shared with the caller: listed with their part in it. A failed read of
      // the shares fails the list; an empty "shared" would say none exist.
      let shared: Awaited<ReturnType<typeof sharedWithMe>>;
      try {
        shared = await sharedWithMe(caller.userId);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      let sharedRows: ListedRow[] = [];
      if (shared.size) {
        const { data: more, error: e2 } = await supabaseAdmin
          .from("sheet_workbooks")
          .select(cols)
          .in("id", [...shared.keys()])
          .neq("user_id", caller.userId)
          .order("updated_at", { ascending: false })
          .limit(500);
        if (e2) return { ok: false, error: `Could not list the shared workbooks: ${e2.message}` };
        sharedRows = (more ?? []) as unknown as ListedRow[];
      }
      const owners = await ownerLabels([...new Set(sharedRows.map((r) => r.user_id))]);
      const summarize = (r: ListedRow): WorkbookSummary => {
        const access = shared.get(r.id);
        const role: Role = r.user_id === caller.userId ? "owner" : (access?.role ?? "viewer");
        const tabs = [...(r.sheet_tabs ?? [])]
          .sort((a, b) => a.position - b.position)
          .filter((t) => !access || role !== "viewer" || !access.hidden.has(t.name.toLowerCase()));
        // A thumbnail shows cells: not for a viewer whose share leaves
        // anything out, since it was drawn from everything.
        const restricted =
          role === "viewer" && !!access && (access.hidden.size > 0 || access.filters.size > 0);
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          created_at: r.created_at,
          updated_at: r.updated_at,
          sheet_count: tabs.length,
          sheets: tabs.map((t) => ({
            name: t.name,
            kind: (t.kind === "table" ? "table" : "grid") as "grid" | "table",
          })),
          preview: restricted ? null : keptPreview(r.sheet_workbook_previews),
          role,
          owner: role === "owner" ? null : (owners.get(r.user_id) ?? "someone"),
        };
      };
      const workbooks = [
        ...((rows ?? []) as unknown as ListedRow[]).map(summarize),
        ...sharedRows.map(summarize),
      ].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { ok: true, limits: await limits(), workbooks };
    },
  );

/** A new workbook with one empty grid sheet. */
export const sheetsCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(4000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: wb, error } = await supabaseAdmin
      .from("sheet_workbooks")
      .insert({ user_id: caller.userId, name: data.name, description: data.description ?? null })
      .select("id")
      .single();
    if (error || !wb)
      return { ok: false, error: `Could not create the workbook: ${error?.message ?? "no row"}` };
    const { error: tabErr } = await supabaseAdmin.from("sheet_tabs").insert({
      workbook_id: wb.id,
      user_id: caller.userId,
      name: "Sheet1",
      kind: "grid",
      position: 0,
      grid: { cells: {} } as Json,
    });
    if (tabErr) {
      // A workbook with no sheet would open to nothing; take it back.
      await supabaseAdmin.from("sheet_workbooks").delete().eq("id", wb.id);
      return { ok: false, error: `Could not create the first sheet: ${tabErr.message}` };
    }
    return { ok: true, id: wb.id };
  });

/**
 * A workbook, its sheets in order, and the instance limits the editor
 * enforces. A viewer gets the sheets their shares allow, with only the rows
 * those keep; `as_share` lets the owner look at it as one of its shares does.
 */
export const sheetsGet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({ id: z.string().uuid(), as_share: z.string().uuid().nullable().optional() })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          workbook: Omit<WorkbookSummary, "sheet_count" | "sheets" | "role" | "owner">;
          tabs: SheetTabRow[];
          limits: SheetsLimits;
          access: WorkbookAccessInfo;
        }
      | (Fail & { missing?: boolean })
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const got = await requireAccess(caller.userId, data.id, "view", { asShare: data.as_share });
      if (!got.ok) return got;
      const access = got.access;
      const { data: wb, error: wbErr } = await supabaseAdmin
        .from("sheet_workbooks")
        .select("id, name, description, created_at, updated_at")
        .eq("id", data.id)
        .maybeSingle();
      if (wbErr) return { ok: false, error: `Could not read the workbook: ${wbErr.message}` };
      if (!wb) return { ok: false, error: "This workbook does not exist", missing: true };
      const { data: tabs, error } = await supabaseAdmin
        .from("sheet_tabs")
        .select("id, workbook_id, name, kind, position, grid, table_config, version, updated_at")
        .eq("workbook_id", data.id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) return { ok: false, error: `Could not read the sheets: ${error.message}` };
      const all = (tabs ?? []) as SheetTabRow[];
      const shown = all.map((t) => tabFor(access, t)).filter((t): t is SheetTabRow => !!t);
      const restricted =
        access.role === "viewer" && (access.hidden.size > 0 || access.filters.size > 0);
      const { data: kept } = restricted
        ? { data: null }
        : await supabaseAdmin
            .from("sheet_workbook_previews")
            .select("preview")
            .eq("workbook_id", data.id)
            .maybeSingle();
      const owner =
        access.role === "owner" || access.viewingAs
          ? null
          : ((await ownerLabels([access.ownerId])).get(access.ownerId) ?? "someone");
      let viewingAsLabel: string | null = null;
      if (access.viewingAs) {
        const { data: share } = await supabaseAdmin
          .from("sheet_workbook_shares")
          .select("principal_type, principal_id")
          .eq("id", access.viewingAs)
          .maybeSingle();
        if (share?.principal_type === "group") {
          const { data: g } = await supabaseAdmin
            .from("iam_groups")
            .select("name")
            .eq("id", share.principal_id)
            .maybeSingle();
          viewingAsLabel = g?.name ? `the group ${g.name}` : "a group";
        } else if (share) {
          viewingAsLabel =
            (await ownerLabels([share.principal_id])).get(share.principal_id) ?? "someone";
        }
      }
      return {
        ok: true,
        workbook: {
          id: wb.id,
          name: wb.name,
          description: wb.description,
          created_at: wb.created_at,
          updated_at: wb.updated_at,
          preview: keptPreview(kept),
        },
        tabs: shown,
        limits: await limits(),
        access: {
          role: access.role,
          viewing_as: access.viewingAs,
          viewing_as_label: viewingAsLabel,
          owner,
          filtered: shown
            .filter((t) => access.filters.has(t.name.toLowerCase()))
            .map((t) => t.name),
          hidden: all.filter((t) => !sheetShown(access, t.name)).length,
        },
      };
    },
  );

/** Rename a workbook or change its description: its owner or an editor. */
export const sheetsUpdateWorkbook = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const got = await requireAccess(caller.userId, data.id, "edit");
    if (!got.ok) return got;
    const patch: { name?: string; description?: string | null } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    const { data: rows, error } = await supabaseAdmin
      .from("sheet_workbooks")
      .update(patch)
      .eq("id", data.id)
      .select("id");
    if (error) return { ok: false, error: `Could not save the workbook: ${error.message}` };
    if (!rows?.length) return { ok: false, error: "This workbook no longer exists" };
    return { ok: true };
  });

/** Delete a workbook: its owner only. */
export const sheetsDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenOnly.extend({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const got = await requireAccess(caller.userId, data.id, "own", { doing: "delete it" });
    if (!got.ok) return got;
    const { data: rows, error } = await supabaseAdmin
      .from("sheet_workbooks")
      .delete()
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .select("id");
    if (error) return { ok: false, error: `Could not delete the workbook: ${error.message}` };
    if (!rows?.length) return { ok: false, error: "This workbook does not exist, or is not yours" };
    return { ok: true };
  });

/** A new grid sheet at the end of the workbook. */
export const sheetsAddTab = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({ workbook_id: z.string().uuid(), name: z.string().trim().min(1).max(100) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tab: SheetTabRow } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const problem = sheetNameProblem(data.name);
    if (problem) return { ok: false, error: problem };
    const got = await requireAccess(caller.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    const { data: last, error: posErr } = await supabaseAdmin
      .from("sheet_tabs")
      .select("position")
      .eq("workbook_id", data.workbook_id)
      .order("position", { ascending: false })
      .limit(1);
    if (posErr) return { ok: false, error: `Could not read the sheets: ${posErr.message}` };
    const { data: tab, error } = await supabaseAdmin
      .from("sheet_tabs")
      .insert({
        workbook_id: data.workbook_id,
        // Every sheet is the owner's, whoever added it: sharing lends the
        // workbook, and a sheet an editor made stays when the share goes.
        user_id: got.access.ownerId,
        name: data.name.trim(),
        kind: "grid",
        position: (last?.[0]?.position ?? -1) + 1,
        grid: { cells: {} } as Json,
      })
      .select("id, workbook_id, name, kind, position, grid, table_config, version, updated_at")
      .single();
    if (error || !tab) {
      return {
        ok: false,
        error:
          error?.code === "23505"
            ? `This workbook already has a sheet named "${data.name.trim()}"`
            : `Could not add the sheet: ${error?.message ?? "no row"}`,
      };
    }
    return { ok: true, tab: tab as SheetTabRow };
  });

export const sheetsRenameTab = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({ tab_id: z.string().uuid(), name: z.string().trim().min(1).max(100) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const problem = sheetNameProblem(data.name);
    if (problem) return { ok: false, error: problem };
    const got = await requireTab(caller.userId, data.tab_id, "edit");
    if (!got.ok) return got;
    const { data: rows, error } = await supabaseAdmin
      .from("sheet_tabs")
      .update({ name: data.name.trim() })
      .eq("id", data.tab_id)
      .select("id");
    if (error) {
      return {
        ok: false,
        error:
          error.code === "23505"
            ? `This workbook already has a sheet named "${data.name.trim()}"`
            : `Could not rename the sheet: ${error.message}`,
      };
    }
    if (!rows?.length) return { ok: false, error: "This sheet no longer exists" };
    return { ok: true };
  });

export const sheetsDeleteTab = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenOnly.extend({ tab_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const got = await requireTab(caller.userId, data.tab_id, "edit");
    if (!got.ok) return got;
    const { count, error: cErr } = await supabaseAdmin
      .from("sheet_tabs")
      .select("id", { count: "exact", head: true })
      .eq("workbook_id", got.tab.workbook_id);
    if (cErr) return { ok: false, error: `Could not read the sheets: ${cErr.message}` };
    if ((count ?? 0) <= 1) return { ok: false, error: "A workbook keeps at least one sheet" };
    const { data: rows, error } = await supabaseAdmin
      .from("sheet_tabs")
      .delete()
      .eq("id", data.tab_id)
      .select("id");
    if (error) return { ok: false, error: `Could not delete the sheet: ${error.message}` };
    if (!rows?.length) return { ok: false, error: "This sheet no longer exists" };
    return { ok: true };
  });

export const sheetsReorderTabs = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({ workbook_id: z.string().uuid(), order: z.array(z.string().uuid()).min(1).max(500) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const got = await requireAccess(caller.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    for (const [i, id] of data.order.entries()) {
      const { error } = await supabaseAdmin
        .from("sheet_tabs")
        .update({ position: i })
        .eq("id", id)
        .eq("workbook_id", data.workbook_id);
      if (error) return { ok: false, error: `Could not reorder the sheets: ${error.message}` };
    }
    return { ok: true };
  });

/**
 * Keep a workbook's thumbnail, as the editor drew it: its owner or an editor
 * (both see every cell). Writing it is not an edit: it lives in its own
 * table, so the workbook's "edited" time stays.
 */
export const sheetsSetPreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ workbook_id: z.string().uuid(), preview: previewSchema }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const got = await requireAccess(caller.userId, data.workbook_id, "edit");
    if (!got.ok) return got;
    const { error } = await supabaseAdmin.from("sheet_workbook_previews").upsert({
      workbook_id: data.workbook_id,
      user_id: got.access.ownerId,
      preview: data.preview as unknown as Json,
      updated_at: new Date().toISOString(),
    });
    if (error) return { ok: false, error: `Could not keep the thumbnail: ${error.message}` };
    return { ok: true };
  });

/**
 * Thumbnails for a few of the caller's own workbooks that have none, computed
 * here from their saved sheets. The gallery asks for the ones it is showing,
 * a few at a time; each is built once and kept.
 */
export const sheetsBackfillPreviews = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ ids: z.array(z.string().uuid()).min(1).max(4) }).parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; previews: Record<string, WorkbookPreview> } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const { data: have, error: e1 } = await supabaseAdmin
        .from("sheet_workbook_previews")
        .select("workbook_id")
        .in("workbook_id", data.ids);
      if (e1) return { ok: false, error: `Could not read the thumbnails: ${e1.message}` };
      const done = new Set((have ?? []).map((h) => h.workbook_id));
      const ids = data.ids.filter((id) => !done.has(id));
      if (!ids.length) return { ok: true, previews: {} };
      // The caller's own sheets only: user_id is the owner's on every tab.
      const { data: tabs, error } = await supabaseAdmin
        .from("sheet_tabs")
        .select("id, workbook_id, name, kind, position, grid")
        .in("workbook_id", ids)
        .eq("user_id", caller.userId);
      if (error) return { ok: false, error: `Could not read the sheets: ${error.message}` };
      const previews: Record<string, WorkbookPreview> = {};
      for (const id of ids) {
        const mine = (tabs ?? []).filter((t) => t.workbook_id === id);
        if (!mine.length) continue;
        let preview: WorkbookPreview | null = null;
        try {
          preview = previewOfTabs(
            mine.map((t) => ({ ...t, kind: t.kind === "table" ? "table" : "grid" })),
          );
        } catch (e) {
          console.warn(`[sheets] no thumbnail for ${id}: ${(e as Error).message}`);
        }
        if (!preview || !previewSchema.safeParse(preview).success) continue;
        const { error: e2 } = await supabaseAdmin.from("sheet_workbook_previews").upsert({
          workbook_id: id,
          user_id: caller.userId,
          preview: preview as unknown as Json,
        });
        if (!e2) previews[id] = preview;
      }
      return { ok: true, previews };
    },
  );

/**
 * Save a grid sheet's cells: its owner or an editor. `base_version` is the
 * version the editor read; the write only lands if the row is still at it,
 * and the answer carries the new version. A newer version wins, and the
 * caller is told so.
 */
export const sheetsSaveGrid = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        tab_id: z.string().uuid(),
        base_version: z.number().int().min(1),
        grid: gridSchema,
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; version: number } | (Fail & { conflict?: boolean; version?: number })
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const got = await requireTab(caller.userId, data.tab_id, "edit", { kind: "grid" });
      if (!got.ok) return got;
      const { maxCells } = await limits();
      const count = Object.keys(data.grid.cells).length;
      if (count > maxCells) {
        return {
          ok: false,
          error: `This sheet has ${count.toLocaleString()} cells and a grid sheet holds at most ${maxCells.toLocaleString()} (SHEETS_MAX_CELLS). Large data belongs in a table sheet, which lives in the lakehouse.`,
        };
      }
      const { data: rows, error } = await supabaseAdmin
        .from("sheet_tabs")
        .update({ grid: data.grid as unknown as Json, version: data.base_version + 1 })
        .eq("id", data.tab_id)
        .eq("workbook_id", got.tab.workbook_id)
        .eq("kind", "grid")
        .eq("version", data.base_version)
        .select("version, workbook_id");
      if (error) return { ok: false, error: `Could not save the sheet: ${error.message}` };
      if (rows?.length) {
        // A version of the workbook as people work, at most one per
        // SHEETS_VERSION_INTERVAL_MINUTES. A failure here never fails the save.
        try {
          await takeVersion(rows[0].workbook_id, got.access.ownerId, "auto", null, caller.userId);
        } catch (e) {
          console.warn(`[sheets] automatic version skipped: ${(e as Error).message}`);
        }
        return { ok: true, version: rows[0].version };
      }
      // Nothing matched: the sheet is gone, or someone saved a newer version.
      const { data: now, error: nowErr } = await supabaseAdmin
        .from("sheet_tabs")
        .select("version")
        .eq("id", data.tab_id)
        .maybeSingle();
      if (nowErr) return { ok: false, error: `Could not read the sheet: ${nowErr.message}` };
      if (!now) return { ok: false, error: "This sheet no longer exists" };
      return {
        ok: false,
        conflict: true,
        version: now.version,
        error: `This sheet was saved elsewhere (version ${now.version}) after you opened it (version ${data.base_version}). Reload it to see those changes; yours are not saved.`,
      };
    },
  );

/**
 * Sheets read from a file (an .xlsx or a CSV, parsed in the browser) saved as
 * grid sheets: into a new workbook, or appended to one the caller owns or
 * edits. All or nothing: a sheet that fails takes the ones already written
 * with it, and a new workbook with it.
 */
export const sheetsImportGrids = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        /** Append to this workbook; without it, a new workbook named `name`. */
        workbook_id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
        sheets: z
          .array(z.object({ name: z.string().trim().min(1).max(100), grid: gridSchema }).strict())
          .min(1),
      })
      .refine((d) => d.workbook_id || d.name, "A new workbook needs a name")
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; workbook_id: string; tabs: SheetTabRow[] } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const { maxCells, maxImportSheets } = await limits();
      if (data.sheets.length > maxImportSheets) {
        return {
          ok: false,
          error: `The file has ${data.sheets.length} sheets; an import brings at most ${maxImportSheets} here (SHEETS_IMPORT_MAX_SHEETS).`,
        };
      }
      const seen = new Set<string>();
      for (const s of data.sheets) {
        const problem = sheetNameProblem(s.name);
        if (problem) return { ok: false, error: `Sheet "${s.name}": ${problem}` };
        if (seen.has(s.name.toLowerCase()))
          return { ok: false, error: `Two sheets are named "${s.name}"` };
        seen.add(s.name.toLowerCase());
        const count = Object.keys(s.grid.cells).length;
        if (count > maxCells) {
          return {
            ok: false,
            error: `Sheet "${s.name}" has ${count.toLocaleString()} cells and a grid sheet holds at most ${maxCells.toLocaleString()} (SHEETS_MAX_CELLS). Bring it in as a table sheet instead.`,
          };
        }
      }

      let workbookId = data.workbook_id;
      let ownerId = caller.userId;
      let created = false;
      let start = 0;
      if (workbookId) {
        const got = await requireAccess(caller.userId, workbookId, "edit");
        if (!got.ok) return got;
        ownerId = got.access.ownerId;
        const { data: existing, error } = await supabaseAdmin
          .from("sheet_tabs")
          .select("name, position")
          .eq("workbook_id", workbookId);
        if (error) return { ok: false, error: `Could not read the sheets: ${error.message}` };
        for (const t of existing ?? []) {
          if (seen.has(t.name.toLowerCase()))
            return { ok: false, error: `This workbook already has a sheet named "${t.name}"` };
          start = Math.max(start, t.position + 1);
        }
      } else {
        const { data: wb, error } = await supabaseAdmin
          .from("sheet_workbooks")
          .insert({
            user_id: caller.userId,
            name: data.name!,
            description: data.description ?? null,
          })
          .select("id")
          .single();
        if (error || !wb)
          return {
            ok: false,
            error: `Could not create the workbook: ${error?.message ?? "no row"}`,
          };
        workbookId = wb.id;
        created = true;
      }

      const { data: tabs, error } = await supabaseAdmin
        .from("sheet_tabs")
        .insert(
          data.sheets.map((s, i) => ({
            workbook_id: workbookId!,
            user_id: ownerId,
            name: s.name.trim(),
            kind: "grid",
            position: start + i,
            grid: s.grid as unknown as Json,
          })),
        )
        .select("id, workbook_id, name, kind, position, grid, table_config, version, updated_at");
      if (error || !tabs?.length) {
        // One insert of every sheet is all or nothing already; a workbook made
        // for this import goes with it.
        if (created) await supabaseAdmin.from("sheet_workbooks").delete().eq("id", workbookId!);
        return {
          ok: false,
          error:
            error?.code === "23505"
              ? "Two sheets would have the same name"
              : `Could not save the sheets: ${error?.message ?? "no rows"}`,
        };
      }
      return {
        ok: true,
        workbook_id: workbookId!,
        tabs: (tabs as SheetTabRow[]).sort((a, b) => a.position - b.position),
      };
    },
  );
