// Server functions refuse calls from other sites (R359).
//
// FOUND IN R359. With a start instance (src/start.ts) that sets no
// requestMiddleware, TanStack Start applies no CSRF check to server functions;
// it does so only when there is no start instance. Its warning about that
// prints only outside production, so the container never said. A POST to a
// /_serverFn/ id with `Sec-Fetch-Site: cross-site` and `Origin:
// https://evil.example` reached the function, the same as a same-origin one.
// start.ts now registers TanStack's own createCsrfMiddleware for server
// functions. These pin the verdicts that middleware gives, and its wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCsrfRequestAllowed } from "@tanstack/start-client-core";

const request = (headers: Record<string, string>) =>
  new Request("http://localhost:8080/_serverFn/abc", { method: "POST", headers });
const allowed = (headers: Record<string, string>) =>
  isCsrfRequestAllowed({}, { request: request(headers) } as never);

describe("what the middleware lets through", () => {
  it("a browser call from the app's own pages", async () => {
    expect(await allowed({ "Sec-Fetch-Site": "same-origin" })).toBe(true);
    expect(await allowed({ Origin: "http://localhost:8080" })).toBe(true);
    expect(await allowed({ Referer: "http://localhost:8080/traces" })).toBe(true);
  });

  it("not a call from another site", async () => {
    expect(await allowed({ "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" })).toBe(
      false,
    );
    expect(await allowed({ Origin: "https://evil.example" })).toBe(false);
    expect(await allowed({ Referer: "https://evil.example/page" })).toBe(false);
  });

  it("nor one that says nothing about where it came from", async () => {
    expect(await allowed({})).toBe(false);
  });
});

describe("the start instance", () => {
  const START = readFileSync("src/start.ts", "utf8");

  it("registers the CSRF middleware for server functions", () => {
    expect(START).toMatch(
      /const csrfMiddleware = createCsrfMiddleware\(\{\s*filter: \(ctx\) => ctx\.handlerType === "serverFn",\s*\}\);/,
    );
    expect(START).toContain("requestMiddleware: [csrfMiddleware],");
  });
});
