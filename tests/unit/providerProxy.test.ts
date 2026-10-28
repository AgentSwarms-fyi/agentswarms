// F1 (private GenAI connectivity): model calls honour the corporate proxy.
//
// HTTPS_PROXY / HTTP_PROXY / NO_PROXY were honoured by warehouse and SaaS
// connectors only; every model call went direct, so a network whose only
// egress is a proxy could reach no hosted model. These tests run a real
// forward proxy in-process (CONNECT tunnels and absolute-URI requests) in front
// of a real target server, and prove which requests went through it.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The proxy resolves names, not us: a proxy-only network often has no
// external DNS at all, so the local lookup fails and the call must still go.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.endsWith(".test")) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return [{ address: host, family: host.includes(":") ? 6 : 4 }];
  },
}));

import { runProviderTest } from "@/utils/integrations/testAdapters.server";
import { providerFetch, safeFetch, SsrfRefusedError } from "@/utils/ssrfGuard.server";

let target: http.Server;
let proxy: http.Server;
let targetPort = 0;
let proxyPort = 0;
const seen: string[] = [];

beforeAll(async () => {
  target = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "proxied-model" }], path: req.url }));
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetPort = (target.address() as AddressInfo).port;

  proxy = http.createServer((req, res) => {
    // Absolute-form request (plain-HTTP proxying): forward to the target.
    seen.push(`GET ${new URL(req.url ?? "/").host}`);
    const u = new URL(req.url ?? "/");
    const fwd = http.request(
      { host: "127.0.0.1", port: targetPort, path: u.pathname + u.search, method: req.method },
      (r2) => {
        res.writeHead(r2.statusCode ?? 502, r2.headers);
        r2.pipe(res);
      },
    );
    req.pipe(fwd);
  });
  proxy.on("connect", (req, client, head) => {
    // CONNECT tunnel: every host maps to the one target server.
    seen.push(`CONNECT ${req.url}`);
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;

  // The proxy dispatcher (and undici under it) is imported on first use,
  // inside the call. Warm it here, so a cold import under a full-suite load
  // does not spend the first test's own 20 s (it did, in R392's gate).
  await import("@/utils/http/connectorFetch.server");
  await import("undici");
}, 120_000);

afterAll(async () => {
  await new Promise((r) => target.close(r));
  await new Promise((r) => proxy.close(r));
});

afterEach(() => {
  vi.unstubAllEnvs();
  seen.length = 0;
});

function useProxyEnv(noProxy = "") {
  // Lower-case first, then upper-case: on Windows the two spellings are ONE
  // variable, so the later assignment is the one that holds.
  for (const k of ["https_proxy", "all_proxy", "http_proxy", "no_proxy"]) vi.stubEnv(k, "");
  for (const k of ["HTTPS_PROXY", "ALL_PROXY"]) vi.stubEnv(k, "");
  vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxyPort}`);
  vi.stubEnv("NO_PROXY", noProxy);
}

describe("model calls go through the proxy", () => {
  it("reaches a model server only the proxy can resolve", async () => {
    useProxyEnv();
    const res = await providerFetch(`http://models.proxy-only.test:${targetPort}/v1/models`);
    expect(res.status).toBe(200);
    expect(seen.join(" ")).toContain(`models.proxy-only.test:${targetPort}`);
  });

  it("a provider connection test does too", async () => {
    useProxyEnv();
    const r = await runProviderTest("vllm", {
      base_url: `http://models.proxy-only.test:${targetPort}/v1`,
    });
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toContain("proxied-model");
    expect(seen.join(" ")).toContain("models.proxy-only.test");
  });

  it("goes direct for a host NO_PROXY names", async () => {
    useProxyEnv("127.0.0.1");
    const res = await providerFetch(`http://127.0.0.1:${targetPort}/v1/models`);
    expect(res.status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("still refuses the metadata address before the proxy is used", async () => {
    useProxyEnv();
    await expect(providerFetch("http://169.254.169.254/latest/")).rejects.toThrow(SsrfRefusedError);
    expect(seen).toEqual([]);
  });

  it("only when asked: plain safeFetch keeps connecting directly", async () => {
    useProxyEnv();
    const res = await safeFetch(`http://127.0.0.1:${targetPort}/v1/models`);
    expect(res.status).toBe(200);
    expect(seen).toEqual([]);
  });
});
