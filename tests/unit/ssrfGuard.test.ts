// The SSRF guard.
//
// This decides whether a server-side fetch may proceed to a URL that a user —
// or, through the web_browse tool and prompt injection, a MODEL — supplied. It
// runs inside the deployment's network, so the thing it is holding back is a
// request to 169.254.169.254, which on every major cloud will hand over the
// host's IAM credentials.
//
// It had no tests. The checks below are the static ones: assertPublicUrl also
// resolves the hostname and re-checks every resulting IP, but that step is a
// SECOND line of defence and cannot be the only one — it swallows resolution
// failures and allows, so anything the static check misses is reachable
// whenever DNS misbehaves.

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPublicUrl,
  isBlockedAlways,
  isPrivateAddress,
  isPrivateNetwork,
} from "@/utils/ssrfGuard.server";

describe("isBlockedAlways — never fetchable, whatever the policy", () => {
  it("blocks cloud instance metadata", () => {
    // The single most valuable SSRF target in existence.
    expect(isBlockedAlways("169.254.169.254")).toBe(true);
    expect(isBlockedAlways("fd00:ec2::254")).toBe(true); // AWS IMDS over IPv6
  });

  it("blocks the rest of link-local", () => {
    expect(isBlockedAlways("169.254.1.1")).toBe(true);
    expect(isBlockedAlways("fe80::1")).toBe(true);
  });

  it("blocks the unspecified address and 0.0.0.0/8", () => {
    // 0.0.0.0 reaches localhost on Linux.
    expect(isBlockedAlways("0.0.0.0")).toBe(true);
    expect(isBlockedAlways("::")).toBe(true);
    expect(isBlockedAlways("0.1.2.3")).toBe(true);
  });

  it("blocks multicast and reserved", () => {
    expect(isBlockedAlways("224.0.0.1")).toBe(true);
    expect(isBlockedAlways("255.255.255.255")).toBe(true);
  });

  it("blocks an IPv4-mapped IPv6 metadata address in BOTH spellings", () => {
    // The compressed hex form is the same address and used to pass every
    // static check, surviving only because the resolver happened to hand back
    // the dotted form. assertPublicUrl allows a URL whose lookup FAILS, so
    // that made a failing resolver into a reachable metadata endpoint.
    expect(isBlockedAlways("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAlways("::ffff:a9fe:a9fe")).toBe(true);
    expect(isBlockedAlways("::FFFF:A9FE:A9FE")).toBe(true);
  });

  it("does not block ordinary public addresses", () => {
    expect(isBlockedAlways("1.1.1.1")).toBe(false);
    expect(isBlockedAlways("example.com")).toBe(false);
    // 128.128.128.128 — mapped, but genuinely public.
    expect(isBlockedAlways("::ffff:8080:8080")).toBe(false);
  });

  it("blocks an empty host rather than treating it as harmless", () => {
    expect(isBlockedAlways("")).toBe(true);
  });
});

describe("isPrivateNetwork — allowed by default, refusable by policy", () => {
  it("recognises loopback and RFC1918", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "::1"]) {
      expect(isPrivateNetwork(h), h).toBe(true);
    }
  });

  it("recognises CGNAT and IPv6 ULA", () => {
    expect(isPrivateNetwork("100.64.0.1")).toBe(true);
    expect(isPrivateNetwork("fc00::1")).toBe(true);
  });

  it("recognises the mapped hex form of private ranges too", () => {
    expect(isPrivateNetwork("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateNetwork("::ffff:a00:1")).toBe(true); // 10.0.0.1
    expect(isPrivateNetwork("::ffff:c0a8:1")).toBe(true); // 192.168.0.1
  });

  it("does not treat 172.32/172.15 as private — the /12 boundary", () => {
    // Off-by-one here either blocks a legitimate host or exposes one.
    expect(isPrivateNetwork("172.15.0.1")).toBe(false);
    expect(isPrivateNetwork("172.32.0.1")).toBe(false);
    expect(isPrivateNetwork("172.31.255.255")).toBe(true);
  });

  it("does not treat public addresses as private", () => {
    for (const h of ["8.8.8.8", "1.1.1.1", "example.com"]) {
      expect(isPrivateNetwork(h), h).toBe(false);
    }
  });
});

describe("isPrivateAddress covers both tiers", () => {
  it("is true for always-blocked and for private", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  afterEach(() => {
    delete process.env.BLOCK_PRIVATE_NETWORK_FETCH;
    delete process.env.ALLOW_PRIVATE_NETWORK_FETCH;
  });

  it("refuses non-http schemes", async () => {
    // file:// would read the server's disk; gopher:// is a classic pivot.
    for (const u of ["file:///etc/passwd", "gopher://x/", "ftp://x/"]) {
      const r = await assertPublicUrl(u);
      expect(r.ok, u).toBe(false);
    }
  });

  it("refuses a malformed URL", async () => {
    expect((await assertPublicUrl("not a url")).ok).toBe(false);
  });

  it("refuses metadata however the address is written", async () => {
    // The URL parser normalises decimal/octal/hex to dotted quad, so these all
    // reduce to the same host — worth pinning, because it is the parser doing
    // the work and a change of parser would silently reopen them.
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://0251.0376.0251.0376/",
      "http://0xA9FEA9FE/",
      "http://169.254.169.254./",
      "http://[::ffff:169.254.169.254]/",
      "http://[fd00:ec2::254]/",
    ]) {
      const r = await assertPublicUrl(u);
      expect(r.ok, u).toBe(false);
    }
  });

  it("allows a private host by default — self-hosted Ollama and friends", async () => {
    expect((await assertPublicUrl("http://127.0.0.1:11434/api/tags")).ok).toBe(true);
  });

  it("refuses private hosts when the operator opts in", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    const r = await assertPublicUrl("http://10.0.0.5/internal");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/BLOCK_PRIVATE_NETWORK_FETCH/);
  });

  it("ALLOW_ overrides BLOCK_ for backward compatibility", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
    expect((await assertPublicUrl("http://10.0.0.5/")).ok).toBe(true);
  });

  it("still refuses metadata even when private networks are allowed", async () => {
    // The two tiers must stay separate: opting into private networks must not
    // opt into the credential endpoint.
    process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
    expect((await assertPublicUrl("http://169.254.169.254/")).ok).toBe(false);
  });
});
