// Lakehouse: a schema drop or materialized-view removal whose catalog row
// could not be deleted is said as such, never reported done.
//
// FOUND FROM THE UI. Dropping a schema ran DROP SCHEMA, then two row deletes
// whose errors were dropped, then reported done — so a schema whose catalog
// row survived stayed listed, pointing at nothing. Removing a materialized
// view did the same, and a view whose row survived kept refreshing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/lakehouse.functions.ts", "utf8");

describe("dropping a schema", () => {
  const fn = src.slice(
    src.indexOf("DROP SCHEMA IF EXISTS"),
    src.indexOf('action: "lakehouse.schema.drop"'),
  );

  it("keeps the error of the catalog-row delete and says the schema itself is already gone", () => {
    expect(fn).toContain("const { error: rowErr } = await supabaseAdmin");
    expect(fn).toContain("The schema was dropped, but its catalog entry could not be removed");
    expect(fn).toContain("It will still be listed until it is; drop it again to retry.");
  });

  it("keeps the error of the grants delete too", () => {
    expect(fn).toContain("const { error: grantsErr } = await supabaseAdmin");
    expect(fn).toContain("the grants on it could not be removed");
  });

  it("throws before the audit entry says it was dropped", () => {
    expect(fn.indexOf("throw new Error(")).toBeGreaterThan(-1);
    expect(fn).not.toMatch(
      /^\s*await supabaseAdmin\.from\("lakehouse_schemas"\)\.delete\(\)\.eq\("id", row\.id\);\s*$/m,
    );
  });
});

describe("removing a materialized view", () => {
  const fn = src.slice(
    src.indexOf("export const deleteLakehouseMatview"),
    src.indexOf('action: "lakehouse.matview.delete"'),
  );

  it("keeps the delete's error and says the view will still refresh", () => {
    expect(fn).toContain("const { error: delErr } = await supabaseAdmin");
    expect(fn).toContain("It is still defined and will still refresh on its schedule.");
    expect(fn).not.toMatch(
      /^\s*await supabaseAdmin\.from\("lakehouse_materialized_views"\)\.delete\(/m,
    );
  });
});
