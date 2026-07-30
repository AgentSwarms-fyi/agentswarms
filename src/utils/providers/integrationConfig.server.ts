// Server-only encryption for secrets stored in integrations.config.
//
// The integrations table holds LLM-provider API keys (llm_provider), gateway
// keys (llm_gateway) and n8n tokens (n8n) inside a JSON config column. Those
// used to be written and read back in plaintext by the browser. Now the secret
// field is AES-GCM encrypted at rest into `<field>_enc` (same scheme as
// provider_credentials / user_secrets); the plaintext field is dropped.
//
// Backward compatible: readers fall back to the legacy plaintext field, so rows
// saved before this change keep working until re-saved. A {{secret:NAME}}
// reference is a pointer (resolved per-user at read time), not a secret at rest,
// so it is stored as-is and never encrypted.
import { encryptJson, decryptJson } from "./crypto.server";
import { containsSecretRef, resolveSecretRefsInObject } from "@/utils/secrets.server";

/** Which config fields hold a secret, per integration `type`. */
const SECRET_FIELDS: Record<string, string[]> = {
  llm_provider: ["api_key"],
  llm_gateway: ["api_key"],
  n8n: ["webhook_token"],
  firecrawl: ["api_key"],
  // The webhook URL IS the secret for notification channels — possession of a
  // Slack/Teams/Discord incoming-webhook URL is permission to post to it.
  notification: ["webhook_url"],
};

type EncBlob = { ciphertext?: string; iv?: string };

export function integrationSecretFields(type: string): string[] {
  return SECRET_FIELDS[type] ?? [];
}

/**
 * Encrypt literal secret values in a config for storage. For each secret field:
 * a non-empty literal is moved to `<field>_enc` (plaintext dropped); a
 * {{secret:NAME}} reference is kept in place; an empty string is REMOVED (it
 * only ever means "keep the existing secret" — persisting it would leave a
 * vestigial plaintext field sitting next to the ciphertext at rest).
 */
export async function encryptIntegrationConfig(
  type: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...config };
  for (const f of integrationSecretFields(type)) {
    const v = out[f];
    delete out[`${f}_enc`]; // clear any stale ciphertext
    if (typeof v === "string" && v.length > 0 && !containsSecretRef(v)) {
      out[`${f}_enc`] = await encryptJson(v);
      delete out[f];
    } else if (typeof v === "string" && v.length === 0) {
      delete out[f];
    }
  }
  return out;
}

/**
 * Carry forward existing encrypted/plaintext secrets when the incoming config
 * leaves a secret field blank — the standard "edit without re-typing the key"
 * behaviour. `incoming` should already be run through encryptIntegrationConfig.
 */
export function preserveBlankSecrets(
  type: string,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!existing) return incoming;
  const out = { ...incoming };
  for (const f of integrationSecretFields(type)) {
    const hasNew =
      (typeof out[f] === "string" && (out[f] as string).length > 0) || out[`${f}_enc`] != null;
    if (!hasNew) {
      if (existing[`${f}_enc`] != null) out[`${f}_enc`] = existing[`${f}_enc`];
      else if (typeof existing[f] === "string" && (existing[f] as string).length > 0)
        out[f] = existing[f];
    }
  }
  return out;
}

/**
 * Server-side read: decrypt `<field>_enc` back into `<field>`, then resolve any
 * {{secret:NAME}} references. Returns a config with usable plaintext secrets.
 * Never throws on a bad ciphertext — it just leaves that field unresolved.
 */
export async function resolveIntegrationConfig(
  userId: string,
  type: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> = { ...config };
  for (const f of integrationSecretFields(type)) {
    const enc = out[`${f}_enc`] as EncBlob | undefined;
    if (enc && enc.ciphertext && enc.iv) {
      try {
        out[f] = await decryptJson<string>(enc.ciphertext, enc.iv);
      } catch {
        /* leave unresolved rather than failing the whole read */
      }
      delete out[`${f}_enc`];
    }
  }
  if (Object.values(out).some((v) => typeof v === "string" && containsSecretRef(v))) {
    out = await resolveSecretRefsInObject(userId, out);
  }
  return out;
}
