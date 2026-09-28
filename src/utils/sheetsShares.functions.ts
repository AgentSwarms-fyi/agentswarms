// Sharing a workbook: with people (by the exact email they sign in with) or
// with IAM groups, as viewers or editors. A viewer's share can leave sheets
// out and keep only some rows of a sheet ("only the rows where Region is
// West"); the server sends that viewer only those rows (sheets/access.server).
// Only the owner manages shares, and every change is audited, naming who was
// given what.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { tableConfigSchema } from "@/utils/sheets/schemas";
import { requireAccess, type RowFilter } from "@/utils/sheets/access.server";
import { findUserByEmail, userLabels } from "@/utils/sheets/people.server";

type Fail = { ok: false; error: string };

export type ShareFilter = RowFilter;

export type ShareRow = {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  /** An email for a person, the group's name for a group. */
  label: string;
  /** A person's display name, or "Group". */
  detail: string | null;
  role: "viewer" | "editor";
  /** Lower-case sheet name → the rows kept. */
  row_filters: Record<string, ShareFilter>;
  /** Lower-case names of the sheets left out. */
  hidden_sheets: string[];
  created_at: string;
};

const tokenOnly = z.object({ access_token: z.string().min(1) });
const filterSchema = z
  .object({
    column: z.string().trim().min(1).max(200),
    values: z.array(z.string().max(500)).min(1).max(1000),
    header: z.number().int().min(0).max(100).optional(),
  })
  .strict();

async function caller(token: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

async function workbookName(id: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("sheet_workbooks")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  return data?.name ?? "a workbook";
}

/** The workbook's shares, with who each one is. Owner only. */
export const sheetsSharesList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ workbook_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; shares: ShareRow[] } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const own = await requireAccess(who.userId, data.workbook_id, "own", {
      doing: "see who it is shared with",
    });
    if (!own.ok) return own;
    try {
      const { data: rows, error } = await supabaseAdmin
        .from("sheet_workbook_shares")
        .select("id, principal_type, principal_id, role, row_filters, hidden_sheets, created_at")
        .eq("workbook_id", data.workbook_id)
        .order("created_at", { ascending: true });
      if (error) return { ok: false, error: `Could not read the shares: ${error.message}` };
      const users = await userLabels(
        (rows ?? []).filter((r) => r.principal_type === "user").map((r) => r.principal_id),
      );
      const groupIds = (rows ?? [])
        .filter((r) => r.principal_type === "group")
        .map((r) => r.principal_id);
      let groupName = new Map<string, string>();
      if (groupIds.length) {
        const { data: groups, error: gErr } = await supabaseAdmin
          .from("iam_groups")
          .select("id, name")
          .in("id", groupIds);
        if (gErr) return { ok: false, error: `Could not read the groups: ${gErr.message}` };
        groupName = new Map((groups ?? []).map((g) => [g.id, g.name]));
      }
      return {
        ok: true,
        shares: (rows ?? []).map((r) => {
          const u = users.get(r.principal_id);
          return {
            id: r.id,
            principal_type: r.principal_type as "user" | "group",
            principal_id: r.principal_id,
            label:
              r.principal_type === "group"
                ? (groupName.get(r.principal_id) ?? "A group that no longer exists")
                : (u?.email ?? "Someone whose account no longer exists"),
            detail: r.principal_type === "group" ? "Group" : (u?.name ?? null),
            role: r.role as "viewer" | "editor",
            row_filters: (r.row_filters ?? {}) as Record<string, ShareFilter>,
            hidden_sheets: r.hidden_sheets ?? [],
            created_at: r.created_at,
          };
        }),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** Groups a workbook can be shared with. */
export const sheetsShareGroups = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenOnly.parse(input))
  .handler(
    async ({ data }): Promise<{ ok: true; groups: { id: string; name: string }[] } | Fail> => {
      const who = await caller(data.access_token);
      if (!who.ok) return who;
      const { data: groups, error } = await supabaseAdmin
        .from("iam_groups")
        .select("id, name")
        .order("name");
      if (error) return { ok: false, error: `Could not list the groups: ${error.message}` };
      return { ok: true, groups: groups ?? [] };
    },
  );

type SheetInfo = { name: string; kind: string; columns: string[] | null; source: string | null };

/** The workbook's sheets, with a table sheet's columns and the lakehouse table it reads. */
async function sheetsOf(workbookId: string): Promise<SheetInfo[]> {
  const { data, error } = await supabaseAdmin
    .from("sheet_tabs")
    .select("name, kind, table_config")
    .eq("workbook_id", workbookId);
  if (error) throw new Error(`Could not read the sheets: ${error.message}`);
  return (data ?? []).map((t) => {
    const cfg = t.kind === "table" ? tableConfigSchema.safeParse(t.table_config) : null;
    return {
      name: t.name,
      kind: t.kind,
      columns: cfg?.success ? cfg.data.columns.map((c) => c.name) : null,
      source:
        cfg?.success && cfg.data.source.kind === "lakehouse"
          ? `${cfg.data.source.schema}.${cfg.data.source.table}`
          : null,
    };
  });
}

/**
 * What a share's filters and left-out sheets say is checked against the
 * workbook as it is: a filter on a sheet or column that isn't there would
 * look like protection and do nothing, so it is refused.
 */
export function shareProblem(
  sheets: SheetInfo[],
  filters: Record<string, ShareFilter>,
  hidden: string[],
): string | null {
  const byName = new Map(sheets.map((s) => [s.name.toLowerCase(), s]));
  for (const h of hidden) {
    if (!byName.has(h.toLowerCase())) return `There is no sheet named "${h}" to leave out`;
  }
  if (
    sheets.length &&
    sheets.every((s) => hidden.some((h) => h.toLowerCase() === s.name.toLowerCase()))
  ) {
    return "A share has to leave at least one sheet in";
  }
  for (const [name, f] of Object.entries(filters)) {
    const s = byName.get(name.toLowerCase());
    if (!s) return `There is no sheet named "${name}" to filter`;
    if (hidden.some((h) => h.toLowerCase() === name.toLowerCase())) {
      return `"${s.name}" is left out already; it needs no filter`;
    }
    if (s.kind === "grid") {
      if (!/^[A-Z]{1,3}$/i.test(f.column.trim())) {
        return `On the grid sheet "${s.name}", name the filter's column by its letter (like B)`;
      }
    } else if (!(s.columns ?? []).some((c) => c.toLowerCase() === f.column.trim().toLowerCase())) {
      return `"${s.name}" has no column "${f.column}"`;
    }
    if (!f.values.length) return `The filter on "${s.name}" keeps no rows; pick at least one value`;
  }
  return null;
}

/**
 * Share with someone (by email) or a group, or change a share. A viewer's
 * share may leave sheets out and keep only some rows of a sheet; an editor
 * sees and changes everything, so an editor's share carries neither.
 * Answers with what the person may not be able to read themselves: a table
 * sheet reads the lakehouse as whoever opens it.
 */
export const sheetsShareSet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        target: z.union([
          z.object({ email: z.string().trim().email().max(320) }).strict(),
          z.object({ group_id: z.string().uuid() }).strict(),
        ]),
        role: z.enum(["viewer", "editor"]),
        row_filters: z.record(z.string().max(100), filterSchema).optional(),
        hidden_sheets: z.array(z.string().max(100)).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string; warnings: string[] } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const own = await requireAccess(who.userId, data.workbook_id, "own", { doing: "share it" });
    if (!own.ok) return own;
    try {
      let principal: { type: "user" | "group"; id: string; label: string };
      if ("email" in data.target) {
        const u = await findUserByEmail(data.target.email);
        if (!u) return { ok: false, error: `No one here signs in as ${data.target.email}` };
        if (u.id === who.userId) return { ok: false, error: "This is your own workbook" };
        principal = { type: "user", id: u.id, label: data.target.email.toLowerCase() };
      } else {
        const { data: g, error: gErr } = await supabaseAdmin
          .from("iam_groups")
          .select("id, name")
          .eq("id", data.target.group_id)
          .maybeSingle();
        if (gErr) return { ok: false, error: `Could not read the group: ${gErr.message}` };
        if (!g) return { ok: false, error: "That group no longer exists" };
        principal = { type: "group", id: g.id, label: g.name };
      }
      const viewer = data.role === "viewer";
      const filters =
        viewer && data.row_filters
          ? Object.fromEntries(
              Object.entries(data.row_filters).map(([k, v]) => [
                k.trim().toLowerCase(),
                { ...v, column: v.column.trim() },
              ]),
            )
          : {};
      const hidden = viewer ? (data.hidden_sheets ?? []).map((s) => s.trim().toLowerCase()) : [];
      const sheets = await sheetsOf(data.workbook_id);
      const problem = shareProblem(sheets, filters, hidden);
      if (problem) return { ok: false, error: problem };

      const { data: row, error } = await supabaseAdmin
        .from("sheet_workbook_shares")
        .upsert(
          {
            workbook_id: data.workbook_id,
            principal_type: principal.type,
            principal_id: principal.id,
            role: data.role,
            row_filters: Object.keys(filters).length ? (filters as unknown as Json) : null,
            hidden_sheets: hidden.length ? hidden : null,
            created_by: who.userId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workbook_id,principal_type,principal_id" },
        )
        .select("id")
        .single();
      if (error || !row) return { ok: false, error: `Could not share: ${error?.message}` };

      const { auditEvent } = await import("@/utils/audit.server");
      auditEvent({
        userId: who.userId,
        action: "sheet.share",
        resourceType: "sheet_workbook",
        resourceName: await workbookName(data.workbook_id),
        resourceId: data.workbook_id,
        detail: {
          with: principal.label,
          principal_type: principal.type,
          role: data.role,
          filtered: Object.keys(filters),
          left_out: hidden,
        },
      });

      // A table sheet reads the lakehouse as the person reading it. Say
      // which ones this person can't read, so the owner can grant access or
      // knows why those sheets will show an error. (A group's members are
      // each asked when they open it.)
      const warnings: string[] = [];
      if (principal.type === "user") {
        const shown = sheets.filter((s) => s.source && !hidden.includes(s.name.toLowerCase()));
        if (shown.length) {
          const { accessibleSchemas } = await import("@/utils/lakehouse/core.server");
          const theirs = new Set((await accessibleSchemas(principal.id)).map((s) => s.name));
          for (const s of shown) {
            const schema = s.source!.split(".")[0];
            if (!theirs.has(schema)) {
              warnings.push(
                `"${s.name}" reads ${s.source}, and ${principal.label} has no access to the ${schema} schema: they will see an error there until it is granted to them.`,
              );
            }
          }
        }
      } else if (sheets.some((s) => s.source)) {
        warnings.push(
          "Table sheets read the lakehouse as whoever opens them: members of the group without access to those tables will see an error on those sheets.",
        );
      }
      return { ok: true, id: row.id, warnings };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** Stop sharing with someone or a group. Owner only. */
export const sheetsShareRemove = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ workbook_id: z.string().uuid(), share_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const who = await caller(data.access_token);
    if (!who.ok) return who;
    const own = await requireAccess(who.userId, data.workbook_id, "own", {
      doing: "change who it is shared with",
    });
    if (!own.ok) return own;
    try {
      const { data: gone, error } = await supabaseAdmin
        .from("sheet_workbook_shares")
        .delete()
        .eq("id", data.share_id)
        .eq("workbook_id", data.workbook_id)
        .select("principal_type, principal_id, role");
      if (error) return { ok: false, error: `Could not stop sharing: ${error.message}` };
      if (!gone?.length) return { ok: false, error: "That share no longer exists" };
      const g = gone[0];
      let label = g.principal_id;
      if (g.principal_type === "user") {
        label = (await userLabels([g.principal_id])).get(g.principal_id)?.email ?? label;
      } else {
        const { data: grp } = await supabaseAdmin
          .from("iam_groups")
          .select("name")
          .eq("id", g.principal_id)
          .maybeSingle();
        label = grp?.name ?? label;
      }
      const { auditEvent } = await import("@/utils/audit.server");
      auditEvent({
        userId: who.userId,
        action: "sheet.unshare",
        resourceType: "sheet_workbook",
        resourceName: await workbookName(data.workbook_id),
        resourceId: data.workbook_id,
        detail: { with: label, principal_type: g.principal_type, role: g.role },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
