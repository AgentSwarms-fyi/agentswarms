// A Slack or Teams credential as used (R494).
//
// What the integration stored is either a value typed in before or a
// `{{secret:NAME}}` picked from its owner's secrets. A reference resolves for
// the integration's owner. `sendTo` names where the value goes (slack.com for a
// bot token, Microsoft's sign-in host for a Teams client secret), so a secret
// shared with the owner resolves where its owner allowed that host; a signing
// secret never leaves the server and so takes only a secret the owner owns.
import { containsSecretRef, resolveSecretRefs } from "@/utils/secrets.server";

/**
 * The value to use, or null when there is none or a reference cannot resolve.
 * Every caller already treats null as "no credential" (an unverifiable request
 * is denied; no bot token, no reply), so a failure is logged, not thrown.
 */
export async function channelCredential(
  stored: string | null,
  ownerId: string,
  what: string,
  sendTo?: readonly string[],
): Promise<string | null> {
  if (!stored) return null;
  if (!containsSecretRef(stored)) return stored;
  try {
    const value = await resolveSecretRefs(ownerId, stored, sendTo ? { sendTo } : undefined);
    return value.trim() || null;
  } catch (e) {
    console.warn(`[channels] ${what}: ${(e as Error).message}`);
    return null;
  }
}
