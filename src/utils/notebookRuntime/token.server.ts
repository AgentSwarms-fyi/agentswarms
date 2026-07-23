// Short-lived, session-scoped capability tokens for the server-side notebook
// runtime. A running kernel holds one of these (never the user's Supabase JWT
// and never any provider API key) and presents it to /api/python-chat and
// /api/python-kb so those calls resolve to the right user with full IAM/budget
// governance — without any long-lived secret ever entering the sandbox.
//
// Dependency-free: a compact HMAC-SHA256 signed token (header.payload.sig,
// base64url), verified server-side. Fails closed when NOTEBOOK_RUNTIME_SECRET
// is unset, so the feature can't be used without an operator opting in.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

let cachedSecret: string | null = null;

function envSecret(): string | null {
  const s = process.env.NOTEBOOK_RUNTIME_SECRET;
  return s && s.length >= 16 ? s : null;
}

/**
 * Resolve the signing secret: an explicit env var wins (operators who manage it
 * themselves), otherwise the server-generated one stored in the DB. Returns null
 * only when neither exists yet.
 */
export async function getRuntimeSecret(): Promise<string | null> {
  const env = envSecret();
  if (env) return env;
  if (cachedSecret) return cachedSecret;
  const { data } = await supabaseAdmin
    .from("notebook_runtime_secrets")
    .select("signing_secret")
    .eq("id", true)
    .maybeSingle();
  cachedSecret = data?.signing_secret ?? null;
  return cachedSecret;
}

/**
 * Get the signing secret, generating and persisting one if none exists. Called
 * when an admin enables the runtime, so nobody has to invent a random string.
 */
export async function ensureRuntimeSecret(): Promise<string> {
  const existing = await getRuntimeSecret();
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex");
  const { error } = await supabaseAdmin
    .from("notebook_runtime_secrets")
    .upsert({ id: true, signing_secret: generated }, { onConflict: "id" });
  if (error) throw new Error(`Could not store the runtime signing secret: ${error.message}`);
  cachedSecret = generated;
  return generated;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** Mint a token for a session. Returns null if no runtime secret exists yet. */
export async function signSessionToken(opts: {
  userId: string;
  sessionId: string;
  ttlSeconds?: number;
}): Promise<string | null> {
  const key = await getRuntimeSecret();
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
export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionTokenClaims | null> {
  const key = await getRuntimeSecret();
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

export async function runtimeSecretConfigured(): Promise<boolean> {
  return (await getRuntimeSecret()) !== null;
}
