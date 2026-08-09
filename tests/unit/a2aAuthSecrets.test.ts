// The A2A node's auth header is a credential field, so it must behave like one.
//
// docs/swarms lists a2aAuthHeader as "Auth header value — use {{secret:NAME}}",
// but nothing on that path resolved it. Measured against the running instance:
//
//   remoteAuthHeader: "Bearer {{secret:NO_SUCH_SECRET_XYZ}}"
//   before:  HTTP 502  Remote agent returned 404: <html>…   ← literal went out
//   after:   HTTP 400  Secret "NO_SUCH_SECRET_XYZ" not found or you don't
//                      have access to it.                    ← never left the box
//
// Two costs, not one. The obvious one is that a reference silently fails as an
// authentication error from the far end. The quieter one is the workaround: the
// inspector's own placeholder used to read "Bearer sk-… or just the token", and
// a token typed there is stored verbatim in the swarm's `nodes` JSON — readable
// by anyone who can open the graph, and copied into every export, version
// snapshot and published_nodes pin. The field is type="password", which makes
// it look like the opposite is true.
//
// Also pinned here: the refusal message the SSRF guard produces. It blamed
// BLOCK_PRIVATE_NETWORK_FETCH unconditionally, and /api/a2a passes
// blockPrivate itself — so on an instance where that variable is not set
// anywhere (this one), the error named an environment variable the operator
// could search for, not find, and learn nothing from.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "@/utils/ssrfGuard.server";

const route = readFileSync(resolve("src/routes/api/a2a.ts"), "utf8");
const inspector = readFileSync(resolve("src/components/swarms/NodeInspector.tsx"), "utf8");
const secretsDoc = readFileSync(resolve("src/routes/docs.secrets.tsx"), "utf8");

/** The block that builds the outbound Authorization header. */
function authHeaderBlock(): string {
  const i = route.indexOf("if (payload.remoteAuthHeader)");
  expect(i, "the auth-header block moved; this test needs re-anchoring").toBeGreaterThan(0);
  return route.slice(i, route.indexOf("const ctrl = new AbortController()", i));
}

describe("A2A auth header resolves secret references", () => {
  it("calls the real resolver, not a local re-implementation", () => {
    expect(route).toMatch(/import \{ resolveSecretRefs \} from "@\/utils\/secrets\.server"/);
    expect(authHeaderBlock()).toMatch(/await resolveSecretRefs\(\s*userId\s*,/);
  });

  it("resolves BEFORE the outbound fetch, so a bad reference never leaves", () => {
    const block = authHeaderBlock();
    const resolvedAt = block.indexOf("resolveSecretRefs");
    const sentAt = block.indexOf("headers.Authorization");
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(sentAt).toBeGreaterThan(resolvedAt);
    // …and the whole header block still precedes safeFetch in the function.
    expect(route.indexOf("if (payload.remoteAuthHeader)")).toBeLessThan(
      route.indexOf("upstream = await safeFetch"),
    );
  });

  it("sends the RESOLVED value, never the raw payload field", () => {
    const block = authHeaderBlock();
    // The Bearer-prefixing must operate on the resolved string. Mutation
    // testing earned this: restoring `payload.remoteAuthHeader` in just the
    // assignment left the resolve call sitting there, doing nothing, and every
    // other assertion in this file still passed.
    expect(block).toMatch(/headers\.Authorization\s*=\s*[\s\S]{0,120}authValue/);
    expect(block).not.toMatch(/headers\.Authorization\s*=[\s\S]{0,200}payload\.remoteAuthHeader/);
  });

  it("surfaces a resolution failure as a 400 naming the secret, not a 502", () => {
    // resolveSecretRefs throws with the secret's name in the message; the
    // catch must return it rather than swallowing it into a generic failure.
    const block = authHeaderBlock();
    expect(block).toMatch(/catch \(e\)/);
    expect(block).toMatch(
      /jsonResponse\(\{ error: e instanceof Error \? e\.message[\s\S]{0,40}400/,
    );
  });

  it("userId reaches handleInvoke, which is what scopes the lookup", () => {
    // Without this the resolver could not enforce ownership/IAM at all.
    expect(route).toMatch(/async function handleInvoke\(payload: InvokePayload, userId: string\)/);
    expect(route).toMatch(/handleInvoke\(payload as InvokePayload, userId\)/);
  });
});

describe("the node inspector points at secrets, not at pasting a token", () => {
  /** The A2A panel only — the HTTP panel has its own secret copy. */
  function a2aPanel(): string {
    const i = inspector.indexOf("function A2APanel(");
    expect(i).toBeGreaterThan(0);
    return inspector.slice(i, inspector.indexOf("\nfunction ", i + 10));
  }

  it("advertises {{secret:NAME}} in the auth field", () => {
    expect(a2aPanel()).toContain("{{secret:");
  });

  it("no longer suggests pasting a raw key as the example", () => {
    expect(a2aPanel()).not.toMatch(/placeholder="Bearer sk-\.\.\./);
  });

  it("does not send first-time users to a dead sample agent", () => {
    // The panel used to recommend a Cloud Run URL belonging to someone's
    // personal project. Verified from this instance: both well-known paths
    // 404, so the hint's only effect was a 502 on the user's first attempt.
    expect(a2aPanel()).not.toContain("sample-a2a-agent-908687846511");
    expect(a2aPanel()).not.toMatch(/run\.app/);
  });

  it("says up front that private/loopback endpoints are refused", () => {
    // /api/a2a hardcodes blockPrivate, so the usual way to try A2A — run the
    // reference agent on localhost — cannot work, and nothing said so.
    expect(a2aPanel()).toMatch(/loopback|localhost|private/i);
  });
});

describe("the secrets doc's list of resolving fields stays complete", () => {
  it("names the A2A node, since a reference elsewhere is passed through literally", () => {
    // That page is explicit that anywhere NOT on its list passes the literal
    // text through, so an omission there is a wrong answer, not a gap.
    expect(secretsDoc).toMatch(/A2A remote-agent node/);
  });
});

describe("a refusal explains the reason that actually applied", () => {
  it("does not blame BLOCK_PRIVATE_NETWORK_FETCH when the caller asked for it", async () => {
    delete process.env.BLOCK_PRIVATE_NETWORK_FETCH;
    delete process.env.ALLOW_PRIVATE_NETWORK_FETCH;
    const r = await assertPublicUrl("http://127.0.0.1:8080/", { blockPrivate: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("127.0.0.1");
    expect(r.error).not.toContain("BLOCK_PRIVATE_NETWORK_FETCH");
  });

  it("still names the variable when the variable is what refused", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    try {
      const r = await assertPublicUrl("http://10.0.0.5/", {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain("BLOCK_PRIVATE_NETWORK_FETCH is enabled");
    } finally {
      delete process.env.BLOCK_PRIVATE_NETWORK_FETCH;
    }
  });

  it("keeps refusing link-local regardless of who asked", async () => {
    const r = await assertPublicUrl("http://169.254.169.254/", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/link-local\/metadata/);
  });
});
