// The SSRF guard, and the caller that had drifted away from it.
//
// /api/a2a is a server-side proxy: it fetches a URL the user supplies and
// RETURNS THE BODY to them. That makes a blocked-range fetch a read primitive,
// not just an outbound request — the payload for 169.254.169.254 is the host's
// IAM credentials.
//
// It carried its own hostname check, which had fallen behind the shared one:
//
//   * no DNS resolution — a public NAME whose A record points at the metadata
//     address passed a check that only ever looked at the literal hostname
//   * no redirect validation — all three fetches followed redirects by default
//   * ::ffff:a9fe:a9fe, the compressed IPv4-mapped spelling of 169.254.169.254,
//     was not recognised. ssrfGuard's own comments document that exact case as
//     a bug IT found and fixed; the copy never received the fix
//   * the unspecified address (::) and CGNAT were missing
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertPublicUrl,
  isBlockedAlways,
  isPrivateNetwork,
  safeFetch,
} from "@/utils/ssrfGuard.server";

describe("addresses that are never a legitimate target", () => {
  it("recognises cloud metadata in every spelling", () => {
    // The compressed form is the one the a2a copy missed. All three are
    // 169.254.169.254.
    for (const h of ["169.254.169.254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe"]) {
      expect(isBlockedAlways(h), h).toBe(true);
    }
  });

  it("recognises it inside brackets, as a URL hostname carries it", () => {
    expect(isBlockedAlways("[::ffff:a9fe:a9fe]")).toBe(true);
  });

  it("blocks the rest of link-local, the unspecified address and multicast", () => {
    for (const h of ["169.254.1.1", "fe80::1", "::", "0.0.0.0", "224.0.0.1", "239.255.255.250"]) {
      expect(isBlockedAlways(h), h).toBe(true);
    }
  });

  it("blocks AWS metadata over IPv6", () => {
    expect(isBlockedAlways("fd00:ec2::254")).toBe(true);
  });

  it("leaves ordinary public addresses alone", () => {
    for (const h of ["93.184.216.34", "1.1.1.1", "example.com", "2606:2800:220:1:248:1893::"]) {
      expect(isBlockedAlways(h), h).toBe(false);
    }
  });
});

describe("ordinary private networks are a policy, not an absolute", () => {
  it("classifies them, including CGNAT", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.5",
      "172.20.0.1",
      "100.64.0.1",
      "::1",
    ]) {
      expect(isPrivateNetwork(h), h).toBe(true);
    }
  });

  it("does not classify a public address as private", () => {
    // 172.32 is outside 172.16/12, and 100.128 outside 100.64/10 — the two
    // ranges that are easy to widen by accident.
    for (const h of ["172.32.0.1", "100.128.0.1", "11.0.0.1", "93.184.216.34"]) {
      expect(isPrivateNetwork(h), h).toBe(false);
    }
  });
});

describe("a caller may be stricter than the deployment", () => {
  // /api/a2a passes blockPrivate because it proxies the response back. The
  // option must only ever ADD refusals.
  it("refuses a private host when the caller asks, regardless of env", async () => {
    const r = await assertPublicUrl("http://192.168.1.5/agent-card.json", { blockPrivate: true });
    expect(r.ok).toBe(false);
  });

  it("permits the same host by default, which self-hosted tools rely on", async () => {
    const r = await assertPublicUrl("http://192.168.1.5/agent-card.json");
    expect(r.ok).toBe(true);
  });

  it("refuses metadata either way — no option can enable it", async () => {
    for (const opts of [{}, { blockPrivate: false }, { blockPrivate: true }]) {
      const r = await assertPublicUrl("http://169.254.169.254/latest/meta-data/", opts);
      expect(r.ok, JSON.stringify(opts)).toBe(false);
    }
  });

  it("refuses the compressed-hex metadata spelling through the URL parser", async () => {
    // End to end: what a URL actually delivers as `hostname` is bracketed.
    const r = await assertPublicUrl("http://[::ffff:a9fe:a9fe]/latest/meta-data/", {
      blockPrivate: true,
    });
    expect(r.ok).toBe(false);
  });

  it("still refuses non-http schemes", async () => {
    for (const u of ["file:///etc/passwd", "gopher://x/", "ftp://x/"]) {
      expect((await assertPublicUrl(u, { blockPrivate: true })).ok, u).toBe(false);
    }
  });
});

describe("resolution, not just spelling", () => {
  it("refuses a name that is statically known to be local", async () => {
    const r = await assertPublicUrl("http://localhost:11434/", { blockPrivate: true });
    expect(r.ok).toBe(false);
  });

  it("resolves the hostname and classifies what comes back", () => {
    // A MUTATION SURVIVED HERE. Replacing the lookup with an empty list broke
    // nothing, because the case above is caught by the STATIC name check before
    // DNS is ever consulted — so nothing exercised resolution at all.
    //
    // A public name whose A record points at 169.254.169.254 is the attack this
    // closes, and reproducing it needs a hostile resolver: a real DNS answer in
    // a unit test is either network-dependent or a mock of the thing under
    // test. So the two halves are checked separately — the classifier is proven
    // above against every blocked spelling, and the wiring is asserted here.
    const guard = readFileSync("src/utils/ssrfGuard.server.ts", "utf8");
    const fn = guard.slice(guard.indexOf("export async function assertPublicUrl"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("await lookup(u.hostname, { all: true })");
    // Every resolved address must go through the same classifier as the
    // hostname — not a second, weaker check.
    expect(body).toMatch(/for \(const a of addrs\)[\s\S]*classify\(a\.address\)/);
  });
});

describe("redirects are re-validated, not followed blindly", () => {
  // A public URL that 302s into a blocked range is the reason safeFetch exists,
  // and a mutation that validated only the first hop survived everything else.
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  };

  const redirectTo = (location: string): typeof fetch =>
    (async () =>
      new Response(null, { status: 302, headers: { location } })) as unknown as typeof fetch;

  it("refuses a redirect into cloud metadata", async () => {
    await withFetch(redirectTo("http://169.254.169.254/latest/meta-data/"), async () => {
      await expect(safeFetch("https://example.com/agent-card.json")).rejects.toThrow(
        /link-local|metadata/i,
      );
    });
  });

  it("refuses a redirect into a private network when the caller is strict", async () => {
    await withFetch(redirectTo("http://192.168.1.5/"), async () => {
      await expect(safeFetch("https://example.com/", { blockPrivate: true })).rejects.toThrow(
        /private|internal/i,
      );
    });
  });

  it("gives up rather than looping forever", async () => {
    await withFetch(redirectTo("https://example.com/next"), async () => {
      await expect(safeFetch("https://example.com/", { maxRedirects: 2 })).rejects.toThrow(
        /too many redirects/i,
      );
    });
  });

  it("returns a non-redirect response untouched", async () => {
    const ok = (async () => new Response("hi", { status: 200 })) as unknown as typeof fetch;
    await withFetch(ok, async () => {
      const res = await safeFetch("https://example.com/", { blockPrivate: true });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hi");
    });
  });
});

describe("a2a no longer has its own copy", () => {
  // The drift is the finding, so the test is that the duplicate is gone and
  // every outbound call goes through the guard that validates redirects.
  const src = readFileSync("src/routes/api/a2a.ts", "utf8");

  it("defines no local hostname check", () => {
    expect(src).not.toContain("function isPrivateHostname");
    expect(src, "an inline private-range table is back").not.toMatch(/a === 169 && b === 254/);
  });

  it("makes no raw fetch — every hop must be re-validated", () => {
    // `fetch(` with the default redirect policy is what let a public URL 302
    // into a blocked range.
    expect(src).not.toMatch(/[^e]await fetch\(/);
    expect(src).toContain("safeFetch(");
  });

  it("asks for the stricter policy on every call", () => {
    // Asserting `blockPrivate: true` appears SOMEWHERE was not enough — a
    // mutation that stripped it from A2A_FETCH still passed, because
    // validateRemoteUrl contains the same words. The shared options object is
    // what the fetches actually spread, so that is what gets checked.
    const opts = src.slice(
      src.indexOf("const A2A_FETCH"),
      src.indexOf("\n", src.indexOf("const A2A_FETCH")),
    );
    expect(opts).toContain("blockPrivate: true");
    const calls = src.match(/safeFetch\(/g) ?? [];
    const spreads = src.match(/\.\.\.A2A_FETCH/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(spreads.length).toBe(calls.length);
  });
});
