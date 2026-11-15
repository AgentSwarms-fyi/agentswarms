// The Git access token as used (R494).
//
// git_export_config.token_enc holds either a token typed in before or a
// `{{secret:NAME}}` picked from the user's secrets. A reference resolves for
// the config's owner toward the one host the token is sent to: api.github.com,
// or the GitLab host the config names (gitlab.com by default). A secret shared
// with the owner therefore resolves only where its owner allowed that host.
import { encryptedSecretName } from "@/utils/credentialRefs.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import { containsSecretRef, resolveSecretRefs } from "@/utils/secrets.server";
import type { GitExportConfig } from "@/utils/git/exporter.server";

type EncBlob = { ciphertext?: string; iv?: string; kid?: string } | null | undefined;

/** Where this config's token goes. */
export function gitTokenDestination(cfg: Pick<GitExportConfig, "provider" | "host">): string {
  return cfg.provider === "gitlab"
    ? (cfg.host?.trim() || "https://gitlab.com").replace(/\/+$/, "")
    : "https://api.github.com";
}

/** The stored token as saved: a key, or a secret reference. Null when none is stored. */
export async function storedGitToken(enc: unknown): Promise<string | null> {
  const blob = enc as EncBlob;
  if (!blob?.ciphertext || !blob?.iv) return null;
  const { token } = await decryptJson<{ token: string }>(blob.ciphertext, blob.iv, blob.kid);
  return token || null;
}

/** The name of the secret the stored token refers to, for the settings form. */
export function storedGitTokenSecret(enc: unknown): Promise<string | null> {
  return encryptedSecretName(enc, "token");
}

/** The token to send, with a secret reference resolved. Throws when one cannot resolve. */
export async function gitTokenForUse(
  userId: string,
  cfg: Pick<GitExportConfig, "provider" | "host">,
  stored: string,
): Promise<string> {
  if (!containsSecretRef(stored)) return stored;
  const value = await resolveSecretRefs(userId, stored, { sendTo: [gitTokenDestination(cfg)] });
  return value.trim();
}
