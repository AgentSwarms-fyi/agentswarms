// Google service-account auth: sign a JWT with the key's private key, exchange
// it for an access token.
//
// Extracted from the BigQuery driver so Sheets (and anything Google added
// later) uses the SAME implementation rather than a second copy. The signing
// is subtle enough — PKCS#8 import, base64url without padding, the exact
// grant_type URN — that two copies would drift, and the failure mode of a
// wrong signature is an opaque 401 from Google rather than anything local.

import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Strip the PEM armour and decode the base64 body into a key buffer. */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** base64url, unpadded — what JWT requires and what btoa does not give you. */
export function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type ServiceAccountKey = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

/**
 * Parse a service-account key JSON, failing with a message that says what is
 * wrong with it rather than throwing a JSON syntax error at the user.
 */
export function parseServiceAccount(json: string, label: string): Required<ServiceAccountKey> {
  let sa: ServiceAccountKey;
  try {
    sa = JSON.parse(json) as ServiceAccountKey;
  } catch {
    throw new Error(`${label}: service account key is not valid JSON`);
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error(`${label}: service account key is missing client_email/private_key`);
  }
  return {
    client_email: sa.client_email,
    private_key: sa.private_key,
    token_uri: sa.token_uri || "https://oauth2.googleapis.com/token",
  };
}

/**
 * Exchange a service-account key for an access token with the given scope.
 *
 * `scope` is per-API and matters: a token minted for BigQuery cannot read a
 * spreadsheet, and Google's refusal says only "insufficient permissions".
 */
export async function googleAccessToken(
  serviceAccountJson: string,
  opts: { scope: string; label: string },
): Promise<string> {
  const sa = parseServiceAccount(serviceAccountJson, opts.label);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: opts.scope,
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
  const res = await connectorFetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${opts.label} auth: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error(`${opts.label} auth: no access_token in the response`);
  return access_token;
}

/** Scopes used by this app. Read-only everywhere — nothing here ever writes. */
export const GOOGLE_SCOPES = {
  bigquery: "https://www.googleapis.com/auth/bigquery",
  sheetsReadonly: "https://www.googleapis.com/auth/spreadsheets.readonly",
  driveReadonly: "https://www.googleapis.com/auth/drive.readonly",
} as const;
