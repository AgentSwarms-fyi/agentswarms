// Server half of signed viewer tokens: the real HMAC, the stored secret, and
// the one place a request's viewer scope is decided.
//
// src/lib/embedViewerToken.ts holds the rules and takes the HMAC as an
// argument, so it stays pure and testable. This supplies Node's crypto: a
// SHA-256 HMAC and, importantly, timingSafeEqual — a `===` on the signature
// exits at the first differing byte, which leaks the expected signature to
// anyone willing to time a few thousand requests.
//
// The secret is stored ENCRYPTED with the same envelope as provider
// credentials. Owners can read their own embed_keys row under RLS, so the
// ciphertext is reachable from the browser; the plaintext exists in the clear
// exactly once, in the response that generates it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { BiRowFilter } from "@/lib/biDashboards";
import {
  attributesFromClaims,
  requireViewerRefusal,
  verifyViewerToken,
  type VerifyResult,
} from "@/lib/embedViewerToken";
import { viewerScopeFilters } from "@/lib/embedViewerScope";
import { decryptJson, encryptJson, isEncryptedBlob } from "@/utils/providers/crypto.server";

/** base64url so the token survives a URL without escaping. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hmacFor(secret: string): (data: string) => string {
  return (data: string) => b64url(createHmac("sha256", secret).update(data).digest());
}

/**
 * Constant-time string compare.
 *
 * timingSafeEqual throws on a length mismatch — which would itself be a
 * length oracle if it escaped as a distinct outcome — so unequal lengths
 * return false after still doing a comparison of equal-length buffers.
 */
export function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** A fresh 256-bit shared secret, shown to the owner once. */
export function generateViewerSecret(): string {
  return `evs_${b64url(randomBytes(32))}`;
}

export async function encryptViewerSecret(secret: string) {
  return encryptJson(secret);
}

/** The stored secret in the clear, or null when the key has none. */
export async function readViewerSecret(stored: unknown): Promise<string | null> {
  if (!isEncryptedBlob(stored)) return null;
  try {
    const plain = await decryptJson<string>(stored.ciphertext, stored.iv, stored.kid);
    return typeof plain === "string" && plain.length > 0 ? plain : null;
  } catch {
    // A secret we cannot decrypt is a secret we cannot verify against. The
    // caller treats null as "no signed viewer available", which fails closed
    // on a key that requires one.
    return null;
  }
}

export type ViewerDecision =
  | { kind: "open" }
  | { kind: "scoped"; filters: BiRowFilter[]; subject?: string }
  | { kind: "refused"; message: string };

type ViewerKeyFields = {
  require_signed_viewer?: boolean | null;
  viewer_attributes?: string[] | null;
  viewer_secret?: unknown;
};

/**
 * What this request's viewer may see.
 *
 * Every failure lands on "refused" rather than "open". The unfiltered view is
 * exactly the thing a signed viewer exists to prevent, so degrading to it on
 * any error would defeat the feature at the moment it matters most: a broken
 * clock, a rotated secret, a truncated URL.
 *
 * A key that does NOT require a signed viewer ignores any token supplied —
 * a public embed is a legitimate configuration, and honouring an unverified
 * token there would let a visitor choose their own filters.
 */
export async function decideViewerScope(
  key: ViewerKeyFields,
  token: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ViewerDecision> {
  if (!key.require_signed_viewer) return { kind: "open" };

  const secret = await readViewerSecret(key.viewer_secret);
  if (!secret) {
    return {
      kind: "refused",
      message:
        "This embed requires a signed viewer token, but its signing secret is unavailable. " +
        "The owner needs to regenerate it.",
    };
  }

  const verify: VerifyResult = verifyViewerToken(token, hmacFor(secret), nowSeconds, safeEquals);
  const refusal = requireViewerRefusal(true, verify);
  if (refusal || !verify.ok) {
    return { kind: "refused", message: refusal ?? "This embed requires a signed viewer token." };
  }

  const scope = viewerScopeFilters(
    key.viewer_attributes ?? [],
    attributesFromClaims(verify.claims),
  );
  if (!scope.ok) return { kind: "refused", message: scope.reason };
  return { kind: "scoped", filters: scope.filters, subject: verify.claims.sub };
}
