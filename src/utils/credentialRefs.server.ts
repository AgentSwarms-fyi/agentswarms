// Which secret a stored, encrypted credential names (R494).
//
// Integrations keep their credentials encrypted, and a form never gets them
// back. Once a credential can be a `{{secret:NAME}}` picked from a list, the
// form needs to show which one is picked: a NAME is not a secret (the secrets
// list shows it to the same user), so it is returned, and nothing else is. A
// credential typed in before stays hidden; the form shows it as a key saved in
// the field.
import { parseSecretRef } from "@/lib/secretRefs";
import { decryptJson } from "@/utils/providers/crypto.server";

type EncBlob = { ciphertext?: string; iv?: string; kid?: string } | null | undefined;

async function decryptBlob(enc: unknown): Promise<unknown> {
  const blob = enc as EncBlob;
  if (!blob?.ciphertext || !blob?.iv) return null;
  try {
    return await decryptJson<unknown>(blob.ciphertext, blob.iv, blob.kid);
  } catch {
    return null;
  }
}

/**
 * The secret one field of an encrypted object names, e.g. `token` of
 * `{ token }`. Null when nothing is stored, the field holds a value typed in,
 * or it will not decrypt.
 */
export async function encryptedSecretName(enc: unknown, field: string): Promise<string | null> {
  const obj = await decryptBlob(enc);
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[field];
  return typeof v === "string" ? parseSecretRef(v) : null;
}

/**
 * For an encrypted object of credentials, which of its fields name a secret
 * (field → NAME) and which hold a value typed in (listed in `raw`). The form
 * shows the first as picked and the second as a key saved in the field.
 */
export async function encryptedSecretFields(
  enc: unknown,
): Promise<{ secrets: Record<string, string>; raw: string[] }> {
  const obj = await decryptBlob(enc);
  const secrets: Record<string, string> = {};
  const raw: string[] = [];
  if (!obj || typeof obj !== "object") return { secrets, raw };
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "string" || !v) continue;
    const name = parseSecretRef(v);
    if (name) secrets[k] = name;
    else raw.push(k);
  }
  return { secrets, raw };
}
