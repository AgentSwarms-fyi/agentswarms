// Who may open a workbook, and what they get. Resolved on the server for
// every read and write of a workbook; nothing about a share reaches a browser
// except through these rules.
//
// - The owner and editors get every sheet and every row.
// - A viewer gets what their shares allow: sheets a share leaves out are not
//   sent at all (not even their names), and a sheet with a row filter
//   arrives with only the rows the filter keeps. For a grid sheet the rows
//   are cut here, before the sheet is sent; for a table sheet the filter is
//   applied where its query starts (buildTableRelation's `restrict`), so a
//   page, a filter's value list, a download, a lookup into it, a pivot of it
//   and a formula over it all see the same rows.
// - A table sheet reads the lakehouse as the person reading, never as the
//   owner: sharing a workbook shares the workbook, not the owner's data
//   access (the AI Analyst's rule). Their own grants, row filters and column
//   masks apply, and the share's row filter narrows further.
//
// Several shares (one to the person, others to groups they are in) combine
// to the widest: an editor share wins; a sheet is left out only if every
// share leaves it out; a row is kept if any share keeps it.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { GridData } from "@/lib/sheets/engine";
import type { OtherTable, TableConfig, TableFilter } from "@/lib/sheets/sql/tableQuery";
import { tableConfigSchema } from "@/utils/sheets/schemas";

import type { Role, RowFilter } from "@/lib/sheets/share";

export type { Role, RowFilter };

export type WorkbookAccess = {
  role: Role;
  workbookId: string;
  ownerId: string;
  /** Lower-case names of the sheets left out for this viewer. */
  hidden: Set<string>;
  /** Lower-case sheet name → the rows a viewer gets: a row is kept if ANY of these keeps it. */
  filters: Map<string, RowFilter[]>;
  /** The owner looking at the workbook as one of its shares sees it ("View as"). */
  viewingAs: string | null;
};

type ShareRow = {
  id?: string;
  role: "viewer" | "editor";
  row_filters: Record<string, RowFilter> | null;
  hidden_sheets: string[] | null;
};

const lower = (s: string) => s.trim().toLowerCase();

/** The IAM groups a user belongs to. A failed read refuses rather than guesses. */
async function groupsOf(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("iam_group_members")
    .select("group_id")
    .eq("user_id", userId);
  if (error) throw new Error(`Could not read your groups: ${error.message}`);
  return (data ?? []).map((g) => g.group_id as string);
}

/**
 * The widest access a set of shares gives. Exported for the tests; the
 * callers use workbookAccess.
 */
export function combineShares(
  shares: ShareRow[],
): Pick<WorkbookAccess, "role" | "hidden" | "filters"> | null {
  if (!shares.length) return null;
  if (shares.some((s) => s.role === "editor")) {
    return { role: "editor", hidden: new Set(), filters: new Map() };
  }
  // A sheet is left out only if every share leaves it out.
  const hidden = shares
    .map((s) => new Set((s.hidden_sheets ?? []).map(lower)))
    .reduce((all, h) => new Set([...all].filter((x) => h.has(x))));
  // A sheet's rows: every row if any share leaves the sheet unfiltered,
  // otherwise the rows any of the shares' filters keeps.
  const filters = new Map<string, RowFilter[]>();
  const named = new Set(shares.flatMap((s) => Object.keys(s.row_filters ?? {}).map(lower)));
  for (const name of named) {
    const each = shares.map(
      (s) => Object.entries(s.row_filters ?? {}).find(([k]) => lower(k) === name)?.[1],
    );
    if (each.some((f) => !f)) continue;
    filters.set(
      name,
      (each as RowFilter[]).map((f) => ({
        column: f.column,
        values: [...f.values],
        ...(f.header !== undefined ? { header: f.header } : {}),
      })),
    );
  }
  return { role: "viewer", hidden, filters };
}

/**
 * The caller's access to a workbook, or null when they have none. `asShare`
 * lets the owner see the workbook as one of its shares does; for anyone else
 * it is refused.
 */
export async function workbookAccess(
  userId: string,
  workbookId: string,
  opts: { asShare?: string | null } = {},
): Promise<WorkbookAccess | null> {
  const { data: wb, error } = await supabaseAdmin
    .from("sheet_workbooks")
    .select("id, user_id")
    .eq("id", workbookId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the workbook: ${error.message}`);
  if (!wb) return null;
  const base = { workbookId, ownerId: wb.user_id as string };
  if (opts.asShare) {
    if (wb.user_id !== userId) {
      throw new Error("Only the workbook's owner can look at it as someone it is shared with");
    }
    const { data: share, error: sErr } = await supabaseAdmin
      .from("sheet_workbook_shares")
      .select("id, role, row_filters, hidden_sheets")
      .eq("id", opts.asShare)
      .eq("workbook_id", workbookId)
      .maybeSingle();
    if (sErr) throw new Error(`Could not read the share: ${sErr.message}`);
    if (!share) throw new Error("That share no longer exists");
    const c = combineShares([share as ShareRow])!;
    return { ...base, ...c, viewingAs: share.id as string };
  }
  if (wb.user_id === userId) {
    return { ...base, role: "owner", hidden: new Set(), filters: new Map(), viewingAs: null };
  }
  const groups = await groupsOf(userId);
  const principals = [`and(principal_type.eq.user,principal_id.eq.${userId})`];
  if (groups.length) {
    principals.push(`and(principal_type.eq.group,principal_id.in.(${groups.join(",")}))`);
  }
  const { data: shares, error: e2 } = await supabaseAdmin
    .from("sheet_workbook_shares")
    .select("role, row_filters, hidden_sheets")
    .eq("workbook_id", workbookId)
    .or(principals.join(","));
  if (e2) throw new Error(`Could not read the workbook's shares: ${e2.message}`);
  const c = combineShares((shares ?? []) as ShareRow[]);
  return c ? { ...base, ...c, viewingAs: null } : null;
}

export type Need = "view" | "edit" | "own";
type Fail = { ok: false; error: string; missing?: boolean };

const NOT_THERE = "This workbook does not exist, or is not shared with you";

/**
 * The caller's access, if it allows `need`; otherwise why not. `doing` ends
 * the owner-only refusal: "Only the workbook's owner can <doing>".
 */
export async function requireAccess(
  userId: string,
  workbookId: string,
  need: Need,
  opts: { asShare?: string | null; doing?: string } = {},
): Promise<{ ok: true; access: WorkbookAccess } | Fail> {
  let a: WorkbookAccess | null;
  try {
    a = await workbookAccess(userId, workbookId, { asShare: opts.asShare });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!a) return { ok: false, error: NOT_THERE, missing: true };
  if (need === "view") return { ok: true, access: a };
  if (a.viewingAs) {
    return {
      ok: false,
      error: "This is the workbook as a share sees it; nothing changes from here",
    };
  }
  if (need === "own" && a.role !== "owner") {
    return { ok: false, error: `Only the workbook's owner can ${opts.doing ?? "do that"}` };
  }
  if (need === "edit" && a.role === "viewer") {
    return {
      ok: false,
      error: "This workbook is shared with you to view; it can't be changed from here",
    };
  }
  return { ok: true, access: a };
}

export type TabRow = {
  id: string;
  workbook_id: string;
  name: string;
  kind: string;
  position: number;
  version: number;
  table_config: unknown;
};

/**
 * A sheet and the caller's access to its workbook, if it allows `need`. A
 * sheet left out for a viewer reads as not there at all.
 */
export async function requireTab(
  userId: string,
  tabId: string,
  need: Need,
  opts: { asShare?: string | null; doing?: string; kind?: "grid" | "table" } = {},
): Promise<{ ok: true; access: WorkbookAccess; tab: TabRow } | Fail> {
  const { data: tab, error } = await supabaseAdmin
    .from("sheet_tabs")
    .select("id, workbook_id, name, kind, position, version, table_config")
    .eq("id", tabId)
    .maybeSingle();
  if (error) return { ok: false, error: `Could not read the sheet: ${error.message}` };
  if (!tab) return { ok: false, error: "This sheet does not exist, or is not shared with you" };
  const got = await requireAccess(userId, tab.workbook_id, need, opts);
  if (!got.ok) return got;
  if (!sheetShown(got.access, tab.name)) {
    return { ok: false, error: "This sheet does not exist, or is not shared with you" };
  }
  if (opts.kind && tab.kind !== opts.kind) {
    return { ok: false, error: `This sheet is a ${tab.kind} sheet, not a ${opts.kind} sheet` };
  }
  return { ok: true, access: got.access, tab: tab as TabRow };
}

/**
 * The workbooks shared with this user (by name or through a group), each
 * with the access its shares give.
 */
export async function sharedWithMe(
  userId: string,
): Promise<Map<string, Pick<WorkbookAccess, "role" | "hidden" | "filters">>> {
  const groups = await groupsOf(userId);
  const principals = [`and(principal_type.eq.user,principal_id.eq.${userId})`];
  if (groups.length) {
    principals.push(`and(principal_type.eq.group,principal_id.in.(${groups.join(",")}))`);
  }
  const { data, error } = await supabaseAdmin
    .from("sheet_workbook_shares")
    .select("workbook_id, role, row_filters, hidden_sheets")
    .or(principals.join(","))
    .limit(2000);
  if (error) throw new Error(`Could not read what is shared with you: ${error.message}`);
  const byWorkbook = new Map<string, ShareRow[]>();
  for (const r of data ?? []) {
    const list = byWorkbook.get(r.workbook_id) ?? [];
    list.push(r as unknown as ShareRow);
    byWorkbook.set(r.workbook_id, list);
  }
  const out = new Map<string, Pick<WorkbookAccess, "role" | "hidden" | "filters">>();
  for (const [id, list] of byWorkbook) {
    const c = combineShares(list);
    if (c) out.set(id, c);
  }
  return out;
}

/** May this caller change the workbook? (Never while the owner is viewing it as a share.) */
export const canEdit = (a: WorkbookAccess | null): boolean =>
  !!a && !a.viewingAs && (a.role === "owner" || a.role === "editor");

export const isOwner = (a: WorkbookAccess | null): boolean =>
  !!a && !a.viewingAs && a.role === "owner";

/** Is this sheet sent to this caller at all? */
export const sheetShown = (a: WorkbookAccess, name: string): boolean => !a.hidden.has(lower(name));

/** The row filters this caller reads a sheet under (none for the owner and editors). */
export const rowFiltersFor = (a: WorkbookAccess, name: string): RowFilter[] =>
  a.filters.get(lower(name)) ?? [];

/**
 * A table sheet's settings as this caller reads them: the share's rows forced
 * in, and, given the sheet as stored, where its rows come from when that is a
 * query (savedSource).
 */
export function restrictedConfig(
  a: WorkbookAccess,
  name: string,
  cfg: TableConfig,
  stored?: unknown,
): TableConfig {
  const base = stored === undefined ? cfg : savedSource(stored, cfg);
  const fs = rowFiltersFor(a, name);
  if (!fs.length) return base;
  const restrict: TableFilter[] = fs.map((f) => ({ column: f.column, op: "in", values: f.values }));
  return { ...base, restrict };
}

/**
 * A read takes a sheet's settings from the editor, so a new sort shows before
 * it is saved. Where a query sheet's rows come from is its SQL, and that is
 * never taken from a read (R154): the SQL saved with the sheet runs, and a
 * sheet saved over a table is not turned into a query by one. A viewer's copy
 * carries no SQL at all (viewerConfig).
 */
export function savedSource(stored: unknown, cfg: TableConfig): TableConfig {
  const saved = tableConfigSchema.safeParse(stored);
  const source = saved.success ? (saved.data.source as TableConfig["source"]) : undefined;
  if (source?.kind === "query") return { ...cfg, source };
  if (cfg.source.kind !== "query") return cfg;
  // A query the sheet doesn't have: run nothing (an empty query is refused).
  return { ...cfg, source: source ?? { kind: "query", sql: "" } };
}

/**
 * A table sheet's settings as a viewer may see them: where the rows come
 * from, without the owner's import query or connection.
 */
export function viewerConfig(cfg: TableConfig): TableConfig {
  // A query sheet's SQL stays with the owner and editors, as an import's
  // query does; a viewer's reads run the saved one (savedSource).
  if (cfg.source.kind === "query") cfg = { ...cfg, source: { kind: "query", sql: "" } };
  const o = cfg.origin;
  if (!o || o.kind === "lakehouse" || o.kind === "upload") return cfg;
  if (o.kind === "warehouse") {
    return { ...cfg, origin: { ...o, connection_id: "", query: "" } };
  }
  return cfg;
}

/**
 * The workbook's table sheets other than `exceptId`, as this caller may read
 * them: sheets left out for them are not there to look up, and a filtered
 * sheet carries its filter, so a lookup or pivot into it sees only those rows.
 */
export async function othersFor(
  a: WorkbookAccess,
  exceptId: string,
): Promise<Map<string, OtherTable>> {
  const { data, error } = await supabaseAdmin
    .from("sheet_tabs")
    .select("id, name, table_config")
    .eq("workbook_id", a.workbookId)
    .eq("kind", "table");
  if (error) throw new Error(`Could not read the workbook's tables: ${error.message}`);
  const out = new Map<string, OtherTable>();
  for (const row of data ?? []) {
    if (row.id === exceptId || !sheetShown(a, row.name)) continue;
    const parsed = tableConfigSchema.safeParse(row.table_config);
    if (!parsed.success) continue;
    out.set(lower(row.name), {
      name: row.name,
      config: restrictedConfig(a, row.name, parsed.data as TableConfig),
    });
  }
  return out;
}

/** The 0-based column of a letter (A, B, AA). */
function colOf(letter: string): number {
  return [...letter.trim().toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/**
 * A grid sheet as a filtered viewer receives it: the top `header` rows, and
 * the rows whose value in the filter's column is one of those kept (any
 * filter keeping a row keeps it). The cells of every other row are left
 * out, and those rows are hidden so the sheet reads like a filtered one.
 * A cell's saved Excel value (`c`) goes too: it can be a total over the
 * rows left out.
 */
export function filterGridRows(grid: GridData, filters: RowFilter[]): GridData {
  if (!filters.length) return grid;
  const tests = filters.map((f) => ({
    col: /^[A-Z]{1,3}$/i.test(f.column.trim()) ? colOf(f.column) : -1,
    keep: new Set(f.values.map(lower)),
    header: Math.max(0, f.header ?? 1),
  }));
  const header = Math.min(...tests.map((t) => t.header));
  const text = (r: number, c: number) =>
    lower((grid.cells[`${r},${c}`]?.i ?? "").replace(/^'/, ""));
  const rowOk = new Map<number, boolean>();
  const cells: GridData["cells"] = {};
  for (const [k, cell] of Object.entries(grid.cells)) {
    const r = Number(k.slice(0, k.indexOf(",")));
    let ok = rowOk.get(r);
    if (ok === undefined) {
      ok = r < header || tests.some((t) => t.col >= 0 && t.keep.has(text(r, t.col)));
      rowOk.set(r, ok);
    }
    if (!ok) continue;
    const { c: _saved, ...rest } = cell;
    cells[k] = rest;
  }
  const removed = [...rowOk.entries()].filter(([, ok]) => !ok).map(([r]) => r);
  const gone = new Set(removed);
  const rowHeights = Object.fromEntries(
    Object.entries(grid.rowHeights ?? {}).filter(([r]) => !gone.has(Number(r))),
  );
  const hiddenRows = [...new Set([...(grid.hiddenRows ?? []), ...removed])].sort((a, b) => a - b);
  const out: GridData = { ...grid, cells, rowHeights };
  if (hiddenRows.length) out.hiddenRows = hiddenRows;
  // The AutoFilter's remembered hidden rows are the owner's view of all rows.
  if (grid.filter) out.filter = { ...grid.filter, hidden: undefined };
  return out;
}

/** A sheet's saved row as this caller receives it, or null when it is left out for them. */
export function tabFor<
  T extends { name: string; kind: string; grid: unknown; table_config: unknown },
>(a: WorkbookAccess, tab: T): T | null {
  if (!sheetShown(a, tab.name)) return null;
  if (a.role !== "viewer") return tab;
  if (tab.kind === "grid") {
    const fs = rowFiltersFor(a, tab.name);
    return fs.length ? { ...tab, grid: filterGridRows(tab.grid as GridData, fs) } : tab;
  }
  const parsed = tableConfigSchema.safeParse(tab.table_config);
  if (!parsed.success) return tab;
  return { ...tab, table_config: viewerConfig(parsed.data as TableConfig) };
}
