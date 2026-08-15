// Signed viewer tokens: who is looking at an embed, asserted by the host app.
//
// THE PROBLEM. An embed key is a CAPABILITY token — it ships inside the
// customer page's iframe src, so anyone who can read the page can read it. It
// answers "may this page show this dashboard?" and it cannot answer "who is
// looking?", because a value the browser holds can be copied by the browser's
// owner. So an embed on its own serves the SAME rows to every visitor: the
// owner's view. That is correct for a public dashboard and useless for
// embedding analytics in a product where each customer must see only their
// own data.
//
// THE FIX. The host's BACKEND mints a short-lived token naming the viewer's
// attributes, signed with a secret only the two servers share, and passes it
// into the iframe. We verify the signature and turn the attributes into row
// filters through the existing attribute-driven policy. The browser can read
// the token — it just cannot forge one, and it cannot mint itself a better
// one.
//
// WHAT THIS MODULE REFUSES, AND WHY EACH REFUSAL IS FAIL-CLOSED:
//
//   • A bad signature, a malformed token, or a missing one yields NO
//     attributes AND an error. It must never degrade to "unfiltered", because
//     the unfiltered view is precisely the one the token exists to prevent.
//   • A token with no `exp` is invalid. A viewer token that never expires is a
//     permanent grant sitting in someone's browser history.
//   • An expired token is invalid, with a small skew allowance — clocks drift,
//     but not by hours.
//   • Attributes only ever NARROW. That is architectural: they are fed to the
//     policy layer, which builds row filters. Nothing here can widen access
//     beyond what the embed key already permits.
//
// The HMAC is injected rather than imported so this module stays pure and
// testable, and so the server can use Node's constant-time comparison.

export type ViewerClaims = {
  /** Opaque identifier for the viewer, for audit. Never trusted for access. */
  sub?: string;
  /** Attribute values the row filters resolve against, e.g. { tenant: "acme" }. */
  attrs: Record<string, string | string[]>;
  /** Seconds since epoch. REQUIRED. */
  exp: number;
  iat?: number;
};

export type VerifyResult = { ok: true; claims: ViewerClaims } | { ok: false; reason: string };

/** Clocks drift; sessions do not need hours of slack. */
export const CLOCK_SKEW_SECONDS = 60;

/** Longest life we will honour, however long the host asked for. */
export const MAX_TOKEN_LIFETIME_SECONDS = 60 * 60 * 12;

// base64url over UTF-8 bytes — deliberately NOT btoa(json)/atob(payload).
//
// btoa and atob are Latin-1: they map each code unit to one byte. Every host
// backend that will mint these tokens does the opposite — Node's
// Buffer.from(json, "utf8"), Python's json.dumps().encode(), Go's []byte(s)
// all produce UTF-8. For ASCII the two agree, which is exactly why the
// mismatch would ship: it surfaces the first time a tenant is called "Ärhus"
// or "東京", as an attribute value that decodes to mojibake and therefore
// matches no row, while still LOOKING like a value. Same encoding as a JWT.
function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Serialise claims for signing.
 *
 * Exported so a host can be handed the exact bytes we will verify, rather than
 * reimplementing the encoding and discovering the mismatch in production.
 */
export function encodeClaims(claims: ViewerClaims): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(claims)));
}

/** Parse the payload half of a token, or null when it is not one. */
export function decodeClaims(payload: string): ViewerClaims | null {
  try {
    // fatal: invalid UTF-8 must throw rather than become U+FFFD. A silent
    // replacement character inside an attribute value is a filter that looks
    // like a value and matches nothing.
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytesFromB64url(payload));
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c.exp !== "number") return null;
    const attrs = c.attrs;
    if (
      attrs !== undefined &&
      (typeof attrs !== "object" || attrs === null || Array.isArray(attrs))
    ) {
      return null;
    }
    return {
      sub: typeof c.sub === "string" ? c.sub : undefined,
      attrs: (attrs as ViewerClaims["attrs"]) ?? {},
      exp: c.exp,
      iat: typeof c.iat === "number" ? c.iat : undefined,
    };
  } catch {
    return null;
  }
}

/** `payload.signature`, both base64url. */
export function signViewerToken(claims: ViewerClaims, hmac: (data: string) => string): string {
  const payload = encodeClaims(claims);
  return `${payload}.${hmac(payload)}`;
}

/**
 * Verify a token and return its claims.
 *
 * `hmac` must produce the same encoding `signViewerToken` used, and `equals`
 * should be a constant-time comparison on the server — a fast-exit compare
 * leaks the signature a byte at a time to anyone willing to time it.
 */
export function verifyViewerToken(
  token: string | undefined | null,
  hmac: (data: string) => string,
  nowSeconds: number,
  equals: (a: string, b: string) => boolean = (a, b) => a === b,
): VerifyResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "No viewer token supplied" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "Malformed viewer token" };
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature FIRST: never parse-then-trust. A payload that has not been
  // authenticated is attacker-controlled data.
  if (!equals(signature, hmac(payload))) {
    return { ok: false, reason: "Viewer token signature does not verify" };
  }
  const claims = decodeClaims(payload);
  if (!claims) return { ok: false, reason: "Viewer token payload is not readable" };
  if (!Number.isFinite(claims.exp)) {
    return { ok: false, reason: "Viewer token has no expiry" };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return { ok: false, reason: "Viewer token has expired" };
  }
  // A token minted far in the future is either a broken clock or an attempt at
  // an eternal grant; either way it is not a session.
  if (claims.iat !== undefined && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: "Viewer token is not valid yet" };
  }
  if (claims.exp - (claims.iat ?? nowSeconds) > MAX_TOKEN_LIFETIME_SECONDS) {
    return { ok: false, reason: "Viewer token lifetime exceeds the maximum allowed" };
  }
  return { ok: true, claims };
}

/**
 * Attributes as the policy layer wants them.
 *
 * Values are coerced to string arrays because a row filter matches against a
 * set; a single value is a set of one. Empty and non-scalar entries are
 * dropped rather than stringified — `{tenant: {}}` becoming the literal
 * "[object Object]" would be a filter that silently matches nothing, which
 * looks identical to a filter that matched nothing legitimately.
 */
export function attributesFromClaims(claims: ViewerClaims): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(claims.attrs ?? {})) {
    const values = (Array.isArray(v) ? v : [v]).filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
    if (values.length > 0) out[k] = values;
  }
  return out;
}

/**
 * What the embed should do when a signed viewer is REQUIRED but absent.
 *
 * Returned as a message rather than a boolean because the host developer
 * integrating this needs to know which of the several failure modes they hit,
 * and "forbidden" costs them an afternoon.
 */
export function requireViewerRefusal(requireSigned: boolean, verify: VerifyResult): string | null {
  if (!requireSigned) return null;
  if (verify.ok) return null;
  return `This embed requires a signed viewer token. ${verify.reason}.`;
}

/**
 * The Node snippet an integrator copies into their backend.
 *
 * It lives here, beside the verifier, because it is the other half of one
 * wire format: if the two drift, every integrator hits it and none of them
 * can see why. tests/unit/embedViewerToken.test.ts mints a token by exactly
 * these steps and asserts verifyViewerToken accepts it, so a change to the
 * encoding that is not made here fails the suite.
 */
export function hostMintingSnippet(args: {
  origin: string;
  embedKey: string;
  attributes: string[];
}): string {
  const attrs = args.attributes.map((a) => `      ${a}: viewer.${a},`).join("\n");
  return `// SERVER-SIDE ONLY. The secret must never reach the browser — anyone
// holding it can mint a token for any customer's data.
import { createHmac } from "node:crypto";

const SECRET = process.env.AGENTSWARMS_VIEWER_SECRET; // shown once, on generation
const EMBED_KEY = "${args.embedKey}";

const b64url = (b) => Buffer.from(b).toString("base64url");

export function embedUrlFor(viewer) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub: viewer.id,          // for your audit trail; never used for access
    attrs: {
${attrs}
    },
    iat: now,
    exp: now + 600,          // keep it short; 12h is the maximum accepted
  }));
  const sig = b64url(createHmac("sha256", SECRET).update(payload).digest());
  return \`${args.origin}/embed/bi/\${EMBED_KEY}?vt=\${payload}.\${sig}\`;
}`;
}
