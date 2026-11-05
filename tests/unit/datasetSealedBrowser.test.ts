// What the page does with a dataset that says its rows go through the server
// (R452). The real engine and the real helpers, over a fake database and fake
// server functions: the assertion is which of the two was asked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tables: [] as Array<Record<string, unknown>>,
  count: 1,
  direct: [] as string[],
  server: [] as string[],
  signedOut: false,
  // What each server function answers, when it is told to.
  windowAnswer: null as null | { ok: false; error: string },
  sharedAnswer: null as null | { ok: false; error: string },
  writeAnswer: null as null | { ok: false; error: string },
  throughAnswer: { ok: true, through: false } as
    { ok: true; through: boolean } | { ok: false; error: string },
  registered: [] as Array<{ name: string; rows: unknown[] }>,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b = {
      validator: () => b,
      inputValidator: () => b,
      handler: () => async () => ({ ok: true }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => ({
    select: (_cols: string, opts?: { head?: boolean }) => {
      if (table === "user_data_tables") {
        return {
          not: () => ({ order: async () => ({ data: h.tables, error: null }) }),
        };
      }
      if (opts?.head) return { eq: async () => ({ count: h.count, error: null }) };
      return {
        eq: (_c: string, id: string) => ({
          order: () => ({
            range: async () => {
              h.direct.push(`rows:${id}`);
              return { data: [{ row: { from: "direct" } }], error: null };
            },
          }),
        }),
      };
    },
  });
  return {
    supabase: {
      from,
      rpc: async (_name: string, args: { _table_id: string }) => {
        h.direct.push(`rpc:${args._table_id}`);
        return { data: [{ from: "rpc" }], error: null };
      },
      auth: {
        getSession: async () => ({
          data: {
            session: h.signedOut ? null : { access_token: "tok", user: { id: "me" } },
          },
        }),
      },
    },
  };
});
vi.mock("@/utils/datasetRows.functions", () => ({
  datasetRowsGoThroughServer: async () => h.throughAnswer,
  readDatasetWindow: async ({ data }: { data: { table_id: string; access_token: string } }) => {
    h.server.push(`window:${data.table_id}:${data.access_token}`);
    return h.windowAnswer ?? { ok: true, rows: [{ from: "server" }] };
  },
  readSharedDataset: async ({ data }: { data: { table_id: string } }) => {
    h.server.push(`shared:${data.table_id}`);
    return h.sharedAnswer ?? { ok: true, rows: [{ from: "server" }] };
  },
  writeDatasetBatch: async ({ data }: { data: { table_id: string; rows: unknown[] } }) => {
    h.server.push(`write:${data.table_id}:${data.rows.length}`);
    return h.writeAnswer ?? { ok: true };
  },
}));
vi.mock("@/lib/browserDuckdb", () => ({
  dropBrowserTable: async () => {},
  isBrowserTableRegistered: () => false,
  prewarmBrowserEngine: async () => {},
  registerBrowserTables: async (t: Array<{ name: string; rows: unknown[] }>) => {
    h.registered.push(...t);
  },
  runBrowserSql: async () => ({ rows: [], columns: [] }),
}));

const { hydrateFromSupabase } = await import("@/lib/sqlEngine");
const { datasetWindow, savesGoThroughServer, sharedDatasetRows, writeRowsThroughServer } =
  await import("@/lib/datasetRowReads");

const dataset = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "sales",
  source_filename: null,
  columns: [{ name: "from", type: "string" }],
  is_sample: false,
  user_id: "me",
  data_loaded_at: null,
  parquet_bytes: null,
  ...over,
});

beforeEach(() => {
  h.tables = [];
  h.count = 1;
  h.direct = [];
  h.server = [];
  h.registered = [];
  h.signedOut = false;
  h.windowAnswer = null;
  h.sharedAnswer = null;
  h.writeAnswer = null;
  h.throughAnswer = { ok: true, through: false };
});

describe("hydrating", () => {
  it("reads a dataset as it always did when the column is not there yet", async () => {
    h.tables = [dataset()];
    await hydrateFromSupabase();
    expect(h.direct).toEqual(["rows:t1"]);
    expect(h.server).toEqual([]);
  });

  it("reads a dataset as it always did when it is not marked", async () => {
    h.tables = [dataset({ rows_sealed: false })];
    await hydrateFromSupabase();
    expect(h.direct).toEqual(["rows:t1"]);
    expect(h.server).toEqual([]);
  });

  it("asks the server for a marked dataset's rows, and not the database", async () => {
    h.tables = [dataset({ rows_sealed: true })];
    const [meta] = await hydrateFromSupabase();
    expect(h.direct).toEqual([]);
    expect(h.server).toEqual(["window:t1:tok"]);
    expect(h.registered[0].rows).toEqual([{ from: "server" }]);
    expect(meta.row_count).toBe(1);
  });

  it("asks the server for a marked dataset shared with this user", async () => {
    h.tables = [dataset({ rows_sealed: true, user_id: "someone-else" })];
    await hydrateFromSupabase();
    expect(h.direct).toEqual([]);
    expect(h.server).toEqual(["shared:t1"]);
  });

  it("reads an unmarked shared dataset through the database function, as before", async () => {
    h.tables = [dataset({ user_id: "someone-else" })];
    await hydrateFromSupabase();
    expect(h.direct).toEqual(["rpc:t1"]);
    expect(h.server).toEqual([]);
  });

  it("goes by each dataset, not by the account", async () => {
    h.tables = [dataset({ rows_sealed: true }), dataset({ id: "t2", name: "other" })];
    await hydrateFromSupabase();
    expect(h.direct).toEqual(["rows:t2"]);
    expect(h.server).toEqual(["window:t1:tok"]);
  });

  it("does not register part of a marked dataset when a window fails", async () => {
    h.tables = [dataset({ rows_sealed: true })];
    h.windowAnswer = { ok: false, error: "the key is gone" };
    await expect(hydrateFromSupabase()).rejects.toThrow(/the key is gone/);
    expect(h.registered).toEqual([]);
  });
});

describe("the helpers", () => {
  it("each say what went wrong rather than hand back nothing", async () => {
    h.windowAnswer = { ok: false, error: "no window" };
    h.sharedAnswer = { ok: false, error: "no share" };
    h.writeAnswer = { ok: false, error: "no write" };
    await expect(datasetWindow("t", 0, 10)).rejects.toThrow("no window");
    await expect(sharedDatasetRows("t")).rejects.toThrow("no share");
    await expect(writeRowsThroughServer("t", [{ a: 1 }])).rejects.toThrow("no write");
  });

  it("a write that worked says nothing, and sends what it was given", async () => {
    await expect(writeRowsThroughServer("t", [{ a: 1 }, { a: 2 }])).resolves.toBeUndefined();
    expect(h.server).toEqual(["write:t:2"]);
  });

  it("someone signed out is told so", async () => {
    h.signedOut = true;
    await expect(datasetWindow("t", 0, 10)).rejects.toThrow("You are signed out");
  });
});

describe("who saves through the server", () => {
  it("is what the server says", async () => {
    expect(await savesGoThroughServer()).toBe(false);
    h.throughAnswer = { ok: true, through: true };
    expect(await savesGoThroughServer()).toBe(true);
  });

  it("is yes when the server cannot say: the other answer leaves rows where the browser put them", async () => {
    h.throughAnswer = { ok: false, error: "down" };
    expect(await savesGoThroughServer()).toBe(true);
  });
});
