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
// The store's endpoint: MinIO, unless a test puts the lake on Cloud Storage (R443).
const where = vi.hoisted(() => ({ endpoint: "minio:9000" }));
vi.mock("@/utils/ml/experimentArtifacts.server", () => ({
  lakeTarget: () => ({
    bucket: "lake",
    dataUrl: "s3://lake/main",
    target: {
      endpoint: where.endpoint,
      region: "us-east-1",
      useSsl: false,
      urlStyle: "path",
      bucket: "lake",
      accessKeyId: "AKTEST",
      secretAccessKey: "SKTEST",
    },
  }),
}));
// R442: the KMS key the owner's lake objects are written under; null: none.
const owner = vi.hoisted(() => ({
  kms: null as string | null,
  asked: [] as string[],
  secrets: [] as string[],
  part: undefined as string | null | undefined,
}));
vi.mock("@/utils/lakehouse/customerKeyFiles.server", () => ({
  lakeObjectKmsKey: async (userId: string) => {
    owner.asked.push(userId);
    return owner.kms;
  },
  // How the engine's secret names the key: S3's KMS_KEY_ID unless a test
  // says otherwise (R443: Cloud Storage's header, or none until it is safe).
  engineKeyPart: async (keyRef: string) =>
    owner.part === undefined ? `KMS_KEY_ID '${keyRef}'` : owner.part,
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
    lakehouseConfig: () => ({
      catalogUrl: "postgres://x",
      dataUrl: "s3://lake/main",
      s3: {
        endpoint: "minio:9000",
        region: "us-east-1",
        urlStyle: "path",
        useSsl: false,
      },
    }),
  };
});
// The store's keys come from the credential resolver, not the config (R465).
vi.mock("@/utils/lakehouse/lakeCredentials.server", async (orig) => ({
  ...(await orig<typeof import("@/utils/lakehouse/lakeCredentials.server")>()),
  lakeCredentials: async () => ({
    accessKeyId: "AKTEST",
    secretAccessKey: "SKTEST",
    expiresAt: null,
    mode: "keys",
    source: "test",
  }),
}));

const lake = await import("@/utils/lakehouse/sandboxLake.server");

const OWNER = "owner-1";
const ARN = "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
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
    // R458: loads of columns the sandbox read as VARIANT.
    t_docs: {
      label: "Docs",
      schema: "mine",
      table: "docs",
      mode: "append" as const,
      primaryKey: [],
    },
    t_docs_snap: {
      label: "Docs snap",
      schema: "mine",
      table: "docsnap",
      mode: "replace" as const,
      primaryKey: [],
    },
    t_structy: {
      label: "Structy",
      schema: "mine",
      table: "structy",
      mode: "append" as const,
      primaryKey: [],
    },
    t_plain: {
      label: "Plain",
      schema: "mine",
      table: "plain",
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

  // R442. The rows a read stages are the owner's, so a covered owner's go
  // under their customer key: a secret on the engine scoped to that one file,
  // made before the copy and dropped after it, whatever the copy did.
  async function recording(failCopy = false) {
    const engine = db.engine!;
    const sql: string[] = [];
    db.engine = async () => {
      const real = (await engine()) as DuckDBConnection;
      return new Proxy(real, {
        get(t, prop) {
          if (prop === "run") {
            return async (text: string) => {
              sql.push(text);
              // This engine has no httpfs to make an S3 secret with; what the
              // app asks of the real one is what is checked.
              if (/^(CREATE SECRET|DROP SECRET IF EXISTS) stage_ck_/.test(text)) {
                return { getRows: async () => [] };
              }
              if (failCopy && text.startsWith("COPY (")) throw new Error("the store said no");
              return t.run(text);
            };
          }
          const v = Reflect.get(t, prop);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    };
    return { sql, restore: () => (db.engine = engine) };
  }

  it("stages a covered owner's rows under their customer key, by a secret for that one file", async () => {
    owner.kms = ARN;
    const rec = await recording();
    try {
      const out = await lake.lakeRead({
        userId: OWNER,
        sessionId: SID,
        manifest: manifest(),
        id: "n_orders",
        via: "test",
        io,
      });
      const key = decodeURIComponent(new URL(out.files[0]!.get).pathname).replace(/^\/lake\//, "");
      const create = rec.sql.findIndex((q) => q.startsWith("CREATE SECRET stage_ck_"));
      const copy = rec.sql.findIndex((q) => q.startsWith("COPY ("));
      const drop = rec.sql.findIndex((q) => q.startsWith("DROP SECRET IF EXISTS stage_ck_"));
      expect(create).toBeGreaterThanOrEqual(0);
      expect(copy).toBeGreaterThan(create);
      expect(drop).toBeGreaterThan(copy);
      const made = rec.sql[create]!;
      expect(made).toContain("TYPE s3");
      expect(made).toContain("KEY_ID 'AKTEST'");
      expect(made).toContain(`KMS_KEY_ID '${ARN}'`);
      expect(made).toContain(`SCOPE 's3://lake/${key}'`);
      const name = /^CREATE SECRET (\w+)/.exec(made)![1]!;
      expect(rec.sql[drop]).toBe(`DROP SECRET IF EXISTS ${name};`);
      // Not a name the engine's schema sync drops (LIKE 'lake_ck_%', where _
      // is any one character): it would go in the middle of the copy.
      expect(name).not.toMatch(/^lake.ck./);
      expect(await staged(out)).toHaveLength(3);
    } finally {
      rec.restore();
      owner.kms = null;
    }
  });

  it("drops that secret when the copy fails", async () => {
    owner.kms = ARN;
    const rec = await recording(true);
    try {
      await expect(
        lake.lakeRead({
          userId: OWNER,
          sessionId: SID,
          manifest: manifest(),
          id: "n_orders",
          via: "test",
          io,
        }),
      ).rejects.toThrow(/the store said no/);
      const made = rec.sql.find((q) => q.startsWith("CREATE SECRET stage_ck_"))!;
      const name = /^CREATE SECRET (\w+)/.exec(made)![1]!;
      expect(rec.sql).toContain(`DROP SECRET IF EXISTS ${name};`);
    } finally {
      rec.restore();
      owner.kms = null;
    }
  });

  // R443: on Cloud Storage the secret names the key with its header, and
  // only once the store has taken it on reads; until then the copy is made
  // under the store's own encryption, with no secret at all.
  it("names the key the store's way, and makes no secret when the store may not be told", async () => {
    owner.kms = "projects/acme-prod/locations/europe-west1/keyRings/lake/cryptoKeys/acme";
    owner.part = `EXTRA_HTTP_HEADERS MAP {'x-goog-encryption-kms-key-name': '${owner.kms}'}`;
    let rec = await recording();
    try {
      await lake.lakeRead({
        userId: OWNER,
        sessionId: SID,
        manifest: manifest(),
        id: "n_orders",
        via: "test",
        io,
      });
      const made = rec.sql.find((q) => q.startsWith("CREATE SECRET stage_ck_")) ?? "";
      expect(made).toContain(owner.part);
      expect(made).not.toContain("KMS_KEY_ID");
    } finally {
      rec.restore();
    }
    owner.part = null;
    rec = await recording();
    try {
      const out = await lake.lakeRead({
        userId: OWNER,
        sessionId: SID,
        manifest: manifest(),
        id: "n_orders",
        via: "test",
        io,
      });
      expect(rec.sql.some((q) => /SECRET/.test(q))).toBe(false);
      expect(out.rows).toBe(3);
    } finally {
      rec.restore();
      owner.kms = null;
      owner.part = undefined;
    }
  });

  it("makes no secret for an owner no customer key covers", async () => {
    const rec = await recording();
    try {
      await lake.lakeRead({
        userId: OWNER,
        sessionId: SID,
        manifest: manifest(),
        id: "n_orders",
        via: "test",
        io,
      });
      expect(rec.sql.some((q) => /SECRET/.test(q))).toBe(false);
    } finally {
      rec.restore();
    }
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
  const st = await lake.lakeStage({ sessionId: SID, manifest: m, id, parts: 1, userId: READER });
  const key = decodeURIComponent(new URL(st.puts[0]!).pathname).replace(/^\/lake\//, "");
  mkdirSync(path.dirname(io.url(key)), { recursive: true });
  await q(`COPY (${select}) TO '${io.url(key)}' (FORMAT parquet)`);
  return { id, batch: st.batch, parts: 1 };
}

const commit = (
  loads: { id: string; batch: string; parts: number; documents?: string[] }[],
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
  it("hands out PUTs under this session's own prefix, for declared targets only", async () => {
    const st = await lake.lakeStage({
      sessionId: SID,
      manifest: manifest(),
      id: "t_append",
      parts: 3,
      userId: READER,
    });
    expect(st.puts).toHaveLength(3);
    for (const [k, u] of st.puts.entries()) {
      expect(new URL(u).pathname).toBe(
        `/lake/_sandbox_staging/${SID}/out/${st.batch}/${k}.parquet`,
      );
    }
    await expect(
      lake.lakeStage({
        sessionId: SID,
        manifest: manifest(),
        id: "n_orders",
        parts: 1,
        userId: READER,
      }),
    ).rejects.toThrow(/declared no lakehouse target/);
    await expect(
      lake.lakeStage({
        sessionId: SID,
        manifest: manifest(),
        id: "t_append",
        parts: 0,
        userId: READER,
      }),
    ).rejects.toThrow(/1 to \d+ staged parts/);
  });

  // R442. The store takes a KMS key only from headers, so the URL alone cannot
  // say it; signed into the URL, the headers are what the store checks, and an
  // upload that leaves them out, or names another key, is refused.
  it("signs the owner's customer key into every PUT, for code that sends it", async () => {
    owner.kms = ARN;
    owner.asked.length = 0;
    try {
      const st = await lake.lakeStage({
        sessionId: SID,
        manifest: manifest(),
        id: "t_append",
        parts: 2,
        userId: OWNER,
        sendsHeaders: true,
      });
      expect(owner.asked).toEqual([OWNER]);
      expect(st.headers).toEqual({
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": ARN,
      });
      for (const u of st.puts) {
        expect(new URL(u).searchParams.get("X-Amz-SignedHeaders")).toBe(
          "host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id",
        );
      }
    } finally {
      owner.kms = null;
    }
  });

  it("signs no key for code that does not send headers, and asks for none", async () => {
    // A pipeline ejected to code before R442: a URL naming headers it never
    // sends would fail every load. Its rows stage as they always did.
    owner.kms = ARN;
    owner.asked.length = 0;
    try {
      const st = await lake.lakeStage({
        sessionId: SID,
        manifest: manifest(),
        id: "t_append",
        parts: 1,
        userId: OWNER,
      });
      expect(owner.asked).toEqual([]);
      expect(st.headers).toBeUndefined();
      expect(new URL(st.puts[0]!).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    } finally {
      owner.kms = null;
    }
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

// R458. A VARIANT column reached Python as dicts and was staged as a STRUCT
// (or a MAP of strings), so a pipeline that read a VARIANT wrote back
// something else. The sandbox now stages those columns as JSON text and names
// them; the commit makes each the type its target already has, or VARIANT.
describe("a load of columns the sandbox read as VARIANT", () => {
  const DOC = `'{"n": 5, "tags": ["a", "b"], "o": {"k": true}}'`;
  const typeOf = async (table: string, column: string) =>
    (
      await q(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'mine' AND table_name = '${table}' AND column_name = '${column}'`,
      )
    )[0]?.[0];

  it("lands as a VARIANT with the JSON's structure in a table the load creates", async () => {
    await commit([
      {
        ...(await stage("t_docs", `SELECT 1 AS id, ${DOC} AS payload UNION ALL SELECT 2, NULL`)),
        documents: ["payload"],
      },
    ]);
    expect(await typeOf("docs", "payload")).toBe("VARIANT");
    expect(
      await q(
        `SELECT id, payload IS NULL, variant_typeof(payload), payload.n::INTEGER,
                payload.o.k::BOOLEAN, CAST(payload AS JSON)::VARCHAR
         FROM mine.docs WHERE id = 1`,
      ),
    ).toEqual([
      [1, false, "OBJECT(n, tags, o)", 5, true, '{"n":5,"tags":["a","b"],"o":{"k":true}}'],
    ]);
    // A missing value stays a SQL NULL. (DuckDB 1.5.5 also names a NULL in a
    // VARIANT column VARIANT_NULL and casts it to JSON 'null', measured on a
    // table that never went through a pipeline; IS NULL is what holds.)
    expect(await q("SELECT payload IS NULL FROM mine.docs WHERE id = 2")).toEqual([[true]]);
  });

  it("appends into a VARIANT column, and replaces a table as VARIANT", async () => {
    await commit([
      {
        ...(await stage("t_docs", `SELECT 3 AS id, '[1, 2.5]' AS payload`)),
        documents: ["payload"],
      },
    ]);
    expect(await q("SELECT id, variant_typeof(payload) FROM mine.docs WHERE id = 3")).toEqual([
      [3, "ARRAY(2)"],
    ]);
    await commit([
      { ...(await stage("t_docs_snap", `SELECT ${DOC} AS payload`)), documents: ["payload"] },
    ]);
    expect(await typeOf("docsnap", "payload")).toBe("VARIANT");
  });

  it("becomes the type a target column already has, as a STRUCT did before", async () => {
    await q("CREATE TABLE mine.structy (id INTEGER, payload STRUCT(n INTEGER))");
    await commit([
      {
        ...(await stage("t_structy", `SELECT 1 AS id, '{"n": 7}' AS payload`)),
        documents: ["payload"],
      },
    ]);
    expect(await typeOf("structy", "payload")).toBe("STRUCT(n INTEGER)");
    expect(await q("SELECT payload.n FROM mine.structy")).toEqual([[7]]);
  });

  it("leaves text alone when the load names no document, and a named column that is not text", async () => {
    await commit([await stage("t_plain", `SELECT 1 AS id, ${DOC} AS payload, 9 AS n`)]);
    expect(await typeOf("plain", "payload")).toBe("VARCHAR");
    await commit([
      {
        ...(await stage("t_plain", `SELECT 2 AS id, ${DOC} AS payload, 10 AS n`)),
        // n is staged as a number: the sandbox only names what it wrote as JSON.
        documents: ["n", "not_a_column"],
      },
    ]);
    expect(await typeOf("plain", "n")).toBe("INTEGER");
    expect(await q("SELECT count(*) FROM mine.plain")).toEqual([[2n]]);
  });

  it("quotes a document's name, so a name cannot become SQL", async () => {
    await commit([
      {
        ...(await stage("t_docs_snap", `SELECT '{"a": 1}' AS "we""ird) --"`)),
        documents: ['we"ird) --'],
      },
    ]);
    expect(await typeOf("docsnap", 'we"ird) --')).toBe("VARIANT");
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

  it("signs for the session's owner, never for someone the request names (R442)", () => {
    const fn = route.slice(
      route.indexOf("async function lakePart"),
      route.indexOf("async function handle"),
    );
    // The key a put is signed under is the owner's: whoever the token says.
    const call = (name: string) =>
      fn.slice(fn.indexOf(`lake.${name}({`), fn.indexOf("})", fn.indexOf(`lake.${name}({`)));
    for (const name of ["lakeArtifact", "lakeStage"]) {
      expect(fn.indexOf(`lake.${name}({`), name).toBeGreaterThan(-1);
      expect(call(name), name).toContain("userId: s.userId,");
    }
    expect(fn).not.toMatch(/userId: body\./);
    // A stage signs headers only for code that says it sends them.
    expect(fn).toContain("sendsHeaders: body.headers === true,");
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

  it("is signed for the one key this run declared, for the method it declared", async () => {
    const put = await lake.lakeArtifact({
      manifest: m({ put: "ml-artifacts/m1/v3/model.joblib", get: [] }),
      which: "put",
      uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
      userId: OWNER,
    });
    const url = new URL(put.url);
    expect(url.pathname).toBe("/lake/ml-artifacts/m1/v3/model.joblib");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(put.headers).toBeUndefined();
  });

  it("puts a covered owner's model under their customer key, and reads one with no key", async () => {
    owner.kms = ARN;
    owner.asked.length = 0;
    try {
      const put = await lake.lakeArtifact({
        manifest: m({
          put: "ml-artifacts/m1/v3/model.joblib",
          get: ["ml-artifacts/m1/v2/model.joblib"],
        }),
        which: "put",
        uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
        userId: OWNER,
      });
      expect(owner.asked).toEqual([OWNER]);
      expect(put.headers).toEqual({
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": ARN,
      });
      expect(new URL(put.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
        "host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id",
      );
      // A read is decrypted by the store for whoever signed the URL.
      const get = await lake.lakeArtifact({
        manifest: m({ get: ["ml-artifacts/m1/v2/model.joblib"] }),
        which: "get",
        uri: "s3://lake/ml-artifacts/m1/v2/model.joblib",
        userId: OWNER,
      });
      expect(owner.asked).toEqual([OWNER]);
      expect(get.headers).toBeUndefined();
      expect(new URL(get.url).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    } finally {
      owner.kms = null;
    }
  });

  it("names the key the way the store reads it: Cloud Storage's header there", async () => {
    // R443: on Cloud Storage a Cloud KMS key is named by x-goog-encryption-kms-key-name;
    // S3's SSE-KMS headers would be ignored, and the model stored under the bucket's own.
    const GKEY = "projects/acme-prod/locations/europe-west1/keyRings/lake/cryptoKeys/acme";
    owner.kms = GKEY;
    where.endpoint = "storage.googleapis.com";
    try {
      const put = await lake.lakeArtifact({
        manifest: m({ put: "ml-artifacts/m1/v3/model.joblib", get: [] }),
        which: "put",
        uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
        userId: OWNER,
      });
      expect(put.headers).toEqual({ "x-goog-encryption-kms-key-name": GKEY });
      expect(new URL(put.url).host).toBe("storage.googleapis.com");
      expect(new URL(put.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
        "host;x-goog-encryption-kms-key-name",
      );
      const st = await lake.lakeStage({
        sessionId: SID,
        manifest: manifest(),
        id: "t_append",
        parts: 1,
        userId: OWNER,
        sendsHeaders: true,
      });
      expect(st.headers).toEqual({ "x-goog-encryption-kms-key-name": GKEY });
    } finally {
      owner.kms = null;
      where.endpoint = "minio:9000";
    }
  });

  it("cannot be read when only writing was declared, or the other way round", async () => {
    const writeOnly = m({ put: "ml-artifacts/m1/v3/model.joblib", get: [] });
    await expect(
      lake.lakeArtifact({
        manifest: writeOnly,
        which: "get",
        uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
        userId: OWNER,
      }),
    ).rejects.toThrow(/may not get/);
    const readOnly = m({ get: ["ml-artifacts/m1/v3/model.joblib"] });
    await expect(
      lake.lakeArtifact({
        manifest: readOnly,
        which: "put",
        uri: "s3://lake/ml-artifacts/m1/v3/model.joblib",
        userId: OWNER,
      }),
    ).rejects.toThrow(/may not put/);
  });

  it("cannot be another model's, whatever URI is asked for", async () => {
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
      await expect(
        lake.lakeArtifact({ manifest: mine, which: "get", uri, userId: OWNER }),
        uri,
      ).rejects.toThrow(/may not get/);
    }
  });

  it("is refused outright by a run that declared none", async () => {
    await expect(
      lake.lakeArtifact({
        manifest: manifest() as never,
        which: "get",
        uri: "s3://lake/x",
        userId: OWNER,
      }),
    ).rejects.toThrow(/declared no model artifacts/);
  });
});
