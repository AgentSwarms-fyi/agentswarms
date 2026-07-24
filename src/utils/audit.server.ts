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
};

/** Insert one audit event. Never throws, never blocks the caller's path. */
export function auditEvent(args: AuditEmit): void {
  void supabaseAdmin
    .from("audit_events")
    .insert({
      user_id: args.userId,
      action: args.action,
      resource_type: args.resourceType ?? null,
      resource_name: args.resourceName?.slice(0, 200) ?? null,
      resource_id: args.resourceId ?? null,
      detail: (args.detail ?? {}) as Json,
    })
    .then(({ error }) => {
      if (error) console.warn("[audit] insert failed:", error.message);
    });
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
 */
export async function purgeAuditEvents(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastPurge < PURGE_INTERVAL_MS) return;
  lastPurge = now;
  const { data: settings } = await supabaseAdmin
    .from("iam_settings")
    .select("audit_retention_days")
    .limit(1)
    .maybeSingle();
  const days = settings?.audit_retention_days ?? 365;
  const cutoff = new Date(now - days * 86_400_000).toISOString();

  if (!/^(0|false|no)$/i.test(process.env.AUDIT_ARCHIVE_ON_PURGE ?? "")) {
    // Page through the doomed rows rather than loading them all: a long-dormant
    // instance can have a very large expiring set, and this runs in-process.
    for (let from = 0; ; from += ARCHIVE_BATCH) {
      const { data: batch, error: readErr } = await supabaseAdmin
        .from("audit_events")
        .select("*")
        .lt("created_at", cutoff)
        .order("created_at", { ascending: true })
        .range(from, from + ARCHIVE_BATCH - 1);
      if (readErr) {
        // Archiving is best-effort, but never delete what we failed to archive.
        console.warn("[audit] archive read failed, skipping purge:", readErr.message);
        return;
      }
      if (!batch || batch.length === 0) break;
      for (const row of batch) console.log("audit-archive " + JSON.stringify(row));
      if (batch.length < ARCHIVE_BATCH) break;
    }
  }

  const { error } = await supabaseAdmin.from("audit_events").delete().lt("created_at", cutoff);
  if (error) console.warn("[audit] purge failed:", error.message);
}
