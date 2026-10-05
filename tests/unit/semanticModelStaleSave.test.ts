// Two tabs on one semantic model (R286, sweep 9). The save wrote the whole
// definition over whatever was stored, so a save from a second tab undid the
// first's. Certification writes the row too, so `updated_at` cannot say who
// changed it; the save compares a fingerprint of the stored definition with
// the one the page opened. The projection is tested as a function; the wiring
// is pinned by reading the server function and the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintOf } from "@/lib/definitionFingerprint";
import { semanticModelDefinition } from "@/lib/semanticLayer";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const server = read("src/utils/semantic.functions.ts");
const page = read("src/routes/_authenticated/semantics.tsx");

const written = {
  user_id: "u1",
  name: "stg_revenue",
  label: "stg_revenue",
  description: null,
  source_kind: "data_table",
  table_id: "t1",
  connection_id: null,
  source_table: "analytics.stg_revenue",
  primary_key: null,
  fiscal_year_start_month: null,
  calendar: null,
  rollups: [],
  parameters: [],
  hierarchies: [],
  joins: [],
  dimensions: [{ name: "region", sql: '"region"', type: "categorical" }],
  metrics: [{ name: "revenue", sql: '"net_usd"', agg: "sum" }],
  assertions: [],
};

describe("semanticModelDefinition", () => {
  it("fingerprints a stored row as the save that wrote it", async () => {
    const stored = {
      ...written,
      // jsonb hands objects back with their keys in another order.
      dimensions: [{ type: "categorical", sql: '"region"', name: "region" }],
      metrics: [{ agg: "sum", name: "revenue", sql: '"net_usd"' }],
      id: "m1",
      status: "certified",
      certified_by: "u2",
      certified_at: "2026-10-05T09:00:00+00:00",
      created_at: "2026-10-01T00:00:00+00:00",
      updated_at: "2026-10-05T09:00:01+00:00",
    };
    expect(await fingerprintOf(semanticModelDefinition(stored))).toBe(
      await fingerprintOf(semanticModelDefinition(written)),
    );
  });

  it("leaves out status and ownership, and changes with what the editor saves", async () => {
    const base = await fingerprintOf(semanticModelDefinition(written));
    expect(
      await fingerprintOf(semanticModelDefinition({ ...written, user_id: "u9", status: "draft" })),
    ).toBe(base);
    for (const change of [
      { label: "stg_revenue B286" },
      { description: "r286 A" },
      { dimensions: [{ name: "region_x", sql: '"region"', type: "categorical" }] },
      { metrics: [{ name: "revenue", sql: '"net_usd"', agg: "avg" }] },
    ]) {
      expect(await fingerprintOf(semanticModelDefinition({ ...written, ...change }))).not.toBe(
        base,
      );
    }
  });
});

describe("semanticUpsertModel and the list", () => {
  it("hands each model to the page with its definition's fingerprint", () => {
    expect(server).toMatch(
      /\(rows \?\? \[\]\)\.map\(async \(r\) => \(\{\s*\.\.\.r,\s*fingerprint: await fingerprintOf\(semanticModelDefinition\(r\)\),\s*\}\)\)/,
    );
  });

  it("refuses a save whose stored definition moved on, before writing", () => {
    expect(server).toMatch(
      /if \(stored && data\.expectedFingerprint\) \{\s*const storedPrint = await fingerprintOf\(semanticModelDefinition\(stored\)\);\s*if \(storedPrint !== data\.expectedFingerprint\) \{\s*return \{\s*stale: true,/,
    );
    expect(server.indexOf("stale: true,")).toBeLessThan(server.indexOf(".update(row as never)"));
  });

  it("lands only on the row it read, and returns the fingerprint of what it wrote", () => {
    expect(server).toMatch(/if \(stored\) q = q\.eq\("updated_at", stored\.updated_at\);/);
    expect(server).toContain(
      "const fingerprint = await fingerprintOf(semanticModelDefinition(row));",
    );
    expect(server).toContain("return { id: up.id, fingerprint };");
  });
});

describe("the Semantic Layer page", () => {
  it("sends the fingerprint of the row it opened, unless overwriting", () => {
    expect(page).toMatch(
      /expectedFingerprint: overwrite\s*\? undefined\s*: \(\(draftRow\?\.fingerprint as string \| undefined\) \?\? undefined\),/,
    );
    expect(page).toMatch(
      /if \("stale" in res\) \{\s*setStale\(true\);\s*toast\.error\(res\.error\);\s*return;\s*\}\s*setStale\(false\);\s*setDraftRow\(\(r\) => \(r \? \{ \.\.\.r, fingerprint: res\.fingerprint \} : r\)\);/,
    );
  });

  it("does not hand the click event to save as an overwrite", () => {
    expect(page).not.toContain("onClick={save}");
    expect(page).toContain("onClick={() => void save()}");
  });

  it("says so, with Reload and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<div[^>]*data-testid="semantic-stale"/);
    expect(page).toMatch(
      /const fresh = all\.find\(\(r\) => r\.id === draft\.id\);\s*if \(fresh\) editModel\(fresh\);/,
    );
    expect(page).toMatch(/onClick=\{\(\) => void save\(true\)\}\s*>\s*Overwrite with mine/);
  });
});
