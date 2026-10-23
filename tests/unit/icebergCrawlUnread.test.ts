// An Iceberg crawl that cannot read its catalog is not an empty catalog (R369).
//
// FOUND FROM THE UI (R369). Data Catalog: "R369 fake catalog", an Iceberg REST
// catalog with two tables, crawled (2 assets), and the `orders` asset given an
// owner and a description. The catalog was then stopped and the source
// re-crawled. The toast read "Crawled 'R369 fake catalog' — 0 assets, 0
// columns · 2 removed", the source went green, and both assets were gone with
// their curation. Every failure in the crawl was caught and passed over, so a
// catalog that could not be reached read as one with nothing in it, and the
// save removed what it no longer saw.
//
// These run the crawl against a real HTTP server standing in for the catalog.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

const { crawlIcebergRest, unreadCovers } = await import("@/utils/catalog/crawler.server");

const TABLE = {
  metadata: {
    "current-schema-id": 0,
    schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "order_id", type: "long" }] }],
  },
};

/** A catalog whose every path answers as `routes` says: a body, or a status. */
type Route = Record<string, unknown> | number;
let server: Server | null = null;
async function catalog(routes: Record<string, Route>): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const key = url.searchParams.has("parent")
      ? `${url.pathname}?parent=${url.searchParams.get("parent")}`
      : url.pathname;
    const route = routes[key] ?? (url.searchParams.has("parent") ? { namespaces: [] } : 404);
    if (typeof route === "number") {
      res.writeHead(route).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(route));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const TWO_TABLES: Record<string, Route> = {
  "/v1/config": {},
  "/v1/namespaces": { namespaces: [["r369"]] },
  "/v1/namespaces/r369/tables": {
    identifiers: [
      { namespace: ["r369"], name: "orders" },
      { namespace: ["r369"], name: "refunds" },
    ],
  },
  "/v1/namespaces/r369/tables/orders": TABLE,
  "/v1/namespaces/r369/tables/refunds": TABLE,
};

describe("a catalog that answers", () => {
  it("is crawled whole, with nothing unread", async () => {
    const res = await crawlIcebergRest({ uri: await catalog(TWO_TABLES) });
    expect(res.assets.map((a) => a.fqn)).toEqual(["r369.orders", "r369.refunds"]);
    expect(res.unread).toEqual({ namespaces: [], deeper: [], tables: [], firstError: null });
  });
});

describe("a catalog that cannot be read", () => {
  it("fails the crawl, saying where and why, rather than answering empty", async () => {
    const uri = await catalog(TWO_TABLES);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await expect(crawlIcebergRest({ uri })).rejects.toThrow(
      `Iceberg: ${uri} could not be reached: nothing is listening there (connection refused)`,
    );
  });

  it("fails when its answer lists no namespaces", async () => {
    const uri = await catalog({ ...TWO_TABLES, "/v1/namespaces": {} });
    await expect(crawlIcebergRest({ uri })).rejects.toThrow(
      "Iceberg: the catalog's answer did not list namespaces",
    );
  });

  it("fails when not one listed table could be read", async () => {
    const uri = await catalog({
      ...TWO_TABLES,
      "/v1/namespaces/r369/tables/orders": 503,
      "/v1/namespaces/r369/tables/refunds": 503,
    });
    await expect(crawlIcebergRest({ uri })).rejects.toThrow(
      "Iceberg: none of the catalog's tables could be read. The first failure: Iceberg REST 503",
    );
  });
});

describe("a catalog read in part", () => {
  it("says which table it could not load, and crawls the rest", async () => {
    const uri = await catalog({ ...TWO_TABLES, "/v1/namespaces/r369/tables/refunds": 500 });
    const res = await crawlIcebergRest({ uri });
    expect(res.assets.map((a) => a.fqn)).toEqual(["r369.orders"]);
    expect(res.unread.tables).toEqual(["r369.refunds"]);
    expect(res.unread.firstError).toContain("Iceberg REST 500");
  });

  it("says which namespace's tables it could not list", async () => {
    const uri = await catalog({
      ...TWO_TABLES,
      "/v1/namespaces": { namespaces: [["r369"], ["empty"]] },
      "/v1/namespaces/empty/tables": 500,
    });
    const res = await crawlIcebergRest({ uri });
    expect(res.assets).toHaveLength(2);
    expect(res.unread.namespaces).toEqual([["empty"]]);
  });

  it("still crawls a namespace's own tables when its children cannot be listed", async () => {
    const uri = await catalog({ ...TWO_TABLES, "/v1/namespaces?parent=r369": 400 });
    const res = await crawlIcebergRest({ uri });
    expect(res.assets).toHaveLength(2);
    expect(res.unread.deeper).toEqual([["r369"]]);
  });
});

describe("what a crawl keeps", () => {
  const unread = {
    namespaces: [["sales"]],
    deeper: [["r369"]],
    tables: ["ops.events"],
    firstError: "x",
  };

  it("keeps everything under a namespace it could not list", () => {
    expect(unreadCovers(unread, "sales.orders")).toBe(true);
    expect(unreadCovers(unread, "sales.eu.orders")).toBe(true);
  });

  it("keeps only what is deeper under a namespace whose children it could not list", () => {
    expect(unreadCovers(unread, "r369.eu.orders")).toBe(true);
    expect(unreadCovers(unread, "r369.orders")).toBe(false);
  });

  it("keeps a table it could not load, and nothing it did not name", () => {
    expect(unreadCovers(unread, "ops.events")).toBe(true);
    expect(unreadCovers(unread, "ops.other")).toBe(false);
    expect(unreadCovers(unread, "salesforce.orders")).toBe(false);
  });
});

describe("the save", () => {
  const CRAWLER = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");

  it("removes only what the crawl read and found gone", () => {
    expect(CRAWLER).toContain(
      "const stale = existing.filter((e) => !seen.has(e.fqn) && !keep.has(e.fqn));",
    );
  });

  it("is handed what the Iceberg crawl could not read, and counts it", () => {
    const iceberg = CRAWLER.slice(CRAWLER.indexOf('} else if (source.kind === "iceberg_rest") {'));
    expect(iceberg).toContain(
      "for (const e of existing) if (unreadCovers(res.unread, e.fqn)) keep.add(e.fqn);",
    );
    expect(CRAWLER).toContain("await persistAssets(userId, source.id, assets, existing, keep);");
    expect(CRAWLER).toContain("...(unreadCount > 0 ? { unread: unreadCount } : {}),");
  });
});

describe("the page", () => {
  it("says a re-crawl that could not read part of the catalog, as a warning", () => {
    const view = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");
    const recrawl = view.slice(view.indexOf("async function recrawl("));
    expect(recrawl).toMatch(/if \(res\.stats\.unread\) \{\s*toast\.warning\(/);
    expect(recrawl).toContain("could not be read; what was cataloged from them was kept");
  });

  it("says it in the Add source wizard too", () => {
    const wizard = readFileSync("src/components/catalog/AddSourceWizard.tsx", "utf8");
    expect(wizard).toMatch(/\{result\?\.unread \? \(/);
    expect(wizard).toContain("part(s) of the catalog could not be read");
  });
});
