// Credentials the object store will honour only for one run's files.
//
// The Spark cluster is the one place that still holds storage credentials:
// its executors read and write files themselves, so there is no app in the
// middle the way there is for a sandbox (sandboxLake.server). R230 gives it a
// credential that expires and that the STORE limits to the prefixes one run
// needs, so nothing on the cluster has to be trusted to respect them.
//
// The policy is checked here; that this deployment's MinIO enforces it was
// driven live (ADVERSARIAL_LOG R230).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { normalisePrefix, scopePolicy, stsRequired } from "@/utils/lakehouse/sts.server";
import { planFilePrefixes } from "@/utils/lakehouse/sparkQuery.server";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

type Statement = {
  Effect: string;
  Action: string[];
  Resource: string[];
  Condition?: { StringLike: { "s3:prefix": string[] } };
};
const parse = (json: string) => JSON.parse(json) as { Statement: Statement[] };

describe("the prefix a scoped credential may name", () => {
  it("ends at a directory, so a sibling whose name merely starts the same is out", () => {
    // "main/analytics/orders*" would match "orders_private/" too. The policy
    // is written as "main/analytics/orders/*".
    expect(normalisePrefix("main/analytics/orders")).toBe("main/analytics/orders/");
    expect(normalisePrefix("/main//analytics/orders/")).toBe("main/analytics/orders/");
    const p = parse(scopePolicy("lake", { read: ["main/analytics/orders"] }));
    expect(p.Statement[0]!.Resource).toEqual(["arn:aws:s3:::lake/main/analytics/orders/*"]);
  });

  it("refuses a prefix that climbs out of itself, or none at all", () => {
    for (const bad of ["main/../other", "..", "/", ""]) {
      expect(() => normalisePrefix(bad), bad).toThrow(/not a prefix/);
    }
    expect(() => scopePolicy("lake", {})).toThrow(/must name a prefix/);
    expect(() => scopePolicy("lake", { read: [] })).toThrow(/must name a prefix/);
  });
});

describe("the session policy", () => {
  it("reads where it may read, writes where it may write, and lists neither wider", () => {
    const p = parse(scopePolicy("lake", { read: ["main/a/t/"], write: ["_stage/s1/out/"] }));
    const [read, write, list] = p.Statement;
    expect(read!.Action).toEqual(["s3:GetObject"]);
    expect(read!.Resource).toEqual(["arn:aws:s3:::lake/main/a/t/*"]);
    // S3A writes through multipart uploads and removes its own markers, so a
    // write scope that cannot abort or delete fails at the END of a long job.
    expect(write!.Action).toEqual(
      expect.arrayContaining(["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]),
    );
    expect(write!.Resource).toEqual(["arn:aws:s3:::lake/_stage/s1/out/*"]);
    // Nothing may write where it may only read.
    expect(write!.Resource).not.toContain("arn:aws:s3:::lake/main/a/t/*");
    // Listing is bounded to the same prefixes: the credential cannot
    // enumerate the bucket to find what else is there.
    expect(list!.Action).toEqual(["s3:ListBucket"]);
    expect(list!.Resource).toEqual(["arn:aws:s3:::lake"]);
    expect(list!.Condition!.StringLike["s3:prefix"]).toEqual(["main/a/t/*", "_stage/s1/out/*"]);
  });

  it("names no action beyond the objects it was given", () => {
    const json = scopePolicy("lake", { write: ["_stage/s1/out/"] });
    for (const forbidden of ["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:*", '"*"']) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });
});

// R442. On AWS a file under a KMS key is read and written only by an identity
// that may use the key, and a session may do only what its role AND its
// session policy allow: S3 actions alone left the cluster unable to read a
// customer-key schema's files. Found reading the policy against AWS's rules
// for session policies; LocalStack does not enforce them, so it is pinned
// here and said in SANDBOX_LAKEHOUSE_ACCESS.md.
describe("the session policy's use of KMS keys", () => {
  type KmsStatement = {
    Action: string[];
    Resource: string;
    Condition: { StringEquals: { "kms:ViaService": string } };
  };
  const kms = (json: string) =>
    (JSON.parse(json) as { Statement: KmsStatement[] }).Statement.find((st) =>
      st.Action.some((a) => a.startsWith("kms:")),
    );

  it("lets a read decrypt, and a write also make data keys, only through S3 in the bucket's region", () => {
    const read = kms(scopePolicy("lake", { read: ["main/a/t/"] }, "eu-west-1"))!;
    expect(read.Action).toEqual(["kms:Decrypt"]);
    expect(read.Condition.StringEquals["kms:ViaService"]).toBe("s3.eu-west-1.amazonaws.com");
    const write = kms(scopePolicy("lake", { write: ["_stage/s1/out/"] }, "eu-west-1"))!;
    expect(write.Action).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(write.Condition.StringEquals["kms:ViaService"]).toBe("s3.eu-west-1.amazonaws.com");
    // No other KMS action: nothing that creates, lists or manages a key.
    expect(scopePolicy("lake", { write: ["x/"] }, "eu-west-1")).not.toMatch(
      /kms:(Encrypt|ReEncrypt|Create|List|Describe|Put|Schedule|Disable|\*)/,
    );
  });

  it("names no KMS action for a store other than AWS", () => {
    expect(kms(scopePolicy("lake", { read: ["main/a/t/"] }))).toBeUndefined();
  });

  it("is asked for when the store is AWS, and not when it is MinIO", async () => {
    const { assumeScopedCredentials } = await import("@/utils/lakehouse/sts.server");
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(
          "<AssumeRoleResponse><Credentials><AccessKeyId>A</AccessKeyId><SecretAccessKey>S</SecretAccessKey><SessionToken>T</SessionToken><Expiration>2026-11-04T00:00:00Z</Expiration></Credentials></AssumeRoleResponse>",
          { status: 200 },
        );
      }),
    );
    try {
      const base = {
        region: "eu-west-1",
        useSsl: true,
        urlStyle: "vhost" as const,
        bucket: "lake",
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      };
      await assumeScopedCredentials({ target: base, scope: { read: ["main/a/t/"] }, label: "q" });
      await assumeScopedCredentials({
        target: { ...base, endpoint: "minio:9000", useSsl: false, urlStyle: "path" },
        scope: { read: ["main/a/t/"] },
        label: "q",
      });
      const policy = (b: string) => new URLSearchParams(b).get("Policy") ?? "";
      expect(policy(bodies[0]!)).toContain('"kms:ViaService":"s3.eu-west-1.amazonaws.com"');
      expect(policy(bodies[1]!)).not.toContain("kms:");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the prefixes a Spark lakehouse query needs", () => {
  const table = (schema: string, name: string, files: string[]) => ({
    schema,
    table: name,
    columns: [{ name: "id", type: "INTEGER" }],
    dataFiles: files,
    deleteFiles: [],
  });

  it("is each table's own directory, once, however many files it has", () => {
    const prefixes = planFilePrefixes("lake", [
      table("analytics", "orders", [
        "s3://lake/main/analytics/orders/a.parquet",
        "s3://lake/main/analytics/orders/b.parquet",
      ]),
      {
        ...table("analytics", "refunds", ["s3://lake/main/analytics/refunds/c.parquet"]),
        deleteFiles: ["s3://lake/main/analytics/refunds/d-delete.parquet"],
      },
    ]);
    expect(prefixes.sort()).toEqual(["main/analytics/orders/", "main/analytics/refunds/"]);
  });

  it("refuses to describe a file outside the lake's bucket rather than guess", () => {
    // A credential scoped to the lake's bucket cannot read one elsewhere; the
    // caller falls back to the engine's rather than issue one that cannot
    // read what the query needs.
    expect(() =>
      planFilePrefixes("lake", [table("a", "t", ["s3://other-bucket/main/a/t/x.parquet"])]),
    ).toThrow(/not in the lakehouse's bucket/);
  });
});

describe("a deployment whose store has no STS", () => {
  const OLD = process.env.LAKEHOUSE_STS_REQUIRED;
  beforeEach(() => {
    delete process.env.LAKEHOUSE_STS_REQUIRED;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.LAKEHOUSE_STS_REQUIRED;
    else process.env.LAKEHOUSE_STS_REQUIRED = OLD;
  });

  it("keeps the engine's credentials by default, and refuses when told to", () => {
    expect(stsRequired()).toBe(false);
    process.env.LAKEHOUSE_STS_REQUIRED = "true";
    expect(stsRequired()).toBe(true);
    process.env.LAKEHOUSE_STS_REQUIRED = "TRUE";
    expect(stsRequired()).toBe(true);
    // Anything else is off: a typo must not quietly harden a deployment into
    // refusing every Spark run.
    process.env.LAKEHOUSE_STS_REQUIRED = "yes";
    expect(stsRequired()).toBe(false);
  });
});

// R465: on AWS the app may sign as a role (the credential chain), and
// AssumeRole from temporary credentials is role chaining, which AWS refuses
// above one hour. A role's own maximum is one hour unless its owner raised it.
describe("how long a scoped credential is asked to last (R465)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("one hour when the app signs with temporary credentials, whatever is configured", async () => {
    const { durationSeconds, resetStsWarning } = await import("@/utils/lakehouse/sts.server");
    resetStsWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(durationSeconds({ sessionToken: "t" })).toBe(3600);
      expect(durationSeconds({ sessionToken: "t", endpoint: "minio:9000" })).toBe(3600);
      vi.stubEnv("LAKEHOUSE_STS_DURATION_SECONDS", "43200");
      expect(durationSeconds({ sessionToken: "t" })).toBe(3600);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/role chaining/);
      vi.stubEnv("LAKEHOUSE_STS_DURATION_SECONDS", "1800");
      expect(durationSeconds({ sessionToken: "t" })).toBe(1800);
    } finally {
      warn.mockRestore();
    }
  });

  it("an hour by default on AWS, twelve on MinIO, and what is configured otherwise", async () => {
    const { durationSeconds } = await import("@/utils/lakehouse/sts.server");
    expect(durationSeconds({})).toBe(3600);
    expect(durationSeconds({ endpoint: "s3.eu-west-1.amazonaws.com" })).toBe(3600);
    expect(durationSeconds({ endpoint: "minio:9000" })).toBe(12 * 3600);
    vi.stubEnv("LAKEHOUSE_STS_DURATION_SECONDS", "7200");
    expect(durationSeconds({})).toBe(7200);
    vi.stubEnv("LAKEHOUSE_STS_DURATION_SECONDS", "60");
    expect(durationSeconds({ endpoint: "minio:9000" })).toBe(12 * 3600);
  });

  it("the call is signed with the session token, which goes in a signed header", async () => {
    const { assumeScopedCredentials } = await import("@/utils/lakehouse/sts.server");
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push({
          headers: init?.headers as Record<string, string>,
          body: String(init?.body ?? ""),
        });
        return new Response(
          "<AssumeRoleResponse><Credentials><AccessKeyId>A</AccessKeyId><SecretAccessKey>S</SecretAccessKey><SessionToken>T</SessionToken><Expiration>2026-11-09T00:00:00Z</Expiration></Credentials></AssumeRoleResponse>",
          { status: 200 },
        );
      }),
    );
    try {
      await assumeScopedCredentials({
        target: {
          region: "eu-west-1",
          useSsl: true,
          urlStyle: "vhost",
          bucket: "lake",
          accessKeyId: "ASIAROLE",
          secretAccessKey: "SECRET",
          sessionToken: "the-task-role-token",
        },
        scope: { read: ["main/a/t/"] },
        label: "q",
      });
      const { headers, body } = seen[0]!;
      expect(headers["x-amz-security-token"]).toBe("the-task-role-token");
      expect(headers.Authorization).toMatch(/SignedHeaders=[^,]*x-amz-security-token/);
      expect(new URLSearchParams(body).get("DurationSeconds")).toBe("3600");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
