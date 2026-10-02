// Sheets: what saving writes must be what the database accepts. The first
// catalog registration wrote status "active", which catalog_assets' CHECK
// refuses; the table saved and the catalog step failed. Pinned against the
// migration, so a status that is not in the constraint fails here instead.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

function allowedAssetStatuses(): string[] {
  const dir = "supabase/migrations";
  for (const f of readdirSync(resolve(process.cwd(), dir)).sort().reverse()) {
    const sql = read(`${dir}/${f}`);
    const m =
      /catalog_assets[\s\S]*?ADD COLUMN status text[^,;]*CHECK \(status IN \(([^)]*)\)\)/.exec(sql);
    if (m) return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  throw new Error("catalog_assets.status constraint not found");
}

describe("the catalog entry Sheets writes", () => {
  it("uses only statuses the catalog accepts", () => {
    const allowed = allowedAssetStatuses();
    expect(allowed).toEqual(["draft", "certified", "deprecated"]);
    const src = read("src/utils/sheetsPublish.functions.ts");
    const written = [...src.matchAll(/status:\s*([^,\n]+),/g)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(0);
    for (const expr of written) {
      for (const lit of expr.matchAll(/"([^"]+)"/g)) expect(allowed).toContain(lit[1]);
    }
  });

  it("records lineage as Sheets, which a crawl does not clear", () => {
    const src = read("src/utils/sheetsPublish.functions.ts");
    expect(src).toContain('source_system: "sheets"');
    // A crawl clears only its own (Databricks) edges.
    const crawler = read("src/utils/catalog/crawler.server.ts");
    expect(crawler).toMatch(/\.eq\("source_system", "databricks"\)/);
  });
});
