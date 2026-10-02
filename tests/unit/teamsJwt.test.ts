// The whole security boundary for the Teams channel.
//
// The endpoint is public, so anyone who learns the URL can POST an activity
// claiming to be any user in any tenant. What stops them is this verifier, and
// every test below is a forgery that must be refused — signed with the wrong
// key, minted for another bot, from another issuer, expired, algorithm
// downgraded, or pointing the bot's reply at a host the attacker controls.
//
// Real RSA keys, generated here and signed here: a verifier tested only
// against hand-written fixtures can pass while verifying nothing.
import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

import { BOT_ISSUER, CLOCK_SKEW_SECONDS, verifyTeamsToken } from "@/utils/teams/jwt.server";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";

const b64url = (bytes: Uint8Array | string): string => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let pair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let jwks: Record<string, unknown>[];

async function keyPair() {
  return webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

async function jwkFor(p: CryptoKeyPair, kid: string) {
  const jwk = (await webcrypto.subtle.exportKey("jwk", p.publicKey)) as Record<string, unknown>;
  return { ...jwk, kid, kty: "RSA", alg: "RS256" };
}

/** Mint a token the way Microsoft would, so the verifier meets a real one. */
async function mint(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string; signWith?: CryptoKeyPair } = {},
) {
  const header = b64url(
    JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" }),
  );
  const payload = b64url(JSON.stringify(claims));
  const sig = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (opts.signWith ?? pair).privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const now = 1_800_000_000;
const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: BOT_ISSUER,
  aud: APP_ID,
  serviceUrl: SERVICE_URL,
  exp: now + 3600,
  nbf: now - 60,
  ...over,
});

const verify = (token: string, over: Partial<Parameters<typeof verifyTeamsToken>[0]> = {}) =>
  verifyTeamsToken({
    authorization: `Bearer ${token}`,
    appId: APP_ID,
    serviceUrl: SERVICE_URL,
    now,
    keys: jwks,
    ...over,
  });

beforeAll(async () => {
  pair = await keyPair();
  otherPair = await keyPair();
  jwks = [await jwkFor(pair, "k1")];
}, 30_000);

describe("a token Microsoft really issued", () => {
  it("is accepted", async () => {
    const r = await verify(await mint(goodClaims()));
    expect(r).toEqual({ ok: true, appId: APP_ID });
  });

  it("is accepted when the token carries no serviceUrl claim", async () => {
    // Some channel tokens omit it; the activity still has one to reply to.
    const { serviceUrl: _drop, ...rest } = goodClaims();
    const r = await verify(await mint(rest));
    expect(r.ok).toBe(true);
  });

  it("tolerates a little clock skew, and not a lot", async () => {
    const justExpired = await mint(goodClaims({ exp: now - CLOCK_SKEW_SECONDS + 10 }));
    expect((await verify(justExpired)).ok).toBe(true);
    const longExpired = await mint(goodClaims({ exp: now - CLOCK_SKEW_SECONDS - 10 }));
    expect((await verify(longExpired)).ok).toBe(false);
  });
});

describe("forgeries", () => {
  it("refuses a token signed with a key that is not Microsoft's", async () => {
    // The attack: mint your own token, sign it with your own key.
    const token = await mint(goodClaims(), { signWith: otherPair });
    const r = await verify(token);
    expect(r).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a key the token brought with it", async () => {
    // A verifier that trusted an embedded key would verify the attacker's own
    // signature. Only the published set counts, so an unknown kid is refused.
    const token = await mint(goodClaims(), { kid: "attacker-key", signWith: otherPair });
    expect((await verify(token)).ok).toBe(false);
    expect(await verify(token)).toMatchObject({ reason: "unknown kid" });
  });

  it("refuses an algorithm downgrade", async () => {
    // "none" and HMAC-with-the-public-key both arrive as a changed alg.
    for (const alg of ["none", "HS256", "RS512"]) {
      const token = await mint(goodClaims(), { alg });
      expect((await verify(token)).ok, alg).toBe(false);
    }
  });

  it("refuses a token minted for another bot", async () => {
    // Validly signed by Microsoft, and still not ours.
    const token = await mint(goodClaims({ aud: "99999999-0000-0000-0000-000000000000" }));
    expect(await verify(token)).toMatchObject({ ok: false, reason: "aud is not this bot" });
  });

  it("refuses another issuer", async () => {
    const token = await mint(goodClaims({ iss: "https://login.microsoftonline.com/x/v2.0" }));
    expect((await verify(token)).ok).toBe(false);
  });

  it("refuses an expired token, and one that is not valid yet", async () => {
    expect((await verify(await mint(goodClaims({ exp: now - 10_000 })))).ok).toBe(false);
    expect((await verify(await mint(goodClaims({ nbf: now + 10_000 })))).ok).toBe(false);
    // A token with no expiry at all is refused rather than treated as eternal.
    const { exp: _drop, ...noExp } = goodClaims();
    expect(await verify(await mint(noExp))).toMatchObject({ reason: "expired" });
  });

  it("refuses to send the answer somewhere the token did not authorise", async () => {
    // THE exfiltration check: the activity says reply to evil.example, the
    // token says reply to Microsoft. Accepting that posts the agent's answer,
    // and whatever it read, to the attacker.
    const token = await mint(goodClaims());
    const r = await verify(token, { serviceUrl: "https://evil.example/" });
    expect(r).toMatchObject({ ok: false, reason: "serviceUrl does not match the token" });
    // Trailing slashes are not a difference.
    expect((await verify(token, { serviceUrl: SERVICE_URL.replace(/\/$/, "") })).ok).toBe(true);
    // And an activity with no serviceUrl cannot satisfy a token that names one.
    expect((await verify(token, { serviceUrl: null })).ok).toBe(false);
  });
});

describe("nothing is accepted by absence", () => {
  it("refuses a request with no token at all", async () => {
    for (const authorization of [null, "", "Basic abc", "Bearer", "Bearer  "]) {
      const r = await verifyTeamsToken({
        authorization,
        appId: APP_ID,
        serviceUrl: SERVICE_URL,
        now,
        keys: jwks,
      });
      expect(r.ok, String(authorization)).toBe(false);
    }
  });

  it("refuses a malformed or unreadable token", async () => {
    for (const t of ["a.b", "a.b.c.d", "not-base64.not-base64.x"]) {
      expect((await verify(t)).ok, t).toBe(false);
    }
  });

  it("refuses when the key set cannot be loaded", async () => {
    // Fails closed: no keys is not "skip the signature check".
    const token = await mint(goodClaims());
    const r = await verifyTeamsToken({
      authorization: `Bearer ${token}`,
      appId: APP_ID,
      serviceUrl: SERVICE_URL,
      now,
      keys: [],
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a header with no kid", async () => {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify(goodClaims()));
    const sig = await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const r = await verify(`${header}.${payload}.${b64url(new Uint8Array(sig))}`);
    expect(r).toMatchObject({ ok: false, reason: "no kid" });
  });
});
