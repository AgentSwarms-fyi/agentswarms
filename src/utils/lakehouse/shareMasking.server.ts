// Personal data in lakehouse shares: masking it in a share, and asking the
// share's owner first (R554). The dataset version of this is R521
// (data/sensitiveShares.server.ts), and the same three rules hold:
//
//   ONE IMPLEMENTATION OF "MASK". `maskShareColumns` is the only code that
//   adds columns to a shared table's mask. The owner's control in the Shares
//   dialog and an approved suggestion both call it.
//
//   AUTHORITY IS THE SHARE, NOT THE APPROVAL ROW. An approval's owner may
//   write its row, so a row naming someone else's share proves nothing. Only
//   the share's owner may mask its columns, checked against lakehouse_shares
//   every time.
//
//   IT ONLY EVER NARROWS. Masking takes something away from recipients; it
//   never gives anyone more, so a repeated or overlapping request is harmless.
//   Showing a column again stays what it was: remove the table, add it back.
//
// A recipient reads governed snapshots (shares.server.ts), keyed by the
// policy, so a new mask would only be served from the next snapshot on; the
// old snapshots are dropped here so the next read writes a masked one and no
// file under the old policy is left to fetch.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  MASK_SHARE_ACTION,
  shareIntent,
  shareMaskDescription,
  shareMaskFromPayload,
  shareMaskTitle,
} from "@/lib/lakeShareMasking";
import {
  describeColumns,
  findSensitiveColumns,
  hiddenBy,
  maskWith,
  suggestionFor,
  type PriorSuggestion,
  type SensitiveFinding,
} from "@/lib/sensitiveData";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";

export { MASK_SHARE_ACTION };

/** Rows sampled per shared table when looking for personal data. */
export const SHARE_SAMPLE_ROWS = 500;
/** Shared tables looked at per sweep, so one sweep stays bounded. */
const SWEEP_TABLE_CAP = 200;
/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** What the sweep's reads are called in the query log and the audit. */
export const SCAN_VIA = "personal-data-monitor";

type Fail = { ok: false; error: string };
type ShareTable = {
  id: string;
  share_id: string;
  schema_name: string;
  table_name: string;
  masked_columns: string[] | null;
};
type Share = { id: string; user_id: string; name: string };

const SHARE_TABLE_COLUMNS = "id, share_id, schema_name, table_name, masked_columns";

/** The table's columns as the lake spells them, read as its owner. */
async function lakeColumns(ownerId: string, schema: string, table: string) {
  const { lakehouseTableColumns } = await import("./tableColumns.server");
  const cols = await lakehouseTableColumns(ownerId, schema, table, SCAN_VIA);
  return cols?.map((c) => c.name) ?? null;
}

/**
 * Mask columns of one shared table in its share. THE ONLY PLACE THAT DOES.
 * `approvalId` is set when this runs because the owner approved a
 * suggestion, so the audit says which one.
 */
export async function maskShareColumns(
  shareTableId: string,
  columns: readonly string[],
  actorId: string,
  approvalId?: string | null,
): Promise<{ ok: true; masked: string[]; added: string[] } | Fail> {
  const { data: st, error: stErr } = await supabaseAdmin
    .from("lakehouse_share_tables")
    .select(SHARE_TABLE_COLUMNS)
    .eq("id", shareTableId)
    .maybeSingle();
  if (stErr) return { ok: false, error: stErr.message };
  const notYours = { ok: false as const, error: "Only the share's owner can mask its columns" };
  if (!st) return notYours;
  const { data: share, error: sErr } = await supabaseAdmin
    .from("lakehouse_shares")
    .select("id, user_id, name")
    .eq("id", st.share_id)
    .maybeSingle();
  if (sErr) return { ok: false, error: sErr.message };
  // One answer for "not there" and "not yours": the second must not confirm
  // that someone else's share exists.
  if (!share || share.user_id !== actorId) return notYours;

  // Names as the table spells them; a name it does not have is refused, so a
  // typo cannot read as "masked" while masking nothing.
  const declared = await lakeColumns(actorId, st.schema_name, st.table_name);
  if (!declared) {
    return { ok: false, error: `${st.schema_name}.${st.table_name} could not be read just now` };
  }
  const wanted: string[] = [];
  for (const c of columns) {
    const match = declared.find((d) => d.trim().toLowerCase() === c.trim().toLowerCase());
    if (!match) return { ok: false, error: `It has no column named "${c}"` };
    if (!hiddenBy(wanted, match)) wanted.push(match);
  }
  if (!wanted.length) return { ok: false, error: "Name at least one column to mask" };

  const before = st.masked_columns ?? [];
  const after = maskWith(before, wanted);
  const added = after.slice(before.length);
  if (added.length) {
    const { error } = await supabaseAdmin
      .from("lakehouse_share_tables")
      .update({ masked_columns: after })
      .eq("id", st.id)
      .eq("share_id", share.id);
    if (error) return { ok: false, error: error.message };
    const { dropShareTableSnapshots } = await import("./shares.server");
    await dropShareTableSnapshots(st.id).catch((e: unknown) =>
      // The mask is in force from the next snapshot either way; an old file
      // left behind is pruned on the next read.
      console.warn(`[share-masking] snapshots of ${st.id}: ${(e as Error).message}`),
    );
  }

  auditEvent({
    userId: actorId,
    action: "lakehouse.share.columns_masked",
    resourceType: "lakehouse_share",
    resourceId: share.id,
    resourceName: share.name,
    decisionId: approvalId ?? null,
    detail: {
      table: `${st.schema_name}.${st.table_name}`,
      columns: wanted,
      added,
      approval_id: approvalId ?? null,
    },
  });
  return { ok: true, masked: after, added };
}

/**
 * Carry out a suggestion the owner approved in the inbox: claimed once
 * (resumed_at), carried out by the one writer, the claim given back on a
 * failure so pressing again can still do it.
 */
export async function applyApprovedShareMask(
  approvalId: string,
  callerId: string,
): Promise<{ ok: true; masked: string[]; added: string[]; shareId: string } | Fail> {
  const { data: approval } = await supabaseAdmin
    .from("approvals")
    .select("id, user_id, action_type, status, payload")
    .eq("id", approvalId)
    .maybeSingle();
  if (!approval || approval.user_id !== callerId) return { ok: false, error: "Approval not found" };
  if (approval.action_type !== MASK_SHARE_ACTION) {
    return { ok: false, error: "That approval is not a suggestion to mask columns in a share" };
  }
  if (approval.status !== "approved") return { ok: false, error: `It was ${approval.status}` };
  const p = shareMaskFromPayload(approval.payload);
  if (!p) return { ok: false, error: "That approval does not name a shared table and its columns" };

  const { data: claimed } = await supabaseAdmin
    .from("approvals")
    .update({ resumed_at: new Date().toISOString() })
    .eq("id", approvalId)
    .is("resumed_at", null)
    .select("id");
  if (!claimed?.length) return { ok: false, error: "It has already been carried out" };

  const res = await maskShareColumns(p.share_table_id, p.columns, callerId, approvalId);
  if (!res.ok) {
    await supabaseAdmin.from("approvals").update({ resumed_at: null }).eq("id", approvalId);
    return res;
  }
  return { ...res, shareId: p.share_id };
}

/** The earlier suggestions for one shared table, in any state. */
async function priorSuggestions(shareTableId: string): Promise<PriorSuggestion[]> {
  const { data } = await supabaseAdmin
    .from("approvals")
    .select("status, payload")
    .eq("action_type", MASK_SHARE_ACTION)
    .contains("payload", { share_table_id: shareTableId });
  return (data ?? []).map((r) => ({
    status: r.status,
    columns: shareMaskFromPayload(r.payload)?.columns ?? [],
  }));
}

/**
 * Look at one shared table and, when personal columns reach its recipients
 * and have not been asked about, ask the share's owner in the inbox.
 * `policyMask` is what the table's own policy already masks for every reader
 * (its explicit columns and its tag rules): a recipient does not see those.
 */
export async function suggestForShareTable(
  st: ShareTable,
  share: Share,
  recipients: number,
  policyMask: readonly string[],
): Promise<{ suggested: string[] | null; findings: SensitiveFinding[] }> {
  const { runLakehouseStatement } = await import("./core.server");
  const { qualifiedTable } = await import("@/utils/dataMonitors/core");
  const res = await runLakehouseStatement(
    share.user_id,
    `SELECT * FROM ${qualifiedTable(st.schema_name, st.table_name)} LIMIT ${SHARE_SAMPLE_ROWS}`,
    { rowCap: SHARE_SAMPLE_ROWS, auditVia: SCAN_VIA, useCache: false },
  );
  const names = res.columns.map((c) => c.name);
  // The engine answers rows as arrays in column order.
  const rows = res.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
  const findings = findSensitiveColumns(rows, names);
  // One reader's view: the share's mask on top of the table's own.
  const mask = maskWith(st.masked_columns ?? [], policyMask);
  const cols = suggestionFor(findings, [mask], await priorSuggestions(st.id));
  if (!cols) return { suggested: null, findings };

  const these = findings.filter((f) => cols.includes(f.column));
  const payload = {
    share_id: share.id,
    share_table_id: st.id,
    share_name: share.name,
    schema: st.schema_name,
    table: st.table_name,
    columns: cols,
    findings: these.map((f) => ({ column: f.column, kind: f.kind, evidence: f.evidence })),
  };
  const { data: row, error } = await supabaseAdmin
    .from("approvals")
    .insert({
      user_id: share.user_id,
      agent_name: share.name,
      action_type: MASK_SHARE_ACTION,
      action_title: shareMaskTitle(payload),
      description: shareMaskDescription(these, recipients),
      risk_level: "medium",
      payload: payload as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "the suggestion was not saved");

  auditEvent({
    userId: share.user_id,
    action: "lakehouse.share.mask_suggested",
    resourceType: "lakehouse_share",
    resourceId: share.id,
    resourceName: share.name,
    decisionId: row.id,
    detail: { table: `${st.schema_name}.${st.table_name}`, columns: cols, approval_id: row.id },
  });
  await notifyUser(share.user_id, {
    title: `Personal data in the share ${share.name}`,
    body: `${describeColumns(these)} in ${st.schema_name}.${st.table_name} can be read by the share's recipients. Approve or reject masking ${these.length === 1 ? "it" : "them"} in your approvals.`,
    link: `/lakehouse?open=${encodeURIComponent(shareIntent(share.id))}`,
    kind: "alert",
  });
  return { suggested: cols, findings };
}

/** Tokens that can read a share now: not revoked, not expired. */
export function liveTokens(
  tokens: ReadonlyArray<{ share_id: string; revoked_at: string | null; expires_at: string | null }>,
  now: Date,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokens) {
    if (t.revoked_at) continue;
    if (t.expires_at && new Date(t.expires_at).getTime() <= now.getTime()) continue;
    out.set(t.share_id, (out.get(t.share_id) ?? 0) + 1);
  }
  return out;
}

let lastSweep = 0;

/**
 * Every table in a share someone can read, looked at for personal data its
 * recipients can see. Rides the scheduler's pass, a few times a day. A share
 * with no live token has no recipient yet: nothing to mask from anyone.
 */
export async function sweepLakeShareMasking(force = false): Promise<number | null> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return null;
  lastSweep = now;

  // Never the token hash: which shares have a recipient is all this needs.
  const { data: tokens, error: tkErr } = await supabaseAdmin
    .from("lakehouse_share_tokens")
    .select("share_id, revoked_at, expires_at");
  if (tkErr) throw new Error(`share-masking sweep: ${tkErr.message}`);
  const recipientsBy = liveTokens(tokens ?? [], new Date(now));
  const shareIds = [...recipientsBy.keys()];
  if (!shareIds.length) return 0;

  const { data: shares, error: sErr } = await supabaseAdmin
    .from("lakehouse_shares")
    .select("id, user_id, name")
    .in("id", shareIds);
  if (sErr) throw new Error(`share-masking sweep: ${sErr.message}`);
  const shareBy = new Map((shares ?? []).map((s) => [s.id, s as Share]));

  const { data: tables, error: tErr } = await supabaseAdmin
    .from("lakehouse_share_tables")
    .select(SHARE_TABLE_COLUMNS)
    .in("share_id", [...shareBy.keys()])
    .order("created_at", { ascending: true })
    .limit(SWEEP_TABLE_CAP);
  if (tErr) throw new Error(`share-masking sweep: ${tErr.message}`);
  if (!tables?.length) return 0;

  // What each table's own policy masks, tag rules folded in, as any recipient
  // gets it (shares.server.ts applies the same before the share's own mask).
  const { loadPolicies } = await import("./policies.server");
  const owners = [...new Set([...shareBy.values()].map((s) => s.user_id))];
  const policies = await loadPolicies(
    owners,
    tables.map((t) => ({ schema: t.schema_name.toLowerCase(), table: t.table_name.toLowerCase() })),
  );

  let asked = 0;
  for (const t of tables as ShareTable[]) {
    const share = shareBy.get(t.share_id);
    if (!share) continue;
    const policy = policies.get(`${t.schema_name}.${t.table_name}`.toLowerCase());
    try {
      const r = await suggestForShareTable(
        t,
        share,
        recipientsBy.get(share.id) ?? 0,
        policy?.masked_columns ?? [],
      );
      if (r.suggested) asked++;
    } catch (e) {
      // One table that cannot be read does not stop the rest.
      console.warn(`[share-masking] ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return asked;
}
