// Embed-key validation shared by /api/embed and /api/embed/chat.
//
// An embed key is a capability token that ships inside a customer page's
// <iframe src>: it grants access to exactly ONE resource (agent, swarm or
// BI dashboard), only when the embedding page's origin matches the key's
// domain allow-list. The parent origin is taken from document.referrer
// inside the iframe — browsers set it truthfully for real visitors, so a
// third-party site cannot silently embed someone else's key. Keys can be
// deactivated instantly from /dashboard.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
};

export function hostnameOf(originOrUrl: string | null | undefined): string | null {
  if (!originOrUrl) return null;
  try {
    return new URL(originOrUrl).hostname.toLowerCase();
  } catch {
    // Bare hostname without scheme
    const bare = String(originOrUrl).trim().toLowerCase();
    return /^[a-z0-9.-]+$/.test(bare) ? bare : null;
  }
}

/** '*' allows everything; 'example.com' exact; '*.example.com' any subdomain (and the apex). */
export function domainAllowed(allowed: string[], parentOrigin: string | null | undefined): boolean {
  const list = (allowed ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (list.includes("*")) return true;
  const host = hostnameOf(parentOrigin);
  if (!host) return false;
  for (const entry of list) {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (host === base || host.endsWith("." + base)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

export type EmbedValidation =
  | { ok: true; row: EmbedKeyRow; preview: boolean }
  | { ok: false; status: number; error: string };

export async function validateEmbedKey(opts: {
  key: string | undefined;
  parentOrigin?: string | null;
  previewToken?: string | null;
}): Promise<EmbedValidation> {
  const key = (opts.key ?? "").trim();
  if (!key.startsWith("emk_") || key.length < 20 || key.length > 80) {
    return { ok: false, status: 400, error: "Invalid embed key." };
  }
  const { data: row } = await supabaseAdmin
    .from("embed_keys")
    .select(
      "id, user_id, name, key, resource_type, resource_id, allowed_domains, allow_ai, is_active, use_count",
    )
    .eq("key", key)
    .maybeSingle();
  if (!row) return { ok: false, status: 404, error: "This embed key does not exist." };
  if (!row.is_active) {
    return { ok: false, status: 403, error: "This embed has been disabled by its owner." };
  }

  // Owner preview from /dashboard: a signed-in session token belonging to
  // the key's owner bypasses the domain check (nothing else does).
  if (opts.previewToken) {
    const { data } = await supabaseAdmin.auth.getUser(opts.previewToken);
    if (data.user?.id === row.user_id) {
      return { ok: true, row: row as EmbedKeyRow, preview: true };
    }
  }

  if (!domainAllowed(row.allowed_domains ?? [], opts.parentOrigin)) {
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
export function touchEmbedKey(row: EmbedKeyRow): void {
  void supabaseAdmin
    .from("embed_keys")
    .update({ use_count: row.use_count + 1, last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => {});
}

// Light in-process rate limiting (per key, sliding window). Shared with the
// other public endpoints — see rateLimit.server.ts for the scaling caveat.
export { rateLimited } from "@/utils/rateLimit.server";
