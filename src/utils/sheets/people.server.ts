// People, as sharing names them: an account found by its exact email (never
// a search, so the page cannot be used to list who has an account), and the
// email and name to show for accounts a workbook is already shared with.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PAGE = 1000;

async function allUsers(): Promise<{ id: string; email: string | null }[]> {
  const out: { id: string; email: string | null }[] = [];
  for (let page = 1; page < 1000; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) throw new Error(`Could not read the accounts: ${error.message}`);
    const users = data?.users ?? [];
    out.push(...users.map((u) => ({ id: u.id, email: u.email ?? null })));
    if (users.length < PAGE) break;
  }
  return out;
}

/** The account that signs in with this email (case ignored), or null. */
export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const want = email.trim().toLowerCase();
  const hit = (await allUsers()).find((u) => (u.email ?? "").toLowerCase() === want);
  return hit ? { id: hit.id } : null;
}

/** Email and display name for each of these accounts. */
export async function userLabels(
  ids: string[],
): Promise<Map<string, { email: string | null; name: string | null }>> {
  const out = new Map<string, { email: string | null; name: string | null }>();
  if (!ids.length) return out;
  const wanted = new Set(ids);
  for (const u of await allUsers())
    if (wanted.has(u.id)) out.set(u.id, { email: u.email, name: null });
  const { data: profiles } = await supabaseAdmin
    .from("profiles")
    .select("user_id, display_name")
    .in("user_id", ids);
  for (const p of profiles ?? []) {
    const cur = out.get(p.user_id);
    if (cur) cur.name = p.display_name;
  }
  return out;
}
