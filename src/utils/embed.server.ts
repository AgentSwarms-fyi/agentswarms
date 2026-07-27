// Embed-key validation shared by /api/embed and /api/embed/chat.
//
// An embed key is a capability token that ships inside a customer page's
// <iframe src>: it grants access to exactly ONE resource (agent, swarm or
// BI dashboard). Two origin checks gate it:
//
//   1. The browser-set `Origin` header on the API call (requestOriginAllowed).
//      Page JavaScript cannot forge this, so it blocks a third-party site that
//      lifted the key from calling the API from its own page.
//   2. The `parentOrigin` the embed page reports from document.referrer /
//      ancestorOrigins, matched against the key's domain allow-list. This is
//      what stops a real browser from rendering the widget on an unlisted
//      site.
//
// THREAT MODEL, stated plainly: the key is PUBLIC — it is visible in the host
// page's HTML — and every header is forgeable by a non-browser client. So the
// domain allow-list is a browser-level control, not an authentication
// boundary; a determined script with the key can still call the API. What
// bounds that abuse is the per-key monthly budget, the rate limit, and key
// expiry (all enforced server-side), plus audited denials and instant
// deactivation from /dashboard. Treat an embed key like a publishable API
// key, not a secret.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { domainAllowed, hostnameOf, requestOriginAllowed } from "@/utils/embedOrigin";

// Re-exported so existing importers keep working.
export { domainAllowed, hostnameOf, requestOriginAllowed };

export type EmbedKeyRow = {
  id: string;
  user_id: string;
  name: string;
  key: string;
  resource_type: "agent" | "swarm" | "bi_dashboard";
  resource_id: string;
  allowed_domains: string[];
  allow_ai: boolean;
  is_active: boolean;
  use_count: number;
  /** Hard expiry; NULL means the key never expires. */
  expires_at: string | null;
};

const KEY_COLUMNS =
  "id, user_id, name, key, resource_type, resource_id, allowed_domains, allow_ai, is_active, use_count, expires_at";

export type EmbedValidation =
  | { ok: true; row: EmbedKeyRow; preview: boolean }
  | { ok: false; status: number; error: string };

export async function validateEmbedKey(opts: {
  key: string | undefined;
  parentOrigin?: string | null;
  previewToken?: string | null;
  /** Forensic context for denial auditing (see requestMeta.server.ts). */
  ip?: string | null;
  userAgent?: string | null;
  /**
   * The incoming request, so the browser-set Origin can be checked against the
   * key's allow-list — see requestOriginAllowed().
   */
  request?: Request;
}): Promise<EmbedValidation> {
  const key = (opts.key ?? "").trim();
  if (!key.startsWith("emk_") || key.length < 20 || key.length > 80) {
    return { ok: false, status: 400, error: "Invalid embed key." };
  }
  const { data: row } = await supabaseAdmin
    .from("embed_keys")
    .select(KEY_COLUMNS)
    .eq("key", key)
    .maybeSingle();
  // An unknown key can't be attributed to an owner, so there is nobody to
  // audit it against — the rate limiter is the control for key-guessing.
  if (!row) return { ok: false, status: 404, error: "This embed key does not exist." };

  // Denials are the security-relevant events on this surface: without them a
  // disabled key being hammered, or an unauthorized site trying to use
  // someone's embed, leaves no trace anywhere in the product.
  const denied = (reason: string) =>
    auditEvent({
      userId: row.user_id,
      action: "embed.access.denied",
      resourceType: "embed_key",
      resourceId: row.id,
      resourceName: row.name,
      detail: {
        reason,
        parent_origin: opts.parentOrigin ?? null,
        resource_type: row.resource_type,
        ip: opts.ip ?? null,
        user_agent: opts.userAgent ?? null,
      },
    });

  if (!row.is_active) {
    denied("key_disabled");
    return { ok: false, status: 403, error: "This embed has been disabled by its owner." };
  }
  // Expiry is enforced here rather than by a cleanup job, so a lapsed key stops
  // working the moment it lapses even if no purge has run.
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    denied("key_expired");
    return { ok: false, status: 403, error: "This embed key has expired." };
  }

  // Owner preview from /dashboard: a signed-in session token belonging to
  // the key's owner bypasses the domain check (nothing else does).
  if (opts.previewToken) {
    const { data } = await supabaseAdmin.auth.getUser(opts.previewToken);
    if (data.user?.id === row.user_id) {
      return { ok: true, row: row as EmbedKeyRow, preview: true };
    }
  }

  // Browser-set Origin first: unlike `parentOrigin` below, page JavaScript
  // cannot forge it, so this rejects a third-party site calling the API
  // directly even when it claims an allowed parentOrigin.
  if (opts.request) {
    const originCheck = requestOriginAllowed(opts.request, row.allowed_domains ?? []);
    if (!originCheck.ok) {
      denied("request_origin_not_allowed");
      return {
        ok: false,
        status: 403,
        error: "This embed is not authorized to be called from this origin.",
      };
    }
  }

  if (!domainAllowed(row.allowed_domains ?? [], opts.parentOrigin)) {
    denied("domain_not_allowed");
    return {
      ok: false,
      status: 403,
      error:
        "This embed is not authorized for this site. The owner controls the allowed domains from their AgentSwarms dashboard.",
    };
  }
  return { ok: true, row: row as EmbedKeyRow, preview: false };
}

/** Best-effort usage stamp — never blocks the request path. */
export function touchEmbedKey(row: EmbedKeyRow, ip?: string | null): void {
  void supabaseAdmin
    .from("embed_keys")
    .update({
      use_count: row.use_count + 1,
      last_used_at: new Date().toISOString(),
      ...(ip ? { last_used_ip: ip } : {}),
    })
    .eq("id", row.id)
    .then(() => {});
}

// Light in-process rate limiting (per key, sliding window). Shared with the
// other public endpoints — see rateLimit.server.ts for the scaling caveat.
export { rateLimited } from "@/utils/rateLimit.server";
