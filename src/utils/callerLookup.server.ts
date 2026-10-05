// "You are not signed in" versus "who you are could not be checked" (R297).
//
// Every server function and API route asks the auth server whose token it was
// handed, and every one of them read any error from that question as a
// refusal: a network blip, a rate limit or an auth outage answered a signed-in
// person with "Unauthorized" or "Not signed in". R295's drive saw it in a node
// preview with the session good for another forty minutes, and the docgen
// routes once reported a misconfigured URL the same way.
//
// supabase-js already tells the two apart. A refusal is an answer about the
// token: no user, no session (`session_not_found`), or a 4xx such as a bad
// JWT. Anything else - a network error or a 502/503/504 (both
// `AuthRetryableFetchError`), a 429, any other 5xx, a reply that would not
// parse - is a lookup that failed, and says so.
import { isAuthError } from "@supabase/supabase-js";

/**
 * Statuses on which the token itself was refused: by the auth server
 * (`AuthApiError`), or by getClaims reading it (`AuthInvalidJwtError`, 400 -
 * a malformed or wrongly signed JWT). The R297 drive found the second: a first
 * version counted only `AuthApiError`, and a junk token got 503.
 */
const REFUSED = new Set([400, 401, 403, 404, 422]);

/**
 * Whether an error from `auth.getUser` is the auth server refusing the token,
 * as opposed to the lookup failing. No error at all (an answer with no user)
 * is a refusal.
 */
export function isCallerRefusal(error: unknown): boolean {
  if (!error) return true;
  // A missing session (`session_not_found`) is a 400 like a malformed JWT; a
  // retryable fetch error carries 0 or a 5xx, so it never lands here.
  if (!isAuthError(error)) return false;
  return typeof error.status === "number" && REFUSED.has(error.status);
}

/**
 * The message for a lookup that found no caller: `refused` - the message the
 * call site has always used - when the token was refused, and a sentence that
 * says the check itself failed when it did.
 */
export function callerFailure(error: unknown, refused: string): string {
  if (isCallerRefusal(error)) return refused;
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not check who you are just now (${reason}). Nothing was done; try again in a moment.`;
}

/** The HTTP status for the same: 401 for a refusal, 503 for a lookup that failed. */
export function callerFailureStatus(error: unknown): 401 | 503 {
  return isCallerRefusal(error) ? 401 : 503;
}

/**
 * What a helper that answers "user id, or null for nobody" returns when the
 * check itself failed, so its caller can answer 503 instead of treating the
 * person as signed out - or, where a missing user skips a gate, as anonymous.
 */
export type CallerCheckFailed = { checkFailed: string };

/** `{ checkFailed }` for a lookup that failed; null for a refusal or no error. */
export function checkFailed(error: unknown): CallerCheckFailed | null {
  return isCallerRefusal(error) ? null : { checkFailed: callerFailure(error, "") };
}
