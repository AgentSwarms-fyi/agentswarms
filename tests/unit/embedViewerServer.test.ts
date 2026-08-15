// The server half of signed viewers, and the interop contract with the host.
//
// The tests that matter here are the ones a unit test of the pure module
// cannot reach: that a token minted by the EXACT steps we hand integrators is
// accepted, that the encoding survives non-ASCII attribute values, and that
// decideViewerScope lands on "refused" — never "open" — for every way the
// verification can fail.
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  decodeClaims,
  encodeClaims,
  hostMintingSnippet,
  signViewerToken,
  verifyViewerToken,
  type ViewerClaims,
} from "@/lib/embedViewerToken";

const NOW = 1_760_000_000;
const SECRET = "evs_test_secret_value";

/**
 * Exactly what hostMintingSnippet tells an integrator to run: base64url of the
 * UTF-8 JSON, then base64url of HMAC-SHA256 over that string. Written out
 * independently so a change to our encoder that is not also a change to the
 * documented format shows up as a failure here.
 */
function mintLikeAHost(claims: ViewerClaims, secret: string): string {
  const b64url = (b: Buffer | string) => Buffer.from(b as Buffer).toString("base64url");
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

let hmacFor: (s: string) => (d: string) => string;
let safeEquals: (a: string, b: string) => boolean;
let generateViewerSecret: () => string;
let decideViewerScope: typeof import("@/utils/embedViewer.server").decideViewerScope;
let encryptViewerSecret: typeof import("@/utils/embedViewer.server").encryptViewerSecret;

beforeAll(async () => {
  // The secret store needs an envelope key, like every other credential.
  process.env.PROVIDER_CREDS_SECRET ??= "test-envelope-key-for-viewer-secrets";
  const mod = await import("@/utils/embedViewer.server");
  hmacFor = mod.hmacFor;
  safeEquals = mod.safeEquals;
  generateViewerSecret = mod.generateViewerSecret;
  decideViewerScope = mod.decideViewerScope;
  encryptViewerSecret = mod.encryptViewerSecret;
});

const claims = (over: Partial<ViewerClaims> = {}): ViewerClaims => ({
  sub: "user-1",
  attrs: { tenant: "acme" },
  iat: NOW,
  exp: NOW + 600,
  ...over,
});

describe("the wire format we publish is the wire format we verify", () => {
  it("accepts a token minted by the documented host steps", () => {
    const token = mintLikeAHost(claims(), SECRET);
    const r = verifyViewerToken(token, hmacFor(SECRET), NOW, safeEquals);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.attrs).toEqual({ tenant: "acme" });
  });

  it("produces byte-identical tokens from either side", () => {
    expect(signViewerToken(claims(), hmacFor(SECRET))).toBe(mintLikeAHost(claims(), SECRET));
  });

  it("round-trips a NON-ASCII attribute value", () => {
    // btoa/atob are Latin-1 and every host backend is UTF-8, so this is where
    // the two would silently disagree: the value would decode to mojibake and
    // match no row, while still looking like a value.
    const c = claims({ attrs: { city: "東京", tenant: "Ärhus" } });
    const r = verifyViewerToken(mintLikeAHost(c, SECRET), hmacFor(SECRET), NOW, safeEquals);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.attrs).toEqual({ city: "東京", tenant: "Ärhus" });
    expect(decodeClaims(encodeClaims(c))).toEqual(c);
  });

  it("rejects a host token signed with the wrong secret", () => {
    const token = mintLikeAHost(claims(), "not-the-secret");
    expect(verifyViewerToken(token, hmacFor(SECRET), NOW, safeEquals).ok).toBe(false);
  });

  it("hands the integrator a snippet naming their key and attributes", () => {
    const s = hostMintingSnippet({
      origin: "https://app.example.com",
      embedKey: "emk_abc",
      attributes: ["tenant", "region"],
    });
    expect(s).toContain("emk_abc");
    expect(s).toContain("tenant: viewer.tenant");
    expect(s).toContain("region: viewer.region");
    expect(s).toContain('createHmac("sha256"');
    expect(s).toContain("base64url");
    // The one mistake that undoes the whole mechanism.
    expect(s).toMatch(/SERVER-SIDE ONLY/);
  });
});

describe("constant-time comparison", () => {
  it("is true only for equal strings", () => {
    expect(safeEquals("abc", "abc")).toBe(true);
    expect(safeEquals("abc", "abd")).toBe(false);
  });

  it("returns false on a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; an exception escaping here
    // would turn a bad token into a 500 rather than a refusal.
    expect(safeEquals("a", "abcdef")).toBe(false);
    expect(safeEquals("", "x")).toBe(false);
  });
});

describe("generated secrets", () => {
  it("are long, prefixed and distinct", () => {
    const a = generateViewerSecret();
    const b = generateViewerSecret();
    expect(a.startsWith("evs_")).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(a).not.toBe(b);
  });
});

describe("deciding what a request's viewer may see", () => {
  const scopedKey = async (over: Record<string, unknown> = {}) => ({
    require_signed_viewer: true,
    viewer_attributes: ["tenant"],
    viewer_secret: await encryptViewerSecret(SECRET),
    ...over,
  });

  it("is open when the embed does not require a signed viewer", async () => {
    const d = await decideViewerScope({ require_signed_viewer: false }, undefined, NOW);
    expect(d.kind).toBe("open");
  });

  it("IGNORES a token on an embed that does not require one", async () => {
    // Otherwise a visitor could hand themselves filters, or a stale token
    // could narrow a public dashboard in ways its owner never configured.
    const d = await decideViewerScope(
      { require_signed_viewer: false, viewer_attributes: ["tenant"] },
      mintLikeAHost(claims(), SECRET),
      NOW,
    );
    expect(d.kind).toBe("open");
  });

  it("scopes a valid token to its attributes", async () => {
    const d = await decideViewerScope(await scopedKey(), mintLikeAHost(claims(), SECRET), NOW);
    expect(d).toMatchObject({
      kind: "scoped",
      filters: [{ column: "tenant", values: ["acme"] }],
      subject: "user-1",
    });
  });

  it("REFUSES rather than opening when the token is missing", async () => {
    const d = await decideViewerScope(await scopedKey(), undefined, NOW);
    expect(d.kind).toBe("refused");
  });

  it("REFUSES a forged token", async () => {
    const forged = mintLikeAHost(claims({ attrs: { tenant: "victim" } }), "wrong-secret");
    const d = await decideViewerScope(await scopedKey(), forged, NOW);
    expect(d.kind).toBe("refused");
  });

  it("REFUSES an expired token", async () => {
    const d = await decideViewerScope(
      await scopedKey(),
      mintLikeAHost(claims({ exp: NOW - 7200 }), SECRET),
      NOW,
    );
    expect(d).toMatchObject({ kind: "refused" });
    if (d.kind === "refused") expect(d.message).toContain("expired");
  });

  it("REFUSES when the token omits a required attribute, naming it", async () => {
    const d = await decideViewerScope(
      await scopedKey({ viewer_attributes: ["tenant", "region"] }),
      mintLikeAHost(claims(), SECRET),
      NOW,
    );
    expect(d).toMatchObject({ kind: "refused" });
    if (d.kind === "refused") expect(d.message).toContain("region");
  });

  it("REFUSES when the stored secret cannot be read", async () => {
    // A rotated envelope key, or a row edited by hand. Falling back to the
    // owner's view here would defeat the feature exactly when it broke.
    const d = await decideViewerScope(
      { require_signed_viewer: true, viewer_attributes: ["tenant"], viewer_secret: null },
      mintLikeAHost(claims(), SECRET),
      NOW,
    );
    expect(d).toMatchObject({ kind: "refused" });
    if (d.kind === "refused") expect(d.message).toContain("regenerate");
  });

  it("REFUSES a secret blob that cannot be decrypted", async () => {
    // The realistic version of the case above: the row still holds a
    // well-formed blob, but the envelope key that wrote it is gone. It must
    // refuse with the owner-actionable message, not fall back to some other
    // secret and report a signature failure the host cannot act on.
    const d = await decideViewerScope(
      {
        require_signed_viewer: true,
        viewer_attributes: ["tenant"],
        viewer_secret: { ciphertext: "AAAAAAAAAAAAAAAAAAAA", iv: "AAAAAAAAAAAAAAAA", kid: "gone" },
      },
      mintLikeAHost(claims(), SECRET),
      NOW,
    );
    expect(d).toMatchObject({ kind: "refused" });
    if (d.kind === "refused") expect(d.message).toContain("regenerate");
  });

  it("REFUSES a key that requires a signed viewer but names no attributes", async () => {
    const d = await decideViewerScope(
      await scopedKey({ viewer_attributes: [] }),
      mintLikeAHost(claims(), SECRET),
      NOW,
    );
    expect(d.kind).toBe("refused");
  });
});
