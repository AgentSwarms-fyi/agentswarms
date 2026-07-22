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

/** Delete audit events older than the configured retention window. */
export async function purgeAuditEvents(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastPurge < PURGE_INTERVAL_MS) return;
  lastPurge = now;
  const { data: settings } = await supabaseAdmin
    .from("iam_settings")
    .select("audit_retention_days")
    .limit(1)
    .maybeSingle();
  const days = settings?.audit_retention_days ?? 14;
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const { error } = await supabaseAdmin.from("audit_events").delete().lt("created_at", cutoff);
  if (error) console.warn("[audit] purge failed:", error.message);
}
