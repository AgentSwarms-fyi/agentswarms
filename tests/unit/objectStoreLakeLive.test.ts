// The lake's own object-store calls, against a real S3-compatible server.
//
// The bundled store moved from MinIO to SILO, a maintained fork of it, because
// MinIO stopped publishing images anyone can pull (VA-2026-10-25-35, R418). "It
// keeps the S3 API" is the fork's claim; these are the calls this app makes,
// made against the server:
//
//   - signed PUT, HEAD, LIST and DELETE (presign.server.ts), which shares,
//     sandbox writes and the cleanup sweeps use;
//   - presigned URLs whose method and key are inside the signature;
//   - STS AssumeRole with a session policy, the scoped credential the Spark
//     cluster runs with (sts.server.ts), refused outside its prefixes;
//   - DuckDB's httpfs writing and reading Parquet with that credential, the way
//     the lakehouse engine attaches the store (core.server.ts).
//
//   docker run -d --name as-lake-test -p 127.0.0.1:9010:9000 \
//     -e MINIO_ROOT_USER=probeaccesskey -e MINIO_ROOT_PASSWORD=probesecretkey123 \
//     pgsty/silo:RELEASE.2026-10-26T00-00-00Z server /data
//
// Skipped, loudly, when nothing answers there, as objectStoreParquet.test.ts is:
// a suite that passes because its subject was absent proves nothing.
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { signS3Request } from "@/utils/catalog/objectStore.server";
import {
  presignS3,
  s3DeleteObject,
  s3DeletePrefix,
  s3ListKeys,
  s3ObjectSize,
  s3PutObject,
  type S3Target,
} from "@/utils/lakehouse/presign.server";
import { assumeScopedCredentials } from "@/utils/lakehouse/sts.server";

const ENDPOINT = "127.0.0.1:9010";
const TARGET: S3Target = {
  endpoint: ENDPOINT,
  region: "us-east-1",
  useSsl: false,
  urlStyle: "path",
  bucket: "lake-live",
  accessKeyId: "probeaccesskey",
  secretAccessKey: "probesecretkey123",
};
/** Every key this file writes is under here, and removed at the end. */
const ROOT = "itest";

const live = await (async () => {
  try {
    const r = await fetch(`http://${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
})();

if (!live) {
  console.warn(
    `\n[objectStoreLakeLive] no S3 server on ${ENDPOINT}: these tests are SKIPPED, not passed. ` +
      "They are the proof the bundled store answers the calls the lakehouse makes.\n",
  );
}

const withStore = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  it.skipIf(!live)(name, fn, timeout);

async function createBucket(): Promise<void> {
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const headers = {
    host: ENDPOINT,
    "x-amz-content-sha256": createHash("sha256").update("").digest("hex"),
    "x-amz-date": amzDate,
  };
  const { authorization } = signS3Request({
    method: "PUT",
    canonicalUri: `/${TARGET.bucket}`,
    query: {},
    headers,
    region: TARGET.region,
    accessKeyId: TARGET.accessKeyId,
    secretAccessKey: TARGET.secretAccessKey,
  });
  const { host: _host, ...send } = headers;
  void _host;
  const res = await fetch(`http://${ENDPOINT}/${TARGET.bucket}`, {
    method: "PUT",
    headers: { ...send, Authorization: authorization },
  });
  // 409: it is already there, from an earlier run.
  if (!res.ok && res.status !== 409) throw new Error(`create bucket: ${res.status}`);
}

beforeAll(async () => {
  if (!live) return;
  await createBucket();
  await s3DeletePrefix(TARGET, `${ROOT}/`).catch(() => 0);
}, 60_000);

describe("the app's signed calls", () => {
  withStore("write, size, list and delete one object", async () => {
    const key = `${ROOT}/signed/hello.txt`;
    const body = Buffer.from("hello from the lake\n");
    const put = await s3PutObject(TARGET, key, body);
    expect(put.bytes).toBe(body.length);
    expect(await s3ObjectSize(TARGET, key)).toBe(body.length);
    const listed = await s3ListKeys(TARGET, `${ROOT}/signed/`);
    expect(listed.map((k) => k.key)).toEqual([key]);
    expect(listed[0].lastModified.getTime()).toBeGreaterThan(Date.now() - 10 * 60_000);
    await s3DeleteObject(TARGET, key);
    expect(await s3ObjectSize(TARGET, key)).toBeNull();
  });

  withStore(
    "list a prefix past one page",
    async () => {
      // ListObjectsV2 answers 1000 keys a page; the continuation token is what
      // a cleanup sweep follows, and a server that dropped it would strand the rest.
      const n = 1005;
      for (let i = 0; i < n; i += 50) {
        await Promise.all(
          Array.from({ length: Math.min(50, n - i) }, (_, j) =>
            s3PutObject(TARGET, `${ROOT}/many/${String(i + j).padStart(5, "0")}`, Buffer.from("x")),
          ),
        );
      }
      expect((await s3ListKeys(TARGET, `${ROOT}/many/`)).length).toBe(n);
      expect(await s3DeletePrefix(TARGET, `${ROOT}/many/`)).toBe(n);
      expect(await s3ListKeys(TARGET, `${ROOT}/many/`)).toEqual([]);
    },
    180_000,
  );
});

describe("a presigned URL does the one thing it was signed for", () => {
  withStore("PUT then GET by URL, with no credential on the request", async () => {
    const key = `${ROOT}/presigned/model.bin`;
    const body = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    const putUrl = presignS3({
      target: TARGET,
      key,
      method: "PUT",
      expiresSeconds: 300,
      which: "app",
    });
    const put = await fetch(putUrl, { method: "PUT", body: new Uint8Array(body) });
    expect(put.status, await put.text()).toBe(200);

    const getUrl = presignS3({
      target: TARGET,
      key,
      method: "GET",
      expiresSeconds: 300,
      which: "app",
    });
    const got = await fetch(getUrl);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(body)).toBe(true);
  });

  withStore("refuses the URL for another method, another key, or after it expired", async () => {
    const key = `${ROOT}/presigned/only-this.txt`;
    await s3PutObject(TARGET, key, Buffer.from("only this"));
    const getUrl = presignS3({
      target: TARGET,
      key,
      method: "GET",
      expiresSeconds: 300,
      which: "app",
    });
    // The method is inside the signature: a GET URL cannot write.
    expect((await fetch(getUrl, { method: "PUT", body: "overwritten" })).status).toBe(403);
    // So is the key: the same signature on a neighbour is refused.
    expect((await fetch(getUrl.replace("only-this.txt", "neighbour.txt"))).status).toBe(403);
    const expired = presignS3({
      target: TARGET,
      key,
      method: "GET",
      expiresSeconds: 1,
      which: "app",
      now: new Date(Date.now() - 3600_000),
    });
    expect((await fetch(expired)).status).toBe(403);
    // And the object is what it was.
    expect(await (await fetch(getUrl)).text()).toBe("only this");
  });
});

describe("a scoped credential the store itself limits (STS AssumeRole)", () => {
  withStore("reads and writes inside its prefixes and nowhere else", async () => {
    await s3PutObject(TARGET, `${ROOT}/scope/in/source.txt`, Buffer.from("readable"));
    await s3PutObject(TARGET, `${ROOT}/scope/secret/hidden.txt`, Buffer.from("not for you"));

    const creds = await assumeScopedCredentials({
      target: TARGET,
      scope: { read: [`${ROOT}/scope/in/`], write: [`${ROOT}/scope/out/`] },
      label: "itest-scope",
    });
    expect(creds, "the store answered AssumeRole with no session").not.toBeNull();
    const scoped: S3Target = {
      ...TARGET,
      accessKeyId: creds!.accessKeyId,
      secretAccessKey: creds!.secretAccessKey,
      sessionToken: creds!.sessionToken,
    };
    expect(new Date(creds!.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Inside: read the read prefix, write the write prefix, list each.
    expect(await s3ObjectSize(scoped, `${ROOT}/scope/in/source.txt`)).toBe(8);
    await s3PutObject(scoped, `${ROOT}/scope/out/result.txt`, Buffer.from("written"));
    expect((await s3ListKeys(scoped, `${ROOT}/scope/in/`)).map((k) => k.key)).toEqual([
      `${ROOT}/scope/in/source.txt`,
    ]);

    // Outside: the store refuses, not the app.
    await expect(s3ObjectSize(scoped, `${ROOT}/scope/secret/hidden.txt`)).rejects.toThrow(/403/);
    await expect(
      s3PutObject(scoped, `${ROOT}/scope/in/overwrite.txt`, Buffer.from("no")),
    ).rejects.toThrow(/403/);
    await expect(s3ListKeys(scoped, `${ROOT}/`)).rejects.toThrow(/403/);
    // A sibling whose name only starts the same way is outside too.
    await expect(
      s3PutObject(scoped, `${ROOT}/scope/out_private/x.txt`, Buffer.from("no")),
    ).rejects.toThrow(/403/);
  });
});

describe("DuckDB writes and reads Parquet in the store", () => {
  withStore(
    "with the scoped credential, as a Spark or engine run would",
    async () => {
      const creds = await assumeScopedCredentials({
        target: TARGET,
        scope: { write: [`${ROOT}/duck/`] },
        label: "itest-duckdb",
      });
      expect(creds).not.toBeNull();
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const conn = await (await DuckDBInstance.create(":memory:")).connect();
      const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
      await conn.run("INSTALL httpfs; LOAD httpfs;");
      // The secret's shape is core.server.ts's, with the session token a
      // scoped credential adds.
      await conn.run(
        `CREATE SECRET lake (TYPE s3, KEY_ID ${q(creds!.accessKeyId)}, SECRET ${q(
          creds!.secretAccessKey,
        )}, SESSION_TOKEN ${q(creds!.sessionToken)}, ENDPOINT ${q(ENDPOINT)}, REGION 'us-east-1', URL_STYLE 'path', USE_SSL false)`,
      );
      const url = `s3://${TARGET.bucket}/${ROOT}/duck/orders.parquet`;
      // Enough rows that the upload is several parts, not one.
      await conn.run(
        `COPY (SELECT i AS order_id, 'region-' || (i % 7) AS region, i * 1.25 AS amount
               FROM range(400000) t(i)) TO ${q(url)} (FORMAT PARQUET)`,
      );
      const rows = await (
        await conn.run(
          `SELECT count(*)::INTEGER AS n, sum(order_id)::BIGINT AS s FROM read_parquet(${q(url)})`,
        )
      ).getRowObjects();
      expect(Number(rows[0].n)).toBe(400000);
      expect(BigInt(String(rows[0].s))).toBe(BigInt(399999 * 400000) / 2n);
      expect(await s3ObjectSize(TARGET, `${ROOT}/duck/orders.parquet`)).toBeGreaterThan(1_000_000);

      // Outside its prefix the same session reads nothing.
      await s3PutObject(TARGET, `${ROOT}/elsewhere/t.csv`, Buffer.from("a\n1\n"));
      await expect(
        conn.run(`SELECT * FROM read_csv(${q(`s3://${TARGET.bucket}/${ROOT}/elsewhere/t.csv`)})`),
      ).rejects.toThrow();
    },
    180_000,
  );
});

describe("cleanup", () => {
  withStore("leaves the bucket as it found it", async () => {
    await s3DeletePrefix(TARGET, `${ROOT}/`);
    expect(await s3ListKeys(TARGET, `${ROOT}/`)).toEqual([]);
  });
});
