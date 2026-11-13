// A sandbox's environment, handed over once, in exchange for a nonce (R477).
//
// The ECS backend cannot put a sandbox's secrets in RunTask's overrides:
// CloudTrail records the request and DescribeTasks returns it. So the app
// keeps the environment here, sealed under the deployment key, and gives the
// task a random nonce instead. On start the sandbox posts the nonce to
// BOOTSTRAP_PATH and gets the environment back; the sealed copy is deleted as
// it is handed over, so the nonce opens it once. A nonce read later from
// CloudTrail opens nothing.
//
// Only the nonce's hash is stored: the database never holds what opens it.
import { createHash } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptBlob, encryptJson, isEncryptedBlob } from "@/utils/providers/crypto.server";

export const BOOTSTRAP_PATH = "/api/notebook/runtime/bootstrap";

/** How long after the session was created its nonce still works. */
export const BOOTSTRAP_WINDOW_MINUTES = 15;

export function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

/** 32 random bytes, base64url: 43 characters. */
export const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Keep the sandbox's environment, sealed under its owner's key (the session
 * row's user, as every encrypted row is), until its nonce comes back.
 */
export async function stageBootstrap(
  sessionId: string,
  userId: string,
  env: Record<string, string>,
  nonce: string,
): Promise<void> {
  const sealed = await encryptJson(env, { owner: userId });
  const { error } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .update({ bootstrap_env: sealed, bootstrap_hash: nonceHash(nonce), bootstrap_used_at: null })
    .eq("id", sessionId);
  if (error) throw new Error(`Could not keep the sandbox's environment: ${error.message}`);
}

/**
 * The environment, if this nonce opens it: right session, unused, and within
 * the window. Null for anything else, without saying which, since the caller
 * is a sandbox and anyone else who learned the nonce.
 */
export async function redeemBootstrap(
  sessionId: string,
  nonce: string,
): Promise<Record<string, string> | null> {
  if (!NONCE_RE.test(nonce)) return null;
  const { data, error } = await supabaseAdmin.rpc("redeem_notebook_bootstrap", {
    p_session: sessionId,
    p_hash: nonceHash(nonce),
    p_window_minutes: BOOTSTRAP_WINDOW_MINUTES,
  });
  if (error) throw new Error(`Could not read the sandbox's environment: ${error.message}`);
  if (!data || !isEncryptedBlob(data)) return null;
  return decryptBlob<Record<string, string>>(data);
}
