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
