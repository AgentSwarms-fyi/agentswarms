// Signed delivery of async swarm-run results.
//
// A long swarm can run for minutes; holding an HTTP connection open for that
// is fragile (proxy and browser timeouts, no retry story). With `async: true`
// the endpoint returns a runId immediately and POSTs the result to the
// caller's callback URL when it finishes.
//
// The payload is signed with the API key's own secret so the receiver can
// prove it came from us — the callback URL is otherwise an unauthenticated
// endpoint that anyone could POST to.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertPublicUrl, safeFetch } from "@/utils/ssrfGuard.server";

export type SwarmRunCallback = {
  runId: string | null;
  /**
   * "suspended" = the run parked at a human-approval step. It is not finished;
   * a second callback follows when someone decides and the run completes.
   * Receivers that only branch on success/error should treat it as "still
   * running" rather than as a terminal outcome.
   */
  status: "success" | "error" | "suspended";
  output: string;
  error: string | null;
  swarmId: string;
};

/** Hex HMAC-SHA256 of `body` under `secret`, via WebCrypto (worker-safe). */
export async function signPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deliver a finished run to the caller's callback. Best-effort with a small
 * bounded retry: the run already happened and its result is durable in
 * swarm_runs, so a failed delivery must never surface as a run failure.
 */
export async function deliverRunCallback(opts: {
  url: string;
  secret: string | null;
  payload: SwarmRunCallback;
}): Promise<void> {
  // The URL comes from an API caller, so it is attacker-controlled: refuse
  // private/internal targets exactly as the web_browse tool does.
  const safe = await assertPublicUrl(opts.url);
  if (!safe.ok) {
    console.warn(`[swarm-callback] refusing unsafe callback URL: ${safe.error}`);
    return;
  }

  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-AgentSwarms-Event": "swarm.run.completed",
  };
  if (opts.secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    // Timestamp is inside the signed material so a captured delivery can't be
    // replayed indefinitely by the receiver's own verification logic.
    headers["X-AgentSwarms-Timestamp"] = ts;
    headers["X-AgentSwarms-Signature"] =
      `sha256=${await signPayload(opts.secret, `${ts}.${body}`)}`;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        // safeFetch re-validates on every redirect hop, so a public URL can't
        // bounce the delivery into an internal address.
        const r = await safeFetch(opts.url, {
          method: "POST",
          headers,
          body,
          signal: ctrl.signal,
        });
        if (r.ok) return;
        // 4xx means the receiver rejected it — retrying won't help.
        if (r.status >= 400 && r.status < 500) {
          console.warn(`[swarm-callback] receiver returned ${r.status}; not retrying`);
          return;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      console.warn(`[swarm-callback] attempt ${attempt + 1} failed:`, (e as Error).message);
    }
    // Linear backoff; total worst case well under a minute.
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

/** Generate a webhook signing secret for a new API key. */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "whsec_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex of a request body — the idempotency payload fingerprint. */
export async function hashBody(body: unknown): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(body ?? {})),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Purge idempotency records past their useful life (24h is generous). */
export async function purgeIdempotencyRecords(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin
    .from("swarm_run_idempotency")
    .delete()
    .lt("created_at", cutoff);
  if (error) console.warn("[idempotency] purge failed:", error.message);
}
