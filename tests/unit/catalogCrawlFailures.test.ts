// A catalog source whose last crawl failed says so in words (R370).
//
// FOUND FROM THE UI (R369/R370). "R369 fake catalog", re-crawled with its
// catalog down: the row read "R369 fake catalog 2" beside a red dot 6 px wide,
// and the reason ("Iceberg: http://r369-fake-iceberg:8181 could not be
// reached: its host name does not resolve") was in that dot's and the row's
// hover titles only. Nothing else on the page mentioned it once the toast had
// gone, and a scheduled crawl has no toast.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { crawlFailures } from "@/lib/catalogCrawlFailures";

const SOURCES = [
  { id: "a", name: "Warehouse", status: "ready", last_error: null },
  {
    id: "b",
    name: "R369 fake catalog",
    status: "error",
    last_error: "  Iceberg: http://r369-fake-iceberg:8181 could not be reached  ",
  },
  { id: "c", name: "Lake", status: "error", last_error: null },
  { id: "d", name: "Busy", status: "crawling", last_error: "an older failure" },
];

describe("which failures the page says", () => {
  it("every failed source, when all are shown", () => {
    expect(crawlFailures(SOURCES, "all")).toEqual([
      {
        id: "b",
        name: "R369 fake catalog",
        reason: "Iceberg: http://r369-fake-iceberg:8181 could not be reached",
      },
      { id: "c", name: "Lake", reason: "No reason was recorded." },
    ]);
  });

  it("only the picked source's, when one is picked", () => {
    expect(crawlFailures(SOURCES, "c").map((f) => f.id)).toEqual(["c"]);
    expect(crawlFailures(SOURCES, "a")).toEqual([]);
  });

  it("none for a source that is ready or crawling again", () => {
    expect(crawlFailures(SOURCES, "d")).toEqual([]);
  });
});

describe("the Data Catalog page", () => {
  const VIEW = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");

  it("works out the failures the page is showing", () => {
    expect(VIEW).toContain(
      "const failures = useMemo(() => crawlFailures(sources, sourceFilter), [sources, sourceFilter]);",
    );
  });

  it("says each one above the assets, with its reason, and a Re-crawl for its owner", () => {
    const bar = VIEW.slice(VIEW.indexOf("{failures.length > 0 ? ("));
    expect(bar.slice(0, 400)).toContain('data-testid="catalog-crawl-failures"');
    expect(bar).toMatch(/The last crawl of “\{f\.name\}” failed: \{f\.reason\}/);
    expect(bar).toMatch(/\{failed && ownsSource\(failed\) \? \(\s*<button/);
    expect(bar).toContain("onClick={() => void recrawl(failed)}");
  });

  it("marks the failed source's row in words, not only by colour", () => {
    expect(VIEW).toMatch(
      /\{statusDot\(s\)\}\s*\{s\.status === "error" \? \(\s*<span className="text-\[10px\] font-medium text-destructive">failed<\/span>/,
    );
  });
});
