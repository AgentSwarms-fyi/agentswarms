// The loopback fallback for the app's calls to itself names the port the
// server actually listens on.
//
// FOUND IN R485: resolveInternalOrigin() fell back to a fixed
// http://127.0.0.1:8080, on the reasoning that "the server never reads PORT".
// server.mjs has read PORT since it replaced `vite preview`, so a platform
// that sets PORT (Render, Fly, Heroku style) got a server on that port and
// every self-call (deployed and scheduled swarm runs, evals, channels) sent
// to 8080, where nothing listens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveInternalOrigin } from "@/utils/internalOrigin.server";

beforeEach(() => {
  for (const v of ["PUBLIC_APP_URL", "SITE_URL", "PORT"]) vi.stubEnv(v, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveInternalOrigin's loopback fallback", () => {
  it("is port 8080 when PORT is not set, as server.mjs defaults", () => {
    expect(resolveInternalOrigin()).toBe("http://127.0.0.1:8080");
  });

  it("follows PORT, the variable server.mjs listens on", () => {
    vi.stubEnv("PORT", "10000");
    // Before R486: http://127.0.0.1:8080.
    expect(resolveInternalOrigin()).toBe("http://127.0.0.1:10000");
  });

  it("treats an empty PORT as unset, as server.mjs does", () => {
    vi.stubEnv("PORT", "");
    expect(resolveInternalOrigin()).toBe("http://127.0.0.1:8080");
  });

  it("keeps 8080 for a PORT that is not a port number", () => {
    for (const bad of ["abc", "0", "70000", "80.5", "-1"]) {
      vi.stubEnv("PORT", bad);
      expect(resolveInternalOrigin(), bad).toBe("http://127.0.0.1:8080");
    }
  });

  it("still prefers PUBLIC_APP_URL, then SITE_URL, over any port", () => {
    vi.stubEnv("PORT", "10000");
    vi.stubEnv("SITE_URL", "https://site.example.com/");
    expect(resolveInternalOrigin()).toBe("https://site.example.com");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.example.com");
    expect(resolveInternalOrigin()).toBe("https://app.example.com");
  });

  it("reads PORT the same way server.mjs does", async () => {
    // The two must not drift apart: if server.mjs stops reading PORT, or
    // reads another variable, this fallback is wrong again.
    const { readFileSync } = await import("node:fs");
    const server = readFileSync("server.mjs", "utf8");
    expect(server).toContain("const PORT = Number(process.env.PORT || 8080);");
  });
});
