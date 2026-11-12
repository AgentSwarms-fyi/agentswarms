// Approval requests and notifications under their owner's user key (R450).
//
// A swarm's approval request keeps what the step before it produced, up to
// 4,000 characters, so its approvers can decide; a workflow's keeps its message.
// A notification keeps what happened: a dataset's name, what an analysis found,
// an error. All of that is sealed by the app under the owner's user key.
//
// An approval differs from everything sealed before it: its readers are other
// users. The text stays under the OWNER'S key, and the server opens it for an
// approver after row-level security has said they may see the row. Revoking the
// owner's key leaves it unreadable for them too.
//
// What stays readable: an approval's title, which is the node's own setting, its
// status, risk and routing; a notification's kind, link and times. The inbox's
// toast reads only those. (Until R468 it read them from a realtime event that
// carried the sealed row; now from the rows the inbox loads.)
//
// Neither can simply be dropped when the key cannot be had. An approval is the
// only thing that puts a parked run in front of a person, and a notification is
// the only sign of what it reports. So each is written without its text, and
// says so: nothing is left in the clear or put under another key.
//
// What leaves the app is a copy and outside all this: the email an approver or
// a scheduled analysis sends, and the message mirrored to a Slack or Teams
// channel.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  isSealedJson,
  openJson,
  sealJson,
  unreadableReason,
} from "@/utils/chat/sealedThreads.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { fieldsOf, TRACE_DROPPED_MARK } from "@/utils/observability/sealedTraces.server";
import { isSealedText, openText, sealedTextKid, sealText } from "@/utils/providers/crypto.server";
import type { InboxPass } from "./inboxPass";

export const inboxWhere = {
  approvalDescription: (id: string) => `approvals/${id}/description`,
  approvalPayload: (id: string) => `approvals/${id}/payload`,
  notificationTitle: (id: string) => `notifications/${id}/title`,
  notificationBody: (id: string) => `notifications/${id}/body`,
};

/** The kinds of approval that hold someone's words; the others hold ids and fixed text. */
export const SEALED_APPROVALS = ["swarm_step", "workflow_step"] as const;

type ApprovalBody = { description: string | null; payload: unknown };

/** A swarm step's payload is its text. A workflow's is ids, which stay readable. */
const sealsPayload = (actionType: string) => actionType === "swarm_step";

/**
 * An approval's text, sealed; null before the user-key tables exist. Throws
 * DataKeyUnavailableError when the owner's key cannot be had: never sealed under
 * another key.
 */
async function sealApprovalColumns(
  owner: string,
  id: string,
  actionType: string,
  body: ApprovalBody,
): Promise<ApprovalBody | null> {
  let { description, payload } = body;
  if (description) {
    const sealed = await sealText(description, {
      owner,
      where: inboxWhere.approvalDescription(id),
    });
    if (!sealed) return null;
    description = sealed;
  }
  if (sealsPayload(actionType)) {
    const sealed = await sealJson(payload, { owner, where: inboxWhere.approvalPayload(id) });
    if (!sealed) return null;
    payload = sealed;
  }
  return { description, payload };
}

/**
 * An approval's text as it is stored. Never throws: when the owner's key cannot
 * be had the request is still raised, without its text, and says so.
 */
export async function sealApprovalBody(
  owner: string,
  id: string,
  actionType: string,
  body: ApprovalBody,
): Promise<ApprovalBody> {
  try {
    return (await sealApprovalColumns(owner, id, actionType, body)) ?? body;
  } catch (e) {
    console.warn(`[approvals] raised without its text: ${(e as Error).message}`);
    const kept = sealsPayload(actionType) ? {} : fieldsOf(body.payload);
    return { description: null, payload: { ...kept, [TRACE_DROPPED_MARK]: true } };
  }
}

type ApprovalSealing = {
  /** Its text is stored under the owner's key. */
  body_sealed: boolean;
  /** Raised without its text: the owner's key could not be had at the time. */
  body_dropped: boolean;
  /** Why its text cannot be read now; null when it can. */
  body_unreadable: string | null;
};

/** An approval, opened. One that cannot be keeps what is readable and says why. */
export async function openApprovalRow<T extends { id: string } & ApprovalBody>(
  row: T,
): Promise<T & ApprovalSealing> {
  const body_sealed =
    (!!row.description && isSealedText(row.description)) || isSealedJson(row.payload);
  const { [TRACE_DROPPED_MARK]: droppedMark, ...rest } = fieldsOf(row.payload);
  const body_dropped = droppedMark === true;
  try {
    const [description, payload] = await Promise.all([
      row.description
        ? openText(row.description, inboxWhere.approvalDescription(row.id))
        : row.description,
      openJson<unknown>(row.payload, inboxWhere.approvalPayload(row.id)),
    ]);
    return {
      ...row,
      description,
      payload: body_dropped ? rest : payload,
      body_sealed,
      body_dropped,
      body_unreadable: null,
    };
  } catch (e) {
    return {
      ...row,
      description: null,
      payload: {},
      body_sealed,
      body_dropped,
      body_unreadable: unreadableReason(e),
    };
  }
}

/** A list of approvals, opened. A key that is gone is asked for once, not once per row. */
export async function openApprovalRows<T extends { id: string } & ApprovalBody>(
  rows: T[],
): Promise<Array<T & ApprovalSealing>> {
  const refused = new Map<string, string>();
  const out: Array<T & ApprovalSealing> = [];
  for (const row of rows) {
    const kid = row.description ? sealedTextKid(row.description) : null;
    const known = kid ? refused.get(kid) : undefined;
    if (known) {
      out.push({
        ...row,
        description: null,
        payload: {},
        body_sealed: true,
        body_dropped: false,
        body_unreadable: known,
      });
      continue;
    }
    const opened = await openApprovalRow(row);
    if (kid && opened.body_unreadable && !opened.body_unreadable.startsWith("It did not open")) {
      refused.set(kid, opened.body_unreadable);
    }
    out.push(opened);
  }
  return out;
}

/** An approval's text for an approver's email, or nothing when it cannot be opened. */
export async function openApprovalDescription(row: {
  id: string;
  description: string | null;
}): Promise<string> {
  if (!row.description) return "";
  try {
    return await openText(row.description, inboxWhere.approvalDescription(row.id));
  } catch {
    return "";
  }
}

export const NOT_KEPT_TITLE = "A notification could not be kept";
export const NOT_KEPT_BODY =
  "Its text was not stored, because your key could not be had at the time.";

/**
 * A notification's title and body as they are stored. The title is always
 * sealed and the body with it, the empty one too: that is how the pass finds
 * what is left to do. Never throws: when the owner's key cannot be had it is
 * still written, saying its text was not kept, because it may be the only sign
 * that something happened.
 */
export async function sealNotification(
  owner: string,
  id: string,
  n: { title: string; body: string },
): Promise<{ title: string; body: string }> {
  try {
    const title = await sealText(n.title, { owner, where: inboxWhere.notificationTitle(id) });
    if (!title) return n;
    const body = await sealText(n.body, { owner, where: inboxWhere.notificationBody(id) });
    return { title, body: body ?? n.body };
  } catch (e) {
    console.warn(`[notify] kept without its text: ${(e as Error).message}`);
    return { title: NOT_KEPT_TITLE, body: NOT_KEPT_BODY };
  }
}

/** A notification, opened. One that cannot be says so in its own place, not a failed list. */
export async function openNotificationRow<T extends { id: string; title: string; body: string }>(
  row: T,
): Promise<T & { body_unreadable: string | null }> {
  try {
    const [title, body] = await Promise.all([
      openText(row.title, inboxWhere.notificationTitle(row.id)),
      openText(row.body, inboxWhere.notificationBody(row.id)),
    ]);
    return { ...row, title, body, body_unreadable: null };
  } catch (e) {
    const reason = unreadableReason(e);
    return { ...row, title: "Cannot be read", body: reason, body_unreadable: reason };
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** How many values one background pass seals; the button's pass has no limit. */
export function inboxSealPerPass(raw = process.env.INBOX_SEAL_PER_PASS): number {
  const v = Number((raw ?? "").trim());
  return Number.isInteger(v) && v > 0 ? v : 2000;
}

const PAGE = 100;
const NO_ID = "00000000-0000-0000-0000-000000000000";
const stillPlain = "ck1:%";
// The words of approvals_structural_immutable. Before migration 20261108000000
// it refuses any change to a payload, the service role's included.
const TRIGGER_REFUSED = /cannot be changed after it is created/;

/**
 * Seal the approval requests and notifications kept before R450. A row that
 * cannot be sealed (its owner's key cannot be had) is counted and left. A row is
 * written only if it is still unsealed. Older swarm requests need migration
 * 20261108000000, since their payload is otherwise immutable; until it is
 * applied they are left, and the pass says so.
 */
export async function sealOlderInbox(opts: { limit?: number } = {}): Promise<InboxPass> {
  const r: InboxPass = {
    approvals: 0,
    notifications: 0,
    unreadable: 0,
    left: false,
    needsMigration: false,
    failed: 0,
    errors: [],
  };
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  const fail = (what: string, e: unknown) => {
    if (e instanceof DataKeyUnavailableError) {
      r.unreadable++;
      return;
    }
    r.failed++;
    if (r.errors.length < 10) r.errors.push(`${what}: ${(e as Error).message}`);
  };

  let cursor = NO_ID;
  approvals: for (;;) {
    const { data, error } = await supabaseAdmin
      .from("approvals")
      .select("id, user_id, action_type, description, payload")
      .in("action_type", [...SEALED_APPROVALS])
      .not("description", "like", stillPlain)
      .neq("description", "")
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("approvals", new Error(error.message));
      break;
    }
    const rows = data ?? [];
    for (const row of rows) {
      if (budget <= 0) {
        r.left = true;
        return r;
      }
      cursor = row.id;
      try {
        const sealed = await sealApprovalColumns(row.user_id, row.id, row.action_type, {
          description: row.description,
          payload: row.payload,
        });
        // No user keys yet: nothing in this pass can be sealed.
        if (!sealed) return r;
        const patch = sealsPayload(row.action_type) ? sealed : { description: sealed.description };
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("approvals")
          .update(patch as never)
          .eq("id", row.id)
          .not("description", "like", stillPlain)
          .select("id");
        if (e1) {
          if (TRIGGER_REFUSED.test(e1.message)) {
            r.needsMigration = true;
            break approvals;
          }
          throw new Error(e1.message);
        }
        if (!moved?.length) continue;
        r.approvals++;
        budget--;
      } catch (e) {
        fail(`approval ${row.id}`, e);
      }
    }
    if (rows.length < PAGE) break;
  }

  cursor = NO_ID;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("notifications")
      .select("id, user_id, title, body")
      .not("title", "like", stillPlain)
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("notifications", new Error(error.message));
      break;
    }
    const rows = data ?? [];
    for (const row of rows) {
      if (budget <= 0) {
        r.left = true;
        return r;
      }
      cursor = row.id;
      try {
        const title = await sealText(row.title, {
          owner: row.user_id,
          where: inboxWhere.notificationTitle(row.id),
        });
        if (!title) return r;
        const body = await sealText(row.body, {
          owner: row.user_id,
          where: inboxWhere.notificationBody(row.id),
        });
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("notifications")
          .update({ title, body: body as string })
          .eq("id", row.id)
          .not("title", "like", stillPlain)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.notifications++;
        budget--;
      } catch (e) {
        fail(`notification ${row.id}`, e);
      }
    }
    if (rows.length < PAGE) break;
  }
  return r;
}
