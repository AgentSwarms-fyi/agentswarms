// The hosts a shared secret may be sent to (R419, VA-2026-10-25-30): how an
// owner's list is read, and how a destination is matched against it. The
// Secrets editor and the server use these same functions.
import { describe, expect, it } from "vitest";

import {
  hostAllowed,
  hostOf,
  MAX_ALLOWED_HOSTS,
  parseAllowedHost,
  parseAllowedHosts,
  sharedUseNote,
} from "@/lib/secretHosts";

describe("hostOf reads the host a request goes to", () => {
  it("from a URL, a host:port or a bare host, normalised", () => {
    expect(hostOf("https://API.OpenAI.com/v1/chat")).toBe("api.openai.com");
    expect(hostOf("postgres://u:p@db.internal:5432/app")).toBe("db.internal");
    expect(hostOf("acme.snowflakecomputing.com:443")).toBe("acme.snowflakecomputing.com");
    expect(hostOf("example.com.")).toBe("example.com");
    expect(hostOf("[::1]:8080")).toBe("::1");
    expect(hostOf("10.0.0.5")).toBe("10.0.0.5");
    // An international name compares as punycode, the form DNS and TLS use.
    expect(hostOf("https://bücher.example/")).toBe("xn--bcher-kva.example");
  });

  it("the userinfo trick does not change the host", () => {
    // `https://api.openai.com@evil.test` goes to evil.test.
    expect(hostOf("https://api.openai.com@evil.test/")).toBe("evil.test");
  });

  it("refuses what is not a host", () => {
    for (const bad of ["", "   ", "http://", "not a host", "https://exa mple.com", "a..b"]) {
      expect(hostOf(bad), bad).toBeNull();
    }
  });
});

describe("an owner's list", () => {
  it("keeps hosts and wildcards, and reduces a URL to its host", () => {
    expect(parseAllowedHost("api.openai.com")).toEqual({ ok: true, host: "api.openai.com" });
    expect(parseAllowedHost("*.snowflakecomputing.com")).toEqual({
      ok: true,
      host: "*.snowflakecomputing.com",
    });
    expect(parseAllowedHost("https://Api.Stripe.com/v1")).toEqual({
      ok: true,
      host: "api.stripe.com",
    });
  });

  it("refuses a wildcard that would match a whole top-level domain, or sits mid-name", () => {
    expect(parseAllowedHost("*.com")).toMatchObject({ ok: false });
    expect(parseAllowedHost("*")).toMatchObject({ ok: false });
    expect(parseAllowedHost("api.*.example.com")).toMatchObject({ ok: false });
    expect(parseAllowedHost("*.10.0.0.5")).toMatchObject({ ok: false });
    expect(parseAllowedHost("")).toMatchObject({ ok: false });
  });

  it("deduplicates, skips blank lines, names the first bad entry, and is bounded", () => {
    expect(parseAllowedHosts(["a.example.com", "", "A.example.com", "b.example.com"])).toEqual({
      ok: true,
      hosts: ["a.example.com", "b.example.com"],
    });
    const bad = parseAllowedHosts(["ok.example.com", "*.com"]);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/\*\.com/);
    const many = Array.from({ length: MAX_ALLOWED_HOSTS + 1 }, (_, i) => `h${i}.example.com`);
    expect(parseAllowedHosts(many).ok).toBe(false);
  });
});

describe("matching a destination", () => {
  const allowed = ["api.openai.com", "*.snowflakecomputing.com"];

  it("an exact entry matches that host only", () => {
    expect(hostAllowed("https://api.openai.com/v1", allowed)).toBe(true);
    expect(hostAllowed("api.openai.com.evil.test", allowed)).toBe(false);
    expect(hostAllowed("evilapi.openai.com", allowed)).toBe(false);
  });

  it("a wildcard matches names under the domain, not the domain itself", () => {
    expect(hostAllowed("acme.snowflakecomputing.com", allowed)).toBe(true);
    expect(hostAllowed("a.b.snowflakecomputing.com", allowed)).toBe(true);
    expect(hostAllowed("snowflakecomputing.com", allowed)).toBe(false);
    expect(hostAllowed("evilsnowflakecomputing.com", allowed)).toBe(false);
  });

  it("a destination that does not parse, or an empty list, never matches", () => {
    expect(hostAllowed("not a host", allowed)).toBe(false);
    expect(hostAllowed("api.openai.com", [])).toBe(false);
    expect(hostAllowed("https://api.openai.com@evil.test", allowed)).toBe(false);
  });
});

describe("the words shown next to a secret", () => {
  it("names the hosts, or says nobody else can use it", () => {
    expect(sharedUseNote(["a.example.com", "b.example.com"])).toBe(
      "May be sent to a.example.com, b.example.com",
    );
    expect(sharedUseNote([])).toMatch(/cannot use it/);
    expect(sharedUseNote(undefined)).toMatch(/cannot use it/);
  });
});
