// A catalog column that holds personal data keeps no value read from its data
// (R556): no sample, no range. The catalog can be shared read-only with people
// who have no access to the data, and it outlived erasure and masking at the
// source; "AI docs" sent the sample to the model.
//
// What is held here is the application's half, through the real writers: a
// crawl's write, a sheet published to the lakehouse, a tag saved in the panel,
// and AI docs (its prompt and its write). The database applies the same rule
// to every write, plus the owner's mask rules and row filters; that half is
// pinned below and was run against a real Postgres (docs/ADVERSARIAL_LOG.md).
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  prompts: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: async (rows: Array<Record<string, unknown>>) => {
        h.upserts.push(...rows);
        return { error: null };
      },
      insert: async () => ({ error: null }),
      delete: () => ({ in: async () => ({ error: null }) }),
    }),
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "catalog_assets") throw new Error(`unexpected write to ${table}`);
      return {
        update: (payload: Record<string, unknown>) => {
          h.updates.push(payload);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  },
}));

const { keepableColumn, keepsNoValues, withoutValues } = await import("@/lib/catalogColumnValues");
const { columnsFromRows, persistAssets } = await import("@/utils/catalog/crawler.server");
const { docsColumnLine, generateAssetDocs, updateCatalogAsset } = await import("@/lib/dataCatalog");

type Col = Record<string, unknown> & { name: string };
const named = (cols: unknown, name: string) => (cols as Col[]).find((c) => c.name === name)!;

beforeEach(() => {
  h.upserts = [];
  h.updates = [];
  h.prompts = [];
  vi.unstubAllGlobals();
});

describe("which columns keep no value", () => {
  it("one judged personal, or tagged pii however it is spelled", () => {
    expect(keepsNoValues({ pii: true })).toBe(true);
    expect(keepsNoValues({ tags: ["metric", " PII "] })).toBe(true);
    expect(keepsNoValues({ pii: false, tags: ["metric"] })).toBe(false);
    expect(keepsNoValues({ tags: "pii" })).toBe(false);
    expect(keepsNoValues({})).toBe(false);
  });

  it("loses its sample and range and nothing else, and the input is untouched", () => {
    const c = {
      name: "phone",
      type: "number",
      pii: true,
      pii_kind: "phone",
      pii_evidence: "20 of 20 values are phone numbers.",
      sample: "5551234",
      min: 5550000,
      max: 5559999,
      null_pct: 0,
      distinct_count: 20,
    };
    const kept = withoutValues(c);
    expect(kept).toEqual({
      name: "phone",
      type: "number",
      pii: true,
      pii_kind: "phone",
      pii_evidence: "20 of 20 values are phone numbers.",
      null_pct: 0,
      distinct_count: 20,
    });
    expect(c.sample).toBe("5551234");
    expect(keepableColumn({ name: "city", type: "string", sample: "Oslo" })).toEqual({
      name: "city",
      type: "string",
      sample: "Oslo",
    });
  });
});

describe("a crawl's write", () => {
  it("keeps no value of a personal column, including one its owner tagged before", async () => {
    await persistAssets(
      "u1",
      "s1",
      [
        {
          asset_type: "dataset",
          schema_name: null,
          name: "people",
          fqn: "raw/people/*.csv",
          columns: [
            {
              name: "contact",
              type: "string",
              pii: true,
              pii_kind: "email",
              pii_evidence: "20 of 20 values are email addresses.",
              sample: "person0@example.com",
            },
            { name: "phone", type: "number", sample: "5551234", min: 5550000, max: 5559999 },
            { name: "city", type: "string", sample: "Oslo", min: undefined },
          ],
          pii: true,
        },
      ] as never,
      [
        {
          id: "a1",
          fqn: "raw/people/*.csv",
          columns: [{ name: "phone", type: "number", tags: ["PII"] }],
          row_count: 20,
          schema_hash: null,
          description: null,
          tags: [],
        },
      ],
    );
    expect(h.upserts).toHaveLength(1);
    const cols = h.upserts[0].columns;
    expect(named(cols, "contact")).not.toHaveProperty("sample");
    expect(named(cols, "contact").pii_evidence).toBe("20 of 20 values are email addresses.");
    expect(named(cols, "phone")).not.toHaveProperty("sample");
    expect(named(cols, "phone")).not.toHaveProperty("min");
    expect(named(cols, "phone")).not.toHaveProperty("max");
    expect(named(cols, "phone").tags).toEqual(["PII"]);
    expect(named(cols, "city").sample).toBe("Oslo");
  });
});

describe("a sheet published to the lakehouse", () => {
  const rows = [1, 2, 3, 4, 5].map((i) => [`reader${i}@example.com`, i === 1 ? null : "Lyon", i]);

  it("is judged from the rows read, and a personal column keeps no sample", () => {
    const cols = columnsFromRows(
      [
        { name: "reach_me", type: "VARCHAR" },
        { name: "city", type: "VARCHAR" },
        { name: "n", type: "BIGINT" },
      ],
      rows,
    );
    const reach = named(cols, "reach_me");
    expect(reach.pii).toBe(true);
    expect(reach.pii_kind).toBe("email");
    expect(reach).not.toHaveProperty("sample");
    expect(reach).not.toHaveProperty("values");
    // The first value that is there, not the first row's null.
    expect(named(cols, "city").sample).toBe("Lyon");
    expect(named(cols, "city").pii).toBeUndefined();
    expect(named(cols, "n").sample).toBe("1");
  });

  it("a personal name with too few values to overrule it keeps no sample either", () => {
    const cols = columnsFromRows([{ name: "email", type: "BIGINT" }], [[1], [2], [3]]);
    expect(named(cols, "email").pii).toBe(true);
    expect(named(cols, "email")).not.toHaveProperty("sample");
  });
});

describe("a tag saved in the catalog panel", () => {
  it("takes the column's sample with it in the same write", async () => {
    await updateCatalogAsset("a1", {
      tags: ["sales"],
      columns: [
        { name: "city", type: "string", sample: "Oslo", tags: ["pii"] },
        { name: "n", type: "number", sample: "3", min: 1, max: 5, tags: ["metric"] },
      ],
    });
    const cols = h.updates[0].columns;
    expect(named(cols, "city")).not.toHaveProperty("sample");
    expect(named(cols, "n")).toMatchObject({ sample: "3", min: 1, max: 5 });
    expect(h.updates[0].tags).toEqual(["sales"]);
  });

  it("leaves the columns out when they were not changed", async () => {
    await updateCatalogAsset("a1", { description: "People we write to" });
    expect(h.updates[0]).toEqual({ description: "People we write to" });
  });
});

describe("AI docs", () => {
  it("describes a personal column by what it holds, never by an example", () => {
    expect(
      docsColumnLine({
        name: "contact",
        type: "string",
        pii: true,
        pii_kind: "email",
        sample: "a@example.com",
      }),
    ).toBe("- contact (string, personal data: email addresses)");
    expect(docsColumnLine({ name: "x", type: "string", pii: true, pii_kind: "constructor" })).toBe(
      "- x (string, personal data)",
    );
    expect(docsColumnLine({ name: "y", type: "string", tags: ["pii"], sample: "z" })).toBe(
      "- y (string, personal data)",
    );
    expect(docsColumnLine({ name: "city", type: "string", sample: "Oslo" })).toBe(
      '- city (string, e.g. "Oslo")',
    );
  });

  it("sends the model no personal value, and writes back none", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      h.prompts.push(JSON.parse(init.body).userPrompt);
      return new Response(
        JSON.stringify({
          result: {
            description: "People we write to.",
            columns: { contact: "Where to write", city: "Town" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const res = await generateAssetDocs("token", {
      id: "a1",
      fqn: "raw/people/*.csv",
      asset_type: "dataset",
      format: "csv",
      row_count: 20,
      // A row written before the migration still holds the sample.
      columns: [
        {
          name: "contact",
          type: "string",
          pii: true,
          pii_kind: "email",
          sample: "person0@example.com",
        },
        { name: "city", type: "string", sample: "Oslo" },
      ],
    } as never);
    expect(h.prompts[0]).not.toContain("person0@example.com");
    expect(h.prompts[0]).toContain("- contact (string, personal data: email addresses)");
    expect(h.prompts[0]).toContain('- city (string, e.g. "Oslo")');
    expect(named(h.updates[0].columns, "contact")).not.toHaveProperty("sample");
    expect(named(h.updates[0].columns, "contact").description).toBe("Where to write");
    expect(named(res.columns, "city").sample).toBe("Oslo");
  });
});

describe("where the rule is used", () => {
  const view = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");
  const sheets = readFileSync("src/utils/sheetsPublish.functions.ts", "utf8");
  const sql = readFileSync(
    "supabase/migrations/20261213000000_catalog_hidden_column_values.sql",
    "utf8",
  );

  it("the panel shows no sample or range of a column that keeps none, and says why", () => {
    expect(view).toMatch(/!keepsNoValues\(c\) && c\.min !== undefined && c\.max !== undefined/);
    // Personal, or emptied by the database for a mask or row filter.
    expect(view).toMatch(
      /\{keepsNoValues\(c\) \|\| c\.values_hidden === true \? \(\s*<td[\s\S]{0,200}title=\{keepsNoValues\(c\) \? NO_SAMPLE_TITLE : HIDDEN_SAMPLE_TITLE\}/,
    );
  });

  it("publishing a sheet builds its columns through the crawler's rule", () => {
    expect(sheets).toContain("columnsFromRows(described.columns, described.rows)");
    expect(sheets).not.toMatch(/isPiiColumn\(/);
  });

  it("the database applies it on every write, to rules written later, and to what is kept", () => {
    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE OF columns, tags, schema_name, name ON public\.catalog_assets\s+FOR EACH ROW EXECUTE FUNCTION public\.catalog_strip_hidden_values\(\)/,
    );
    expect(sql).toMatch(
      /THEN \(e\.c - 'sample' - 'min' - 'max'\) \|\| '\{"values_hidden": true\}'::jsonb\s+ELSE e\.c - 'values_hidden'/,
    );
    expect(sql).toMatch(/AFTER INSERT OR UPDATE ON public\.lakehouse_table_policies/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE ON public\.lakehouse_tag_policies/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.catalog_strip_hidden_values\(\) FROM public, anon, authenticated;/,
    );
    // The backfill is the last statement, after the trigger exists.
    expect(sql.lastIndexOf("UPDATE public.catalog_assets a")).toBeGreaterThan(
      sql.indexOf("CREATE TRIGGER catalog_assets_strip_hidden_values"),
    );
    expect((sql.match(/SET search_path = ''/g) ?? []).length).toBe(2);
  });
});
