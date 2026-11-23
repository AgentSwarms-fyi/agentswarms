// The engine behind "Any REST API" (R528), against a faked network: where it
// stops, what it refuses, where the credential goes; and the wiring that makes
// it one more app source.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  respond: (() => new Response("[]")) as (url: string) => Response,
  requests: [] as Array<{ url: string; headers: Record<string, string> }>,
}));

vi.mock("@/utils/http/connectorFetch.server", () => ({
  connectorFetch: async (url: string, init: { headers?: Record<string, string> }) => {
    net.requests.push({ url, headers: init.headers ?? {} });
    return net.respond(url);
  },
}));

const { fetchRestRows, listRestStreams, restIncremental, specOf } =
  await import("@/utils/saas/restApi.server");

const spec = (over: Record<string, unknown> = {}, stream: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    name: "Shop",
    base_url: "https://api.shop.example/v1",
    auth: { kind: "bearer" },
    streams: [{ id: "orders", label: "Orders", path: "/orders", records: "data", ...stream }],
    ...over,
  });
const cfg = (s: string, credential = "tok") => ({
  provider: "rest_api" as const,
  spec: s,
  credential,
});
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

async function rows(s: string, credential = "tok") {
  const out: Record<string, unknown>[] = [];
  for await (const r of fetchRestRows(cfg(s, credential), "orders")) out.push(r);
  return out;
}

beforeEach(() => {
  net.requests = [];
  net.respond = () => json({ data: [] });
});

describe("reading", () => {
  it("pages until the API says it is done, flattening each record", async () => {
    let page = 0;
    net.respond = () =>
      json({ data: page++ === 0 ? [{ id: 1, customer: { name: "Ada" } }] : [], next: null });
    const s = spec({}, { pagination: { kind: "page", param: "page" } });
    const got = await rows(s);
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0])).toContain("id");
    expect(net.requests.map((r) => new URL(r.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(net.requests[0].headers.Authorization).toBe("Bearer tok");
  });

  it("stops at a page the API hands back twice, and says so", async () => {
    net.respond = () => json({ data: [{ id: 1 }], meta: { next: "same" } });
    const s = spec({}, { pagination: { kind: "cursor", param: "after", next_path: "meta.next" } });
    await expect(rows(s)).rejects.toThrow("the API returned the same next page twice");
    expect(net.requests).toHaveLength(2);
  });

  it("stops at max_pages rather than returning a short dataset quietly", async () => {
    let n = 0;
    net.respond = () => json({ data: [{ id: n }], meta: { next: `c${n++}` } });
    const s = spec(
      { max_pages: 3 },
      { pagination: { kind: "cursor", param: "after", next_path: "meta.next" } },
    );
    await expect(rows(s)).rejects.toThrow("orders has more than 3 pages");
    expect(net.requests).toHaveLength(3);
  });

  it("never follows a next page to another host", async () => {
    net.respond = () =>
      json({ data: [{ id: 1 }] }, { link: '<https://evil.example/orders?page=2>; rel="next"' });
    const s = spec({}, { pagination: { kind: "link_header" } });
    await expect(rows(s)).rejects.toThrow("not https://api.shop.example; it was not followed");
    expect(net.requests.every((r) => r.url.startsWith("https://api.shop.example/"))).toBe(true);
  });

  it("says what went wrong in the API's own terms", async () => {
    net.respond = () => new Response("nope", { status: 401 });
    await expect(rows(spec())).rejects.toThrow("the API refused the credential (401)");
    net.respond = () => new Response("missing", { status: 404 });
    await expect(rows(spec())).rejects.toThrow("/v1/orders was not found (404)");
    net.respond = () => new Response("<html>", { status: 200 });
    await expect(rows(spec())).rejects.toThrow("did not answer with JSON");
    net.respond = () => json({ results: [] });
    await expect(rows(spec())).rejects.toThrow(
      'There is no list at "data" in the response (it has: results)',
    );
  });

  it("asks for a key the API needs, and sends none where auth is optional and there is none", async () => {
    await expect(rows(spec(), "")).rejects.toThrow("this API needs a key or token");
    expect(net.requests).toHaveLength(0);
    await rows(spec({ auth: { kind: "bearer", optional: true } }), "");
    expect(net.requests[0].headers.Authorization).toBeUndefined();
  });

  it("puts a query credential in the request and basic auth in the header", async () => {
    await rows(spec({ auth: { kind: "query", param: "api_token" } }));
    expect(new URL(net.requests[0].url).searchParams.get("api_token")).toBe("tok");
    net.requests = [];
    await rows(spec({ auth: { kind: "basic", username: "anystring", password: "{credential}" } }));
    expect(net.requests[0].headers.Authorization).toBe(
      `Basic ${Buffer.from("anystring:tok").toString("base64")}`,
    );
  });

  it("refuses a stored spec that no longer checks out, before any request", async () => {
    await expect(rows(spec({ base_url: "http://api.shop.example" }))).rejects.toThrow(
      "The connector has problems: base_url must be an https address",
    );
    expect(() => specOf(cfg("{"))).toThrow("not JSON");
    expect(net.requests).toHaveLength(0);
  });

  it("lists its streams after one real request proves it answers", async () => {
    const streams = await listRestStreams(cfg(spec()));
    expect(streams).toEqual([{ id: "orders", label: "Orders" }]);
    expect(net.requests).toHaveLength(1);
  });

  it("follows changes only for a stream that declares how", () => {
    const inc = spec(
      {},
      {
        incremental: { param: "since", format: "unix", cursor_field: "updated", primary_key: "id" },
      },
    );
    expect(restIncremental("orders", cfg(inc))).toEqual({
      cursorField: "updated",
      primaryKey: "id",
      compare: "number",
    });
    expect(restIncremental("orders", cfg(spec()))).toBeNull();
    expect(restIncremental("orders")).toBeNull();
  });
});

describe("one more app source", () => {
  const rd = (p: string) => readFileSync(p, "utf8");

  it("is a provider, a card, a host for its key, and a connector", async () => {
    const { SAAS_PROVIDERS, SAAS_LABELS } = await import("@/utils/saas/types");
    const { SAAS_CARDS, saasSecretFields } = await import("@/utils/saas/catalog");
    const { saasCredentialHosts } = await import("@/utils/saas/origins");
    expect(SAAS_PROVIDERS).toContain("rest_api");
    expect(SAAS_LABELS.rest_api).toBe("Any REST API");
    expect(SAAS_CARDS.rest_api.fields.map((f) => f.key)).toEqual([
      "spec",
      "credential",
      "username",
    ]);
    expect(saasSecretFields("rest_api")).toEqual(["credential"]);
    expect(saasCredentialHosts({ provider: "rest_api", spec: spec() })).toEqual([
      "https://api.shop.example",
    ]);
    expect(saasCredentialHosts({ provider: "rest_api", spec: "{" })).toEqual([]);
    expect(rd("src/utils/saas/sync.server.ts")).toContain(
      "connector.incremental?.(args.streamId, args.config)",
    );
  });

  it("a database without the migration is told what to run", () => {
    expect(rd("supabase/migrations/20261125000000_saas_rest_api.sql")).toContain("'rest_api'");
    expect(rd("src/utils/saas.functions.ts")).toContain(
      "Any REST API needs a database update first (migration 20261125000000",
    );
  });

  it("previews any source's first rows, for your own sources only", () => {
    const fns = rd("src/utils/saas.functions.ts");
    const at = fns.indexOf("export const previewSaasStream");
    const body = fns.slice(at, fns.indexOf("export const syncSaasConnection", at));
    expect(body).toContain("{ allowShared: false }");
    expect(body).toContain("if (rows.length === PREVIEW_ROWS) {");
    expect(rd("src/components/integrations/SaasSourcesTab.tsx")).toContain(
      "aria-label={`Preview ${s.label}`}",
    );
  });
});
