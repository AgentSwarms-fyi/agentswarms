// Audit trail plumbing: fire-and-forget event emission for server-side
// activities, and the retention purge driven by the shared scheduler.
// Model calls are NOT duplicated here — execution_traces already records
// every LLM call with user/model/cost, and the audit view merges both
// streams at read time.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

export type AuditEmit = {
  userId: string;
  action: string;
  resourceType?: string;
  resourceName?: string;
  resourceId?: string;
  detail?: Record<string, unknown>;
  /**
   * The actor's email, when the caller already has it (requireSuperadmin
   * returns one). Saves the lookup below; otherwise it is resolved lazily.
   */
  actorEmail?: string | null;
  /**
   * The decision this event belongs to -- a chat turn, swarm run or dashboard
   * refresh -- so "where did this come from?" is two indexed reads rather than
   * a timestamp guess. Absent for events outside any decision (an IAM change,
   * a secret rotation), which is correct rather than missing.
   */
  decisionId?: string | null;
};

/**
 * Cache of user id → email, for attribution that survives account deletion.
 *
 * Audit events are per-ACTION, not per-token, so a cached lookup is affordable
 * where it would not be on the trace path. The TTL is long because an email
 * rarely changes and a slightly stale one is still better attribution than a
 * bare UUID that no longer resolves to anything.
 */
const emailCache = new Map<string, { at: number; email: string | null }>();
const EMAIL_TTL_MS = 30 * 60 * 1000;

async function actorEmailFor(userId: string): Promise<string | null> {
  const hit = emailCache.get(userId);
  if (hit && Date.now() - hit.at < EMAIL_TTL_MS) return hit.email;
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = data.user?.email ?? null;
    emailCache.set(userId, { at: Date.now(), email });
    if (emailCache.size > 2000) {
      for (const [k, v] of emailCache) if (Date.now() - v.at > EMAIL_TTL_MS) emailCache.delete(k);
    }
    return email;
  } catch {
    return null;
  }
}

/**
 * Insert one audit event. Never throws, never blocks the caller's path.
 *
 * ATTRIBUTION IS DENORMALISED ON PURPOSE. user_id used to be
 * `REFERENCES auth.users(id) ON DELETE CASCADE`, so deleting an account
 * deleted everything that account had ever done — "offboard the leaver" and
 * "destroy the evidence" were the same button. The FK is SET NULL now
 * (migration 20260781000000) and the email is copied in here, so an orphaned
 * row still says who it was.
 */
export function auditEvent(args: AuditEmit): void {
  void (async () => {
    try {
      const email =
        args.actorEmail !== undefined ? args.actorEmail : await actorEmailFor(args.userId);
      const { error } = await supabaseAdmin.from("audit_events").insert({
        user_id: args.userId,
        action: args.action,
        resource_type: args.resourceType ?? null,
        resource_name: args.resourceName?.slice(0, 200) ?? null,
        resource_id: args.resourceId ?? null,
        detail: (args.detail ?? {}) as Json,
        // Cast: the generated types are rebuilt from a pushed schema. actor_email
        // ships in 20260781000000, decision_id in 20260848000000.
        ...({ actor_email: email, decision_id: args.decisionId ?? null } as Record<
          string,
          unknown
        >),
      });
      if (error) console.warn("[audit] insert failed:", error.message);
    } catch (e) {
      // "Never throws" was the documented contract and not quite the code:
      // supabaseAdmin is a LAZY getter that throws when the service-role env
      // vars are absent, and that throw escaped as an unhandled rejection
      // rather than a warning. An audit write must not be able to take down
      // the request it is describing -- nor a test that never touches a
      // database.
      console.warn("[audit] skipped:", (e as Error).message);
    }
  })();
}

const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a purge
let lastPurge = 0;

/** Rows archived per batch when streaming expiring events to the log. */
const ARCHIVE_BATCH = 500;

/**
 * Delete audit events older than the configured retention window.
 *
 * Retention defaults to 365 days. The previous 14-day default quietly
 * destroyed the trail well inside any normal compliance review window, and an
 * audit log you cannot produce on request is worse than none.
 *
 * Expiring rows are emitted to stdout as NDJSON (one JSON object per line,
 * prefixed `audit-archive`) BEFORE deletion, so an operator running any log
 * shipper retains them after the DB copy is gone. Set AUDIT_ARCHIVE_ON_PURGE=0
 * to skip that if you already export via /api/audit/export.
 *
 * EVIDENCE IS HELD LONGER. A row carrying a decision_id records a data access
 * made on behalf of an answer someone was given. Those are kept at least
 * iam_settings.provenance_retention_days (default 183 — the EU AI Act Article
 * 26(6) six-month deployer floor), so trimming ordinary audit noise cannot
 * silently empty an answer's provenance. The floor never shortens retention:
 * where the ordinary window is longer, the longer window wins.
 */
export async function purgeAuditEvents(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastPurge < PURGE_INTERVAL_MS) return;
  lastPurge = now;
  // provenance_retention_days arrives with migration 20260849000000; the
  // generated Database types predate it, hence the cast.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: settings } = await (supabaseAdmin.from("iam_settings") as any)
    .select("audit_retention_days, provenance_retention_days")
    .limit(1)
    .maybeSingle();
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const days = settings?.audit_retention_days ?? 365;
  const cutoffMs = now - days * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const floorDays = Number(settings?.provenance_retention_days ?? 183);
  // Compared as timestamps: the earlier cutoff keeps rows longer, so a longer
  // ordinary window always wins over the floor.
  const evidenceCutoff = new Date(
    Number.isFinite(floorDays) && floorDays > 0
      ? Math.min(cutoffMs, now - floorDays * 86_400_000)
      : cutoffMs,
  ).toISOString();

  /**
   * Stream one expiring set to stdout before it is deleted. Mirrors ONE of the
   * two deletes below exactly -- same cutoff, same decision_id filter -- so the
   * archive can never cover a different set of rows than the purge removes.
   * Returns false if the read failed, which aborts the purge: never delete what
   * we failed to archive.
   */
  const archive = async (until: string, withDecision: boolean): Promise<boolean> => {
    // Page through the doomed rows rather than loading them all: a long-dormant
    // instance can have a very large expiring set, and this runs in-process.
    for (let from = 0; ; from += ARCHIVE_BATCH) {
      const q = supabaseAdmin.from("audit_events").select("*").lt("created_at", until);
      const { data: batch, error: readErr } = await (
        withDecision ? q.not("decision_id", "is", null) : q.is("decision_id", null)
      )
        .order("created_at", { ascending: true })
        .range(from, from + ARCHIVE_BATCH - 1);
      if (readErr) {
        console.warn("[audit] archive read failed, skipping purge:", readErr.message);
        return false;
      }
      if (!batch || batch.length === 0) break;
      for (const row of batch) console.log("audit-archive " + JSON.stringify(row));
      if (batch.length < ARCHIVE_BATCH) break;
    }
    return true;
  };

  if (!/^(0|false|no)$/i.test(process.env.AUDIT_ARCHIVE_ON_PURGE ?? "")) {
    if (!(await archive(cutoff, false))) return;
    if (!(await archive(evidenceCutoff, true))) return;
  }

  // Two deletes, two clocks. Ordinary rows expire on the audit window; rows
  // that are part of some answer's provenance are held to the floor.
  const { error } = await supabaseAdmin
    .from("audit_events")
    .delete()
    .lt("created_at", cutoff)
    .is("decision_id", null);
  if (error) console.warn("[audit] purge failed:", error.message);
  const { error: evidenceErr } = await supabaseAdmin
    .from("audit_events")
    .delete()
    .lt("created_at", evidenceCutoff)
    .not("decision_id", "is", null);
  if (evidenceErr) console.warn("[audit] evidence purge failed:", evidenceErr.message);
}
