// Sample seeding under a failed read.
//
// Found while driving /data-sql with every user_data_tables request rejected.
// The mount path treats an empty dataset list as an empty account and calls
// ensureSampleDataset; the injection log then filled with the seeder's own
// existence checks — `select=id&name=eq.saas_sales&is_sample=eq.true` — each
// one rejected. ensureOneSample read that result as
//
//   const { data: existing } = await supabase.from("user_data_tables")...maybeSingle();
//   if (existing) return false;
//   await seedPublicSample(spec);
//
// so a failed check was indistinguishable from an absent sample, and every
// failure went on to seed. The registration RPC happens to return the existing
// id without writing, which is the only reason the measured round changed
// nothing. The row insert below it is guarded the same way — a count read whose
// error is dropped — and a failed count reads as 0, which inserts every sample
// row again on top of the rows already there.
//
// These are behavioural: the real ensureSampleDataset runs against a supabase
// client whose reads are made to fail one at a time, and the assertions are on
// which RPCs were sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Err = { message: string } | null;

const state = vi.hoisted(() => ({
  existing: { data: null as { id: string } | null, error: null as Err },
  count: { count: 5 as number | null, error: null as Err },
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  headSelects: 0,
}));

vi.mock("@/integrations/supabase/client", () => {
  const chain = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "is", "not", "order"]) b[m] = () => b;
    b.maybeSingle = () => Promise.resolve(state.existing);
    // A head select is awaited directly, so the builder itself is the thenable.
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(state.count).then(res, rej);
    return b;
  };
  return {
    supabase: {
      from: () => ({
        select: (_cols: string, opts?: { head?: boolean }) => {
          if (opts?.head) state.headSelects += 1;
          return chain();
        },
      }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        state.rpc.push({ name, args });
        return name === "upsert_sample_dataset"
          ? { data: "tid-1", error: null }
          : { data: null, error: null };
      },
    },
  };
});

vi.mock("@/lib/sqlEngine", () => ({
  parseCsv: async () => ({
    rows: [{ a: 1 }, { a: 2 }],
    columns: [{ name: "a", type: "number" }],
  }),
}));

const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "a\n1\n2" }));

const upserts = () => state.rpc.filter((c) => c.name === "upsert_sample_dataset");
const inserts = () => state.rpc.filter((c) => c.name === "insert_sample_rows");

describe("ensureSampleDataset under a failed read", () => {
  beforeEach(() => {
    state.existing = { data: null, error: null };
    state.count = { count: 5, error: null };
    state.rpc = [];
    state.headSelects = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a failed existence check does not seed", async () => {
    const { ensureSampleDataset } = await import("@/lib/sampleData");
    state.existing = { data: null, error: { message: "injected: user_data_tables unreachable" } };
    await expect(ensureSampleDataset("u1")).rejects.toThrow(
      /could not check for sample saas_sales: injected: user_data_tables unreachable/,
    );
    expect(state.rpc, "no RPC may follow a failed check").toEqual([]);
    expect(fetchMock, "the CSV is not even fetched").not.toHaveBeenCalled();
  });

  it("a sample that is present is left alone", async () => {
    const { ensureSampleDataset } = await import("@/lib/sampleData");
    state.existing = { data: { id: "t-existing" }, error: null };
    await expect(ensureSampleDataset("u1")).resolves.toBe(false);
    expect(state.rpc).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed row count does not insert rows", async () => {
    // Before: count null → treated as 0 → every sample row inserted again on
    // top of the rows already in the table.
    const { ensureSampleDataset } = await import("@/lib/sampleData");
    state.count = { count: null, error: { message: "rows unreachable" } };
    await expect(ensureSampleDataset("u1")).rejects.toThrow(
      /could not count rows of saas_sales: rows unreachable/,
    );
    expect(upserts()).toHaveLength(1);
    expect(inserts(), "a failed count must never become an insert").toHaveLength(0);
    expect(state.headSelects).toBe(1);
  });

  it("an absent registration over a populated table is registered, not re-filled", async () => {
    const { ensureSampleDataset } = await import("@/lib/sampleData");
    state.count = { count: 5, error: null };
    await expect(ensureSampleDataset("u1")).resolves.toBe(true);
    expect(upserts().length).toBeGreaterThan(1);
    expect(inserts()).toHaveLength(0);
  });

  it("an absent sample over an empty table is seeded in full", async () => {
    const { ensureSampleDataset } = await import("@/lib/sampleData");
    state.count = { count: 0, error: null };
    await expect(ensureSampleDataset("u1")).resolves.toBe(true);
    const n = upserts().length;
    expect(n).toBeGreaterThan(1);
    expect(inserts()).toHaveLength(n);
    for (const call of inserts()) {
      expect(call.args._table_id).toBe("tid-1");
      expect(call.args._rows).toHaveLength(2);
    }
  });
});
