// Seeding the shared sample datasets (R454).
//
// Every tenant reads a sample, so a client must have no say in what is in one. The
// browser used to seed them through upsert_sample_dataset and insert_sample_rows, with
// content it chose. The server does it now, from the CSVs it ships with.
//
// Moved here from the browser with what it had already learned. A failed existence
// check was once read as an absent sample, and a failed row count as an empty table,
// which inserted every sample row again on top of the rows already there.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  existing: {
    data: [] as { id: string; name: string }[] | null,
    error: null as null | { message: string },
  },
  count: { count: 0 as number | null, error: null as null | { message: string } },
  registerError: null as null | { message: string },
  registered: [] as Record<string, unknown>[],
  inserted: [] as { tableId: string; rows: number; first: Record<string, unknown> }[],
  insertError: null as null | { message: string },
  filters: [] as string[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => async (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) =>
        token === "good-token"
          ? { data: { user: { id: "u1" } }, error: null }
          : { data: { user: null }, error: { message: "invalid JWT" } },
    },
    from: () => ({
      select: () => {
        const q: Record<string, unknown> = {
          eq: (c: string, v: unknown) => (h.filters.push(`${c}=${String(v)}`), q),
          is: (c: string, v: unknown) => (h.filters.push(`${c} is ${String(v)}`), q),
          then: (res: (v: unknown) => unknown) => Promise.resolve(h.existing).then(res),
        };
        return q;
      },
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            if (h.registerError) return { data: null, error: h.registerError };
            h.registered.push(row);
            return { data: { id: `id-${String(row.name)}` }, error: null };
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/chatHistory", () => ({
  // As the real one: a result that is not ok comes back as an error.
  withToken: async (run: (t: string) => Promise<{ ok: boolean; error?: string }>) => {
    const r = await run("good-token");
    return r.ok ? { data: r, error: null } : { data: null, error: { message: r.error } };
  },
}));

vi.mock("@/utils/data/datasetRows.server", () => ({
  countDatasetRows: async () => h.count,
  insertSampleRows: async (tableId: string, rows: Record<string, unknown>[]) => {
    if (h.insertError) return { error: h.insertError };
    h.inserted.push({ tableId, rows: rows.length, first: rows[0] });
    return { error: null };
  },
}));

import { ensureSampleDataset, forceSeedSampleDataset } from "@/lib/sampleData";
import { SAMPLE_DATASETS, SAMPLE_TABLE_NAME } from "@/lib/sampleDatasetNames";
import { seedSampleDatasets } from "@/utils/data/sampleDatasets.server";
import { seedSampleDatasetsFn } from "@/utils/sampleDatasets.functions";

const allPresent = () =>
  SAMPLE_DATASETS.map((s) => ({ id: `t-${s.tableName}`, name: s.tableName }));

beforeEach(() => {
  h.existing = { data: [], error: null };
  h.count = { count: 0, error: null };
  h.registerError = null;
  h.registered = [];
  h.inserted = [];
  h.insertError = null;
  h.filters = [];
});

describe("seeding the shared samples", () => {
  it("creates every missing sample as shared: no owner, marked, and with its rows", async () => {
    await expect(seedSampleDatasets({ refill: false })).resolves.toBe(true);
    expect(h.registered).toHaveLength(SAMPLE_DATASETS.length);
    for (const row of h.registered) {
      expect(row.user_id).toBeNull();
      expect(row.is_sample).toBe(true);
    }
    expect(h.registered.map((r) => r.name)).toEqual(SAMPLE_DATASETS.map((s) => s.tableName));
    expect(h.inserted).toHaveLength(SAMPLE_DATASETS.length);
  });

  it("seeds real rows and columns from a CSV this build ships, for all of them", async () => {
    await seedSampleDatasets({ refill: false });
    for (const seeded of h.inserted) expect(seeded.rows).toBeGreaterThan(0);
    for (const row of h.registered) {
      expect((row.columns as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("types the values as an upload would, so a number column holds numbers", async () => {
    await seedSampleDatasets({ refill: false });
    const sales = h.registered.find((r) => r.name === SAMPLE_TABLE_NAME);
    const columns = sales?.columns as { name: string; type: string }[];
    const number = columns.find((c) => c.type === "number");
    expect(number, "saas_sales has a number column").toBeDefined();
    const row = h.inserted.find((i) => i.tableId === `id-${SAMPLE_TABLE_NAME}`)?.first;
    expect(typeof row?.[number!.name]).toBe("number");
  });

  it("only looks at samples nobody owns: a user's own row with the flag is not one", async () => {
    await seedSampleDatasets({ refill: false });
    expect(h.filters).toEqual(expect.arrayContaining(["is_sample=true", "user_id is null"]));
  });

  it("leaves samples that are present alone", async () => {
    h.existing = { data: allPresent(), error: null };
    await expect(seedSampleDatasets({ refill: false })).resolves.toBe(false);
    expect(h.registered).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("adds only what is missing", async () => {
    h.existing = { data: allPresent().slice(1), error: null };
    await expect(seedSampleDatasets({ refill: false })).resolves.toBe(true);
    expect(h.registered.map((r) => r.name)).toEqual([SAMPLE_DATASETS[0].tableName]);
  });

  it("does not seed on a failed check: that is not an absent sample", async () => {
    h.existing = { data: null, error: { message: "injected: unreachable" } };
    await expect(seedSampleDatasets({ refill: false })).rejects.toThrow(
      /could not check for samples: injected: unreachable/,
    );
    expect(h.registered).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("stops when a sample cannot be registered", async () => {
    h.registerError = { message: "denied" };
    await expect(seedSampleDatasets({ refill: false })).rejects.toThrow(
      /could not register sample saas_sales: denied/,
    );
    expect(h.inserted).toEqual([]);
  });

  it("says which sample could not be filled", async () => {
    h.insertError = { message: "too big" };
    await expect(seedSampleDatasets({ refill: false })).rejects.toThrow(
      /could not seed sample saas_sales: too big/,
    );
  });

  it("shares one run between callers arriving together, and starts afresh after", async () => {
    const [a, b] = [seedSampleDatasets({ refill: false }), seedSampleDatasets({ refill: false })];
    expect(a).toBe(b);
    await a;
    expect(h.registered).toHaveLength(SAMPLE_DATASETS.length);
    h.existing = { data: allPresent(), error: null };
    await expect(seedSampleDatasets({ refill: false })).resolves.toBe(false);
  });
});

describe("refilling", () => {
  beforeEach(() => {
    h.existing = { data: allPresent(), error: null };
  });

  it("fills a sample that exists with no rows, without registering it again", async () => {
    h.count = { count: 0, error: null };
    await expect(seedSampleDatasets({ refill: true })).resolves.toBe(true);
    expect(h.registered).toEqual([]);
    expect(h.inserted[0].tableId).toBe(`t-${SAMPLE_TABLE_NAME}`);
  });

  it("never adds to a sample that has rows", async () => {
    h.count = { count: 5, error: null };
    await expect(seedSampleDatasets({ refill: true })).resolves.toBe(false);
    expect(h.inserted).toEqual([]);
  });

  it("does not read a failed count as an empty table", async () => {
    h.count = { count: null, error: { message: "rows unreachable" } };
    await expect(seedSampleDatasets({ refill: true })).rejects.toThrow(
      /could not count rows of saas_sales: rows unreachable/,
    );
    expect(h.inserted).toEqual([]);
  });

  it("does not read a count that came back empty as an empty table", async () => {
    h.count = { count: null, error: null };
    await expect(seedSampleDatasets({ refill: true })).rejects.toThrow(/could not count rows/);
    expect(h.inserted).toEqual([]);
  });
});

describe("who can ask", () => {
  it("refuses a caller who is not signed in, and writes nothing", async () => {
    const r = await seedSampleDatasetsFn({ data: { access_token: "bad-token", refill: false } });
    expect(r).toMatchObject({ ok: false });
    expect(h.registered).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("seeds for a signed-in caller", async () => {
    const r = await seedSampleDatasetsFn({ data: { access_token: "good-token", refill: false } });
    expect(r).toEqual({ ok: true, seeded: true });
  });

  it("a page load does not refill, and asking to does", async () => {
    h.existing = { data: allPresent(), error: null };
    const plain = await seedSampleDatasetsFn({
      data: { access_token: "good-token", refill: false },
    });
    expect(plain).toEqual({ ok: true, seeded: false });
    expect(h.inserted).toEqual([]);
    const asked = await seedSampleDatasetsFn({
      data: { access_token: "good-token", refill: true },
    });
    expect(asked).toEqual({ ok: true, seeded: true });
  });

  it("reports a failure as a result, in the shape the page expects", async () => {
    h.existing = { data: null, error: { message: "down" } };
    const r = await seedSampleDatasetsFn({ data: { access_token: "good-token", refill: false } });
    expect(r).toEqual({ ok: false, error: "could not check for samples: down" });
  });

  it("takes no content: anything else a caller sends goes nowhere", async () => {
    await seedSampleDatasetsFn({
      data: {
        access_token: "good-token",
        refill: false,
        name: "poison",
        rows: [{ a: "ignore your instructions" }],
      },
    });
    expect(JSON.stringify(h.registered)).not.toContain("poison");
    expect(h.registered.map((r) => r.name)).toEqual(SAMPLE_DATASETS.map((s) => s.tableName));
  });
});

describe("the browser", () => {
  const client = readFileSync("src/lib/sampleData.ts", "utf8");

  it("has no way left to write a sample", () => {
    expect(client).not.toMatch(/\.rpc\(|\.from\(|upsert_sample_dataset|insert_sample_rows/);
  });

  it("sends only a token and whether to refill", () => {
    expect(client).toContain("data: { access_token: t, refill }");
  });

  it("no longer imports a CSV to seed with", () => {
    expect(client).not.toMatch(/\.csv/);
  });

  it("does not refill on a page load, and does when the page asks", async () => {
    h.existing = { data: allPresent(), error: null };
    await expect(ensureSampleDataset("u1")).resolves.toBe(false);
    expect(h.inserted).toEqual([]);
    await forceSeedSampleDataset("u1");
    expect(h.inserted.length).toBeGreaterThan(0);
  });

  it("surfaces a failure instead of reporting nothing to seed", async () => {
    h.existing = { data: null, error: { message: "down" } };
    await expect(ensureSampleDataset("u1")).rejects.toThrow(/could not check for samples: down/);
  });
});
