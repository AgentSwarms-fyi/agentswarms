// A freshness stamp that is always "now" is not a stamp.
//
// MEASURED: the catalog drawer rendered
// `Crawled {formatDistanceToNow(new Date(asset.last_crawled_at))}`, and the
// local mapping set `last_crawled_at: new Date().toISOString()`. So every local
// table reported "Crawled less than a minute ago" — on this account, 26 tables
// whose real `data_loaded_at` spanned 2026-07-20 to 2026-08-07, up to 27 days
// stale, every one of them shown as fresh.
//
// Two errors in one line, and they need separating:
//
//   · A timestamp was INVENTED while the real one sat in the next column.
//   · The verb was wrong. An uploaded CSV was never "crawled", and a warehouse
//     table is queried in place and never loaded here at all — for that one
//     there is no local timestamp, and the honest output is to say so.
import { describe, expect, it } from "vitest";

import { assetFreshness, freshnessPrefix } from "@/lib/dataCatalog";

const AT = "2026-08-07T13:08:00.000Z";

describe("a local dataset reports when its data arrived", () => {
  it("carries the real timestamp through rather than inventing one", () => {
    const f = assetFreshness({ last_crawled_at: AT, local: true });
    expect(f).toEqual({ kind: "loaded", at: AT });
  });

  it('says "Data loaded", because an uploaded CSV was never crawled', () => {
    expect(freshnessPrefix({ kind: "loaded", at: AT })).toBe("Data loaded");
  });
});

describe("a crawled asset keeps the crawl wording", () => {
  it("is crawled, not loaded", () => {
    const f = assetFreshness({ last_crawled_at: AT, local: false });
    expect(f).toEqual({ kind: "crawled", at: AT });
    expect(freshnessPrefix(f)).toBe("Crawled");
  });

  it("treats a missing local flag as not-local", () => {
    expect(assetFreshness({ last_crawled_at: AT }).kind).toBe("crawled");
  });
});

describe("no timestamp is a state, not a gap to fill", () => {
  it("reports live-query rather than a fabricated time", () => {
    // The warehouse case. Nothing was loaded here, so there is nothing to date.
    expect(assetFreshness({ last_crawled_at: null, local: false })).toEqual({ kind: "live" });
  });

  it("says so in words instead of printing a date", () => {
    const label = freshnessPrefix({ kind: "live" });
    expect(label).toMatch(/queried live/i);
    expect(label).toMatch(/not loaded/i);
  });

  it("never returns a datable shape when there is no date", () => {
    // Guards the render: the caller only formats a time for loaded/crawled.
    const f = assetFreshness({ last_crawled_at: null, local: true });
    expect("at" in f).toBe(false);
  });

  it("treats an empty string like a missing timestamp", () => {
    expect(assetFreshness({ last_crawled_at: "", local: true }).kind).toBe("live");
  });
});
