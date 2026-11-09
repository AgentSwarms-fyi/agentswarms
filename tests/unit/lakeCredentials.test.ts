// R465: the lakehouse store reached as the app's own AWS identity.
//
// Until R465 the lake signed with LAKEHOUSE_S3_KEY_ID / LAKEHOUSE_S3_SECRET and
// nothing else: on AWS, an IAM user's long-lived keys in the environment. Now,
// with no keys, an AWS store is reached through the credential chain (task
// role, IRSA, Pod Identity, instance profile), whose credentials are temporary
// and carry a session token. What has to hold:
//
// - the environment picks exactly one source, and a half-set or contradictory
//   one is refused instead of signing as something nobody chose;
// - every signer gets the session token, or the store refuses the key;
// - the credentials are asked for at each use, so a rotation reaches them;
// - the temporary secret and token are scrubbed from error text like the key;
// - no code reads keys off the config any more (the config has none).
import { readFileSync, readdirSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const chainState = vi.hoisted(() => ({
  calls: 0,
  creds: [] as Array<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiresAt: number | null;
  }>,
}));

// The chain itself is tested in awsCredentials.test.ts; here it hands out
// whatever the test queues, the way a task role's endpoint would.
vi.mock("@/utils/aws/credentials.server", async (orig) => ({
  ...(await orig<typeof import("@/utils/aws/credentials.server")>()),
  createAwsCredentialChain: () => ({
    source: "container",
    get: async () => {
      const c = chainState.creds[Math.min(chainState.calls, chainState.creds.length - 1)];
      chainState.calls++;
      return { ...c, source: "container", identity: "container role test-role" };
    },
  }),
}));

const {
  createLakeCredentialResolver,
  credentialStamp,
  knownLakeSecrets,
  lakeCredentialMode,
  lakeCredentials,
  resetLakeCredentialsForTests,
} = await import("@/utils/lakehouse/lakeCredentials.server");
const { lakehouseS3SecretParts, redactLakehouseSecrets } =
  await import("@/utils/lakehouse/core.server");

afterEach(() => {
  vi.unstubAllEnvs();
  resetLakeCredentialsForTests();
  chainState.calls = 0;
  chainState.creds = [];
});

const TEMP = {
  accessKeyId: "ASIATEMPORARY1",
  secretAccessKey: "temporary-secret-one",
  sessionToken: "session-token-one-xxxxxxxx",
  expiresAt: Date.parse("2026-11-09T12:00:00Z"),
};

describe("which credentials the environment selects", () => {
  it("the keys, when both are set: MinIO, SILO and every install so far", () => {
    expect(
      lakeCredentialMode({
        LAKEHOUSE_S3_KEY_ID: "k",
        LAKEHOUSE_S3_SECRET: "s",
        LAKEHOUSE_S3_ENDPOINT: "minio:9000",
      }),
    ).toBe("keys");
  });

  it("the AWS chain, when there are no keys and the store is AWS S3", () => {
    expect(lakeCredentialMode({})).toBe("chain");
    expect(lakeCredentialMode({ LAKEHOUSE_S3_ENDPOINT: "s3.eu-west-1.amazonaws.com" })).toBe(
      "chain",
    );
  });

  it("no credentials, as before, for another store without keys", () => {
    expect(lakeCredentialMode({ LAKEHOUSE_S3_ENDPOINT: "minio:9000" })).toBe("none");
  });

  it("the chain for any store when asked by name", () => {
    expect(
      lakeCredentialMode({
        LAKEHOUSE_S3_CREDENTIALS: "chain",
        LAKEHOUSE_S3_ENDPOINT: "minio:9000",
      }),
    ).toBe("chain");
  });

  it("refuses a half-set or contradictory environment rather than guess", () => {
    expect(() => lakeCredentialMode({ LAKEHOUSE_S3_KEY_ID: "k" })).toThrow(
      /without LAKEHOUSE_S3_SECRET/,
    );
    expect(() => lakeCredentialMode({ LAKEHOUSE_S3_SECRET: "s" })).toThrow(
      /without LAKEHOUSE_S3_KEY_ID/,
    );
    expect(() =>
      lakeCredentialMode({
        LAKEHOUSE_S3_CREDENTIALS: "chain",
        LAKEHOUSE_S3_KEY_ID: "k",
        LAKEHOUSE_S3_SECRET: "s",
      }),
    ).toThrow(/together with/);
    expect(() => lakeCredentialMode({ LAKEHOUSE_S3_CREDENTIALS: "keys" })).toThrow(/not set/);
    expect(() => lakeCredentialMode({ LAKEHOUSE_S3_CREDENTIALS: "role" })).toThrow(
      /"chain" or "keys"/,
    );
  });
});

describe("what a resolver hands out", () => {
  it("the keys come back as they are, never expiring", async () => {
    const r = createLakeCredentialResolver({
      env: { LAKEHOUSE_S3_KEY_ID: "AKIAFIXED", LAKEHOUSE_S3_SECRET: "fixed-secret" },
    });
    expect(await r.get()).toMatchObject({
      accessKeyId: "AKIAFIXED",
      secretAccessKey: "fixed-secret",
      expiresAt: null,
      mode: "keys",
    });
    expect((await r.get()).sessionToken).toBeUndefined();
  });

  it("the chain's come back with their session token, expiry and source", async () => {
    chainState.creds = [TEMP];
    const r = createLakeCredentialResolver({ env: {} });
    const c = await r.get();
    expect(c).toMatchObject({ ...TEMP, mode: "chain" });
    expect(c.source).toBe("AWS container: container role test-role");
  });

  it("the stamp changes when they rotate, and carries no secret", async () => {
    chainState.creds = [
      TEMP,
      {
        ...TEMP,
        accessKeyId: "ASIATEMPORARY2",
        sessionToken: "session-token-two-xxxxxxxx",
        expiresAt: TEMP.expiresAt + 3_600_000,
      },
    ];
    const r = createLakeCredentialResolver({ env: {} });
    const a = credentialStamp(await r.get());
    const b = credentialStamp(await r.get());
    expect(a).not.toBe(b);
    for (const stamp of [a, b]) {
      expect(stamp).not.toContain("temporary-secret");
      expect(stamp).not.toContain("session-token");
    }
  });
});

describe("every signer gets the session token", () => {
  const cfg = {
    catalog: "postgres://x",
    dataUrl: "s3://lake/main",
    s3: { endpoint: "127.0.0.1:9010", region: "us-east-1", useSsl: false, urlStyle: "path" },
  };

  it("the engine's DuckDB secret names it when there is one, and only then", () => {
    const temp = lakehouseS3SecretParts(cfg, { ...TEMP, mode: "chain", source: "t" });
    expect(temp).toContain(`SESSION_TOKEN '${TEMP.sessionToken}'`);
    expect(temp).toContain(`KEY_ID '${TEMP.accessKeyId}'`);
    const fixed = lakehouseS3SecretParts(cfg, {
      accessKeyId: "k",
      secretAccessKey: "s",
      expiresAt: null,
      mode: "keys",
      source: "t",
    });
    expect(fixed.some((p) => p.startsWith("SESSION_TOKEN"))).toBe(false);
  });

  it("every target builder resolves credentials instead of reading the config", () => {
    // The config has no keys any more (LakehouseConfig.s3), so the compiler
    // already refuses `cfg.s3.keyId`; this keeps the shape from coming back.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        // Not Spark's `….s3.secret-access-key` setting names.
        else if (
          /\.tsx?$/.test(e.name) &&
          /\bs3\.(keyId|secret)\b(?!-)/.test(readFileSync(p, "utf8"))
        ) {
          offenders.push(p);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
    for (const f of [
      "src/utils/ml/experimentArtifacts.server.ts",
      "src/utils/lakehouse/shares.server.ts",
      "src/utils/lakehouse/customerKeyFiles.server.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("await lakeCredentials()");
      expect(src, f).toContain("sessionToken: creds.sessionToken");
    }
  });

  it("a Spark run on the engine's own credentials gets the token too", () => {
    for (const f of [
      "src/utils/etl/service.server.ts",
      "src/utils/lakehouse/sparkQuery.server.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("env.ETL_LAKEHOUSE_S3_SESSION_TOKEN = own.sessionToken;");
    }
  });
});

describe("the temporary secret is scrubbed like the key", () => {
  it("once handed out, its secret and token never reach an error message", async () => {
    vi.stubEnv("LAKEHOUSE_CATALOG_URL", "postgres://lake:catalogpw@db/lake");
    vi.stubEnv("LAKEHOUSE_DATA_URL", "s3://lake/main");
    vi.stubEnv("LAKEHOUSE_S3_KEY_ID", "");
    vi.stubEnv("LAKEHOUSE_S3_SECRET", "");
    vi.stubEnv("LAKEHOUSE_S3_ENDPOINT", "");
    chainState.creds = [TEMP];
    await lakeCredentials();
    expect(knownLakeSecrets()).toEqual(
      expect.arrayContaining([TEMP.secretAccessKey, TEMP.sessionToken]),
    );
    const scrubbed = redactLakehouseSecrets(
      `HTTP 403 with secret ${TEMP.secretAccessKey} and token ${TEMP.sessionToken}`,
    );
    expect(scrubbed).not.toContain(TEMP.secretAccessKey);
    expect(scrubbed).not.toContain(TEMP.sessionToken);
  });
});
