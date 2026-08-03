// The address an MCP key's IP allow-list is checked against.
//
// utils/requestMeta.server derives a client IP from the LEFT-most entry of
// X-Forwarded-For, and says so in its own header: these are "forensic hints —
// never an access-control input". Its three callers obey that. The public MCP
// route carried a private copy of the same left-most logic and fed it directly
// to `ips.includes(...)`.
//
// X-Forwarded-For is appended to, not overwritten. A caller who sends
// `X-Forwarded-For: <permitted address>` has a proxy append the real peer after
// it, so reading `[0]` returns the caller's own choice. Anyone holding a leaked
// key defeated its allow-list with one header — the control worked only against
// callers who did not try.
import { describe, expect, it } from "vitest";

import { clientIp } from "@/routes/api/mcp.s.$slug";

const req = (xff?: string, extra: Record<string, string> = {}) =>
  new Request("https://example.test/api/mcp/s/demo", {
    headers: { ...(xff === undefined ? {} : { "x-forwarded-for": xff }), ...extra },
  });

describe("a caller cannot choose its own address", () => {
  it("ignores the entry the caller supplied and takes the peer the proxy appended", () => {
    // THE BYPASS. "203.0.113.10" is what the attacker sent; "198.51.100.66" is
    // where the request actually came from.
    expect(clientIp(req("203.0.113.10, 198.51.100.66"))).toBe("198.51.100.66");
  });

  it("still reports the real address for an honest caller", () => {
    // Nothing forged: the proxy appended the only entry there is.
    expect(clientIp(req("203.0.113.10"))).toBe("203.0.113.10");
  });

  it("is not fooled by a long forged chain", () => {
    expect(clientIp(req("1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.66"))).toBe("198.51.100.66");
  });

  it("ignores X-Real-IP entirely", () => {
    // nginx overwrites X-Real-IP, but Caddy — the proxy in our own deployment
    // guide — does not set it at all, so a caller's own value would arrive
    // untouched. Consulting it would reopen the bypass on the documented setup.
    expect(clientIp(req("198.51.100.66", { "x-real-ip": "203.0.113.10" }))).toBe("198.51.100.66");
    expect(clientIp(req(undefined, { "x-real-ip": "203.0.113.10" }))).toBe("");
  });
});

describe("no proxy means nothing to verify", () => {
  it("returns empty when the header is absent, which no allow-list contains", () => {
    // Fail closed: an allow-list with entries refuses a request whose address
    // cannot be established.
    expect(clientIp(req())).toBe("");
    expect(["203.0.113.10"].includes(clientIp(req()))).toBe(false);
  });

  it("returns empty for a header that is present but empty or punctuation", () => {
    expect(clientIp(req(""))).toBe("");
    expect(clientIp(req("   "))).toBe("");
    expect(clientIp(req(",,,"))).toBe("");
  });
});

describe("shapes a proxy actually emits", () => {
  it("tolerates the spacing variations in the wild", () => {
    for (const xff of [
      "203.0.113.10,198.51.100.66",
      "203.0.113.10 , 198.51.100.66",
      "  203.0.113.10,   198.51.100.66  ",
    ]) {
      expect(clientIp(req(xff)), xff).toBe("198.51.100.66");
    }
  });

  it("survives a trailing comma or a blank entry mid-chain", () => {
    // ADDED BECAUSE A MUTATION SURVIVED: dropping .filter(Boolean) broke none
    // of the cases above, because they all still resolved to "". This is where
    // it bites — a trailing comma makes the LAST entry empty, so counting from
    // the right lands on nothing and a legitimate caller is refused. Fail-closed
    // is right when the address is unknown, not when the header merely has
    // untidy punctuation.
    expect(clientIp(req("198.51.100.66,"))).toBe("198.51.100.66");
    expect(clientIp(req("203.0.113.10, , 198.51.100.66"))).toBe("198.51.100.66");
    expect(clientIp(req(", 198.51.100.66"))).toBe("198.51.100.66");
  });

  it("handles IPv6, including the mapped form", () => {
    expect(clientIp(req("2001:db8::1, 2001:db8::99"))).toBe("2001:db8::99");
    expect(clientIp(req("::ffff:198.51.100.66"))).toBe("::ffff:198.51.100.66");
  });

  it("clamps an absurdly long entry rather than storing it whole", () => {
    expect(clientIp(req(`1.1.1.1, ${"9".repeat(500)}`)).length).toBeLessThanOrEqual(64);
  });
});

describe("the hop count cannot be pushed past the end of the list", () => {
  it("never reads left of the list even if TRUSTED_PROXY_HOPS is too high", async () => {
    // Misconfiguring hops higher than the real chain must not walk back into
    // caller-supplied entries — it is clamped to the list length, so the worst
    // case is the left-most entry of a chain the proxy itself produced.
    const prev = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = "99";
    try {
      expect(clientIp(req("203.0.113.10, 198.51.100.66"))).toBe("203.0.113.10");
      expect(clientIp(req("198.51.100.66"))).toBe("198.51.100.66");
    } finally {
      if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = prev;
    }
  });
});
