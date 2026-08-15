// Signed viewer tokens. This is the security boundary that makes embedded
// analytics multi-tenant, so every test here is a way an attacker gets the
// wrong rows: a forged token accepted, an expired one honoured, a malformed
// one degrading to "unfiltered" instead of refusing, or claims trusted before
// the signature was checked.
import { describe, expect, it } from "vitest";

import {
  attributesFromClaims,
  decodeClaims,
  encodeClaims,
  MAX_TOKEN_LIFETIME_SECONDS,
  requireViewerRefusal,
  signViewerToken,
  verifyViewerToken,
  type ViewerClaims,
} from "@/lib/embedViewerToken";

// A stand-in HMAC: deterministic, and DIFFERENT for different secrets, which
// is all the module's logic depends on. The real one is Node's createHmac.
const hmacWith = (secret: string) => (data: string) => `sig(${secret}:${data.length}:${data})`;
const hmac = hmacWith("s3cret");
const NOW = 1_760_000_000;

const claims = (over: Partial<ViewerClaims> = {}): ViewerClaims => ({
  sub: "user-1",
  attrs: { tenant: "acme" },
  iat: NOW,
  exp: NOW + 600,
  ...over,
});

describe("round trip", () => {
  it("verifies a token it just signed", () => {
    const r = verifyViewerToken(signViewerToken(claims(), hmac), hmac, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.attrs).toEqual({ tenant: "acme" });
  });

  it("encodes and decodes claims losslessly", () => {
    const c = claims({ attrs: { tenant: ["a", "b"], region: "emea" } });
    expect(decodeClaims(encodeClaims(c))).toEqual(c);
  });
});

describe("forgery", () => {
  it("rejects a token signed with a DIFFERENT secret", () => {
    // The whole point: the browser holds the token and must not be able to
    // mint a better one.
    const forged = signViewerToken(claims({ attrs: { tenant: "victim" } }), hmacWith("wrong"));
    const r = verifyViewerToken(forged, hmac, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("signature");
  });

  it("rejects a payload edited after signing", () => {
    const good = signViewerToken(claims(), hmac);
    const tampered = `${encodeClaims(claims({ attrs: { tenant: "victim" } }))}.${good.split(".")[1]}`;
    expect(verifyViewerToken(tampered, hmac, NOW).ok).toBe(false);
  });

  it("checks the signature BEFORE reading the payload", () => {
    // An unauthenticated payload is attacker-controlled data. Parsing it first
    // and rejecting later still runs a parser on hostile input, and any claim
    // read along the way is untrusted.
    let parsedBeforeVerify = false;
    const spyHmac = (data: string) => {
      // If the implementation decoded first, it would have thrown on this
      // deliberately unparseable payload before ever calling the HMAC.
      parsedBeforeVerify = false;
      return hmac(data);
    };
    const r = verifyViewerToken("!!!not-base64!!!.whatever", spyHmac, NOW);
    expect(r.ok).toBe(false);
    expect(parsedBeforeVerify).toBe(false);
    if (!r.ok) expect(r.reason).toContain("signature");
  });

  it("uses the supplied comparison, so the server can be constant-time", () => {
    let used = false;
    const eq = (a: string, b: string) => {
      used = true;
      return a === b;
    };
    verifyViewerToken(signViewerToken(claims(), hmac), hmac, NOW, eq);
    expect(used).toBe(true);
  });
});

describe("shape", () => {
  it("refuses a missing token rather than treating it as anonymous-but-allowed", () => {
    for (const bad of [undefined, null, "", "no-dot"]) {
      expect(verifyViewerToken(bad as string | undefined, hmac, NOW).ok).toBe(false);
    }
  });

  it("refuses a token with an empty payload or empty signature", () => {
    expect(verifyViewerToken(".sig", hmac, NOW).ok).toBe(false);
    expect(verifyViewerToken("payload.", hmac, NOW).ok).toBe(false);
  });

  it("refuses claims that are not an object", () => {
    expect(decodeClaims(btoa("[1,2,3]"))).toBeNull();
    expect(decodeClaims(btoa('"a string"'))).toBeNull();
    expect(decodeClaims("not base64 at all !!")).toBeNull();
  });

  it("refuses attrs that are an array rather than a map", () => {
    expect(decodeClaims(btoa(JSON.stringify({ exp: NOW, attrs: ["a"] })))).toBeNull();
  });

  it("REFUSES a payload whose bytes are not valid UTF-8", () => {
    // A lone 0xFF inside a string is not UTF-8. A lenient decoder turns it
    // into U+FFFD and JSON.parse then succeeds, yielding attrs.tenant = "�" —
    // a filter that looks like a value and matches no row. The token is
    // otherwise well-formed, so nothing else would catch it.
    const bytes = [
      ...new TextEncoder().encode('{"exp":' + (NOW + 600) + ',"attrs":{"tenant":"'),
      0xff,
      ...new TextEncoder().encode('"}}'),
    ];
    const payload = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeClaims(payload)).toBeNull();
    expect(verifyViewerToken(`${payload}.${hmac(payload)}`, hmac, NOW).ok).toBe(false);
  });
});

describe("expiry", () => {
  it("REQUIRES an expiry — an eternal viewer token is a permanent grant", () => {
    const noExp = btoa(JSON.stringify({ sub: "u", attrs: {} }));
    expect(decodeClaims(noExp)).toBeNull();
    expect(verifyViewerToken(`${noExp}.${hmac(noExp)}`, hmac, NOW).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const r = verifyViewerToken(signViewerToken(claims({ exp: NOW - 3600 }), hmac), hmac, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("expired");
  });

  it("allows a little clock skew but not much", () => {
    expect(verifyViewerToken(signViewerToken(claims({ exp: NOW - 30 }), hmac), hmac, NOW).ok).toBe(
      true,
    );
    expect(verifyViewerToken(signViewerToken(claims({ exp: NOW - 600 }), hmac), hmac, NOW).ok).toBe(
      false,
    );
  });

  it("rejects a token minted in the future", () => {
    const r = verifyViewerToken(
      signViewerToken(claims({ iat: NOW + 7200, exp: NOW + 7800 }), hmac),
      hmac,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not valid yet");
  });

  it("caps the lifetime however long the host asked for", () => {
    const tooLong = claims({ iat: NOW, exp: NOW + MAX_TOKEN_LIFETIME_SECONDS + 60 });
    const r = verifyViewerToken(signViewerToken(tooLong, hmac), hmac, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("lifetime");
  });
});

describe("attributes reaching the policy layer", () => {
  it("normalises single values into sets", () => {
    expect(attributesFromClaims(claims({ attrs: { tenant: "acme" } }))).toEqual({
      tenant: ["acme"],
    });
  });

  it("keeps multi-valued attributes", () => {
    expect(attributesFromClaims(claims({ attrs: { region: ["emea", "apac"] } }))).toEqual({
      region: ["emea", "apac"],
    });
  });

  it("DROPS non-scalar and blank values rather than stringifying them", () => {
    // `{tenant: {}}` stringified becomes "[object Object]" — a filter that
    // matches nothing, indistinguishable from one that legitimately did.
    const c = claims({
      attrs: { a: {} as unknown as string, b: "  ", c: [] as string[], d: "ok" },
    });
    expect(attributesFromClaims(c)).toEqual({ d: ["ok"] });
  });

  it("returns an empty map for absent attrs, never undefined", () => {
    expect(attributesFromClaims({ attrs: {}, exp: NOW })).toEqual({});
  });
});

describe("the refusal when a signed viewer is required", () => {
  it("refuses and says WHY, so the integrator is not guessing", () => {
    const msg = requireViewerRefusal(true, { ok: false, reason: "Viewer token has expired" });
    expect(msg).toContain("requires a signed viewer token");
    expect(msg).toContain("expired");
  });

  it("says nothing when a valid token was supplied", () => {
    expect(requireViewerRefusal(true, { ok: true, claims: claims() })).toBeNull();
  });

  it("says nothing when the embed does not require one", () => {
    // A public dashboard embed is a legitimate configuration.
    expect(
      requireViewerRefusal(false, { ok: false, reason: "No viewer token supplied" }),
    ).toBeNull();
  });
});
