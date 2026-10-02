// The catalog crawl's records: a crawl that succeeded does not leave its
// source "crawling", stale assets are reported removed only once they are,
// and lineage is never written beside what could not be cleared.
//
// FOUND FROM THE SURVEY (R82). crawler.server.ts had 6 writes that dropped
// their errors; the ETL run's lineage delete was the one R78 left.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cr = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");
const etl = readFileSync("src/utils/etl/service.server.ts", "utf8");
const between = (src: string, start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const persistAssets = between(
  cr,
  "const keep = new Set(assets.map((a) => a.fqn));",
  "/** Resolve {{secret:NAME}} refs",
);
const persistLineage = between(
  cr,
  "async function persistLineage(",
  "/** Run a full crawl for a source row",
);
const runCrawl = cr.slice(cr.indexOf("export async function runCrawl("));

describe("a crawl's records", () => {
  it("claims stale assets removed only once they are", () => {
    expect(persistAssets).toContain("const { error: delErr } = await supabaseAdmin");
    expect(persistAssets).toContain("Could not remove");
    expect(persistAssets.indexOf("throw new Error(")).toBeLessThan(
      persistAssets.indexOf("changes.removed = stale.map((e) => e.fqn);"),
    );
  });

  it("never writes lineage beside what could not be cleared, and says a partial graph", () => {
    expect(persistLineage).toContain("const { error: clearErr } = await supabaseAdmin");
    expect(persistLineage.indexOf("if (clearErr) {")).toBeLessThan(
      persistLineage.indexOf("if (edges.length === 0) return;"),
    );
    expect(persistLineage).toContain("the new edges were not written, so the old ones stand");
    expect(persistLineage).toContain("const { error: insErr } = await supabaseAdmin");
    expect(persistLineage).toContain("the graph is partial until the next crawl");
    expect(runCrawl).toContain("lineage could not be refreshed");
  });

  it("marks the source ready with one retry, and fails the crawl it cannot mark", () => {
    expect((runCrawl.match(/await ready\(\)/g) ?? []).length).toBe(2);
    expect(runCrawl).toContain("but the source could not be marked ready");
    expect(runCrawl).toContain("It will show as crawling until it is");
    expect(runCrawl).toContain("const { error: startErr } = await supabaseAdmin");
    expect(runCrawl).toContain("const { error: markErr } = await supabaseAdmin");
  });
});

describe("an ETL run's lineage", () => {
  it("is not rewritten beside edges that could not be cleared", () => {
    // The lineage clear, not R78's cluster-ref clear that also reads `clearErr`.
    const clear = etl.search(/\.from\("catalog_lineage"\)\s*\.delete\(\)/);
    expect(clear).toBeGreaterThan(-1);
    const i = etl.lastIndexOf("const { error: clearErr } = await supabaseAdmin", clear);
    expect(i).toBeGreaterThan(-1);
    const block = etl.slice(i, etl.indexOf("async function runChainTargets(", i));
    expect(block).toContain("if (clearErr) {");
    expect(block).toContain("the old ones stand");
    // Chain-tolerant: prettier may keep the insert on one line or break it.
    const insert = /\.from\("catalog_lineage"\)\s*\.insert\(edges\)/;
    expect(block).toMatch(insert);
    expect(block.indexOf("if (clearErr) {")).toBeLessThan(block.search(insert));
    expect(etl).toContain("const { error: schemaErr } = await supabaseAdmin");
  });
});
