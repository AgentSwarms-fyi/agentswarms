// R441: a dataset's columnar copy is sealed under the dataset owner's key.
//
// The mirror's own code runs: the refresh writes the copy and the reader
// downloads it into the local cache DuckDB reads. The rows table, Storage and
// the Parquet writer are stand-ins. What is checked: the bucket never holds
// the table as it is; the cache gets the opened copy; a cached copy whose key
// is gone is dropped and the dataset reads its rows; a cached file this
// process has no record of is fetched again rather than trusted.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  storage: null as null | { client: unknown },
  table: null as null | Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (name: string) => {
    let counting = false;
    const q: Record<string, unknown> = {};
    q.select = (_cols: string, opts?: { count?: string }) => {
      counting = !!opts?.count;
      return q;
    };
    q.eq = () => q;
    q.order = () => q;
    q.not = () => q;
    q.maybeSingle = async () => ({ data: h.table, error: null });
    q.range = async (lo: number, hi: number) => ({
      data: h.rows.slice(lo, hi + 1).map((row) => ({ row })),
      error: null,
    });
    q.update = (patch: Record<string, unknown>) => {
      h.updates.push({ table: name, patch });
      return q;
    };
    q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(
        counting ? { count: h.rows.length, error: null } : { data: null, error: null },
      ).then(ok, bad);
    return q;
  };
  return {
    supabaseAdmin: {
      from,
      get storage() {
        return h.storage!.client;
      },
    },
  };
});
// DuckDB is not what this is about: the "Parquet" is the rows as text, framed.
vi.mock("@/utils/data/duckdb.server", () => ({
  writeTableToParquet: async (t: { rows: unknown[] }, file: string) =>
    writeFile(file, `PAR1${JSON.stringify(t.rows)}PAR1`),
}));

import { __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import { isSealed, sealedKid } from "@/utils/storage/sealedFile";
import { fakeStorage, type FakeStorage } from "../fixtures/fakeStorage";
import { memoryKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const TABLE = "44444444-4444-4444-8444-444444444444";
const KEY = `${ALICE}/${TABLE}.parquet`;
const SYNCED = "2026-11-03T10:00:00.000Z";

let dir = "";
let mem: MemoryKeyStore;
let store: FakeStorage;
const saved: Record<string, string | undefined> = {};
const ENV = {
  PROVIDER_CREDS_SECRET: "a".repeat(64),
  DATA_KEY_CACHE_SECONDS: "0",
  PARQUET_MIN_ROWS: "0",
  PARQUET_MIRROR: "1",
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "parquet-sealed-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const [k, v] of Object.entries({ ...ENV, PARQUET_CACHE_DIR: dir })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store, null);
  store = fakeStorage();
  h.storage = store;
  h.table = {
    id: TABLE,
    name: "orders",
    user_id: ALICE,
    columns: [{ name: "region", type: "string" }],
    data_loaded_at: "2026-11-03T09:00:00.000Z",
    storage_mode: "auto",
  };
  h.rows = [{ region: "EMEA" }, { region: "Confidential-APAC" }];
  h.updates = [];
  vi.resetModules();
});

afterEach(() => {
  __setKeyHierarchyForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A fresh copy of the mirror module: what a restarted process has. */
async function mirror() {
  const m = await import("@/utils/data/parquet.server");
  // The fresh module must share the key hierarchy the test set up.
  const crypto = await import("@/utils/providers/crypto.server");
  crypto.__setKeyHierarchyForTests(mem.store, null);
  return m;
}

const meta = { tableId: TABLE, userId: ALICE, parquet_synced_at: SYNCED, data_loaded_at: null };

describe("a dataset copy in the bucket", () => {
  it("is sealed under the owner's key, and the refresh records it", async () => {
    const m = await mirror();
    expect(await m.refreshDatasetMirror({ userId: ALICE, tableId: TABLE })).toMatchObject({
      rows: 2,
    });
    const obj = store.get("datasets", KEY)!;
    expect(isSealed(obj.bytes)).toBe(true);
    expect(sealedKid(obj.bytes)).toBe(mem.userKeys.find((k) => k.user_id === ALICE)!.kid);
    expect(new TextDecoder("latin1").decode(obj.bytes)).not.toContain("Confidential-APAC");
    expect(h.updates.some((u) => u.patch.parquet_synced_at)).toBe(true);
  });

  it("is not written when the owner's key cannot be had, and the refresh says so by returning null", async () => {
    mem.group("g1", "a", [ALICE]);
    mem.group("g2", "b", [ALICE]);
    for (const [id, g] of [
      ["10000000-0000-4000-8000-000000000001", "g1"],
      ["10000000-0000-4000-8000-000000000002", "g2"],
    ] as const) {
      mem.customerKeys.set(id, {
        id,
        name: id.slice(-1),
        provider: "app",
        key_ref: null,
        endpoint: null,
        material: "x",
        iv: "x",
        wrapped_by: "x",
        kid: `ck${id.slice(-1)}`,
        created_at: SYNCED,
        destroyed_at: null,
      });
      mem.assignGroup(id, g);
    }
    const m = await mirror();
    expect(await m.refreshDatasetMirror({ userId: ALICE, tableId: TABLE })).toBeNull();
    expect(store.get("datasets", KEY)).toBeUndefined();
    expect(h.updates.some((u) => u.patch.parquet_synced_at)).toBe(false);
  });
});

describe("the local cache", () => {
  it("holds the opened copy, and a second read uses it", async () => {
    const m = await mirror();
    await m.refreshDatasetMirror({ userId: ALICE, tableId: TABLE });
    const file = await m.localParquetPath(meta);
    expect(file).not.toBeNull();
    expect(await readFile(file!, "utf8")).toBe(`PAR1${JSON.stringify(h.rows)}PAR1`);
    const downloads = store.calls.download;
    expect(await m.localParquetPath(meta)).toBe(file);
    expect(store.calls.download).toBe(downloads);
  });

  it("drops a copy whose key was erased, and the dataset reads its rows", async () => {
    const m = await mirror();
    await m.refreshDatasetMirror({ userId: ALICE, tableId: TABLE });
    const file = await m.localParquetPath(meta);
    mem.erase(ALICE);
    expect(await m.localParquetPath(meta)).toBeNull();
    expect(existsSync(file!)).toBe(false);
    // And it is not fetched back: the stored copy is under the same erased key.
    expect(await m.localParquetPath(meta)).toBeNull();
  });

  it("fetches again a cached file this process has no record of", async () => {
    const first = await mirror();
    await first.refreshDatasetMirror({ userId: ALICE, tableId: TABLE });
    const file = await first.localParquetPath(meta);
    vi.resetModules();
    const restarted = await mirror();
    const downloads = store.calls.download;
    mem.erase(ALICE);
    // The file is still on disk from before the restart; it is not trusted.
    expect(existsSync(file!)).toBe(true);
    expect(await restarted.localParquetPath(meta)).toBeNull();
    expect(store.calls.download).toBe(downloads + 1);
  });

  it("uses a copy stored before R441 as it is", async () => {
    store.put(
      "datasets",
      KEY,
      new TextEncoder().encode("PAR1 old PAR1"),
      "application/vnd.apache.parquet",
    );
    const m = await mirror();
    const file = await m.localParquetPath(meta);
    expect(await readFile(file!, "utf8")).toBe("PAR1 old PAR1");
    expect(await m.localParquetPath(meta)).toBe(file);
  });
});
