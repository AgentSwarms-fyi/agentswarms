// Server-side secret reference resolution.
//
// Anywhere a config string can hold a credential (warehouse connections, LLM
// provider keys), users may write {{secret:NAME}} instead of the raw value.
// At use time this module swaps references for decrypted values — but only
// when the requesting user owns the secret or has been granted access via
// IAM (has_resource_access). Values never travel to the client.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "@/utils/providers/crypto.server";

const SECRET_REF_RE = /\{\{\s*secret:([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function containsSecretRef(value: string): boolean {
  SECRET_REF_RE.lastIndex = 0;
  return SECRET_REF_RE.test(value);
}

async function lookupSecretValue(userId: string, name: string): Promise<string> {
  const { data: rows, error } = await supabaseAdmin
    .from("user_secrets")
    .select("id, user_id, value")
    .eq("name", name);
  if (error) throw new Error(`Secret lookup failed: ${error.message}`);

  // Own secret wins; otherwise any single IAM-granted secret with this name.
  let match = (rows ?? []).find((r) => r.user_id === userId) ?? null;
  if (!match) {
    const granted: typeof rows = [];
    for (const row of rows ?? []) {
      const { data: allowed } = await supabaseAdmin.rpc("has_resource_access", {
        rtype: "secret",
        rid: row.id,
        uid: userId,
      });
      if (allowed) granted!.push(row);
    }
    if ((granted?.length ?? 0) > 1) {
      throw new Error(
        `Secret reference "${name}" is ambiguous — multiple shared secrets use that name`,
      );
    }
    match = granted?.[0] ?? null;
  }
  if (!match) {
    throw new Error(
      `Secret "${name}" not found or you don't have access to it. ` +
        `Create it under /secrets or ask an administrator to share it with you.`,
    );
  }

  const enc = match.value as { ciphertext?: string; iv?: string };
  if (!enc?.ciphertext || !enc?.iv) throw new Error(`Secret "${name}" has no stored value`);
  return decryptJson<string>(enc.ciphertext, enc.iv);
}

/** Replace every {{secret:NAME}} in a string, enforcing per-user access. */
export async function resolveSecretRefs(userId: string, input: string): Promise<string> {
  SECRET_REF_RE.lastIndex = 0;
  const names = new Set<string>();
  for (const m of input.matchAll(SECRET_REF_RE)) names.add(m[1]);
  if (names.size === 0) return input;

  const values = new Map<string, string>();
  for (const name of names) values.set(name, await lookupSecretValue(userId, name));

  SECRET_REF_RE.lastIndex = 0;
  return input.replace(SECRET_REF_RE, (_all, name: string) => values.get(name) ?? "");
}

/** Resolve refs in every string property of an object (shallow). */
export async function resolveSecretRefsInObject<T extends Record<string, unknown>>(
  userId: string,
  obj: T,
): Promise<T> {
  const out: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && containsSecretRef(v)) {
      out[k] = await resolveSecretRefs(userId, v);
    }
  }
  return out as T;
}
