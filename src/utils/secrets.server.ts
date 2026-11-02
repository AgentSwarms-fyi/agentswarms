// Server-side secret reference resolution.
//
// Anywhere a config string can hold a credential (warehouse connections, LLM
// provider keys), users may write {{secret:NAME}} instead of the raw value.
// At use time this module swaps references for decrypted values — but only
// when the requesting user owns the secret or has been granted access via
// IAM (has_resource_access). Values never travel to the client.
//
// A secret you OWN resolves wherever you use it. A secret SHARED with you
// resolves only toward hosts its owner allowed (R419, VA-2026-10-25-30), and
// only where the caller says which hosts those are (`sendTo`). Sharing is
// meant to let a colleague use a secret without seeing it, and in every config
// they write they choose the destination: without the owner's list, a
// provider base URL or a connection host aimed at their own server would
// receive the value. A path that names no destination (a URL, a request body,
// a sandbox's environment) therefore takes only secrets the caller owns.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import { hostAllowed, hostOf } from "@/lib/secretHosts";

const SECRET_REF_RE = /\{\{\s*secret:([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function containsSecretRef(value: string): boolean {
  SECRET_REF_RE.lastIndex = 0;
  return SECRET_REF_RE.test(value);
}

export type SecretDestination = {
  /**
   * Every server the resolved value will be sent to, as URLs or host names.
   * A secret shared with the caller resolves only when its owner allowed each
   * one. Omitted, empty or unparseable: only a secret the caller owns resolves.
   */
  sendTo?: readonly string[];
};

type SecretRow = {
  id: string;
  user_id: string;
  value: unknown;
  allowed_hosts?: unknown;
};

async function lookupSecretValue(
  userId: string,
  name: string,
  sendTo: readonly string[] | undefined,
): Promise<string> {
  // `*`, not a column list: allowed_hosts arrives with migration
  // 20261102000000, and naming it before the operator has pushed that would
  // fail every lookup, the owner's own included. Without the column a shared
  // secret has no allowed host, so it resolves for nobody but its owner.
  const { data, error } = await supabaseAdmin.from("user_secrets").select("*").eq("name", name);
  if (error) throw new Error(`Secret lookup failed: ${error.message}`);
  const rows = (data ?? []) as SecretRow[];

  // Own secret wins, wherever it is going.
  const own = rows.find((r) => r.user_id === userId);
  if (own) return decrypt(own, name);

  // A shared one needs a destination. Without one the grant is never even
  // consulted, so there is no record of a check that a caller could probe.
  const hosts = (sendTo ?? []).map((h) => hostOf(h));
  if (hosts.length === 0 || hosts.some((h) => h === null)) {
    throw new Error(
      `Secret "${name}" must be one you own to use it here. A secret shared with you ` +
        `only fills a credential sent to a host its owner allowed — never a URL, a ` +
        `request body or code you run.`,
    );
  }

  const granted: SecretRow[] = [];
  for (const row of rows) {
    const { data: allowed } = await supabaseAdmin.rpc("has_resource_access", {
      rtype: "secret",
      rid: row.id,
      uid: userId,
    });
    if (allowed) granted.push(row);
  }
  if (granted.length > 1) {
    throw new Error(
      `Secret reference "${name}" is ambiguous — multiple shared secrets use that name`,
    );
  }
  const match = granted[0];
  if (!match) {
    throw new Error(
      `Secret "${name}" not found or you don't have access to it. ` +
        `Create it under /secrets or ask an administrator to share it with you.`,
    );
  }

  const allowedHosts = Array.isArray(match.allowed_hosts)
    ? (match.allowed_hosts as unknown[]).filter((h): h is string => typeof h === "string")
    : [];
  const refused = [...new Set(hosts as string[])].filter((h) => !hostAllowed(h, allowedHosts));
  if (refused.length > 0) {
    throw new Error(
      `Secret "${name}" is shared with you, but its owner has not allowed it to be sent ` +
        `to ${refused.join(", ")}. ` +
        (allowedHosts.length > 0
          ? `It may be sent to: ${allowedHosts.join(", ")}. `
          : `They have not allowed any host yet. `) +
        `Its owner adds hosts under Secrets → ${name} → Allowed hosts.`,
    );
  }
  return decrypt(match, name);
}

async function decrypt(row: SecretRow, name: string): Promise<string> {
  const enc = row.value as { ciphertext?: string; iv?: string; kid?: string } | null;
  if (!enc?.ciphertext || !enc?.iv) throw new Error(`Secret "${name}" has no stored value`);
  return decryptJson<string>(enc.ciphertext, enc.iv, enc.kid);
}

/**
 * Replace every {{secret:NAME}} in a string, enforcing per-user access. Pass
 * `sendTo` only where the string is a credential and those are the hosts it
 * will reach; anything else (a URL, a body, a sandbox env) takes owned secrets
 * only, which is what leaving it out means.
 */
export async function resolveSecretRefs(
  userId: string,
  input: string,
  opts?: SecretDestination,
): Promise<string> {
  SECRET_REF_RE.lastIndex = 0;
  const names = new Set<string>();
  for (const m of input.matchAll(SECRET_REF_RE)) names.add(m[1]);
  if (names.size === 0) return input;

  const values = new Map<string, string>();
  for (const name of names) values.set(name, await lookupSecretValue(userId, name, opts?.sendTo));

  SECRET_REF_RE.lastIndex = 0;
  return input.replace(SECRET_REF_RE, (_all, name: string) => values.get(name) ?? "");
}

/** Resolve refs in every string property of an object (shallow), all with the same destination. */
export async function resolveSecretRefsInObject<T extends Record<string, unknown>>(
  userId: string,
  obj: T,
  opts?: SecretDestination,
): Promise<T> {
  const out: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && containsSecretRef(v)) {
      out[k] = await resolveSecretRefs(userId, v, opts);
    }
  }
  return out as T;
}

/**
 * Resolve a config whose credential fields may take a shared secret and whose
 * other fields may not. The other string fields resolve first, owner-only: an
 * endpoint, host, bucket or region decides where the credentials go, so a
 * shared secret there would put the destination back in the caller's hands.
 * `sendTo` then reads that resolved config and names the hosts the
 * credentials will reach. If it throws, the credentials resolve owner-only;
 * the call that follows reports the bad endpoint in its own words.
 */
export async function resolveCredentialConfig<T extends object>(
  userId: string,
  obj: T,
  credentialFields: readonly string[],
  sendTo: (resolved: T) => readonly string[] | undefined,
): Promise<T> {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  const isCredential = (k: string) => credentialFields.includes(k);
  for (const [k, v] of Object.entries(out)) {
    if (!isCredential(k) && typeof v === "string" && containsSecretRef(v)) {
      out[k] = await resolveSecretRefs(userId, v);
    }
  }
  let hosts: readonly string[] | undefined;
  try {
    hosts = sendTo(out as T);
  } catch {
    hosts = undefined;
  }
  for (const [k, v] of Object.entries(out)) {
    if (isCredential(k) && typeof v === "string" && containsSecretRef(v)) {
      out[k] = await resolveSecretRefs(userId, v, { sendTo: hosts });
    }
  }
  return out as T;
}
