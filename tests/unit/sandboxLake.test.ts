// The lakehouse, for a sandbox that holds no lakehouse credential.
//
// A sandbox used to receive the catalog's connection string and the store's
// key. Now it asks the app for the reads and loads its run declared, and the
// app serves them as the run's owner (src/utils/lakehouse/sandboxLake.server).
//
// Behavioural: a real DuckDB in memory stands in for the engine, staging goes
// to a local directory instead of the bucket, and the owners' policies come
// from a stubbed policy table. What a read returns is read back from the
// Parquet the app wrote; what a commit did is read back from the tables.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  policies: [] as Record<string, unknown>[],
  allowed: [] as { name: string; user_id: string }[],
  engine: null as null | (() => Promise<unknown>),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const data = table === "lakehouse_table_policies" ? db.policies : [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "not"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
      return b;
    },
    auth: {
      admin: { getUserById: async () => ({ data: { user: { email: "reader@example.com" } } }) },
    },
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/sheets/owned.server", () => ({ sheetOwnedRefusal: async () => null }));
vi.mock("@/utils/ml/experimentArtifacts.server", () => ({
  lakeTarget: () => ({
    bucket: "lake",
    dataUrl: "s3://lake/main",
    target: {
      endpoint: "minio:9000",
      region: "us-east-1",
      useSsl: false,
      urlStyle: "path",
      bucket: "lake",
      accessKeyId: "AKTEST",
      secretAccessKey: "SKTEST",
    },
  }),
}));
const store = vi.hoisted(() => ({
  keys: [] as { key: string; lastModified: Date }[],
  deleted: [] as string[],
}));
vi.mock("@/utils/lakehouse/presign.server", async (orig) => {
  const real = await orig<typeof import("@/utils/lakehouse/presign.server")>();
  return {
    ...real,
    s3ListKeys: async (_t: unknown, prefix: string) =>
      store.keys.filter((k) => k.key.startsWith(prefix)),
    s3DeleteObject: async (_t: unknown, key: string) => {
      store.deleted.push(key);
    },
  };
});
vi.mock("@/utils/lakehouse/core.server", async (orig) => {
  const real = await orig<typeof import("@/utils/lakehouse/core.server")>();
  return {
    ...real,
    lakehouseConnection: () => db.engine!(),
    accessibleSchemas: async () => db.allowed,
  };
});

const lake = await import("@/utils/lakehouse/sandboxLake.server");

const OWNER = "owner-1";
const READER = "reader-2";
const SID = "0b5f2c1e-7d1a-4c3e-9f00-1234567890ab";
let instance: DuckDBInstance;
let dir: string;
const SEP = path.sep;
const dir0 = () => dir;
const io = {
  url: (key: string) => path.join(dir, key).replace(/\\/g, "/"),
  remove: async (key: string) => rmSync(path.join(dir, key), { force: true }),
  list: async (prefix: string) => {
    const base = path.join(dir, prefix);
    if (!existsSync(base)) return [];
    return readdirSync(base).map((f) => `${prefix}${f}`);
  },
};

async function q(sql: string): Promise<unknown[][]> {
  const c = await instance.connect();
  try {
    return await (await c.run(sql)).getRows();
  } finally {
    c.closeSync();
  }
}

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  db.engine = async () => instance.connect() as Promise<DuckDBConnection>;
  dir = mkdtempSync(path.join(tmpdir(), "sandbox-lake-"));
  mkdirSync(path.join(dir, `_sandbox_staging/${SID}/in`), { recursive: true });
  await q(
    `CREATE SCHEMA sales; CREATE SCHEMA mine; CREATE SCHEMA private;
     CREATE TABLE sales.orders AS SELECT * FROM (VALUES
       (1, 'EMEA', 'ana@example.com', 10), (2, 'APAC', 'bo@example.com', 20),
       (3, 'EMEA', 'cy@example.com', 30)) t(id, region, email, amount);
     CREATE TABLE private.salaries AS SELECT 100 AS amount;`,
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db.policies = [];
  db.allowed = [
    { name: "sales", user_id: OWNER },
    { name: "mine", user_id: READER },
  ];
});

const manifest = (
  extra: Partial<import("@/utils/lakehouse/sandboxLake.server").LakeManifest> = {},
) => ({
  reads: {
    n_orders: { label: "Orders", sql: 'SELECT * FROM "sales"."orders"' },
    n_private: { label: "Private", sql: "SELECT * FROM private.salaries" },
    n_files: { label: "Files", sql: "SELECT * FROM read_text('/etc/hostname')" },
  },
  writes: {
    t_append: {
      label: "Out",
      schema: "mine",
      table: "out",
      mode: "append" as const,
      primaryKey: [],
    },
    t_upsert: {
      label: "Upsert",
      schema: "mine",
      table: "keyed",
      mode: "upsert" as const,
      primaryKey: ["id"],
    },
    t_replace: {
      label: "Snap",
      schema: "mine",
      table: "snap",
      mode: "replace" as const,
      primaryKey: [],
    },
    t_theirs: {
      label: "Theirs",
      schema: "sales",
      table: "orders",
      mode: "append" as const,
      primaryKey: [],
    },
  },
  cursors: { pipelineId: "p-1", nodes: ["n_orders"] },
  ...extra,
});

/** Read back the one file a read staged. */
async function staged(out: { files: { get: string }[] }): Promise<unknown[][]> {
  const key = decodeURIComponent(new URL(out.files[0]!.get).pathname).replace(/^\/lake\//, "");
  return q(`SELECT * FROM read_parquet('${io.url(key)}') ORDER BY 1`);
}

describe("a read", () => {
  it("runs the declared SELECT as the owner and stages the rows as one Parquet file", async () => {
    const out = await lake.lakeRead({
      userId: OWNER,
      sessionId: SID,
      manifest: manifest(),
      id: "n_orders",
      via: "test",
      io,
    });
    expect(out.rows).toBe(3);
    const url = new URL(out.files[0]!.get);
    expect(url.pathname).toMatch(
      new RegExp(`^/lake/_sandbox_staging/${SID}/in/[0-9a-f-]{36}\\.parquet$`),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(new URL(out.files[0]!.delete).pathname).toBe(url.pathname);
    expect((await staged(out)).map((r) => r[2])).toEqual([
      "ana@example.com",
      "bo@example.com",
      "cy@example.com",
    ]);
  });

  it("gives another reader the rows and values the owner's policy allows", async () => {
    db.allowed = [
      { name: "sales", user_id: OWNER },
      { name: "mine", user_id: READER },
    ];
    db.policies = [
      {
        id: "p1",
        user_id: OWNER,
        schema_name: "sales",
        table_name: "orders",
        row_filter: "region = 'EMEA'",
        masked_columns: ["email"],
        mask_style: "null",
      },
    ];
    const out = await lake.lakeRead({
      userId: READER,
      sessionId: SID,
      manifest: manifest(),
      id: "n_orders",
      via: "test",
      io,
    });
    expect(out.rows).toBe(2);
    const rows = await staged(out);
    expect(rows.map((r) => r[1])).toEqual(["EMEA", "EMEA"]);
    expect(rows.map((r) => r[2])).toEqual([null, null]);
  });

  it("is refused for a schema nobody shared, for a table function, and for anything undeclared", async () => {
    const read = (id: string) =>
      lake.lakeRead({ userId: READER, sessionId: SID, manifest: manifest(), id, via: "test", io });
    await expect(read("n_private")).rejects.toThrow(/No access to schema "private"/);
    await expect(read("n_files")).rejects.toThrow(/read_text\(\) is not available here/);
    await expect(read("n_nope")).rejects.toThrow(/declared no lakehouse read "n_nope"/);
    await expect(read("constructor")).rejects.toThrow(/declared no lakehouse read/);
  });

  it("reads no more than a preview shows", async () => {
    const out = await lake.lakeRead({
      userId: OWNER,
      sessionId: SID,
      manifest: manifest({ rowLimit: 2 }),
      id: "n_orders",
      via: "test",
      io,
    });
    expect(out.rows).toBe(2);
  });
});

/** Stage a frame the way the sandbox does: Parquet at the key the stage named. */
async function stage(id: string, select: string, m = manifest()) {
  const st = lake.lakeStage({ sessionId: SID, manifest: m, id, parts: 1 });
  const key = decodeURIComponent(new URL(st.puts[0]!).pathname).replace(/^\/lake\//, "");
  mkdirSync(path.dirname(io.url(key)), { recursive: true });
  await q(`COPY (${select}) TO '${io.url(key)}' (FORMAT parquet)`);
  return { id, batch: st.batch, parts: 1 };
}

const commit = (
  loads: { id: string; batch: string; parts: number }[],
  cursors?: Record<string, string>,
  userId = READER,
) =>
  lake.lakeCommit({
    userId,
    sessionId: SID,
    manifest: manifest(),
    loads,
    cursors,
    via: "test",
    io,
  });

describe("a stage", () => {
  it("hands out PUTs under this session's own prefix, for declared targets only", () => {
    const st = lake.lakeStage({ sessionId: SID, manifest: manifest(), id: "t_append", parts: 3 });
    expect(st.puts).toHaveLength(3);
    for (const [k, u] of st.puts.entries()) {
      expect(new URL(u).pathname).toBe(
        `/lake/_sandbox_staging/${SID}/out/${st.batch}/${k}.parquet`,
      );
    }
    expect(() =>
      lake.lakeStage({ sessionId: SID, manifest: manifest(), id: "n_orders", parts: 1 }),
    ).toThrow(/declared no lakehouse target/);
    expect(() =>
      lake.lakeStage({ sessionId: SID, manifest: manifest(), id: "t_append", parts: 0 }),
    ).toThrow(/1 to \d+ staged parts/);
  });
});

describe("a commit", () => {
  it("does nothing at all for an empty commit: no engine, no transaction", async () => {
    const engine = db.engine;
    db.engine = async () => {
      throw new Error("an empty commit opened the engine");
    };
    try {
      expect(await commit([], {})).toEqual({ loads: [] });
    } finally {
      db.engine = engine;
    }
  });

  it("deletes what it staged once the rows are committed", async () => {
    const ld = await stage("t_append", "SELECT 0 AS id, 'gone' AS v");
    const file = path.join(dir, `_sandbox_staging/${SID}/out/${ld.batch}/0.parquet`);
    expect(existsSync(file)).toBe(true);
    await commit([ld]);
    expect(existsSync(file)).toBe(false);
    await q("DELETE FROM mine.out WHERE id = 0");
  });

  it("appends, upserts and replaces, with the run's cursors, in one transaction", async () => {
    await commit([await stage("t_append", "SELECT 1 AS id, 'a' AS v")]);
    await commit([await stage("t_append", "SELECT 2 AS id, 'b' AS v")]);
    expect(await q("SELECT id, v FROM mine.out ORDER BY id")).toEqual([
      [1, "a"],
      [2, "b"],
    ]);

    await commit([await stage("t_upsert", "SELECT * FROM (VALUES (1, 'x'), (2, 'y')) t(id, v)")]);
    await commit([await stage("t_upsert", "SELECT * FROM (VALUES (2, 'Y'), (3, 'z')) t(id, v)")], {
      n_orders: "42",
    });
    expect(await q("SELECT id, v FROM mine.keyed ORDER BY id")).toEqual([
      [1, "x"],
      [2, "Y"],
      [3, "z"],
    ]);
    expect(await lake.lakeCursors(manifest())).toEqual({ n_orders: "42" });

    await commit([await stage("t_replace", "SELECT 7 AS n")]);
    await commit([await stage("t_replace", "SELECT 8 AS n UNION ALL SELECT 9")]);
    expect(await q("SELECT n FROM mine.snap ORDER BY n")).toEqual([[8], [9]]);
  });

  it("commits nothing, cursors included, when any load in it fails", async () => {
    const good = await stage("t_upsert", "SELECT 1 AS id, 'never' AS v");
    // The text cannot become mine.out's integer id: the second load fails
    // inside the transaction, after the first has run.
    const bad = await stage("t_append", "SELECT 'not a number' AS id, 'z' AS v");
    await expect(commit([good, bad], { n_orders: "77" })).rejects.toThrow(/convert|cast/i);
    expect(await q("SELECT v FROM mine.keyed WHERE id = 1")).toEqual([["x"]]);
    expect(await lake.lakeCursors(manifest())).toEqual({ n_orders: "42" });
  });

  it("records why: the merge's old, bare DELETE matched every row when the key was missing", async () => {
    // The statement the sandbox ran before the gateway, against a frame
    // that had lost its key column upstream (a select or a rename).
    await q(
      `CREATE TABLE mine.r228 AS SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(id, v);
       CREATE TABLE mine.r228_src AS SELECT 'no key' AS v;
       DELETE FROM mine.r228 WHERE ("id") IN (SELECT "id" FROM mine.r228_src);`,
    );
    expect(await q("SELECT count(*) FROM mine.r228")).toEqual([[0n]]);
    await q("DROP TABLE mine.r228; DROP TABLE mine.r228_src;");
  });

  it("refuses to merge rows that lack the key, rather than empty the table", async () => {
    // Bare in the DELETE's subquery, a key the rows lack binds to the
    // target's own column and the DELETE matches every row.
    const keyless = await stage("t_upsert", "SELECT 'no key' AS v");
    await expect(commit([keyless])).rejects.toThrow(
      /rows to merge have no "id" column, which its primary key needs — nothing was loaded/,
    );
    expect(await q("SELECT id, v FROM mine.keyed ORDER BY id")).toEqual([
      [1, "x"],
      [2, "Y"],
      [3, "z"],
    ]);
  });

  it("refuses a policed shared table, an undeclared cursor, and a batch outside the session", async () => {
    db.policies = [
      {
        id: "p1",
        user_id: OWNER,
        schema_name: "sales",
        table_name: "orders",
        row_filter: "region = 'EMEA'",
        masked_columns: [],
        mask_style: "null",
      },
    ];
    const theirs = await stage("t_theirs", "SELECT 4 AS id");
    await expect(commit([theirs])).rejects.toThrow(/read-only for anyone else/);
    await expect(
      commit([await stage("t_append", "SELECT 5 AS id, 'c' AS v")], { n_other: "1" }),
    ).rejects.toThrow(/declared no cursor for "n_other"/);
    await expect(commit([{ id: "t_append", batch: "../../main/sales", parts: 1 }])).rejects.toThrow(
      /Not a staging batch/,
    );
    expect(await q("SELECT count(*) FROM sales.orders")).toEqual([[3n]]);
  });
});

describe("the staging sweep", () => {
  it("deletes only what no live session owns and nothing has touched for an hour", async () => {
    const live = "11111111-2222-4333-8444-555555555555";
    const dead = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const fresh = new Date(Date.now() - 5 * 60_000);
    store.keys = [
      { key: `_sandbox_staging/${live}/in/a.parquet`, lastModified: old },
      { key: `_sandbox_staging/${dead}/out/b/0.parquet`, lastModified: old },
      { key: `_sandbox_staging/${dead}/in/c.parquet`, lastModified: fresh },
    ];
    store.deleted = [];
    expect(await lake.sweepSandboxStaging(new Set([live]))).toBe(1);
    expect(store.deleted).toEqual([`_sandbox_staging/${dead}/out/b/0.parquet`]);
  });

  it("is skipped by the reaper when the live sessions cannot be read", () => {
    const src = readFileSync("src/utils/notebookRuntime/service.server.ts", "utf8");
    const fn = src.slice(src.indexOf("async function sweepLakeStaging"));
    expect(fn.indexOf("if (error) {")).toBeLessThan(fn.indexOf("sweepSandboxStaging("));
    expect(fn.slice(fn.indexOf("if (error) {"), fn.indexOf("sweepSandboxStaging("))).toContain(
      "return;",
    );
  });
});

describe("the session channel", () => {
  const route = readFileSync("src/routes/api/notebook.runtime.source.ts", "utf8");

  it("serves every lake call from the manifest pinned on the session, never from the request", () => {
    const fn = route.slice(
      route.indexOf("async function lakePart"),
      route.indexOf("async function handle"),
    );
    expect(fn).toContain("const manifest = lake.lakeManifestOf(s.inputs);");
    expect(fn).not.toMatch(/body\.(reads|writes|manifest|sql)/);
  });

  it("pins the manifest when the environment is fetched, and a preview may only read", () => {
    const run = route.slice(
      route.indexOf("if (session?.etl_run_id)"),
      route.indexOf("// A warm scorer"),
    );
    expect(run).toContain("readOnly: false");
    expect(run).toMatch(/pinLake\(claims\.sid, session\.inputs, lake\)\) \?\? json\(200, rest\)/);
    const preview = route.slice(
      route.indexOf("etlPreviewStashOf"),
      route.indexOf("// ML training jobs"),
    );
    expect(preview).toContain("readOnly: true");
    expect(preview).toMatch(
      /pinLake\(claims\.sid, session\?\.inputs, lake\)\) \?\? json\(200, rest\)/,
    );
    const lakePart = route.slice(route.indexOf("async function lakePart"));
    const guard = lakePart.search(/if \(s\.readOnly\)\s+return json\(403/);
    expect(guard).toBeGreaterThan(-1);
    expect(lakePart.indexOf('if (part === "lake_read")')).toBeLessThan(guard);
    // Everything after the guard writes: stage and commit sit below it.
    expect(lakePart.indexOf('if (part === "lake_stage")')).toBeGreaterThan(guard);
    expect(lakePart.indexOf('if (part === "lake_commit")')).toBeGreaterThan(guard);
  });
});

describe("a load the cluster wrote", () => {
  // The Spark engine's executors write a directory of part files whose names
  // and number are the cluster's business, so the load says "this batch" and
  // the app lists it (R230).
  const BATCH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const sparkBatch = async (files: Record<string, string>) => {
    const out = path.join(dir0(), `_sandbox_staging/${SID}/out/${BATCH}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const [name, select] of Object.entries(files)) {
      const file = path.join(out, name).split(SEP).join("/");
      await q(`COPY (${select}) TO '${file}' (FORMAT parquet)`);
    }
    return BATCH;
  };
  const commitBatch = (batch: string) =>
    lake.lakeCommit({
      userId: READER,
      sessionId: SID,
      manifest: manifest(),
      loads: [{ id: "t_append", batch, prefix: true }],
      via: "test",
      io,
    });

  it("loads every part the cluster wrote, and ignores what is not data", async () => {
    const batch = await sparkBatch({
      "part-00000.parquet": "SELECT 10 AS id, 'a' AS v",
      "part-00001.parquet": "SELECT 11 AS id, 'b' AS v",
      _SUCCESS: "SELECT 1",
      ".part-00002.parquet.crc": "SELECT 1",
    });
    expect(await commitBatch(batch)).toEqual({ loads: [{ id: "t_append", rows: 2 }] });
    expect(await q("SELECT id, v FROM mine.out WHERE id >= 10 ORDER BY id")).toEqual([
      [10, "a"],
      [11, "b"],
    ]);
    await q("DELETE FROM mine.out WHERE id >= 10");
  });

  it("loads nothing when the cluster wrote no parts, rather than failing", async () => {
    const batch = await sparkBatch({ _SUCCESS: "SELECT 1" });
    expect(await commitBatch(batch)).toEqual({ loads: [] });
  });

  it("cannot list another session's staging, whatever batch it names", async () => {
    for (const bad of ["../../other", "not-a-uuid", "../0b5f2c1e-7d1a-4c3e-9f00-1234567890ab"]) {
      await expect(commitBatch(bad), bad).rejects.toThrow(/Not a staging batch/);
    }
  });
});

describe("the session channel's commit body", () => {
  const route = readFileSync("src/routes/api/notebook.runtime.source.ts", "utf8");

  it("carries every field a load has, so a cluster-written one stays one", () => {
    // FOUND FROM A RUN. The parser rebuilt each load field by field and left
    // `prefix` out, so a Spark load — which names its batch rather than its
    // files — fell into the numbered-parts path and failed with "A load is 1
    // to 256 staged parts". The unit tests called the gateway directly and
    // never saw it.
    const fn = route.slice(route.indexOf('if (part === "lake_commit")'));
    const parse = fn.slice(0, fn.indexOf("const cursors"));
    for (const field of ["id:", "batch:", "parts:", "prefix:"]) {
      expect(parse, field).toContain(field);
    }
    expect(parse).toContain("prefix: o.prefix === true");
  });
});

describe("a read the app bounds", () => {
  // ML trains on a sample of a large table and refuses a series that is over
  // the limit; both are the app's decisions, over the rows the owner may see.
  const withRead = (read: Record<string, unknown>) =>
    ({ ...manifest(), reads: { ...manifest().reads, r: read } }) as never;

  it("samples to the declared size, repeatably, and says it did", async () => {
    const spec = { label: "Orders", sql: "SELECT * FROM sales.orders", sampleTo: 2 };
    const out = await lake.lakeRead({
      userId: OWNER,
      sessionId: SID,
      manifest: withRead(spec),
      id: "r",
      via: "test",
      io,
    });
    expect(out.rows).toBe(2);
    expect(out.total).toBe(3);
    expect(out.sampled).toBe(true);
    // The same rows on a re-run: a model trained twice on "a sample" that
    // moved would score differently for no reason anyone could find.
    const first = (await staged(out)).map((r) => r[0]);
    const again = await lake.lakeRead({
      userId: OWNER,
      sessionId: SID,
      manifest: withRead(spec),
      id: "r",
      via: "test",
      io,
    });
    expect((await staged(again)).map((r) => r[0])).toEqual(first);
  });

  it("does not sample a source that is already within the size", async () => {
    const out = await lake.lakeRead({
      userId: OWNER,
      sessionId: SID,
      manifest: withRead({ label: "Orders", sql: "SELECT * FROM sales.orders", sampleTo: 50 }),
      id: "r",
      via: "test",
      io,
    });
    expect(out).toMatchObject({ rows: 3, total: 3, sampled: false });
  });

  it("refuses rather than reads when the source is over a hard limit", async () => {
    await expect(
      lake.lakeRead({
        userId: OWNER,
        sessionId: SID,
        manifest: withRead({
          label: "Series",
          sql: "SELECT * FROM sales.orders",
          refuseOver: { rows: 2, message: "The series has %d rows, above the 2-row limit." },
        }),
        id: "r",
        via: "test",
        io,
      }),
    ).rejects.toThrow("The series has 3 rows, above the 2-row limit.");
  });

  it("counts what the READER may see, not what the table holds", async () => {
    // A policy hides a row from this reader, so the limit and the sample are
    // over two rows, not three.
    db.policies = [
      {
        id: "p1",
        user_id: OWNER,
        schema_name: "sales",
        table_name: "orders",
        row_filter: "region = 'EMEA'",
        masked_columns: [],
        mask_style: "null",
      },
    ];
    const out = await lake.lakeRead({
      userId: READER,
      sessionId: SID,
      manifest: withRead({ label: "Orders", sql: "SELECT * FROM sales.orders", sampleTo: 50 }),
      id: "r",
      via: "test",
      io,
    });
    expect(out.total).toBe(2);
  });
});

describe("a model artifact", () => {
  const m = (artifacts: Record<string, unknown>) => ({ ...manifest(), artifacts }) as never;

  it("is signed for the one key this run declared, for the method it declared", () => {
    const put = lake.lakeArtifact({
      manifest: m({ put: "ml-artifacts/m1/v3/model.joblib", get: [] }),
      which: "put",
      uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
    });
    const url = new URL(put.url);
    expect(url.pathname).toBe("/lake/ml-artifacts/m1/v3/model.joblib");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("cannot be read when only writing was declared, or the other way round", () => {
    const writeOnly = m({ put: "ml-artifacts/m1/v3/model.joblib", get: [] });
    expect(() =>
      lake.lakeArtifact({
        manifest: writeOnly,
        which: "get",
        uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
      }),
    ).toThrow(/may not get/);
    const readOnly = m({ get: ["ml-artifacts/m1/v3/model.joblib"] });
    expect(() =>
      lake.lakeArtifact({
        manifest: readOnly,
        which: "put",
        uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
      }),
    ).toThrow(/may not put/);
  });

  it("cannot be another model's, whatever URI is asked for", () => {
    const mine = m({
      put: "ml-artifacts/m1/v3/model.joblib",
      get: ["ml-artifacts/m1/v3/model.joblib"],
    });
    for (const uri of [
      "s3://lake/ml-artifacts/m2/v1/model.joblib",
      "s3://lake/main/analytics/orders/a.parquet",
      "s3://other/ml-artifacts/m1/v3/model.joblib",
      "ml-artifacts/m1/v3/../../main/analytics/x.parquet",
    ]) {
      expect(() => lake.lakeArtifact({ manifest: mine, which: "get", uri }), uri).toThrow(
        /may not get/,
      );
    }
  });

  it("is refused outright by a run that declared none", () => {
    expect(() =>
      lake.lakeArtifact({ manifest: manifest() as never, which: "get", uri: "s3://lake/x" }),
    ).toThrow(/declared no model artifacts/);
  });
});
