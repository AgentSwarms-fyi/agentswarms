// Outbound HTTP for connectors: retry policy and proxy selection.
//
// The retry half is about MONEY as much as correctness. These are POSTs that
// may have already run, and every re-send of a warehouse query is billed
// again, so "retry everything" is the wrong default and the boundaries are
// worth pinning.
//
// The proxy half is about an enterprise deployment reaching the internet at
// all. Getting NO_PROXY wrong in the permissive direction sends a credential
// to a proxy the operator excluded on purpose.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  backoffMs,
  bypassesProxy,
  connectorFetch,
  isRetryableError,
  isRetryableStatus,
  proxyForUrl,
  retryAfterMs,
} from "@/utils/http/connectorFetch.server";

const PROXY_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "CONNECTOR_RETRY_500",
  "CONNECTOR_MAX_RETRIES",
  "CONNECTOR_RETRY_BASE_MS",
  "CONNECTOR_RETRY_MAX_MS",
];

function clearEnv() {
  for (const v of PROXY_VARS) delete process.env[v];
}

beforeEach(clearEnv);
afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe("what counts as worth retrying", () => {
  it("retries the statuses that mean 'rejected, come back later'", () => {
    for (const s of [408, 429, 502, 503, 504]) {
      expect(isRetryableStatus(s), `${s} should retry`).toBe(true);
    }
  });

  it("does NOT retry a 500 by default", () => {
    // A 500 usually means the request reached the backend and failed there.
    // Retrying pays for the same warehouse scan twice and rarely helps.
    expect(isRetryableStatus(500)).toBe(false);
  });

  it("retries a 500 when the operator opts in", () => {
    // Some providers return 500 for throttling.
    process.env.CONNECTOR_RETRY_500 = "1";
    expect(isRetryableStatus(500)).toBe(true);
  });

  it("never retries a plain client error", () => {
    // 401/403 is a bad credential and 404 is a bad URL; neither improves by
    // being asked again, and retrying a 401 can trip lockout policies.
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(s), `${s} must not retry`).toBe(false);
    }
  });

  it("does not retry once the caller's deadline has passed", () => {
    // Retrying past an abort ignores the timeout the caller asked for, and the
    // governor's wall-clock budget depends on that being honoured.
    expect(isRetryableError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(false);
  });

  it("retries a transport failure", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("Retry-After is obeyed when the server sends one", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterMs("2")).toBe(2000);
  });

  it("reads an HTTP date", () => {
    const ms = retryAfterMs(new Date(Date.now() + 3000).toUTCString());
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(8000);
  });

  it("never waits longer than the cap, however large the header", () => {
    // A server asking for an hour must not hang a dashboard tile for an hour.
    expect(retryAfterMs("100000")).toBe(8000);
  });

  it("falls back to backoff when absent or nonsense", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });

  it("treats a date in the past as no wait, not a negative one", () => {
    expect(retryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
});

describe("backoff", () => {
  it("grows exponentially", () => {
    // rand()=1 gives the ceiling, which is what the growth is about.
    const one = () => 0.999999;
    expect(backoffMs(0, one)).toBeLessThan(backoffMs(1, one));
    expect(backoffMs(1, one)).toBeLessThan(backoffMs(2, one));
  });

  it("is capped", () => {
    expect(backoffMs(50, () => 0.999999)).toBeLessThanOrEqual(8000);
  });

  it("uses FULL jitter, so retries do not re-collide", () => {
    // Twelve tiles hitting one rate limit retry in lockstep without jitter and
    // collide again on every attempt — the storm recreates the condition it is
    // backing off from. Full jitter means the low end reaches ~0.
    expect(backoffMs(3, () => 0)).toBe(0);
    expect(backoffMs(3, () => 0.5)).toBeGreaterThan(0);
  });
});

describe("NO_PROXY decides what bypasses the proxy", () => {
  it("bypasses everything for '*'", () => {
    expect(bypassesProxy("snowflakecomputing.com", "443", "*")).toBe(true);
  });

  it("matches a bare domain and its subdomains", () => {
    expect(bypassesProxy("internal.corp", "443", "internal.corp")).toBe(true);
    expect(bypassesProxy("db.internal.corp", "443", "internal.corp")).toBe(true);
  });

  it("matches a leading-dot entry, including the bare domain", () => {
    expect(bypassesProxy("db.internal.corp", "443", ".internal.corp")).toBe(true);
    expect(bypassesProxy("internal.corp", "443", ".internal.corp")).toBe(true);
  });

  it("does NOT match a domain that merely ends with the same letters", () => {
    // "notinternal.corp" ends with "internal.corp" as a SUBSTRING. Treating
    // that as a match would send traffic direct that the operator wanted
    // proxied — or, with the entry list reversed, leak it to a proxy.
    expect(bypassesProxy("notinternal.corp", "443", "internal.corp")).toBe(false);
  });

  it("honours a port when the entry carries one", () => {
    expect(bypassesProxy("db.corp", "5432", "db.corp:5432")).toBe(true);
    expect(bypassesProxy("db.corp", "443", "db.corp:5432")).toBe(false);
  });

  it("handles a list with spacing and mixed case", () => {
    expect(bypassesProxy("DB.Corp", "443", "foo.com, DB.corp , bar.com")).toBe(true);
  });
});

describe("choosing the proxy for a URL", () => {
  it("uses HTTPS_PROXY for https and HTTP_PROXY for http", () => {
    process.env.HTTPS_PROXY = "http://secure-proxy:8080";
    process.env.HTTP_PROXY = "http://plain-proxy:3128";
    expect(proxyForUrl(new URL("https://api.stripe.com/v1"))).toBe("http://secure-proxy:8080");
    expect(proxyForUrl(new URL("http://internal/api"))).toBe("http://plain-proxy:3128");
  });

  it("falls back to ALL_PROXY", () => {
    process.env.ALL_PROXY = "http://any-proxy:8080";
    expect(proxyForUrl(new URL("https://api.stripe.com"))).toBe("http://any-proxy:8080");
  });

  it("accepts the lower-case spellings", () => {
    // Both spellings are in real use and tools accept either.
    process.env.https_proxy = "http://lower:8080";
    expect(proxyForUrl(new URL("https://api.stripe.com"))).toBe("http://lower:8080");
  });

  it("returns null when NO_PROXY covers the host", () => {
    process.env.HTTPS_PROXY = "http://secure-proxy:8080";
    process.env.NO_PROXY = "internal.corp";
    expect(proxyForUrl(new URL("https://db.internal.corp/q"))).toBeNull();
    expect(proxyForUrl(new URL("https://api.stripe.com"))).toBe("http://secure-proxy:8080");
  });

  it("returns null when nothing is configured", () => {
    expect(proxyForUrl(new URL("https://api.stripe.com"))).toBeNull();
  });
});

describe("connectorFetch end to end", () => {
  const noSleep = () => Promise.resolve();

  it("retries a 503 and returns the eventual success", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls < 3
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await connectorFetch("https://api.example.com/q", {}, { sleepFn: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("gives up after the configured number of retries", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("busy", { status: 503 });
    });
    const res = await connectorFetch(
      "https://api.example.com/q",
      {},
      { retries: 2, sleepFn: noSleep },
    );
    // The last response is RETURNED, not thrown — the driver's own error
    // reader turns it into the provider's message.
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("does not retry a 401", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("nope", { status: 401 });
    });
    const res = await connectorFetch("https://api.example.com/q", {}, { sleepFn: noSleep });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("refuses a blocked host before any request is made", async () => {
    // SSRF: the check is on the TARGET and happens before a proxy is chosen,
    // so a proxy cannot become a route to cloud metadata.
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      connectorFetch("http://169.254.169.254/latest/meta-data/", {}, { label: "Test" }),
    ).rejects.toThrow(/blocked host/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates an abort instead of retrying past it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(
      connectorFetch("https://api.example.com/q", {}, { sleepFn: noSleep }),
    ).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });
});

describe("every outbound connector call goes through it", () => {
  // A driver still calling bare fetch silently opts out of both proxy support
  // and retry — and the symptom (works for me, times out for the customer
  // behind a proxy) is near-impossible to diagnose from a bug report.
  const files = [
    "src/utils/warehouse/drivers.server.ts",
    "src/utils/saas/googleSheets.server.ts",
    "src/utils/saas/hubspot.server.ts",
    "src/utils/saas/salesforce.server.ts",
    "src/utils/saas/shopify.server.ts",
    "src/utils/saas/stripe.server.ts",
    "src/utils/google/serviceAccount.server.ts",
  ];

  for (const f of files) {
    it(`${f.split("/").pop()} uses no bare fetch`, () => {
      const src = readFileSync(f, "utf8");
      // Negative lookbehind so `connectorFetch(` and `res.fetch(` do not match.
      expect(src).not.toMatch(/(?<![.\w])fetch\(/);
      expect(src).toContain("connectorFetch");
    });
  }
});
