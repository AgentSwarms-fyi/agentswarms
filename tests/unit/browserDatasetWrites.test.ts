// The browser's dataset writes, and what they say when the database says no.
//
// FOUND IN R106. `deleteDataset` and `saveDataset` in lib/sqlEngine.ts are the
// browser's copies of writes the server already had fixed (R87). Neither
// read the database's answer.
//
//   - Delete: driven on BI → Data preparation with a scratch dataset
//     `r106_scratch` and the DELETE on user_data_tables made to fail. The
//     toast read `Deleted "r106_scratch"`, and the refreshed list still showed
//     `r106_scratch · 33 cols · 4 rows`. The table had also been dropped from
//     the page's engine.
//   - Save over an existing name (the warehouse import): the delete of the
//     old rows was not checked, so a failed delete left them and appended the
//     new rows below, a doubled dataset under "Imported N rows". R87 in the
//     browser.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  lookup: { data: null as { id: string } | null, error: null as { message: string } | null },
  clearErr: null as { message: string } | null,
  metaErr: null as { message: string } | null,
  deleteResult: {
    data: [{ id: "t-1" }] as { id: string }[] | null,
    error: null as { message: string } | null,
  },
  calls: [] as string[],
};

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => ({
    select: () => {
      const q: any = { eq: () => q, maybeSingle: async () => state.lookup };
      return q;
    },
    delete: () => ({
      eq: () => {
        state.calls.push(`${table}.delete`);
        const p: any = Promise.resolve(
          table === "user_data_rows" ? { error: state.clearErr } : state.deleteResult,
        );
        p.select = async () => state.deleteResult;
        return p;
      },
    }),
    update: () => ({
      eq: async () => {
        state.calls.push(`${table}.update`);
        return { error: state.metaErr };
      },
    }),
    insert: () => {
      state.calls.push(`${table}.insert`);
      const p: any = Promise.resolve({ error: null });
      p.select = () => ({ single: async () => ({ data: { id: "new-id" }, error: null }) });
      return p;
    },
  });
  return { supabase: { from, auth: { getSession: async () => ({ data: { session: null } }) } } };
});

vi.mock("@/lib/browserDuckdb", () => ({
  dropBrowserTable: async (name: string) => {
    state.calls.push(`engine.drop:${name}`);
  },
  isBrowserTableRegistered: () => false,
  prewarmBrowserEngine: async () => {},
  registerBrowserTables: async () => {},
  runBrowserSql: async () => ({ rows: [], columns: [] }),
}));

const { deleteDataset, saveDataset } = await import("@/lib/sqlEngine");

const SAVE = {
  userId: "owner",
  tableName: "r106_scratch",
  sourceFilename: "warehouse:My Snowflake",
  rows: [{ id: 1 }, { id: 2 }],
  columns: [{ name: "id", type: "number" as const }],
};

beforeEach(() => {
  state.lookup = { data: null, error: null };
  state.clearErr = null;
  state.metaErr = null;
  state.deleteResult = { data: [{ id: "t-1" }], error: null };
  state.calls = [];
});

describe("a delete says Deleted only when the row is gone", () => {
  it("throws the database's refusal, and leaves the page's table alone", async () => {
    // The whole bug: this resolved, and the page toasted "Deleted".
    state.deleteResult = { data: null, error: { message: "R106 injected" } };
    await expect(deleteDataset("t-1", "r106_scratch")).rejects.toThrow(
      /"r106_scratch" was not deleted: R106 injected/,
    );
    expect(state.calls).not.toContain("engine.drop:r106_scratch");
  });

  it("treats a delete that removed nothing as not deleted", async () => {
    // Row-level security filters a delete out without an error.
    state.deleteResult = { data: [], error: null };
    await expect(deleteDataset("t-1", "r106_scratch")).rejects.toThrow(
      /not yours to delete, or it was already gone/,
    );
    expect(state.calls).not.toContain("engine.drop:r106_scratch");
  });

  it("drops the page's table once the row is really gone", async () => {
    await deleteDataset("t-1", "r106_scratch");
    expect(state.calls).toEqual(["user_data_tables.delete", "engine.drop:r106_scratch"]);
  });
});

describe("a replace never appends to rows it could not clear", () => {
  it("stops when the old rows cannot be cleared", async () => {
    state.lookup = { data: { id: "t-1" }, error: null };
    state.clearErr = { message: "statement timeout" };
    await expect(saveDataset(SAVE)).rejects.toThrow(
      /previous rows of "r106_scratch" could not be cleared: statement timeout\. Nothing was written/,
    );
    expect(state.calls).not.toContain("user_data_rows.insert");
    expect(state.calls).not.toContain("user_data_tables.update");
  });

  it("stops when the dataset's details cannot be updated", async () => {
    state.lookup = { data: { id: "t-1" }, error: null };
    state.metaErr = { message: "permission denied" };
    await expect(saveDataset(SAVE)).rejects.toThrow(/could not be updated: permission denied/);
    expect(state.calls).not.toContain("user_data_rows.insert");
  });

  it("stops when it cannot tell whether the name exists", async () => {
    // Guessing "no" would create a second dataset of the same name.
    state.lookup = { data: null, error: { message: "connection reset" } };
    await expect(saveDataset(SAVE)).rejects.toThrow(/Could not check whether "r106_scratch"/);
    expect(state.calls).toEqual([]);
  });

  it("clears, then writes, when everything answers", async () => {
    state.lookup = { data: { id: "t-1" }, error: null };
    const saved = await saveDataset(SAVE);
    expect(saved.row_count).toBe(2);
    const clear = state.calls.indexOf("user_data_rows.delete");
    const insert = state.calls.indexOf("user_data_rows.insert");
    expect(clear).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(clear);
  });

  it("creates a new dataset when the name is free", async () => {
    const saved = await saveDataset(SAVE);
    expect(saved.id).toBe("new-id");
    expect(state.calls).toEqual(["user_data_tables.insert", "user_data_rows.insert"]);
  });
});
