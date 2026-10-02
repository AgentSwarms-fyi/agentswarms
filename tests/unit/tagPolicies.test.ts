// Policies by tag: how tag rules fold into the per-table policy the rewrite
// enforces, and the wiring that carries tags from the catalog to the loader.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { effectivePolicy, normalizeTag, type TagPolicy } from "@/lib/tagPolicies";

const rd = (p: string) => readFileSync(p, "utf8");

const mask = (tag: string, style: "null" | "hash" = "null"): TagPolicy => ({
  id: `m-${tag}`,
  tag,
  scope: "column",
  mask_style: style,
  row_filter: null,
});
const filter = (tag: string, expr: string): TagPolicy => ({
  id: `f-${tag}`,
  tag,
  scope: "table",
  mask_style: "null",
  row_filter: expr,
});
const cols = [
  { name: "id" },
  { name: "email", tags: ["PII"] },
  { name: "phone", tags: ["pii", "contact"] },
  { name: "region" },
];

describe("folding tag rules into a table policy", () => {
  it("masks every column carrying the tag, any case", () => {
    const p = effectivePolicy({
      explicit: null,
      tableTags: [],
      columns: cols,
      tagPolicies: [mask("pii", "hash")],
    });
    expect(p).toEqual({
      row_filter: null,
      masked_columns: ["email", "phone"],
      mask_style: "hash",
      via_tags: ["pii"],
    });
  });

  it("filters a table carrying the tag, and ANDs several filters", () => {
    const p = effectivePolicy({
      explicit: null,
      tableTags: ["Restricted", "eu"],
      columns: cols,
      tagPolicies: [filter("restricted", "region = 'east'"), filter("eu", "region <> 'us'")],
    });
    expect(p?.row_filter).toBe("(region = 'east') AND (region <> 'us')");
    expect(p?.masked_columns).toEqual([]);
    expect(p?.via_tags).toEqual(["eu", "restricted"]);
  });

  it("combines with the table's own policy: masks union, filters AND, blank beats scramble", () => {
    const p = effectivePolicy({
      explicit: { row_filter: "owner_email = @me", masked_columns: ["id"], mask_style: "hash" },
      tableTags: ["restricted"],
      columns: cols,
      tagPolicies: [mask("pii", "null"), filter("restricted", "region = 'east'")],
    });
    expect(p?.masked_columns).toEqual(["id", "email", "phone"]);
    expect(p?.mask_style).toBe("null");
    expect(p?.row_filter).toBe("(owner_email = @me) AND (region = 'east')");
  });

  it("a scramble rule on one column and a blank on another blank both — stricter wins", () => {
    const p = effectivePolicy({
      explicit: null,
      tableTags: [],
      columns: cols,
      tagPolicies: [mask("pii", "hash"), mask("contact", "null")],
    });
    expect(p?.mask_style).toBe("null");
    expect(p?.masked_columns).toEqual(["email", "phone"]);
  });

  it("is null when nothing applies, so the ordinary path pays no cost", () => {
    expect(
      effectivePolicy({
        explicit: null,
        tableTags: ["public"],
        columns: cols,
        tagPolicies: [mask("secret"), filter("internal", "1 = 1")],
      }),
    ).toBeNull();
    // A table rule on a tag the table does not carry is not a filter.
    expect(
      effectivePolicy({
        explicit: null,
        tableTags: [],
        columns: [{ name: "x", tags: ["restricted"] }],
        tagPolicies: [filter("restricted", "1 = 1")],
      }),
    ).toBeNull();
  });

  it("keeps an explicit policy intact when no tag rule applies", () => {
    const explicit = { row_filter: "a = 1", masked_columns: ["x"], mask_style: "hash" as const };
    const p = effectivePolicy({ explicit, tableTags: [], columns: cols, tagPolicies: [] });
    expect(p).toEqual({
      row_filter: "(a = 1)",
      masked_columns: ["x"],
      mask_style: "hash",
      via_tags: [],
    });
  });

  it("normalises tags the way the catalog compares them", () => {
    expect(normalizeTag("  PII ")).toBe("pii");
  });
});

describe("the wiring", () => {
  it("the loader folds tag rules after the explicit policies, from lakehouse sources only", () => {
    const src = rd("src/utils/lakehouse/policies.server.ts");
    const explicit = src.indexOf('.from("lakehouse_table_policies")');
    const rules = src.indexOf("const rules = await loadTagPolicies(ownerIds);");
    expect(explicit).toBeGreaterThan(-1);
    expect(rules).toBeGreaterThan(explicit);
    expect(src).toContain("effectivePolicy({");
    // The same table name on another warehouse connection is not the lakehouse;
    // the provider lives on the connection, which the first live check missed.
    expect(src).toContain('.from("data_warehouse_connections")');
    expect(src).toContain('.eq("provider", "lakehouse")');
    expect(src).toContain('.in("connection_id", connIds)');
    expect(src).toContain('.from("lakehouse_tag_policies")');
  });

  it("every reader of policies goes through the one loader, so Spark refuses tag-policed tables too", () => {
    const spark = rd("src/utils/lakehouse/sparkQuery.server.ts");
    expect(spark).toContain("loadPolicies(");
    expect(spark).not.toContain("lakehouse_table_policies");
    const core = rd("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("loadPolicies(");
  });

  it("owners manage rules through validated server functions", () => {
    const fn = rd("src/utils/lakehouse.functions.ts");
    expect(fn).toContain("export const listLakehouseTagPolicies");
    expect(fn).toContain("export const setLakehouseTagPolicy");
    expect(fn).toContain("export const deleteLakehouseTagPolicy");
    expect(fn).toContain('scope: z.enum(["column", "table"])');
    // A table rule's filter is checked against every table carrying the tag,
    // matched the way enforcement matches: a "Restricted" asset is checked by
    // a "restricted" rule. Seen live: a case-sensitive database pre-filter
    // found no table and let a filter over a missing column through.
    expect(fn).toContain("which carries");
    expect(fn).not.toContain('.contains("tags"');
    expect(fn).toContain('{ onConflict: "user_id,tag,scope" }');
    expect(fn).toContain('action: "lakehouse.tag_policy"');
  });

  it("the lakehouse page offers the rules beside New schema; the catalog drawer tags columns", () => {
    const page = rd("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain("{data?.enabled && <TagPoliciesDialog />}");
    expect(page).toContain("Tables with the tag — filter rows");
    const drawer = rd("src/components/catalog/CatalogView.tsx");
    expect(drawer).toContain("aria-label={`Tags for column ${c.name}`}");
    expect(drawer).toContain("columnTagsDirty");
    expect(rd("src/lib/dataCatalog.ts")).toContain("columns?: CatalogColumn[];");
  });

  it("the crawler carries column tags forward, like descriptions", () => {
    const crawler = rd("src/utils/catalog/crawler.server.ts");
    expect(crawler).toContain("const prevTags = new Map(");
    expect(crawler).toContain("if (t) col.tags = t;");
  });
});
