// Short-lived, session-scoped capability tokens for the server-side notebook
// runtime. A running kernel holds one of these (never the user's Supabase JWT
// and never any provider API key) and presents it to /api/python-chat and
// /api/python-kb so those calls resolve to the right user with full IAM/budget
// governance — without any long-lived secret ever entering the sandbox.
//
// Dependency-free: a compact HMAC-SHA256 signed token (header.payload.sig,
// base64url), verified server-side. Fails closed when NOTEBOOK_RUNTIME_SECRET
// is unset, so the feature can't be used without an operator opting in.
import { createHmac, timingSafeEqual } from "node:crypto";

const SCOPE = "notebook-runtime";

export type SessionTokenClaims = {
  /** user the kernel acts as */
  sub: string;
  /** notebook_runtime_sessions.id */
  sid: string;
  scope: typeof SCOPE;
  iat: number;
  exp: number;
};

function secret(): string | null {
  const s = process.env.NOTEBOOK_RUNTIME_SECRET;
  return s && s.length >= 16 ? s : null;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** Mint a token for a session. Returns null if no runtime secret is configured. */
export function signSessionToken(opts: {
  userId: string;
  sessionId: string;
  ttlSeconds?: number;
}): string | null {
  const key = secret();
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionTokenClaims = {
    sub: opts.userId,
    sid: opts.sessionId,
    scope: SCOPE,
    iat: now,
    exp: now + Math.max(60, Math.min(opts.ttlSeconds ?? 900, 3600)),
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "nbr" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(`${header}.${payload}`, key);
  return `${header}.${payload}.${sig}`;
}

/** Verify a token; returns its claims or null (bad sig, expired, wrong scope). */
export function verifySessionToken(token: string | undefined | null): SessionTokenClaims | null {
  const key = secret();
  if (!key || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = sign(`${header}.${payload}`, key);
  // Constant-time compare on equal-length buffers.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: SessionTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.scope !== SCOPE) return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
  return claims;
}

export function runtimeSecretConfigured(): boolean {
  return secret() !== null;
}
