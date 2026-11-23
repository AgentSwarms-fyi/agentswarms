// A connector described as data (R528): what a spec may say, and how the
// engine pages through an API it describes. Pure: no network.
import { describe, expect, it } from "vitest";

import {
  authFor,
  checkConnectorSpec,
  firstPageUrl,
  linkNext,
  nextPageUrl,
  recordsIn,
  sinceParam,
  specOrigin,
  STARTER_SPEC,
  type ConnectorSpec,
  type ConnectorStream,
} from "@/lib/connectorSpec";

const ok = (raw: unknown): ConnectorSpec => {
  const r = checkConnectorSpec(raw);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
};
const errors = (raw: unknown): string[] => {
  const r = checkConnectorSpec(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.errors;
};
const base = {
  name: "Shop",
  base_url: "https://api.shop.example/v2",
  auth: { kind: "bearer" },
  streams: [{ id: "orders", label: "Orders", path: "/orders", records: "data" }],
};

describe("what a spec may say", () => {
  it("the starter passes as written, as JSON text too", () => {
    expect(ok(STARTER_SPEC)).toEqual(STARTER_SPEC);
    expect(ok(JSON.stringify(STARTER_SPEC)).name).toBe("My API");
  });

  it("one https host, no query, no credentials in the address", () => {
    for (const url of [
      "http://api.shop.example",
      "https://api.shop.example/?key=1",
      "https://user:pw@api.shop.example",
      "ftp://api.shop.example",
      "not a url",
    ]) {
      expect(errors({ ...base, base_url: url })[0], url).toContain(
        "base_url must be an https address",
      );
    }
    expect(specOrigin("https://api.shop.example/v2/")).toBe("https://api.shop.example");
    expect(ok({ ...base, base_url: "https://api.shop.example/v2/" }).base_url).toBe(
      "https://api.shop.example/v2",
    );
  });

  it("a path cannot leave the host", () => {
    for (const path of [
      "orders",
      "//evil.example/x",
      "/a/../b",
      "/x?y=1",
      "/https://evil.example",
      "/a\\b",
    ]) {
      expect(errors({ ...base, streams: [{ id: "x", path }] }).join(" "), path).toContain(
        "path must start with / and stay on the host",
      );
    }
  });

  it("the credential goes only where auth says, and reserved headers stay the platform's", () => {
    expect(errors({ ...base, headers: { Authorization: "Bearer x" } })[0]).toContain("not allowed");
    expect(errors({ ...base, headers: { Host: "evil.example" } })[0]).toContain("not allowed");
    expect(errors({ ...base, headers: { "X-Key": "{credential}" } })[0]).toContain(
      "put the credential in auth",
    );
    expect(errors({ ...base, headers: { "X-A": "a\r\nX-B: b" } })[0]).toContain("one line");
    expect(
      errors({ ...base, streams: [{ id: "x", path: "/x", params: { key: "{credential}" } }] })[0],
    ).toContain("put the credential in auth");
    expect(ok({ ...base, headers: { Accept: "application/json" } }).headers).toEqual({
      Accept: "application/json",
    });
  });

  it("stream ids are names, used once; pagination and incremental are complete", () => {
    expect(errors({ ...base, streams: [] })[0]).toContain("at least one stream");
    expect(errors({ ...base, streams: [{ id: "Open Issues", path: "/i" }] })[0]).toContain(
      "lower case",
    );
    expect(
      errors({
        ...base,
        streams: [
          { id: "a", path: "/a" },
          { id: "a", path: "/b" },
        ],
      })[0],
    ).toContain('"a" is used twice');
    expect(
      errors({ ...base, streams: [{ id: "a", path: "/a", pagination: { kind: "pages" } }] })[0],
    ).toContain("pagination kind must be");
    expect(
      errors({
        ...base,
        streams: [
          { id: "a", path: "/a", pagination: { kind: "offset", param: "o", limit_param: "l" } },
        ],
      })[0],
    ).toContain("limit of 1 to 1000");
    expect(
      errors({ ...base, streams: [{ id: "a", path: "/a", incremental: { param: "since" } }] }).join(
        " ",
      ),
    ).toContain("cursor_field");
    expect(
      errors({ ...base, streams: [{ id: "a", path: "/a", records: "data[0]" }] })[0],
    ).toContain("dotted path");
  });

  it("says every problem at once, and drops what it does not know", () => {
    expect(errors({ name: "", base_url: "x", auth: { kind: "magic" }, streams: [] })).toHaveLength(
      4,
    );
    const spec = ok({ ...base, eval: "rm -rf", streams: [{ ...base.streams[0], script: "x" }] });
    expect(Object.keys(spec)).not.toContain("eval");
    expect(Object.keys(spec.streams[0])).not.toContain("script");
  });

  it("refuses what is not JSON, or too big", () => {
    expect(errors("{nope")[0]).toContain("not JSON");
    expect(errors("x".repeat(60_000))[0]).toContain("over 50 KB");
  });
});

describe("reading a response", () => {
  it("finds the list at the records path, or says what the response holds", () => {
    expect(recordsIn({ data: { items: [{ id: 1 }, 2] } }, "data.items")).toEqual({
      ok: true,
      records: [{ id: 1 }, { value: 2 }],
    });
    expect(recordsIn([{ id: 1 }], "")).toEqual({ ok: true, records: [{ id: 1 }] });
    const miss = recordsIn({ results: [], next: null }, "data");
    expect(!miss.ok && miss.error).toBe(
      'There is no list at "data" in the response (it has: results, next).',
    );
  });

  it("reads the next link of a Link header", () => {
    expect(
      linkNext(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
      ),
    ).toBe("https://api.github.com/x?page=2");
    expect(linkNext('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(linkNext(null)).toBeNull();
  });

  it("writes 'changed since' the way the API asks", () => {
    expect(sinceParam("2026-11-20T10:00:00.000Z", "iso")).toBe("2026-11-20T10:00:00.000Z");
    expect(sinceParam("2026-11-20T10:00:00Z", "unix")).toBe("1795168800");
    expect(sinceParam("1795082400", "unix")).toBe("1795082400");
    expect(sinceParam("2026-11-20T23:59:00Z", "date")).toBe("2026-11-20");
    expect(sinceParam("yesterday", "iso")).toBeNull();
  });
});

describe("paging", () => {
  const ORIGIN = "https://api.shop.example";
  const page = (
    stream: ConnectorStream,
    url: string,
    count: number,
    body: unknown = {},
    link?: string,
  ) => nextPageUrl(stream, ORIGIN, { url, body, count, link });

  it("page numbers end on a short or empty page", () => {
    const s: ConnectorStream = {
      id: "o",
      label: "O",
      path: "/o",
      pagination: { kind: "page", param: "page", size_param: "per_page", size: 100 },
    };
    expect(firstPageUrl(ok({ ...base, streams: [s] }), s)).toBe(
      "https://api.shop.example/v2/o?page=1&per_page=100",
    );
    expect(page(s, `${ORIGIN}/v2/o?page=1&per_page=100`, 100)).toEqual({
      url: `${ORIGIN}/v2/o?page=2&per_page=100`,
    });
    expect(page(s, `${ORIGIN}/v2/o?page=2&per_page=100`, 40)).toEqual({ end: true });
    expect(page(s, `${ORIGIN}/v2/o?page=3&per_page=100`, 0)).toEqual({ end: true });
  });

  it("offsets step by the limit", () => {
    const s: ConnectorStream = {
      id: "o",
      label: "O",
      path: "/o",
      pagination: { kind: "offset", param: "offset", limit_param: "count", limit: 50 },
    };
    expect(page(s, `${ORIGIN}/o?offset=0&count=50`, 50)).toEqual({
      url: `${ORIGIN}/o?offset=50&count=50`,
    });
    expect(page(s, `${ORIGIN}/o?offset=50&count=50`, 12)).toEqual({ end: true });
  });

  it("a cursor the response names is sent back; none ends it", () => {
    const s: ConnectorStream = {
      id: "o",
      label: "O",
      path: "/o",
      pagination: { kind: "cursor", param: "starting_after", next_path: "meta.next" },
    };
    expect(page(s, `${ORIGIN}/o`, 10, { meta: { next: "ord_9" } })).toEqual({
      url: `${ORIGIN}/o?starting_after=ord_9`,
    });
    expect(page(s, `${ORIGIN}/o`, 10, { meta: { next: null } })).toEqual({ end: true });
  });

  it("a next URL is followed only on the spec's own host", () => {
    const s: ConnectorStream = {
      id: "o",
      label: "O",
      path: "/o",
      pagination: { kind: "next_url", next_path: "next" },
    };
    expect(page(s, `${ORIGIN}/o`, 10, { next: "/o?after=2" })).toEqual({
      url: `${ORIGIN}/o?after=2`,
    });
    const away = page(s, `${ORIGIN}/o`, 10, { next: "https://evil.example/o?after=2" });
    expect("error" in away && away.error).toBe(
      "The API's next page is on https://evil.example, not https://api.shop.example; it was not followed.",
    );
    const l: ConnectorStream = {
      id: "o",
      label: "O",
      path: "/o",
      pagination: { kind: "link_header" },
    };
    expect(page(l, `${ORIGIN}/o`, 10, {}, `<${ORIGIN}/o?page=2>; rel="next"`)).toEqual({
      url: `${ORIGIN}/o?page=2`,
    });
    expect(
      page(l, `${ORIGIN}/o`, 10, {}, '<https://evil.example/o?page=2>; rel="next"'),
    ).toHaveProperty("error");
  });

  it("the first page asks for what changed since the last sync", () => {
    const s: ConnectorStream = {
      id: "o",
      label: "O",
      path: "/o",
      params: { status: "any" },
      incremental: {
        param: "updated_after",
        format: "unix",
        cursor_field: "updated",
        primary_key: "id",
      },
    };
    expect(firstPageUrl(ok({ ...base, streams: [s] }), s, "2026-11-20T10:00:00Z")).toBe(
      "https://api.shop.example/v2/o?status=any&updated_after=1795168800",
    );
    expect(firstPageUrl(ok({ ...base, streams: [s] }), s)).toBe(
      "https://api.shop.example/v2/o?status=any",
    );
  });
});

describe("where the credential goes", () => {
  it("as auth says, and nowhere else", () => {
    expect(authFor({ kind: "bearer" }, "tok", "")).toEqual({
      headers: { Authorization: "Bearer tok" },
      params: {},
    });
    expect(authFor({ kind: "header", name: "X-Api-Key", prefix: "Key " }, "tok", "")).toEqual({
      headers: { "X-Api-Key": "Key tok" },
      params: {},
    });
    expect(authFor({ kind: "query", param: "api_token" }, "tok", "")).toEqual({
      headers: {},
      params: { api_token: "tok" },
    });
    expect(
      authFor({ kind: "basic", username: "{credential}", password: "X" }, "tok", "me"),
    ).toMatchObject({
      basic: ["tok", "X"],
    });
    expect(authFor({ kind: "basic" }, "tok", "me")).toMatchObject({ basic: ["me", "tok"] });
    expect(authFor({ kind: "none" }, "tok", "")).toEqual({ headers: {}, params: {} });
  });
});
