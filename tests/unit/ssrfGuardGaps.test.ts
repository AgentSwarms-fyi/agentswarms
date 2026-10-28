// R395 (VA-2026-10-25-21): three gaps in the SSRF guard.
//
//   1. Only the fe80: prefix of IPv6 link-local fe80::/10 was refused (fe90::
//      through febf:: passed), IPv6 multicast was not refused at all, and an
//      IPv4 address carried inside IPv6 (NAT64 64:ff9b::, IPv4-compatible ::,
//      6to4 2002::) was read as an ordinary IPv6 address.
//   2. A URL whose DNS lookup FAILED was allowed — fetch() then resolved it
//      again, so a resolver that failed the check's query and answered the
//      connection's with 169.254.169.254 walked through.
//   3. DNS rebinding between the check and the connection: the check resolved,
//      fetch() resolved again. A direct connection is now pinned to the
//      addresses the check accepted.
import { createServer, type Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
  answers: {} as Record<string, string[]>,
  failures: {} as Record<string, string>,
  queries: [] as string[],
}));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    dns.queries.push(host);
    if (isIP(host)) return [{ address: host, family: isIP(host) }];
    const code = dns.failures[host];
    if (code) throw Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
    const a = dns.answers[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: isIP(address) }));
  },
}));

import { describeFetchFailure } from "@/lib/fetchFailure";
import { isRetryableError } from "@/utils/http/connectorFetch.server";
import {
  assertPublicUrl,
  HostNotResolvedError,
  isBlockedAlways,
  isPrivateNetwork,
  PrivatePathRequiredError,
  providerFetch,
  safeFetch,
  SsrfRefusedError,
  withPrivatePathScope,
} from "@/utils/ssrfGuard.server";

function noProxy() {
  for (const k of ["https_proxy", "http_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(k, "");
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) vi.stubEnv(k, "");
}

beforeAll(async () => {
  // undici and the proxy layer load on first use; not inside a test's budget.
  await import("undici");
}, 120_000);

beforeEach(() => {
  for (const k of Object.keys(dns.answers)) delete dns.answers[k];
  for (const k of Object.keys(dns.failures)) delete dns.failures[k];
  dns.queries.length = 0;
  noProxy();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the always-blocked tier covers whole ranges", () => {
  it("all of IPv6 link-local fe80::/10, not only fe80:", () => {
    for (const h of ["fe80::1", "fe90::1", "fea0::a9fe", "febf:ffff::1", "[fe9a::1]"]) {
      expect(isBlockedAlways(h), h).toBe(true);
    }
    // The edges of the range: fec0:: is past it (site-local, below).
    expect(isBlockedAlways("fec0::1")).toBe(false);
    expect(isBlockedAlways("fe7f::1")).toBe(false);
  });

  it("IPv6 multicast ff00::/8", () => {
    for (const h of ["ff02::1", "ff05::2", "ff0e::1", "ffff::1"]) {
      expect(isBlockedAlways(h), h).toBe(true);
    }
  });

  it("an IPv4 address carried inside IPv6, in the hex form the URL parser writes", () => {
    // What a URL hostname actually holds: WHATWG serialises the dotted tail
    // to hex, so this is the form the static check sees.
    const forms = {
      mapped: new URL("http://[::ffff:169.254.169.254]/").hostname,
      nat64: new URL("http://[64:ff9b::169.254.169.254]/").hostname,
      compatible: new URL("http://[::169.254.169.254]/").hostname,
      sixToFour: new URL("http://[2002:a9fe:a9fe::1]/").hostname,
    };
    expect(forms.nat64).toBe("[64:ff9b::a9fe:a9fe]");
    expect(forms.compatible).toBe("[::a9fe:a9fe]");
    for (const [name, h] of Object.entries(forms)) {
      expect(isBlockedAlways(h), name).toBe(true);
    }
    // Ordinary IPv6 is not mistaken for one.
    expect(isBlockedAlways("2001:db8::a9fe:a9fe")).toBe(false);
    expect(isBlockedAlways("2606:4700::1111")).toBe(false);
  });

  it("an embedded private IPv4 address is private", () => {
    expect(isPrivateNetwork(new URL("http://[64:ff9b::10.0.0.5]/").hostname)).toBe(true);
    expect(isPrivateNetwork(new URL("http://[2002:c0a8:0101::]/").hostname)).toBe(true);
    // Site-local fec0::/10 (deprecated, still routed internally).
    expect(isPrivateNetwork("fec0::1")).toBe(true);
    expect(isPrivateNetwork("2001:db8::1")).toBe(false);
  });

  it("the guard refuses those URLs before any lookup or connection", async () => {
    for (const raw of [
      "http://[fe90::1]/",
      "http://[ff02::1]/",
      "http://[64:ff9b::169.254.169.254]/latest/meta-data/",
      "http://[2002:a9fe:a9fe::]/",
    ]) {
      const r = await assertPublicUrl(raw);
      expect(r.ok, raw).toBe(false);
    }
    expect(dns.queries).toEqual([]);
  });

  it("and a name that resolves into them", async () => {
    dns.answers["ll.attacker.test"] = ["fe90::1"];
    dns.answers["nat64.attacker.test"] = ["64:ff9b::a9fe:a9fe"];
    for (const raw of ["http://ll.attacker.test/", "http://nat64.attacker.test/"]) {
      const r = await assertPublicUrl(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/link-local|metadata/i);
    }
  });
});

describe("a name that does not resolve is refused, unless the proxy resolves it", () => {
  it("assertPublicUrl fails closed and says why", async () => {
    const r = await assertPublicUrl("https://nowhere.attacker.test/");
    expect(r).toMatchObject({
      ok: false,
      unresolved: { host: "nowhere.attacker.test", code: "ENOTFOUND" },
    });
    if (!r.ok) expect(r.error).toMatch(/does not resolve from this server/);
  });

  it("keeps the resolver's own code (a transient EAI_AGAIN)", async () => {
    dns.failures["flaky.test"] = "EAI_AGAIN";
    const r = await assertPublicUrl("https://flaky.test/");
    expect(r).toMatchObject({ ok: false, unresolved: { code: "EAI_AGAIN" } });
  });

  it("passes when the caller says the name is resolved elsewhere", async () => {
    const r = await assertPublicUrl("https://nowhere.attacker.test/", { resolvedElsewhere: true });
    expect(r).toMatchObject({ ok: true, addresses: [] });
  });

  it("when nothing is said, passes only if the proxy applies to that URL", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp.test:3128");
    expect((await assertPublicUrl("https://nowhere.attacker.test/")).ok).toBe(true);
    // NO_PROXY sends it direct, where it must resolve here.
    vi.stubEnv("NO_PROXY", ".attacker.test");
    expect((await assertPublicUrl("https://nowhere.attacker.test/")).ok).toBe(false);
  });

  it("an IPv6 literal resolves to itself (brackets are not part of the name)", async () => {
    const r = await assertPublicUrl("http://[::1]:8080/");
    expect(r).toMatchObject({ ok: true, addresses: [{ address: "::1", family: 6 }] });
  });
});

describe("safeFetch: the fail-closed lookup, as callers see it", () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; dispatcher: unknown }[] = [];
  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher,
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends nothing, and throws a network failure rather than a refusal", async () => {
    const err = await safeFetch("https://nowhere.attacker.test/v1").catch((e) => e);
    expect(err).toBeInstanceOf(HostNotResolvedError);
    expect(err).not.toBeInstanceOf(SsrfRefusedError);
    expect(calls).toEqual([]);
    // Retried like the fetch failure it replaces (a later attempt resolves
    // and checks again), and described in the same words.
    expect(isRetryableError(err)).toBe(true);
    expect(describeFetchFailure(err, "https://nowhere.attacker.test/v1")).toBe(
      "https://nowhere.attacker.test could not be reached: its host name does not resolve",
    );
  });

  it("a redirect into a name that does not resolve stops there", async () => {
    dns.answers["relay.test"] = ["93.184.216.34"];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input), dispatcher: undefined });
      return new Response(null, {
        status: 302,
        headers: { location: "http://rebind.attacker.test/latest/meta-data/" },
      });
    }) as typeof fetch;
    await expect(safeFetch("https://relay.test/")).rejects.toThrow(HostNotResolvedError);
    expect(calls.map((c) => c.url)).toEqual(["https://relay.test/"]);
  });

  it("a proxied model call is sent: the proxy resolves the name", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp.test:3128");
    const res = await providerFetch("https://nowhere.attacker.test/v1/models");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher?.constructor?.name).toBe("ProxyAgent");
  });

  it("a caller's own (proxy) dispatcher is kept, not replaced by a pin", async () => {
    // connectorFetch hands safeFetch its proxy agent. Whether or not the name
    // also resolves here, the request must leave through that proxy.
    const mine = { mine: true };
    await safeFetch("https://nowhere.attacker.test/", { dispatcher: mine } as RequestInit);
    dns.answers["warehouse.vendor.test"] = ["93.184.216.34"];
    await safeFetch("https://warehouse.vendor.test/", { dispatcher: mine } as RequestInit);
    expect(calls.map((c) => c.dispatcher)).toEqual([mine, mine]);
  });

  it("a direct hop gets a pinned dispatcher", async () => {
    dns.answers["api.vendor.test"] = ["93.184.216.34"];
    await safeFetch("https://api.vendor.test/");
    expect(calls[0].dispatcher?.constructor?.name).toBe("Agent");
  });

  it("a provider that requires a private path: an unresolved name is that refusal, audited", async () => {
    const refused: string[] = [];
    const err = await withPrivatePathScope(async (policy) => {
      policy.required = true;
      policy.label = "AWS Bedrock";
      policy.onRefuse = (d) => refused.push(d);
      return providerFetch("https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke");
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PrivatePathRequiredError);
    expect(err.message).toMatch(/AWS Bedrock is set to require a private network path/);
    expect(err.message).toMatch(/does not resolve/);
    expect(refused).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("and is judged on the addresses the connection is pinned to (one lookup per hop)", async () => {
    dns.answers["bedrock-runtime.us-east-1.amazonaws.com"] = ["10.1.2.3"];
    await withPrivatePathScope(async (policy) => {
      policy.required = true;
      return providerFetch("https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke");
    });
    expect(calls).toHaveLength(1);
    expect(dns.queries).toEqual(["bedrock-runtime.us-east-1.amazonaws.com"]);
  });
});

describe("a direct connection goes to the address the check accepted (DNS rebinding)", () => {
  // A real server and the real fetch. `pinned.test` exists only in the mocked
  // resolver the CHECK uses; the operating system has never heard of it. So a
  // request that arrives proves the connection used the checked address and
  // did not resolve the name a second time.
  let server: Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      if (req.url === "/hop") {
        res.writeHead(302, { location: `http://second.test:${port}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seen.length = 0;
  });

  it("connects to the checked address under the original name", async () => {
    dns.answers["pinned.test"] = ["127.0.0.1"];
    const res = await safeFetch(`http://pinned.test:${port}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pinned");
    // The Host header is still the name (virtual hosts and TLS SNI rely on it).
    expect(seen).toEqual([`pinned.test:${port} /hello`]);
    // One resolution: the check's. The connection asked nobody.
    expect(dns.queries).toEqual(["pinned.test"]);
  });

  it("holds with address-family racing off too (the connection asks for one address)", async () => {
    // net.connect asks the lookup for a list when it races IPv4 against IPv6
    // and for a single address when it does not; both answers are pinned.
    const net = await import("node:net");
    const before = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(false);
    try {
      dns.answers["single.test"] = ["127.0.0.1"];
      const res = await safeFetch(`http://single.test:${port}/one`);
      expect(await res.text()).toBe("pinned");
      expect(seen).toEqual([`single.test:${port} /one`]);
    } finally {
      net.setDefaultAutoSelectFamily(before);
    }
  });

  it("pins every redirect hop to that hop's own checked address", async () => {
    dns.answers["first.test"] = ["127.0.0.1"];
    dns.answers["second.test"] = ["127.0.0.1"];
    const res = await safeFetch(`http://first.test:${port}/hop`);
    expect(await res.text()).toBe("pinned");
    expect(seen).toEqual([`first.test:${port} /hop`, `second.test:${port} /landed`]);
    expect(dns.queries).toEqual(["first.test", "second.test"]);
  });

  it("a name the check refused is never connected to, whatever the OS would answer", async () => {
    // `localhost` resolves to the server for the OS; the check's resolver says
    // metadata. The check's answer is the one that counts.
    dns.answers["localhost"] = ["169.254.169.254"];
    await expect(safeFetch(`http://localhost:${port}/`)).rejects.toThrow(SsrfRefusedError);
    expect(seen).toEqual([]);
  });
});
