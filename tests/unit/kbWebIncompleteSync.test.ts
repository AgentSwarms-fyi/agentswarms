// A website sync that could not read a page removes nothing (R371).
//
// FOUND FROM THE UI (R371). Knowledge Bases → "R371 site KB" → Connect →
// Website at a throwaway site with three pages: "Indexed 3/3 documents". The
// site's /b then answered 503, as a page does in a bad minute, and the source
// was synced again: "2 docs · +0 ~0 =2 −1 · 1 skipped", Documents (2). The
// page's document, its chunks and its access list were deleted as removed
// from the site, to be fetched and embedded again on the next good sync. A
// crawl also misses every page linked only from the one that failed, so what
// a crawl did not see is not known to be gone.
//
// The listing is run against a real HTTP server standing in for the site.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { KB_CONNECTORS } from "@/utils/kb/connectors.server";

const page = (body: string) => `<html><body>${body}</body></html>`;

let server: Server | null = null;
/** A site of three pages; `b` answers with that status, or closes the socket. */
async function site(b: number | "drop"): Promise<string> {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page('<a href="/a">A</a> <a href="/b">B</a>'));
    }
    if (path === "/a") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page("Alpha"));
    }
    if (path === "/b") {
      if (b === "drop") return req.socket.destroy();
      res.writeHead(b, { "Content-Type": "text/html" });
      return res.end(b === 200 ? page("Beta") : "");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const list = async (start: string) =>
  KB_CONNECTORS.web.listItems({ start_urls: [start] } as never, {} as never);
const ids = (items: { externalId: string }[]) =>
  items.map((i) => new URL(i.externalId).pathname).sort();

describe("a site read whole", () => {
  it("lists every page and is complete", async () => {
    const res = await list(await site(200));
    expect(ids(res.items)).toEqual(["/", "/a", "/b"]);
    expect(res.incomplete).toBeUndefined();
  });
});

describe("a page failing for now", () => {
  for (const status of [503, 500, 429]) {
    it(`(HTTP ${status}) is kept, and the listing says it is incomplete`, async () => {
      const start = await site(status);
      const res = await list(start);
      expect(ids(res.items)).toEqual(["/", "/a"]);
      expect(res.incomplete).toBe(`${start}b answered HTTP ${status}`);
      expect(res.skipped).toContainEqual({
        name: `${start}b`,
        reason: `HTTP ${status} (its last synced copy is kept)`,
      });
    });
  }

  it("(a dropped connection) is kept too", async () => {
    const start = await site("drop");
    const res = await list(start);
    expect(ids(res.items)).toEqual(["/", "/a"]);
    expect(res.incomplete).toMatch(new RegExp(`^${start}b could not be read: `));
  });
});

describe("a page that is gone or no longer public", () => {
  for (const status of [404, 410, 403, 401]) {
    it(`(HTTP ${status}) is removed as before: the listing is complete`, async () => {
      const start = await site(status);
      const res = await list(start);
      expect(ids(res.items)).toEqual(["/", "/a"]);
      expect(res.incomplete).toBeUndefined();
      expect(res.skipped).toContainEqual({ name: `${start}b`, reason: `HTTP ${status}` });
    });
  }
});

describe("the sync", () => {
  const SYNC = readFileSync("src/utils/kb/sync.server.ts", "utf8");

  it("removes nothing when the listing could not read everything, and says how many it kept", () => {
    expect(SYNC).toContain(
      "const { items, skipped, incomplete } = await connector.listItems(config, creds);",
    );
    expect(SYNC).toContain("const toRemove = incomplete ? [] : toRemoveExternalIds;");
    expect(SYNC).toMatch(
      /if \(incomplete\) \{\s*stats\.incomplete = incomplete;\s*if \(toRemoveExternalIds\.length > 0\) stats\.kept = toRemoveExternalIds\.length;/,
    );
    expect(SYNC).toContain('.in("external_id", toRemove);');
    expect(SYNC).not.toContain('.in("external_id", toRemoveExternalIds);');
  });

  it("is said on the source's card", () => {
    const page = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");
    expect(page).toMatch(/\{isConnector && src\.last_sync_stats\?\.incomplete \? \(/);
    expect(page).toContain("Nothing was removed this sync");
    expect(page).toContain("not seen, kept)");
  });
});
