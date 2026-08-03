// Resolves the caller of /api/python-chat and /api/python-kb from EITHER a
// Supabase user JWT OR a notebook-runtime session token (a server-side kernel).
//
// The JWT branch predates the removal of the in-browser Pyodide runtime, which
// is what used to present one — notebooks now run only on sandboxed server
// kernels, so in practice every notebook call arrives on the session-token
// branch. The JWT path is kept because it is the one a signed-in caller
// (or a future in-page runtime) would use, and because narrowing it buys
// nothing; but it is no longer the common case, and comments that described it
// as "the browser runtime" were describing something that had been deleted.
//
// Both resolve to a userId with identical governance downstream; the difference
// is only how reads are scoped:
//   - JWT path      → a JWT-scoped client, RLS enforces access.
//   - session token → the service-role client + an explicit scopeUserId, so we
//                     replicate the RLS ownership check in code (own + samples +
//                     IAM-granted). No provider key ever enters the sandbox.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveGrantedResourceIds } from "@/utils/iam.server";
import { verifySessionToken } from "./token.server";

export type PythonCaller = {
  userId: string;
  /** Client to read with: RLS-scoped for JWT, service-role for session tokens. */
  sb: SupabaseClient<Database>;
  /** Set only for the session-token path → explicit ownership scoping. */
  scopeUserId?: string;
};

function jwtClient(token: string): SupabaseClient<Database> | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export async function resolvePythonCaller(request: Request): Promise<PythonCaller | null> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token) return null;

  // A server kernel presents a session token — verify and act as that user.
  const claims = await verifySessionToken(token);
  if (claims) return { userId: claims.sub, sb: supabaseAdmin, scopeUserId: claims.sub };

  // Otherwise a Supabase user JWT from the browser runtime.
  const sb = jwtClient(token);
  if (!sb) return null;
  const { data } = await sb.auth.getClaims(token);
  const userId = data?.claims?.sub;
  if (!userId) return null;
  return { userId, sb };
}

type KbRow = { id: string; name: string; is_sample: boolean };

/** Knowledge bases the caller may read (own + samples + IAM-granted). */
export async function listReadableKnowledgeBases(
  caller: PythonCaller,
): Promise<{ data: KbRow[]; error: string | null }> {
  if (!caller.scopeUserId) {
    const { data, error } = await caller.sb
      .from("knowledge_bases")
      .select("id, name, is_sample")
      .order("name", { ascending: true });
    return { data: (data as KbRow[]) ?? [], error: error?.message ?? null };
  }
  const uid = caller.scopeUserId;
  const [{ data: rows, error }, granted] = await Promise.all([
    supabaseAdmin.from("knowledge_bases").select("id, name, is_sample, user_id").order("name"),
    resolveGrantedResourceIds(supabaseAdmin, uid, "knowledge_base"),
  ]);
  const data = (rows ?? [])
    .filter((k) => k.user_id === uid || k.is_sample || granted.has(k.id))
    .map((k) => ({ id: k.id, name: k.name, is_sample: k.is_sample }));
  return { data, error: error?.message ?? null };
}

/** Readable KB ids, optionally intersected with a requested subset. */
export async function readableKbIds(
  caller: PythonCaller,
  requested?: string[],
): Promise<{ ids: string[]; error: string | null }> {
  if (!caller.scopeUserId) {
    let q = caller.sb.from("knowledge_bases").select("id");
    if (requested && requested.length) q = q.in("id", requested);
    const { data, error } = await q;
    return { ids: (data ?? []).map((r) => r.id), error: error?.message ?? null };
  }
  const uid = caller.scopeUserId;
  const base = supabaseAdmin.from("knowledge_bases").select("id, user_id, is_sample");
  const [{ data: rows, error }, granted] = await Promise.all([
    requested && requested.length ? base.in("id", requested) : base,
    resolveGrantedResourceIds(supabaseAdmin, uid, "knowledge_base"),
  ]);
  const ids = (rows ?? [])
    .filter((k) => k.user_id === uid || k.is_sample || granted.has(k.id))
    .map((k) => k.id);
  return { ids, error: error?.message ?? null };
}
