// R440: lakehouse files under customer keys, the server half, over tables and
// an in-memory S3.
//
// The real plan, secrets, pass and check run; the database is the in-memory
// PostgREST fake, the engine a connection that records its SQL, and the store
// a fetch handler that keeps objects with the encryption each request asked
// for. What is checked is what an operator relies on: a covered schema's
// writes carry the customer's key and nothing else's does; a plan that cannot
// be read drops nothing; the pass puts each file where it belongs and never
// moves one off a destroyed key; the check reports what the store did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as null | Record<string, unknown>,
  audits: [] as Array<Record<string, unknown>>,
  conn: null as null | {
    run: (sql: string) => Promise<{ getRows: () => Promise<unknown[][]> }>;
    closeSync: () => void;
  },
}));

vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => h.audits.push(e),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (h.db as Record<string | symbol, unknown>)[prop] },
  ),
}));
vi.mock("@/utils/lakehouse/core.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/lakehouse/core.server")>()),
  lakehouseConnection: async () => h.conn,
}));

import {
  checkStoreUnderKey,
  customerKeyFileError,
  ensureCustomerKeySecrets,
  customerKeyFilesView,
  forgetCustomerKeyFiles,
  forgetEngineAttachment,
  reEncryptFilesAfterMove,
  reEncryptLakehouseFiles,
} from "@/utils/lakehouse/customerKeyFiles.server";
import type { CustomerKeyRow } from "@/utils/kms/keyHierarchy.server";
import { s3CopyInPlace } from "@/utils/lakehouse/presign.server";
import { fakePostgrest } from "../fixtures/fakePostgrest";

const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const DEST = "arn:aws:kms:eu-west-1:111122223333:key/dddddddd-12ab-34cd-56ef-1234567890ab";
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const CAROL = "00000000-0000-4000-8000-0000000ca201";
const K_AWS = "10000000-0000-4000-8000-000000000001";
const K_APP = "10000000-0000-4000-8000-000000000002";
const K_DEAD = "10000000-0000-4000-8000-000000000003";
const S_ACME = "20000000-0000-4000-8000-000000000001";
const S_BOBS = "20000000-0000-4000-8000-000000000002";
const S_MOUNT = "20000000-0000-4000-8000-000000000003";
const S_CAROL = "20000000-0000-4000-8000-000000000004";
const T_ACME = "30000000-0000-4000-8000-000000000001";
const T_BOBS = "30000000-0000-4000-8000-000000000002";
const hex = (id: string) => id.replace(/-/g, "");

const ENV = {
  LAKEHOUSE_CATALOG_URL: "postgres://lake:pw@catalog:5432/lake",
  LAKEHOUSE_DATA_URL: "s3://lake-bucket/lake",
  LAKEHOUSE_S3_ENDPOINT: "s3.test:9000",
  LAKEHOUSE_S3_KEY_ID: "AKIDEXAMPLE",
  LAKEHOUSE_S3_SECRET: "test-secret-value",
  LAKEHOUSE_S3_REGION: "eu-west-1",
  LAKEHOUSE_S3_URL_STYLE: "path",
  LAKEHOUSE_S3_USE_SSL: "false",
  LAKEHOUSE_SSE_KMS: "on",
};
const saved: Record<string, string | undefined> = {};

function key(
  id: string,
  provider: string,
  ref: string | null,
  destroyed = false,
): Record<string, unknown> {
  return {
    id,
    name: { [K_AWS]: "Acme", [K_APP]: "Bobco", [K_DEAD]: "Gone" }[id],
    provider,
    key_ref: ref,
    endpoint: null,
    material: destroyed ? null : "m",
    iv: null,
    wrapped_by: null,
    kid: `kid${id.slice(-4)}`,
    created_at: "2026-11-01T00:00:00Z",
    destroyed_at: destroyed ? "2026-11-02T00:00:00Z" : null,
  };
}

function seed(overrides: Record<string, Array<Record<string, unknown>>> = {}) {
  h.db = fakePostgrest({
    customer_keys: [
      key(K_AWS, "aws", ARN),
      key(K_APP, "app", null),
      key(K_DEAD, "aws", DEST, true),
    ],
    customer_key_members: [
      { id: "m1", customer_key_id: K_AWS, user_id: ALICE, group_id: null },
      { id: "m2", customer_key_id: K_APP, user_id: BOB, group_id: null },
    ],
    user_keys: [],
    iam_group_members: [],
    lakehouse_schemas: [
      { id: S_ACME, name: "acme", user_id: ALICE, lake_source_id: null, iceberg_catalog_id: null },
      { id: S_BOBS, name: "bobs", user_id: BOB, lake_source_id: null, iceberg_catalog_id: null },
      {
        id: S_MOUNT,
        name: "acme_raw",
        user_id: ALICE,
        lake_source_id: "src",
        iceberg_catalog_id: null,
      },
      {
        id: S_CAROL,
        name: "carol",
        user_id: CAROL,
        lake_source_id: null,
        iceberg_catalog_id: null,
      },
    ],
    lakehouse_share_tables: [
      { id: T_ACME, schema_name: "acme" },
      { id: T_BOBS, schema_name: "bobs" },
    ],
    ...overrides,
  }).client as unknown as Record<string, unknown>;
}

/** An engine connection that records its SQL and keeps a set of secrets. */
function fakeConn(secrets: string[] = []) {
  const state = { sql: [] as string[], secrets: new Set(secrets), noInlining: new Set<string>() };
  h.conn = {
    async run(sql: string) {
      state.sql.push(sql);
      let rows: unknown[][] = [];
      if (sql.includes("__ducklake_metadata_lake.ducklake_schema")) {
        rows = [
          ["acme", "acme/", true, 1n],
          ["bobs", "bobs/", true, 2n],
          ["carol", "carol/", true, 3n],
        ];
      } else if (sql.includes("FROM duckdb_secrets()")) {
        rows = [...state.secrets].map((n) => [n]);
      } else if (sql.includes("FROM ducklake_options('lake')")) {
        rows = [...state.noInlining].map((n) => [n]);
      } else {
        const made = /^CREATE OR REPLACE SECRET (\w+)/.exec(sql);
        if (made) state.secrets.add(made[1]);
        const dropped = /^DROP SECRET IF EXISTS (\w+)/.exec(sql);
        if (dropped) state.secrets.delete(dropped[1]);
        const inline = /set_option\('data_inlining_row_limit', 0, schema => '(\w+)'\)/.exec(sql);
        if (inline) state.noInlining.add(inline[1]);
      }
      return { getRows: async () => rows };
    },
    closeSync() {},
  };
  return state;
}

type Obj = { sse: string; kms: string | null; type: string };
/** An S3 that keeps each object's encryption as the request asked. */
function fakeS3(opts: { ignoresKms?: boolean; refuseKms?: string; copyFailsFor?: string } = {}) {
  const objects = new Map<string, Obj>();
  const requests: Array<{ method: string; key: string; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const [, bucket, ...rest] = u.pathname.split("/");
    const k = decodeURIComponent(rest.join("/"));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [n, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[n.toLowerCase()] = v;
    }
    requests.push({ method, key: k, headers });
    const id = `${bucket}/${k}`;
    const sseOf = (): Obj => {
      if (headers["x-amz-server-side-encryption"] === "aws:kms" && !opts.ignoresKms) {
        return {
          sse: "aws:kms",
          kms: headers["x-amz-server-side-encryption-aws-kms-key-id"],
          type: "",
        };
      }
      return { sse: "AES256", kms: null, type: "" };
    };
    if (method === "GET" && u.searchParams.get("list-type") === "2") {
      const prefix = `${bucket}/${u.searchParams.get("prefix") ?? ""}`;
      const keys = [...objects.keys()].filter((o) => o.startsWith(prefix));
      const xml = `<ListBucketResult>${keys
        .map(
          (o) =>
            `<Contents><Key>${o.slice(bucket.length + 1)}</Key><LastModified>2026-11-03T00:00:00Z</LastModified></Contents>`,
        )
        .join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (method === "HEAD") {
      const o = objects.get(id);
      if (!o) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "10",
          "content-type": o.type || "application/octet-stream",
          "x-amz-server-side-encryption": o.sse,
          ...(o.kms ? { "x-amz-server-side-encryption-aws-kms-key-id": o.kms } : {}),
        },
      });
    }
    if (method === "PUT") {
      if (opts.refuseKms && headers["x-amz-server-side-encryption"] === "aws:kms") {
        return new Response(
          `<Error><Code>${opts.refuseKms}</Code><Message>Invalid keyId</Message></Error>`,
          { status: 400 },
        );
      }
      if (headers["x-amz-copy-source"]) {
        if (opts.copyFailsFor && k.includes(opts.copyFailsFor)) {
          return new Response(
            "<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>",
            {
              status: 200,
            },
          );
        }
        expect(headers["x-amz-copy-source"]).toBe(`/${bucket}/${k}`);
        const before = objects.get(id) as Obj;
        objects.set(id, { ...sseOf(), type: headers["content-type"] ?? before.type });
        return new Response("<CopyObjectResult><ETag>x</ETag></CopyObjectResult>", { status: 200 });
      }
      const o = sseOf();
      objects.set(id, o);
      return new Response("", {
        status: 200,
        headers: {
          "x-amz-server-side-encryption": o.sse,
          ...(o.kms ? { "x-amz-server-side-encryption-aws-kms-key-id": o.kms } : {}),
        },
      });
    }
    if (method === "DELETE") {
      objects.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  });
  vi.stubGlobal("fetch", fetchFn);
  return { objects, requests };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  h.audits.length = 0;
  forgetCustomerKeyFiles();
  forgetEngineAttachment();
  seed();
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.SHARE_DATA_URL;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("each covered schema's writes carry its customer's key", () => {
  it("creates a scoped secret for a covered schema and its shares, and none for anyone else", async () => {
    const st = fakeConn([`lake_ck_s_${"9".repeat(32)}`]);
    await ensureCustomerKeySecrets(h.conn!, true);
    const created = st.sql.filter((s) => s.startsWith("CREATE OR REPLACE SECRET"));
    expect(created).toHaveLength(2);
    const schema = created.find((s) => s.includes(`lake_ck_s_${hex(S_ACME)}`)) ?? "";
    // The store's own credential, the customer's key, the schema's folder.
    expect(schema).toContain("TYPE s3");
    expect(schema).toContain("KEY_ID 'AKIDEXAMPLE'");
    expect(schema).toContain("ENDPOINT 's3.test:9000'");
    expect(schema).toContain(`KMS_KEY_ID '${ARN}'`);
    expect(schema).toContain("SCOPE 's3://lake-bucket/lake/acme/'");
    const share = created.find((s) => s.includes(`lake_ck_t_${hex(T_ACME)}`)) ?? "";
    expect(share).toContain(`SCOPE 's3://lake-bucket/shares/${T_ACME}/'`);
    // Bob's key is held by the app; Carol has none; a mount's files are not ours.
    expect(created.join("\n")).not.toContain(hex(S_BOBS));
    expect(created.join("\n")).not.toContain(hex(S_CAROL));
    expect(created.join("\n")).not.toContain(hex(S_MOUNT));
    expect(created.join("\n")).not.toContain(hex(T_BOBS));
    // A secret no longer wanted goes.
    expect(st.sql).toContain(`DROP SECRET IF EXISTS lake_ck_s_${"9".repeat(32)};`);
    expect([...st.secrets].sort()).toEqual(
      [`lake_ck_s_${hex(S_ACME)}`, `lake_ck_t_${hex(T_ACME)}`].sort(),
    );
    // Small writes of the covered schema stop going into the catalog.
    expect(st.sql.filter((s) => s.includes("data_inlining_row_limit', 0"))).toEqual([
      "CALL lake.set_option('data_inlining_row_limit', 0, schema => 'acme');",
    ]);
  });

  it("follows SHARE_DATA_URL for share snapshots", async () => {
    process.env.SHARE_DATA_URL = "s3://share-bucket/out/";
    const st = fakeConn();
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(st.sql.join("\n")).toContain(`SCOPE 's3://share-bucket/out/${T_ACME}/'`);
  });

  it("sets the inlining option once, not on every sync", async () => {
    const st = fakeConn();
    await ensureCustomerKeySecrets(h.conn!, true);
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(st.sql.filter((s) => s.includes("set_option('data_inlining_row_limit'"))).toHaveLength(
      1,
    );
  });

  it("sets the inlining option on its own attachment even when the catalog shows it set", async () => {
    // R440's round: with a Postgres catalog, ducklake_options() showed the
    // option another worker had set, the sync trusted it, and this worker's
    // attachment (which read its options when it attached) still inlined a
    // one-row insert into the catalog. The view is not consulted any more.
    const st = fakeConn();
    st.noInlining.add("acme");
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(st.sql).toContain(
      "CALL lake.set_option('data_inlining_row_limit', 0, schema => 'acme');",
    );
    // A new engine attaches afresh, and sets it again.
    forgetEngineAttachment();
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(st.sql.filter((s) => s.includes("set_option('data_inlining_row_limit'"))).toHaveLength(
      2,
    );
  });

  it("leaves alone, without a warning, a covered schema the catalog does not have yet", async () => {
    seed({
      lakehouse_schemas: [
        {
          id: S_ACME,
          name: "acme",
          user_id: ALICE,
          lake_source_id: null,
          iceberg_catalog_id: null,
        },
        {
          id: S_MOUNT,
          name: "acme_new",
          user_id: ALICE,
          lake_source_id: null,
          iceberg_catalog_id: null,
        },
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const st = fakeConn();
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(st.sql.filter((s) => s.includes("set_option('data_inlining_row_limit'"))).toEqual([
      "CALL lake.set_option('data_inlining_row_limit', 0, schema => 'acme');",
    ]);
    // Its secret is there all the same: the first write after it is created is covered.
    expect(st.secrets.has(`lake_ck_s_${hex(S_MOUNT)}`)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("tells the card what each key covers without opening the lakehouse", async () => {
    // R440's round: the card waited over a minute on "Checking..." while the
    // first lakehouse connection brought a catalog up.
    h.conn = {
      run: () => Promise.reject(new Error("the lakehouse must not be opened for the card")),
      closeSync() {},
    };
    const v = await customerKeyFilesView();
    expect(v.error).toBeUndefined();
    expect(v.perKey.get(K_AWS)).toEqual({ kmsKeyId: ARN, why: null, schemas: 1 });
    expect(v.perKey.get(K_APP)?.kmsKeyId).toBeNull();
    expect(v.perKey.get(K_APP)?.schemas).toBe(1);
  });

  it("syncs at most every few seconds unless forced", async () => {
    const st = fakeConn();
    await ensureCustomerKeySecrets(h.conn!, true);
    const n = st.sql.length;
    await ensureCustomerKeySecrets(h.conn!);
    expect(st.sql.length).toBe(n);
    forgetCustomerKeyFiles();
    await ensureCustomerKeySecrets(h.conn!);
    expect(st.sql.length).toBeGreaterThan(n);
  });

  it("drops every customer key's secret when the store does not encrypt under them", async () => {
    const st = fakeConn([`lake_ck_s_${hex(S_ACME)}`]);
    process.env.LAKEHOUSE_SSE_KMS = "off";
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(st.sql.some((s) => s.startsWith("CREATE OR REPLACE SECRET"))).toBe(false);
    expect(st.secrets.size).toBe(0);
  });

  it("drops nothing when the schemas cannot be read", async () => {
    // R372's lesson: a list that could not be read is not an empty one. Here
    // it would have dropped every covered schema's secret, and its files would
    // have been written under the store's own encryption without a word.
    // No lakehouse_schemas table: its read fails.
    h.db = fakePostgrest({
      customer_keys: [key(K_AWS, "aws", ARN)],
      customer_key_members: [{ id: "m1", customer_key_id: K_AWS, user_id: ALICE, group_id: null }],
      iam_group_members: [],
    }).client as unknown as Record<string, unknown>;
    const st = fakeConn([`lake_ck_s_${hex(S_ACME)}`]);
    await expect(ensureCustomerKeySecrets(h.conn!, true)).rejects.toThrow(
      /Could not read the lakehouse schemas/,
    );
    expect(st.sql.some((s) => s.startsWith("DROP SECRET"))).toBe(false);
    expect(st.secrets.has(`lake_ck_s_${hex(S_ACME)}`)).toBe(true);
  });

  it("explains a refusal of the customer's key on a covered schema's file", async () => {
    fakeConn();
    await ensureCustomerKeySecrets(h.conn!, true);
    expect(
      customerKeyFileError(
        "HTTP Error: HTTP GET error reading 's3://lake-bucket/lake/acme/t/x.parquet' in region 'eu-west-1' (HTTP 403 Forbidden)",
      ),
    ).toMatch(/^The store refused a file of lakehouse schema "acme"/);
    expect(
      customerKeyFileError(
        "HTTP Error: HTTP GET error reading 's3://lake-bucket/lake/bobs/t/x.parquet' (HTTP 403 Forbidden)",
      ),
    ).toBeNull();
  });
});

describe("the re-encrypt pass puts each file where it belongs", () => {
  function files(s3: ReturnType<typeof fakeS3>) {
    s3.objects.set("lake-bucket/lake/acme/t/a.parquet", { sse: "AES256", kms: null, type: "" });
    s3.objects.set("lake-bucket/lake/acme/t/b.parquet", { sse: "aws:kms", kms: ARN, type: "" });
    // Bob's key is held by the app: a file under Acme's key is his no longer.
    s3.objects.set("lake-bucket/lake/bobs/t/c.parquet", {
      sse: "aws:kms",
      kms: ARN,
      type: "application/vnd.apache.parquet",
    });
    s3.objects.set("lake-bucket/lake/bobs/t/d.parquet", { sse: "aws:kms", kms: DEST, type: "" });
    s3.objects.set(`lake-bucket/shares/${T_ACME}/fp-1/part-0.parquet`, {
      sse: "AES256",
      kms: null,
      type: "",
    });
  }

  it("copies in place onto the customer's key, back to the store's, and never off a destroyed key", async () => {
    const st = fakeConn();
    const s3 = fakeS3();
    files(s3);
    const r = await reEncryptLakehouseFiles();
    expect(r).toMatchObject({
      skipped: null,
      schemas: 3,
      files: 5,
      reEncrypted: 2,
      toStoreKey: 1,
      alreadyRight: 1,
      keptUnderDestroyed: 1,
      failed: 0,
    });
    expect(s3.objects.get("lake-bucket/lake/acme/t/a.parquet")).toMatchObject({
      sse: "aws:kms",
      kms: ARN,
    });
    expect(s3.objects.get(`lake-bucket/shares/${T_ACME}/fp-1/part-0.parquet`)).toMatchObject({
      kms: ARN,
    });
    expect(s3.objects.get("lake-bucket/lake/bobs/t/c.parquet")).toMatchObject({
      sse: "AES256",
      kms: null,
      type: "application/vnd.apache.parquet",
    });
    expect(s3.objects.get("lake-bucket/lake/bobs/t/d.parquet")).toMatchObject({ kms: DEST });
    // The copies: onto a key with COPY, back to the store's with REPLACE and the type kept.
    const copies = s3.requests.filter((q) => q.headers["x-amz-copy-source"]);
    expect(copies).toHaveLength(3);
    const toKey = copies.find((q) => q.key === "lake/acme/t/a.parquet")!;
    expect(toKey.headers["x-amz-metadata-directive"]).toBe("COPY");
    expect(toKey.headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(ARN);
    const toStore = copies.find((q) => q.key === "lake/bobs/t/c.parquet")!;
    expect(toStore.headers["x-amz-metadata-directive"]).toBe("REPLACE");
    expect(toStore.headers["x-amz-server-side-encryption"]).toBeUndefined();
    expect(toStore.headers["content-type"]).toBe("application/vnd.apache.parquet");
    // Rows still inline in the catalog are written out first, for covered schemas.
    expect(st.sql.filter((s) => s.includes("ducklake_flush_inlined_data"))).toEqual([
      "CALL ducklake_flush_inlined_data('lake', schema_name => 'acme')",
    ]);
  });

  it("takes only the given owners' schemas", async () => {
    fakeConn();
    const s3 = fakeS3();
    files(s3);
    const r = await reEncryptLakehouseFiles({ owners: [BOB] });
    expect(r).toMatchObject({ schemas: 1, files: 2, toStoreKey: 1, keptUnderDestroyed: 1 });
    expect(s3.objects.get("lake-bucket/lake/acme/t/a.parquet")).toMatchObject({ sse: "AES256" });
  });

  it("counts a copy S3 failed after answering 200", async () => {
    fakeConn();
    const s3 = fakeS3({ copyFailsFor: "acme/t/a.parquet" });
    files(s3);
    const r = await reEncryptLakehouseFiles({ owners: [ALICE] });
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toBe(
      "lake/acme/t/a.parquet: COPY lake/acme/t/a.parquet failed (200 InternalError: We encountered an internal error.)",
    );
    expect(s3.objects.get("lake-bucket/lake/acme/t/a.parquet")).toMatchObject({ sse: "AES256" });
  });

  it("leaves alone a schema whose owner is in two customer keys", async () => {
    seed({
      customer_key_members: [
        { id: "m1", customer_key_id: K_AWS, user_id: null, group_id: "g1" },
        { id: "m2", customer_key_id: K_APP, user_id: null, group_id: "g2" },
      ],
      iam_group_members: [
        { group_id: "g1", user_id: ALICE },
        { group_id: "g2", user_id: ALICE },
      ],
    });
    fakeConn();
    const s3 = fakeS3();
    files(s3);
    const r = await reEncryptLakehouseFiles({ owners: [ALICE] });
    expect(r).toMatchObject({ schemas: 0, conflicted: 1, files: 0 });
    expect(s3.requests.some((q) => q.headers["x-amz-copy-source"])).toBe(false);
  });

  it("does nothing, and says why, while the store does not encrypt under customer keys", async () => {
    process.env.LAKEHOUSE_SSE_KMS = "off";
    fakeConn();
    const s3 = fakeS3();
    const r = await reEncryptLakehouseFiles();
    expect(r.skipped).toBe("Turned off for this deployment (LAKEHOUSE_SSE_KMS=off).");
    expect(s3.requests).toHaveLength(0);
  });
});

describe("after a move, the files follow once every worker has synced", () => {
  it("runs the owners' pass after the sync window, and audits it", async () => {
    vi.useFakeTimers();
    fakeConn();
    const s3 = fakeS3();
    s3.objects.set("lake-bucket/lake/acme/t/a.parquet", { sse: "AES256", kms: null, type: "" });
    reEncryptFilesAfterMove([ALICE], 'assignment to "Acme"', {
      userId: "00000000-0000-4000-8000-0000000ad111",
      email: "admin@example.test",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.audits).toHaveLength(0); // not before every worker could have synced
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.audits).toHaveLength(1));
    expect(h.audits[0]).toMatchObject({
      action: "security.lakehouse_files.reencrypt",
      actorEmail: "admin@example.test",
      detail: { trigger: 'assignment to "Acme"', users: 1, files: 1, files_reencrypted: 1 },
    });
    expect(s3.objects.get("lake-bucket/lake/acme/t/a.parquet")).toMatchObject({ kms: ARN });
  });

  it("schedules nothing while no live customer key is in AWS KMS", async () => {
    vi.useFakeTimers();
    seed({ customer_keys: [key(K_APP, "app", null), key(K_DEAD, "aws", DEST, true)] });
    fakeConn();
    const s3 = fakeS3();
    reEncryptFilesAfterMove([BOB], "a group change");
    await vi.advanceTimersByTimeAsync(25_000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.audits).toHaveLength(0);
    expect(s3.requests).toHaveLength(0);
  });
});

describe("the check asks the store to write under the key", () => {
  const row = (id: string, provider: string, ref: string | null) =>
    key(id, provider, ref) as unknown as CustomerKeyRow;

  it("reports a file the store wrote under the key, and deletes it", async () => {
    const s3 = fakeS3();
    const r = await checkStoreUnderKey(row(K_AWS, "aws", ARN));
    expect(r).toEqual({
      covered: true,
      ok: true,
      detail: "The lakehouse store wrote a test file under this key (aws:kms) and it was deleted.",
    });
    const put = s3.requests.find((q) => q.method === "PUT")!;
    expect(put.key).toMatch(new RegExp(`^_customer_key_check/${K_AWS}/[0-9a-f-]+\\.txt$`));
    expect(put.headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(ARN);
    expect(s3.requests.at(-1)?.method).toBe("DELETE");
    expect(s3.objects.size).toBe(0);
  });

  it("says so when the store took the file but not the key", async () => {
    const s3 = fakeS3({ ignoresKms: true });
    const r = await checkStoreUnderKey(row(K_AWS, "aws", ARN));
    expect(r).toEqual({
      covered: true,
      ok: false,
      detail:
        "The lakehouse store took the test file but stored it under AES256, not this key: it does not encrypt under customer keys.",
    });
    expect(s3.objects.size).toBe(0);
  });

  it("quotes the store's refusal", async () => {
    fakeS3({ refuseKms: "KMS.NotFoundException" });
    expect(await checkStoreUnderKey(row(K_AWS, "aws", ARN))).toEqual({
      covered: true,
      ok: false,
      detail:
        "The lakehouse store refused to write a test file under this key: KMS.NotFoundException: Invalid keyId.",
    });
  });

  it("does not ask the store about a key it cannot use", async () => {
    const s3 = fakeS3();
    const r = await checkStoreUnderKey(row(K_APP, "app", null));
    expect(r.covered).toBe(false);
    expect(s3.requests).toHaveLength(0);
  });
});

describe("a copy in place is signed with its source and encryption", () => {
  it("puts the copy headers inside the signature", async () => {
    const s3 = fakeS3();
    s3.objects.set("lake-bucket/k.parquet", { sse: "AES256", kms: null, type: "" });
    await s3CopyInPlace(
      {
        endpoint: "s3.test:9000",
        region: "eu-west-1",
        useSsl: false,
        urlStyle: "path",
        bucket: "lake-bucket",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "test-secret-value",
      },
      "k.parquet",
      { kmsKeyId: ARN, contentType: null },
    );
    const auth = s3.requests[0].headers.authorization;
    expect(auth).toMatch(
      /SignedHeaders=host;x-amz-content-sha256;x-amz-copy-source;x-amz-date;x-amz-metadata-directive;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id,/,
    );
  });
});
