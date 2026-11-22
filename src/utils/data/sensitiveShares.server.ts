// Personal data in shared datasets: hiding it from the shares, and asking the
// owner first (R521).
//
// THREE RULES, the same ones a model promotion follows (ml/promote.server.ts):
//
//   ONE IMPLEMENTATION OF "HIDE". `hideColumnsFromShares` is the only code that
//   adds a dataset's columns to its grants' masks. The owner's button on the
//   dataset page and an approved suggestion both call it, so the approved path
//   cannot do something slightly different from the one the owner can see.
//
//   AUTHORITY IS THE DATASET, NOT THE APPROVAL ROW. An approval's owner may
//   write its row (status, payload), so a row naming someone else's dataset
//   proves nothing. Only the dataset's owner may hide its columns, checked
//   against user_data_tables every time.
//
//   IT ONLY EVER NARROWS. Hiding a column takes something away from people a
//   dataset is shared with; it never gives anyone more. That is why the
//   owner may do it to a grant an administrator made, and why a repeated or
//   overlapping request is harmless.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  describeColumns,
  findSensitiveColumns,
  HIDE_COLUMNS_ACTION,
  hiddenBy,
  maskWith,
  suggestionFor,
  type PriorSuggestion,
  type SensitiveFinding,
} from "@/lib/sensitiveData";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";

import { scanDatasetRows } from "./datasetRows.server";

export { HIDE_COLUMNS_ACTION };

/** Rows sampled per dataset when looking for personal data. */
export const SENSITIVE_SAMPLE_ROWS = 500;
/** Datasets looked at per sweep, so one sweep stays bounded. */
const SWEEP_DATASET_CAP = 200;
/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Fail = { ok: false; error: string };

/** The columns a dataset declares. */
function columnsOf(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .map((c) => (c && typeof c === "object" ? (c as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === "string" && !!n)
    : [];
}

/**
 * Hide columns of a dataset from every grant that shares it. THE ONLY PLACE
 * THAT DOES. `approvalId` is set when this runs because the owner approved a
 * suggestion, so the audit says which one.
 */
export async function hideColumnsFromShares(
  datasetId: string,
  columns: readonly string[],
  actorId: string,
  approvalId?: string | null,
): Promise<{ ok: true; changed: number; grants: number; columns: string[] } | Fail> {
  const { data: table, error: tErr } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, user_id, columns, is_sample")
    .eq("id", datasetId)
    .maybeSingle();
  if (tErr) return { ok: false, error: tErr.message };
  // One answer for "not there" and "not yours": the second must not confirm
  // that someone else's dataset exists.
  if (!table || table.user_id !== actorId || table.is_sample) {
    return { ok: false, error: "Only the dataset's owner can hide its columns" };
  }

  // Names as the dataset spells them; a name it does not have is refused, so a
  // typo cannot read as "hidden" while hiding nothing.
  const declared = columnsOf(table.columns);
  const wanted: string[] = [];
  for (const c of columns) {
    const match = declared.find((d) => d.trim().toLowerCase() === c.trim().toLowerCase());
    if (!match) return { ok: false, error: `It has no column named "${c}"` };
    if (!hiddenBy(wanted, match)) wanted.push(match);
  }
  if (!wanted.length) return { ok: false, error: "Name at least one column to hide" };

  const { data: grants, error: gErr } = await supabaseAdmin
    .from("iam_resource_grants")
    .select("id, column_mask")
    .eq("resource_type", "data_table")
    .eq("resource_id", datasetId);
  if (gErr) return { ok: false, error: gErr.message };

  let changed = 0;
  for (const g of grants ?? []) {
    const before = Array.isArray(g.column_mask) ? g.column_mask.map(String) : [];
    const after = maskWith(before, wanted);
    if (after.length === before.length) continue;
    const { error } = await supabaseAdmin
      .from("iam_resource_grants")
      .update({ column_mask: after })
      .eq("id", g.id);
    // Stop at the first failure and say how far it got: the owner must not
    // read "hidden" while a grant still serves the column.
    if (error) {
      return {
        ok: false,
        error: `Hidden from ${changed} of ${(grants ?? []).length} grants, then: ${error.message}`,
      };
    }
    changed++;
  }

  auditEvent({
    userId: actorId,
    action: "dataset.columns.hidden",
    resourceType: "data_table",
    resourceId: datasetId,
    resourceName: table.name,
    decisionId: approvalId ?? null,
    detail: { columns: wanted, grants_changed: changed, approval_id: approvalId ?? null },
  });
  return { ok: true, changed, grants: (grants ?? []).length, columns: wanted };
}

/**
 * Carry out a suggestion the owner approved in the inbox.
 *
 * The row is claimed once (resumed_at, as a resumed swarm run claims its
 * approval), so a second press, a second tab or a retry cannot apply it
 * twice; applying twice would do no harm, but it would audit twice.
 */
export async function applyApprovedColumnHide(
  approvalId: string,
  callerId: string,
): Promise<{ ok: true; changed: number; grants: number; columns: string[] } | Fail> {
  const { data: approval } = await supabaseAdmin
    .from("approvals")
    .select("id, user_id, action_type, status, payload, resumed_at")
    .eq("id", approvalId)
    .maybeSingle();
  if (!approval || approval.user_id !== callerId) return { ok: false, error: "Approval not found" };
  if (approval.action_type !== HIDE_COLUMNS_ACTION) {
    return { ok: false, error: "That approval is not a suggestion to hide columns" };
  }
  if (approval.status !== "approved") return { ok: false, error: `It was ${approval.status}` };
  const p = (approval.payload ?? {}) as { dataset_id?: unknown; columns?: unknown };
  const datasetId = typeof p.dataset_id === "string" ? p.dataset_id : null;
  const columns = Array.isArray(p.columns) ? p.columns.filter((c) => typeof c === "string") : [];
  if (!datasetId || !columns.length) {
    return { ok: false, error: "That approval does not name a dataset and its columns" };
  }

  const { data: claimed } = await supabaseAdmin
    .from("approvals")
    .update({ resumed_at: new Date().toISOString() })
    .eq("id", approvalId)
    .is("resumed_at", null)
    .select("id");
  if (!claimed?.length) return { ok: false, error: "It has already been carried out" };

  const res = await hideColumnsFromShares(datasetId, columns as string[], callerId, approvalId);
  // A failure gives the claim back, so pressing again can still carry it out.
  if (!res.ok) {
    await supabaseAdmin.from("approvals").update({ resumed_at: null }).eq("id", approvalId);
  }
  return res;
}

/** The earlier suggestions for one dataset. */
async function priorSuggestions(datasetId: string): Promise<PriorSuggestion[]> {
  const { data } = await supabaseAdmin
    .from("approvals")
    .select("status, payload")
    .eq("action_type", HIDE_COLUMNS_ACTION)
    .contains("payload", { dataset_id: datasetId });
  return (data ?? []).map((r) => {
    const cols = (r.payload as { columns?: unknown } | null)?.columns;
    return {
      status: r.status,
      columns: Array.isArray(cols) ? cols.filter((c): c is string => typeof c === "string") : [],
    };
  });
}

/**
 * Look at one shared dataset and, when personal columns are readable through
 * its grants and have not been asked about, ask its owner in the inbox.
 */
export async function suggestForDataset(
  table: { id: string; name: string; user_id: string; columns: unknown },
  masks: ReadonlyArray<readonly string[]>,
): Promise<{ suggested: string[] | null; findings: SensitiveFinding[] }> {
  const { rows } = await scanDatasetRows(table.id, SENSITIVE_SAMPLE_ROWS);
  const findings = findSensitiveColumns(rows, columnsOf(table.columns));
  const cols = suggestionFor(findings, masks, await priorSuggestions(table.id));
  if (!cols) return { suggested: null, findings };

  const these = findings.filter((f) => cols.includes(f.column));
  // Grants that can read at least one of them; one already hiding all of
  // them is not "sharing" them.
  const readers = masks.filter((m) => cols.some((c) => !hiddenBy(m, c))).length;
  const { data: row, error } = await supabaseAdmin
    .from("approvals")
    .insert({
      user_id: table.user_id,
      agent_name: table.name,
      action_type: HIDE_COLUMNS_ACTION,
      action_title: `Hide personal data in ${table.name} from its shares`,
      description:
        `${describeColumns(these)} ${these.length === 1 ? "looks" : "look"} personal, and ` +
        `${readers === 1 ? "the one grant that shares it" : `the ${readers} grants that share it`} ` +
        `can read ${these.length === 1 ? "it" : "them"}. Approving hides ` +
        `${these.length === 1 ? "that column" : "those columns"} from every grant; you still see ` +
        `everything. Rejecting leaves the shares as they are, and you will not be asked about ` +
        `${these.length === 1 ? "it" : "them"} again.`,
      risk_level: "medium",
      payload: {
        dataset_id: table.id,
        columns: cols,
        findings: these.map((f) => ({ column: f.column, kind: f.kind, evidence: f.evidence })),
      } as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "the suggestion was not saved");

  auditEvent({
    userId: table.user_id,
    action: "dataset.columns.hide_suggested",
    resourceType: "data_table",
    resourceId: table.id,
    resourceName: table.name,
    decisionId: row.id,
    detail: { columns: cols, approval_id: row.id },
  });
  await notifyUser(table.user_id, {
    title: `Personal data in ${table.name} is shared`,
    body: `${describeColumns(these)} can be read by people it is shared with. Approve or reject hiding ${these.length === 1 ? "it" : "them"} in your approvals.`,
    link: `/data-sql/${table.id}`,
    kind: "alert",
  });
  return { suggested: cols, findings };
}

let lastSweep = 0;

/**
 * Every shared dataset, looked at for personal data its shares can read. Rides
 * the scheduler's pass, a few times a day: a share made this morning is asked
 * about today. Only datasets with a grant are read; a dataset nobody else can
 * read has nothing to hide from anyone.
 */
export async function sweepSensitiveShares(force = false): Promise<number | null> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return null;
  lastSweep = now;

  const { data: grants, error } = await supabaseAdmin
    .from("iam_resource_grants")
    .select("resource_id, column_mask")
    .eq("resource_type", "data_table");
  if (error) throw new Error(`sensitive-data sweep: ${error.message}`);
  const masksBy = new Map<string, string[][]>();
  for (const g of grants ?? []) {
    const list = masksBy.get(g.resource_id) ?? [];
    list.push(Array.isArray(g.column_mask) ? g.column_mask.map(String) : []);
    masksBy.set(g.resource_id, list);
  }
  const ids = [...masksBy.keys()].slice(0, SWEEP_DATASET_CAP);
  if (!ids.length) return 0;

  const { data: tables, error: tErr } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, user_id, columns, is_sample")
    .in("id", ids);
  if (tErr) throw new Error(`sensitive-data sweep: ${tErr.message}`);

  let asked = 0;
  for (const t of tables ?? []) {
    if (t.is_sample || !t.user_id) continue;
    try {
      const r = await suggestForDataset(
        { id: t.id, name: t.name, user_id: t.user_id, columns: t.columns },
        masksBy.get(t.id) ?? [],
      );
      if (r.suggested) asked++;
    } catch (e) {
      // One dataset that cannot be read does not stop the rest.
      console.warn(`[sensitive-data] ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return asked;
}
