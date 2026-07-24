// Server-only helpers for MCP server bearer tokens.
//
// Tokens are AES-GCM encrypted at rest in mcp_servers.auth_token_enc (same
// scheme as provider_credentials / user_secrets). Rows saved before that column
// existed still carry a plaintext auth_token, so the resolver reads whichever
// is present — new saves encrypt, old rows keep working until re-saved.
import { encryptJson, decryptJson } from "@/utils/providers/crypto.server";

type EncBlob = { ciphertext?: string; iv?: string } | null | undefined;

/** Encrypt a token for storage. Returns null for an empty/absent token. */
export async function encryptMcpAuthToken(
  token: string | null | undefined,
): Promise<{ ciphertext: string; iv: string } | null> {
  const t = (token ?? "").trim();
  if (!t) return null;
  return encryptJson(t);
}

/**
 * Resolve the usable bearer token for a server row: decrypt auth_token_enc when
 * present, else fall back to the legacy plaintext auth_token. Never throws — a
 * decrypt failure resolves to null so the caller just proceeds unauthenticated
 * rather than failing the whole probe/call.
 */
export async function resolveMcpAuthToken(row: {
  auth_token_enc?: EncBlob | unknown;
  auth_token?: string | null;
}): Promise<string | null> {
  const enc = row.auth_token_enc as EncBlob;
  if (enc && typeof enc === "object" && enc.ciphertext && enc.iv) {
    try {
      return await decryptJson<string>(enc.ciphertext, enc.iv);
    } catch {
      return null;
    }
  }
  return row.auth_token ?? null;
}
