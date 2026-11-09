// R465, against a real S3-compatible store: the lake reached as the app's own
// AWS identity rather than with keys.
//
// On ECS a task role's credentials come from a container-credentials endpoint
// (EKS Pod Identity serves the same shape). That endpoint is played here, in
// this process, and what it hands out are the store's own temporary
// credentials (STS AssumeRole), so the store checks every session token for
// real. Everything after the endpoint is the app's: the credential chain,
// lakeCredentials' resolver, the engine's secret (lakehouseS3SecretParts), the
// signed requests, and the rotation five minutes before expiry.
//
//   docker run -d --name as-lake-test -p 127.0.0.1:9010:9000 \
//     -e MINIO_ROOT_USER=probeaccesskey -e MINIO_ROOT_PASSWORD=probesecretkey123 \
//     pgsty/silo:RELEASE.2026-10-26T00-00-00Z server /data
//
// Skipped, loudly, when nothing answers there: a suite that passes because
// its subject was absent proves nothing.
import { createHash } from "node:crypto";
import http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAwsCredentialChain } from "@/utils/aws/credentials.server";
import { signS3Request } from "@/utils/catalog/objectStore.server";
import { lakehouseS3SecretParts, type LakehouseConfig } from "@/utils/lakehouse/core.server";
import {
  createLakeCredentialResolver,
  credentialStamp,
  type LakeCredentials,
} from "@/utils/lakehouse/lakeCredentials.server";
import {
  s3DeletePrefix,
  s3ListKeys,
  s3ObjectSize,
  s3PutObject,
  type S3Target,
} from "@/utils/lakehouse/presign.server";
import { assumeScopedCredentials } from "@/utils/lakehouse/sts.server";

const ENDPOINT = "127.0.0.1:9010";
const BUCKET = "lake-chain";
const ROOT = "itest-chain";
/** The store's root keys: used here only to set up, and by the endpoint to mint. */
const ROOT_TARGET: S3Target = {
  endpoint: ENDPOINT,
  region: "us-east-1",
  useSsl: false,
  urlStyle: "path",
  bucket: BUCKET,
  accessKeyId: "probeaccesskey",
  secretAccessKey: "probesecretkey123",
};
const CFG: LakehouseConfig = {
  catalog: "postgres://unused",
  dataUrl: `s3://${BUCKET}/main`,
  s3: { endpoint: ENDPOINT, region: "us-east-1", useSsl: false, urlStyle: "path" },
};

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
    `\n[lakeCredentialChainLive] no S3 server on ${ENDPOINT}: these tests are SKIPPED, not passed.\n`,
  );
}
const withStore = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it.skipIf(!live)(name, fn, timeout);

// ── The container-credentials endpoint (what ECS's agent serves) ────────────

let clock = Date.now();
let minted = 0;
let server: http.Server | null = null;
let port = 0;

/** Minted ahead: ECS's agent answers from its own cache, well inside the chain's timeout. */
const pool: Array<Awaited<ReturnType<typeof assumeScopedCredentials>>> = [];

async function startEndpoint(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    pool.push(
      await assumeScopedCredentials({
        target: ROOT_TARGET,
        scope: { write: [`${ROOT}/`] },
        label: `itest-chain-${i}`,
      }),
    );
  }
  server = http.createServer((req, res) => {
    if (req.url !== "/creds") {
      res.writeHead(404).end();
      return;
    }
    const c = pool[minted++ % pool.length];
    // The store's credentials last longer (15 min, its minimum); the endpoint
    // says six from the test's clock, so the chain's five-minute margin is
    // reached by moving the clock, not by waiting.
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        AccessKeyId: c!.accessKeyId,
        SecretAccessKey: c!.secretAccessKey,
        Token: c!.sessionToken,
        Expiration: new Date(clock + 6 * 60_000).toISOString(),
        RoleArn: "arn:aws:iam::000000000000:role/itest-task-role",
      }),
    );
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  port = (server!.address() as { port: number }).port;
}

function resolver() {
  const env = {
    LAKEHOUSE_S3_CREDENTIALS: "chain",
    LAKEHOUSE_S3_ENDPOINT: ENDPOINT,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${port}/creds`,
  };
  return createLakeCredentialResolver({
    env,
    chain: createAwsCredentialChain({ region: "us-east-1", env, now: () => clock }),
  });
}

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
    canonicalUri: `/${BUCKET}`,
    query: {},
    headers,
    region: "us-east-1",
    accessKeyId: ROOT_TARGET.accessKeyId,
    secretAccessKey: ROOT_TARGET.secretAccessKey,
  });
  const { host: _h, ...send } = headers;
  void _h;
  const r = await fetch(`http://${ENDPOINT}/${BUCKET}`, {
    method: "PUT",
    headers: { ...send, Authorization: authorization },
  });
  if (!r.ok && r.status !== 409) throw new Error(`create bucket: ${r.status} ${await r.text()}`);
}

const targetOf = (c: LakeCredentials): S3Target => ({
  ...ROOT_TARGET,
  accessKeyId: c.accessKeyId,
  secretAccessKey: c.secretAccessKey,
  ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
});

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function duck() {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run("INSTALL httpfs; LOAD httpfs;");
  return conn;
}

// Six AssumeRole calls ahead of time: seconds alone, more when the host is
// busy, so not the default ten-second hook limit.
beforeAll(async () => {
  if (!live) return;
  await createBucket();
  await startEndpoint();
}, 120_000);

afterAll(async () => {
  if (!live) return;
  await s3DeletePrefix(ROOT_TARGET, `${ROOT}/`);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
}, 60_000);

describe("the lake on the app's own identity, not keys", () => {
  withStore(
    "the chain's credentials, with their session token, carry the engine's reads and writes",
    async () => {
      const r = resolver();
      expect(r.mode).toBe("chain");
      const creds = await r.get();
      expect(creds.sessionToken, "temporary credentials always have one").toBeTruthy();
      expect(creds.expiresAt).toBe(clock + 6 * 60_000);
      expect(creds.source).toMatch(/^AWS container: /);

      const conn = await duck();
      await conn.run(
        `CREATE SECRET lakehouse_s3 (${lakehouseS3SecretParts(CFG, creds).join(", ")})`,
      );
      const url = `s3://${BUCKET}/${ROOT}/engine/orders.parquet`;
      await conn.run(
        `COPY (SELECT i AS id, i * 2 AS twice FROM range(50000) t(i)) TO ${q(url)} (FORMAT PARQUET)`,
      );
      const rows = await (
        await conn.run(`SELECT count(*)::INTEGER AS n FROM read_parquet(${q(url)})`)
      ).getRowObjects();
      expect(Number(rows[0].n)).toBe(50000);

      // The secret as it was before R465 (no SESSION_TOKEN): the store refuses
      // these credentials outright.
      const without = lakehouseS3SecretParts(CFG, creds).filter(
        (p) => !p.startsWith("SESSION_TOKEN"),
      );
      await conn.run(`CREATE OR REPLACE SECRET lakehouse_s3 (${without.join(", ")})`);
      await expect(conn.run(`SELECT count(*) FROM read_parquet(${q(url)})`)).rejects.toThrow(
        /403|Forbidden|InvalidAccessKeyId|InvalidToken|security token/i,
      );
    },
  );

  withStore("signed requests (shares, ML artifacts, staging) carry the token too", async () => {
    const creds = await resolver().get();
    const t = targetOf(creds);
    await s3PutObject(t, `${ROOT}/signed/a.txt`, Buffer.from("signed with a role"));
    expect(await s3ObjectSize(t, `${ROOT}/signed/a.txt`)).toBe(18);
    expect((await s3ListKeys(t, `${ROOT}/signed/`)).map((k) => k.key)).toEqual([
      `${ROOT}/signed/a.txt`,
    ]);
    const { sessionToken: _t, ...noToken } = t;
    void _t;
    await expect(s3ObjectSize(noToken, `${ROOT}/signed/a.txt`)).rejects.toThrow(/403/);
  });

  withStore(
    "rotation: the same credentials until five minutes before expiry, then new ones that work",
    async () => {
      const r = resolver();
      const before = minted;
      const first = await r.get();
      expect(minted).toBe(before + 1);

      clock += 30_000; // five and a half minutes left of the six: still cached
      const cached = await r.get();
      expect(minted).toBe(before + 1);
      expect(credentialStamp(cached)).toBe(credentialStamp(first));

      clock += 60_000; // four and a half left: inside the five-minute margin, so it fetches
      const second = await r.get();
      expect(minted).toBe(before + 2);
      expect(second.accessKeyId).not.toBe(first.accessKeyId);
      expect(credentialStamp(second)).not.toBe(credentialStamp(first));

      // What refreshEngineSecretIfDue does with them: the rebuilt secret works.
      const conn = await duck();
      const url = `s3://${BUCKET}/${ROOT}/rotate/r.parquet`;
      await conn.run(
        `CREATE SECRET lakehouse_s3 (${lakehouseS3SecretParts(CFG, first).join(", ")})`,
      );
      await conn.run(`COPY (SELECT 1 AS one) TO ${q(url)} (FORMAT PARQUET)`);
      await conn.run(
        `CREATE OR REPLACE SECRET lakehouse_s3 (${lakehouseS3SecretParts(CFG, second).join(", ")})`,
      );
      const rows = await (
        await conn.run(`SELECT count(*)::INTEGER AS n FROM read_parquet(${q(url)})`)
      ).getRowObjects();
      expect(Number(rows[0].n)).toBe(1);
    },
  );

  withStore(
    "AssumeRole from temporary credentials is refused here, so Spark falls back",
    async () => {
      // AWS lets a role session assume a role for up to an hour (role chaining;
      // durationSeconds clamps to it). This store does not chain: it answers
      // AccessDenied with the session token and without it alike, so it cannot
      // show whether the token authenticated (the signed header is pinned in
      // stsScopedCredentials.test.ts; AWS's side is not measured here). What it
      // does show is the fallback being reached: no scoped credential, so the
      // Spark run gets the engine's own credentials, with their token (R465).
      const { resetStsWarning } = await import("@/utils/lakehouse/sts.server");
      const creds = await resolver().get();
      const codes: string[] = [];
      const warn = console.warn;
      console.warn = (m: unknown) => {
        codes.push(/\(([A-Za-z]+)\)/.exec(String(m))?.[1] ?? String(m));
      };
      try {
        for (const target of [targetOf(creds), { ...targetOf(creds), sessionToken: undefined }]) {
          resetStsWarning();
          const scoped = await assumeScopedCredentials({
            target,
            scope: { read: [`${ROOT}/engine/`] },
            label: "itest-chained",
          });
          expect(scoped).toBeNull();
        }
      } finally {
        console.warn = warn;
      }
      expect(codes).toEqual(["AccessDenied", "AccessDenied"]);
    },
  );
});
