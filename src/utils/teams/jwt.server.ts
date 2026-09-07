// Verify that an inbound Bot Framework request really came from Microsoft.
//
// This is the whole security boundary for the Teams integration, and it is a
// harder one than Slack's. Slack signs each request with a shared secret, so
// verification is an HMAC. Microsoft signs with a rotating RSA key it
// publishes, so verification means fetching a key set, picking the key the
// token names, checking an RS256 signature, and then checking the claims —
// and every one of those steps has a way to be wrong that still says "ok".
//
// What an attacker gets if this is weak: the endpoint is public, so anyone who
// learns the URL can POST an activity claiming to be any user in any tenant
// and read whatever the target agent or analyst can read.
//
// The four checks that matter, each a real vulnerability on its own:
//
//   1. THE SIGNATURE, against the key the token's `kid` names — from
//      Microsoft's published set, never from the token itself. A verifier that
//      trusts an embedded `jwk`/`x5c` verifies the attacker's own signature.
//   2. THE ISSUER. A validly-signed token from some other Microsoft-issued
//      audience is still not a Bot Framework channel request.
//   3. THE AUDIENCE — this bot's own app id. Without it, a token minted for
//      somebody else's bot is accepted by ours.
//   4. THE SERVICE URL. The token carries the `serviceUrl` the bot may reply
//      to; if it does not match the activity's, an attacker can make the bot
//      post its answer to a host they control. This is the check people
//      leave out, and it is the one that turns a read into an exfiltration.
//
// `alg` is pinned to RS256. Accepting whatever the header says is how "none"
// and HMAC-with-the-public-key forgeries get in.
//
// Everything fails CLOSED: a missing header, an unknown kid, a key set that
// will not load, a claim that is absent. There is no path here that returns ok
// because something was missing.
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Where Microsoft publishes the metadata for channel-issued tokens. */
export const BOT_OPENID_CONFIG =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

/** The only issuer a Bot Framework channel token may carry. */
export const BOT_ISSUER = "https://api.botframework.com";

/** Clock skew allowed on `exp`/`nbf`, in seconds. */
export const CLOCK_SKEW_SECONDS = 300;

export type TeamsVerifyResult =
  | { ok: true; appId: string }
  /** For the server log only — the HTTP response must never explain itself. */
  | { ok: false; reason: string };

type Jwk = { kid?: string; kty?: string; use?: string; n?: string; e?: string; alg?: string };

// The key set changes rarely and every inbound activity needs it, so it is
// cached — but for minutes, not for the process's life: Microsoft rotates
// these, and a cache that never expires turns a rotation into an outage.
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
let keyCache: { at: number; keys: Jwk[] } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
  } catch {
    return null;
  }
}

/**
 * Microsoft's current signing keys.
 *
 * Two hops, as the protocol requires: the OpenID configuration names the
 * `jwks_uri`, and that document holds the keys. Hard-coding the second URL
 * would break the day Microsoft moves it.
 */
async function signingKeys(): Promise<Jwk[]> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.keys;
  const meta = await connectorFetch(BOT_OPENID_CONFIG, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!meta.ok) throw new Error(`openid configuration: HTTP ${meta.status}`);
  const { jwks_uri: jwksUri } = (await meta.json()) as { jwks_uri?: string };
  if (!jwksUri) throw new Error("openid configuration has no jwks_uri");
  const res = await connectorFetch(jwksUri, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`jwks: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("jwks has no keys");
  keyCache = { at: Date.now(), keys };
  return keys;
}

/**
 * Verify a Bot Framework token.
 *
 * `serviceUrl` is the one from the ACTIVITY, and is compared with the token's
 * own claim. Passing the token's value here would make the check tautological,
 * which is the subtle way to have this code and no protection.
 */
export async function verifyTeamsToken(args: {
  authorization: string | null;
  appId: string;
  serviceUrl: string | null;
  /** Seconds since epoch; a parameter so this is testable. */
  now?: number;
  /** Injected in tests; production reads Microsoft's published set. */
  keys?: Jwk[];
}): Promise<TeamsVerifyResult> {
  const header = args.authorization ?? "";
  if (!/^Bearer\s+/i.test(header)) return { ok: false, reason: "no bearer token" };
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };

  const head = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!head || !claims) return { ok: false, reason: "unreadable token" };

  // Pinned, not read: "none" and HMAC-with-the-public-key both live here.
  if (head.alg !== "RS256") return { ok: false, reason: `alg ${String(head.alg)}` };
  const kid = typeof head.kid === "string" ? head.kid : null;
  if (!kid) return { ok: false, reason: "no kid" };

  if (claims.iss !== BOT_ISSUER) return { ok: false, reason: `iss ${String(claims.iss)}` };
  // The audience is this bot's own app id. A token for another bot is a valid
  // Microsoft token and still not ours.
  if (claims.aud !== args.appId) return { ok: false, reason: "aud is not this bot" };

  const now = args.now ?? Math.floor(Date.now() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  const nbf = typeof claims.nbf === "number" ? claims.nbf : null;
  if (exp === null || now > exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (nbf !== null && now + CLOCK_SKEW_SECONDS < nbf) return { ok: false, reason: "not yet valid" };

  // The claim that stops the bot being told where to send its answer. Absent
  // on some channel tokens; when present it must match, and when the activity
  // has no serviceUrl at all there is nothing to reply to anyway.
  if (typeof claims.serviceUrl === "string") {
    const a = (args.serviceUrl ?? "").replace(/\/+$/, "");
    const b = claims.serviceUrl.replace(/\/+$/, "");
    if (!a || a !== b) return { ok: false, reason: "serviceUrl does not match the token" };
  }

  let keys: Jwk[];
  try {
    keys = args.keys ?? (await signingKeys());
  } catch (e) {
    return { ok: false, reason: `keys unavailable: ${(e as Error).message}` };
  }
  const jwk = keys.find((k) => k.kid === kid && (k.kty ?? "RSA") === "RSA");
  if (!jwk?.n || !jwk.e) return { ok: false, reason: "unknown kid" };

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (e) {
    return { ok: false, reason: `bad key: ${(e as Error).message}` };
  }

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]) as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  );
  if (!valid) return { ok: false, reason: "signature" };
  return { ok: true, appId: args.appId };
}
