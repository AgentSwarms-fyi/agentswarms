// A dataset that says its rows go through the server (R452).
//
// Rows of a user under a customer key are to be sealed, and the browser holds no
// key, so it reads and writes those through the server. Everyone else is meant
// to notice nothing: no extra write, no new column touched, no change of path.
// A grantee reads through restrictSharedDataset, which answers nothing without a
// grant. Nothing is sealed yet: that is the next round.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
  grants: [] as Array<{ row_filter: unknown; column_mask: string[] }>,
  grantsThrow: false,
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
        token === "alice-token"
          ? { data: { user: { id: "00000000-0000-4000-8000-00000000a11c" } }, error: null }
          : token === "bob-token"
            ? { data: { user: { id: "00000000-0000-4000-8000-000000000b0b" } }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT" } },
    },
    from: (t: string) => h.db!.from(t),
  },
}));
vi.mock("@/utils/iam.server", () => ({
  readApplicableGrants: async () => {
    if (h.grantsThrow) throw new Error("could not read access grants: down");
    return h.grants;
  },
}));

import { __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import {
  datasetWriter,
  insertDatasetRows,
  mergeDatasetRows,
  moveDatasetRows,
  sealsDatasetRows,
  windowDatasetRows,
} from "@/utils/data/datasetRows.server";
import {
  datasetRowsGoThroughServer,
  readDatasetWindow,
  readSharedDataset,
  writeDatasetBatch,
} from "@/utils/datasetRows.functions";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SAMPLE = "33333333-3333-4333-8333-333333333333";

let fake: FakeDb;
let mem: MemoryKeyStore;

const table = (over: Record<string, unknown> = {}) => ({
  id: T1,
  user_id: ALICE,
  is_sample: false,
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
    { name: "secret", type: "string" },
  ],
  rows_sealed: false,
  ...over,
});
const rows = () => [
  { table_id: T1, row: { region: "EMEA", amount: 1, secret: "a" } },
  { table_id: T1, row: { region: "APAC", amount: 2, secret: "b" } },
  { table_id: T1, row: { region: "EMEA", amount: 3, secret: "c" } },
];

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({ user_data_tables: [table()], user_data_rows: rows() });
  h.db = fake.client as never;
  h.grants = [];
  h.grantsThrow = false;
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
  vi.restoreAllMocks();
});

const ok = <T>(r: T): Exclude<T, { ok: false }> => {
  const v = r as { ok: boolean; error?: string };
  if (!v.ok) throw new Error(`expected ok: ${v.error}`);
  return r as Exclude<T, { ok: false }>;
};
const underCustomerKey = (who: string) => {
  __setKeyHierarchyForTests({
    ...mem.store,
    memberships: async (u: string) =>
      u === who ? [{ customerKeyId: "ck", customerKeyName: "Acme", via: "user" as const }] : [],
    customerKey: async () => ({ id: "ck", name: "Acme", destroyed_at: null }) as never,
  });
};
const flag = (id = T1) =>
  (fake.tables.user_data_tables.find((t) => t.id === id) as { rows_sealed: boolean }).rows_sealed;
const tableWrites = () => fake.log.filter((l: string) => l === "update user_data_tables").length;

/** The database, with one operation on one table refused. */
const refusing = (table: string, op: string, message = "refused") => {
  const real = fake.client.from.bind(fake.client);
  h.db = {
    from: (t: string) => {
      const q = real(t) as unknown as Record<string, unknown>;
      if (t === table) {
        const answer = { data: null, error: { message } };
        const chain: Record<string, unknown> = {
          then: (ok: (v: unknown) => unknown) => Promise.resolve(answer).then(ok),
        };
        for (const m of ["eq", "order", "range", "maybeSingle"]) chain[m] = () => chain;
        q[op] = () => chain;
      }
      return q;
    },
  } as never;
};

describe("who has their rows go through the server", () => {
  it("someone under a customer key does; nobody else", async () => {
    underCustomerKey(ALICE);
    expect(await sealsDatasetRows(ALICE)).toBe(true);
    expect(await sealsDatasetRows(BOB)).toBe(false);
  });

  it("nobody, before the key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    expect(await sealsDatasetRows(ALICE)).toBe(false);
  });

  it("a lookup that fails counts as yes: that way nothing is left for the browser to write", async () => {
    __setKeyHierarchyForTests({
      ...mem.store,
      memberships: async () => {
        throw new Error("the database is down");
      },
    });
    expect(await sealsDatasetRows(ALICE)).toBe(true);
  });

  it("a user in two customers' groups counts as yes, and is not asked which", async () => {
    __setKeyHierarchyForTests({
      ...mem.store,
      memberships: async () =>
        [
          { customerKeyId: "a", customerKeyName: "A", via: "group", groupId: "g", groupName: "G" },
          { customerKeyId: "b", customerKeyName: "B", via: "group", groupId: "h", groupName: "H" },
        ] as never,
    });
    expect(await sealsDatasetRows(ALICE)).toBe(true);
  });
});

describe("marking a dataset", () => {
  it("marks it when rows are written for someone under a customer key", async () => {
    underCustomerKey(ALICE);
    await insertDatasetRows(T1, ALICE, [{ a: 1 }]);
    expect(flag()).toBe(true);
  });

  it("marks that dataset and no other", async () => {
    underCustomerKey(ALICE);
    fake.tables.user_data_tables.push(table({ id: T2, name: "other" }));
    await insertDatasetRows(T1, ALICE, [{ a: 1 }]);
    expect(flag()).toBe(true);
    expect(flag(T2)).toBe(false);
  });

  it("touches nothing for anyone else: not the column, not the table", async () => {
    await insertDatasetRows(T1, ALICE, [{ a: 1 }]);
    expect(flag()).toBe(false);
    expect(tableWrites()).toBe(0);
  });

  it("does nothing for no rows", async () => {
    underCustomerKey(ALICE);
    await insertDatasetRows(T1, ALICE, []);
    expect(flag()).toBe(false);
  });

  it("asks once for a whole upload, not once a flush", async () => {
    const asked = vi.spyOn(mem.store, "memberships");
    const writer = await datasetWriter(T1, ALICE);
    await writer.insert([{ a: 1 }]);
    await writer.insert([{ a: 2 }]);
    await writer.insert([{ a: 3 }]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(fake.tables.user_data_rows).toHaveLength(6);
  });

  it("marks where an upload's rows land, on a swap", async () => {
    underCustomerKey(ALICE);
    fake.tables.user_data_tables.push(table({ id: T2, name: "target" }));
    await moveDatasetRows(T1, T2, ALICE);
    expect(flag(T2)).toBe(true);
  });

  it("does not mark on a move that failed", async () => {
    underCustomerKey(ALICE);
    fake.tables.user_data_tables.push(table({ id: T2, name: "target" }));
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        if (t === "user_data_rows") {
          const refused = { eq: async () => ({ error: { message: "locked" } }) };
          q.update = () => refused;
        }
        return q;
      },
    } as never;
    expect(await moveDatasetRows(T1, T2, ALICE)).toEqual({ error: { message: "locked" } });
    expect(flag(T2)).toBe(false);
  });

  it("marks the dataset rows landed in, not the one they left", async () => {
    underCustomerKey(ALICE);
    fake.tables.user_data_tables.push(table({ id: T2, name: "target" }));
    await moveDatasetRows(T1, T2, ALICE);
    expect(flag()).toBe(false);
  });

  it("does not mark on a merge that failed", async () => {
    underCustomerKey(ALICE);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    (supabaseAdmin as unknown as { rpc: unknown }).rpc = async () => ({
      data: null,
      error: { message: "conflict" },
    });
    const r = await mergeDatasetRows({ targetId: T1, stagingId: T2, key: "id", owner: ALICE });
    expect(r.error).toEqual({ message: "conflict" });
    expect(flag()).toBe(false);
  });

  it("marks where a merge lands, and says what it did", async () => {
    underCustomerKey(ALICE);
    const client = fake.client as unknown as { rpc?: unknown };
    client.rpc = async () => ({ data: [{ updated: 1, inserted: 2 }], error: null });
    h.db = fake.client as never;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    (supabaseAdmin as unknown as { rpc: unknown }).rpc = client.rpc;
    const r = await mergeDatasetRows({ targetId: T1, stagingId: T2, key: "id", owner: ALICE });
    expect(r).toEqual({ updated: 1, inserted: 2, error: null });
    expect(flag()).toBe(true);
  });

  it("a failed mark is said, and the rows are still written", async () => {
    underCustomerKey(ALICE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        if (t === "user_data_tables") {
          q.update = () => ({ eq: async () => ({ error: { message: "no column" } }) });
        }
        return q;
      },
    } as never;
    expect(await insertDatasetRows(T1, ALICE, [{ a: 1 }])).toEqual({ error: null });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/was not marked: no column/));
    expect(fake.tables.user_data_rows).toHaveLength(4);
  });
});

describe("the server's answer on who saves through it", () => {
  it("says so for someone under a customer key", async () => {
    underCustomerKey(ALICE);
    expect(
      ok(await datasetRowsGoThroughServer({ data: { access_token: "alice-token" } })).through,
    ).toBe(true);
    expect(
      ok(await datasetRowsGoThroughServer({ data: { access_token: "bob-token" } })).through,
    ).toBe(false);
  });

  it("refuses a caller with no session", async () => {
    expect(await datasetRowsGoThroughServer({ data: { access_token: "nope" } })).toMatchObject({
      ok: false,
    });
  });
});

describe("reading a window", () => {
  const read = (t: string, id = T1, from = 0, size = 2) =>
    readDatasetWindow({ data: { access_token: t, table_id: id, from, size } });

  it("gives the owner their rows, window by window", async () => {
    expect(ok(await read("alice-token")).rows.map((r) => r.amount)).toEqual([1, 2]);
    expect(ok(await read("alice-token", T1, 2)).rows.map((r) => r.amount)).toEqual([3]);
  });

  it("gives another user nothing, and does not say why", async () => {
    expect(await read("bob-token")).toEqual({ ok: false, error: "Dataset not found" });
  });

  it("gives anyone a sample, which belongs to nobody", async () => {
    fake.tables.user_data_tables.push(table({ id: SAMPLE, user_id: null, is_sample: true }));
    fake.tables.user_data_rows.push({ table_id: SAMPLE, row: { a: 1 } });
    expect(ok(await read("bob-token", SAMPLE)).rows).toEqual([{ a: 1 }]);
  });

  it("does not take a dataset that is not there for an empty one", async () => {
    expect(await read("alice-token", T2)).toEqual({ ok: false, error: "Dataset not found" });
  });

  it("refuses a caller with no session", async () => {
    expect(await read("nope")).toMatchObject({ ok: false });
  });

  it("says a failed read, and does not answer it with an empty page", async () => {
    refusing("user_data_rows", "select", "statement timeout");
    expect(await read("alice-token")).toEqual({ ok: false, error: "statement timeout" });
  });

  it("says a failed lookup of the dataset, and does not call it missing", async () => {
    refusing("user_data_tables", "select", "connection lost");
    expect(await read("alice-token")).toEqual({ ok: false, error: "connection lost" });
  });

  it("asks for no more than one window a time, and at least one row", async () => {
    ok(await read("alice-token", T1, 0, 1000));
    await expect(read("alice-token", T1, 0, 0)).rejects.toThrow();
    await expect(read("alice-token", T1, -1, 10)).rejects.toThrow();
  });

  it("holds a window to the size the browser's pager asks for", async () => {
    await expect(read("alice-token", T1, 0, 5000)).rejects.toThrow();
  });

  it("reads one dataset, in a stable order, by the window it was asked for", async () => {
    fake.tables.user_data_rows.push({ table_id: T2, row: { other: true } });
    const { rows: page, error } = await windowDatasetRows(T1, 1, 2);
    expect(error).toBeNull();
    expect(page.map((r) => r.amount)).toEqual([2, 3]);
    expect(readFileSync(path.resolve("src/utils/data/datasetRows.server.ts"), "utf8")).toMatch(
      /\.order\("id", \{ ascending: true \}\)\s*\.range\(from, from \+ size - 1\)/,
    );
  });
});

describe("reading a shared dataset", () => {
  const read = (t: string, id = T1) =>
    readSharedDataset({ data: { access_token: t, table_id: id } });

  it("gives its owner everything", async () => {
    expect(ok(await read("alice-token")).rows).toHaveLength(3);
  });

  it("gives someone with no grant nothing, without reading the table to say so", async () => {
    expect(ok(await read("bob-token")).rows).toEqual([]);
    expect(fake.log).not.toContain("select user_data_rows");
  });

  it("applies the grant's row filter and column mask", async () => {
    h.grants = [{ row_filter: { column: "region", values: ["EMEA"] }, column_mask: ["secret"] }];
    const seen = ok(await read("bob-token")).rows;
    expect(seen.map((r) => r.amount)).toEqual([1, 3]);
    expect(seen.every((r) => !("secret" in r))).toBe(true);
  });

  it("a second grant does not reduce what the first allowed", async () => {
    h.grants = [
      { row_filter: null, column_mask: ["secret"] },
      { row_filter: { column: "region", values: ["EMEA"] }, column_mask: [] },
    ];
    const seen = ok(await read("bob-token")).rows;
    expect(seen).toHaveLength(3);
    expect(seen[0]).toHaveProperty("secret");
  });

  it("says so when the grants could not be read: that is not an empty dataset", async () => {
    h.grantsThrow = true;
    expect(await read("bob-token")).toEqual({
      ok: false,
      error: "could not read access grants: down",
    });
  });

  it("says a failed read of the rows", async () => {
    refusing("user_data_rows", "select", "statement timeout");
    expect(await read("alice-token")).toMatchObject({ ok: false });
  });

  it("gives a sample to anyone, without a grant", async () => {
    fake.tables.user_data_tables.push(table({ id: SAMPLE, user_id: null, is_sample: true }));
    fake.tables.user_data_rows.push({ table_id: SAMPLE, row: { a: 1 } });
    expect(ok(await read("bob-token", SAMPLE)).rows).toEqual([{ a: 1 }]);
  });

  it("does not hand back a prefix of a table too large to read", async () => {
    const src = readFileSync(path.resolve("src/utils/datasetRows.functions.ts"), "utf8");
    expect(src).toContain('if (scan.truncated) return { ok: false, error: "This shared dataset');
  });

  it("does not take a dataset that is not there for an empty one", async () => {
    expect(await read("alice-token", T2)).toEqual({ ok: false, error: "Dataset not found" });
  });

  it("refuses a caller with no session", async () => {
    expect(await read("nope")).toMatchObject({ ok: false });
  });
});

describe("writing through the server", () => {
  const write = (t: string, id = T1, batch: unknown[] = [{ a: 1 }]) =>
    writeDatasetBatch({ data: { access_token: t, table_id: id, rows: batch } });

  it("adds the owner's rows, and marks the dataset for someone under a customer key", async () => {
    underCustomerKey(ALICE);
    ok(await write("alice-token"));
    expect(fake.tables.user_data_rows).toHaveLength(4);
    expect(flag()).toBe(true);
  });

  it("refuses to write into someone else's dataset", async () => {
    expect(await write("bob-token")).toEqual({ ok: false, error: "Dataset not found" });
    expect(fake.tables.user_data_rows).toHaveLength(3);
  });

  it("refuses a caller with no session", async () => {
    expect(await write("nope")).toMatchObject({ ok: false });
    expect(fake.tables.user_data_rows).toHaveLength(3);
  });

  it("says a failed write", async () => {
    refusing("user_data_rows", "insert", "disk full");
    expect(await write("alice-token")).toEqual({ ok: false, error: "disk full" });
  });

  it("takes a full batch", async () => {
    ok(await write("alice-token", T1, Array(500).fill({ a: 1 })));
    expect(fake.tables.user_data_rows).toHaveLength(503);
  });

  it("refuses a dataset that is not there", async () => {
    expect(await write("alice-token", T2)).toEqual({ ok: false, error: "Dataset not found" });
  });

  it("holds a batch to what the browser sends", async () => {
    await expect(write("alice-token", T1, Array(501).fill({ a: 1 }))).rejects.toThrow();
  });
});

describe("what the browser does", () => {
  const src = readFileSync(path.resolve("src/lib/sqlEngine.ts"), "utf8");

  it("reads every column of the list, so the page works before the migration", () => {
    const at = src.indexOf('.from("user_data_tables")');
    expect(src.slice(at, at + 260)).toContain('.select("*")');
    expect(src).not.toContain(
      '"id, name, source_filename, columns, is_sample, user_id, data_loaded_at, parquet_bytes"',
    );
  });

  it("asks the server for a marked dataset, and reads every other as it did", () => {
    expect(src).toContain("const throughServer = t.rows_sealed === true;");
    expect(src).toContain("if (throughServer) return datasetWindow(t.id, from, size);");
    expect(src).toContain(
      "const rows = throughServer ? await sharedDatasetRows(t.id) : await loadShared(t.id);",
    );
  });

  it("every server write says whose rows they are", () => {
    const ingest = readFileSync(path.resolve("src/utils/data/ingest.server.ts"), "utf8");
    expect(ingest).toMatch(
      /moveDatasetRows\(\s*args\.stagingId,\s*existing\.id,\s*args\.userId,?\s*\)/,
    );
    expect(ingest).toMatch(/mergeDatasetRows\(\{[^}]*owner: args\.userId/);
    expect(ingest.match(/new RowSink\(staging\.id, args\.userId, maxRows\)/g)).toHaveLength(2);
  });

  it("the migration adds the column, off by default", () => {
    const sql = readFileSync(
      path.resolve("supabase/migrations/20261109000000_dataset_rows_sealed.sql"),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS rows_sealed boolean NOT NULL DEFAULT false");
  });

  it("nothing is ever marked just by being read", () => {
    const fns = readFileSync(path.resolve("src/utils/datasetRows.functions.ts"), "utf8");
    expect(fns.slice(0, fns.indexOf("export const writeDatasetBatch"))).not.toContain(
      "insertDatasetRows",
    );
  });
});
