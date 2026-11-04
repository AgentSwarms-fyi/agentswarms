// R440: lakehouse files under customer keys — the decisions, with no I/O.
//
// What each one protects: the store is asked to use a key only where it can
// (AWS S3, a key's ARN, the bucket's region); a file under a destroyed
// customer key is never moved onto another key; a refusal of a customer's key
// names the schema and the key, and nothing else is taken for one.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  artifactFolderOf,
  awsKmsKeyRegion,
  cloudKmsKeyName,
  keyHeaders,
  objectEncryptionOf,
  storeKindOf,
  describeCustomerKeyFileError,
  fileKeyFor,
  filesPassLine,
  laterPass,
  reEncryptAction,
  schemaPrefix,
  isAwsEndpoint,
  splitS3Url,
  sseKmsMode,
  stagedUnderKeyBit,
  whyNotCovered,
  type CoveredPrefix,
} from "@/utils/lakehouse/customerKeyFiles";

const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const OTHER = "arn:aws:kms:eu-west-1:111122223333:key/9999abcd-12ab-34cd-56ef-1234567890ab";
const LAKE = "s3://lake-bucket/lake";

describe("whether the store encrypts under customer keys (LAKEHOUSE_SSE_KMS)", () => {
  it("is on for AWS S3 by default: no endpoint, or an amazonaws.com one", () => {
    expect(sseKmsMode(undefined, LAKE, undefined).on).toBe(true);
    expect(sseKmsMode("auto", LAKE, "bucket.vpce-0a1b.s3.eu-west-1.vpce.amazonaws.com").on).toBe(
      true,
    );
    expect(sseKmsMode("", LAKE, "https://s3.eu-west-1.amazonaws.com").on).toBe(true);
  });

  it("is off by default for any other store, and names it", () => {
    const m = sseKmsMode(undefined, LAKE, "minio:9000");
    expect(m.on).toBe(false);
    expect(m.why).toMatch(/The lakehouse store is minio, not AWS S3 or Cloud Storage/);
    expect(m.why).toMatch(/nothing else needs a customer key/);
    expect(m.why).toMatch(/LAKEHOUSE_SSE_KMS=on/);
    // A lookalike is not AWS.
    expect(sseKmsMode(undefined, LAKE, "s3.amazonaws.com.attacker.test").on).toBe(false);
  });

  it("takes on and off as said, and an unknown value is off and named", () => {
    expect(sseKmsMode("on", LAKE, "minio:9000").on).toBe(true);
    expect(sseKmsMode("off", LAKE, undefined).on).toBe(false);
    const m = sseKmsMode("yes", LAKE, undefined);
    expect(m.on).toBe(false);
    expect(m.why).toBe(
      "LAKEHOUSE_SSE_KMS=yes is not auto, on or off, so files are not encrypted under customer keys.",
    );
  });

  it("is off when the lake is not on S3, or not configured", () => {
    expect(sseKmsMode("on", "az://container/lake", undefined).on).toBe(false);
    expect(sseKmsMode("on", undefined, undefined).why).toBe("The lakehouse is not configured.");
  });
});

describe("which customer keys can cover lakehouse files", () => {
  const on = sseKmsMode(undefined, LAKE, undefined);
  const aws = { provider: "aws" as const, key_ref: ARN, destroyed_at: null };

  it("reads the region of a key's ARN, and nothing else", () => {
    expect(awsKmsKeyRegion(ARN)).toBe("eu-west-1");
    expect(
      awsKmsKeyRegion(
        "arn:aws-cn:kms:cn-north-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      ),
    ).toBe("cn-north-1");
    expect(awsKmsKeyRegion("arn:aws:kms:eu-west-1:111122223333:alias/acme")).toBeNull();
    expect(awsKmsKeyRegion("1234abcd-12ab-34cd-56ef-1234567890ab")).toBeNull();
  });

  it("covers a key in AWS KMS in the bucket's region", () => {
    expect(fileKeyFor(aws, on, "eu-west-1")).toEqual({ kmsKeyId: ARN });
  });

  it("does not cover a key in another region, and says both", () => {
    expect(whyNotCovered(fileKeyFor(aws, on, "us-east-1"))).toBe(
      "The key is in eu-west-1 and the lakehouse bucket in us-east-1: S3 encrypts only under a key in the bucket's own region.",
    );
  });

  it("does not cover an alias, whose key S3 records by another name", () => {
    expect(
      whyNotCovered(
        fileKeyFor(
          { ...aws, key_ref: "arn:aws:kms:eu-west-1:111122223333:alias/acme" },
          on,
          "eu-west-1",
        ),
      ),
    ).toMatch(/^Not a key's ARN \(an alias or a bare key id\)/);
  });

  it("does not cover a key the app holds, or one in another provider", () => {
    expect(
      whyNotCovered(
        fileKeyFor({ provider: "app", key_ref: null, destroyed_at: null }, on, "eu-west-1"),
      ),
    ).toMatch(/^Held by the app: the store cannot use a key the app holds/);
    expect(
      whyNotCovered(
        fileKeyFor(
          { provider: "azure", key_ref: "https://v.vault.azure.net/keys/k", destroyed_at: null },
          on,
          "eu-west-1",
        ),
      ),
    ).toMatch(/^In Azure Key Vault: the lakehouse store is S3/);
  });

  it("does not cover anything while the store does not, and says the store's reason", () => {
    const off = sseKmsMode(undefined, LAKE, "minio:9000");
    expect(whyNotCovered(fileKeyFor(aws, off, "eu-west-1"))).toBe(off.why);
  });

  it("does not cover a destroyed key", () => {
    expect(fileKeyFor({ ...aws, destroyed_at: "2026-11-03T00:00:00Z" }, on, "eu-west-1")).toEqual({
      kmsKeyId: null,
      why: "Destroyed.",
    });
  });
});

describe("where a schema's files are", () => {
  it("puts a relative catalog path under the data path", () => {
    expect(schemaPrefix("s3://b/lake", "acme/", true)).toBe("s3://b/lake/acme/");
    expect(schemaPrefix("s3://b/lake/", "acme", true)).toBe("s3://b/lake/acme/");
    expect(schemaPrefix("s3://b/", "acme/", true)).toBe("s3://b/acme/");
  });

  it("keeps an absolute one as it is", () => {
    expect(schemaPrefix("s3://b/lake", "s3://other/acme", false)).toBe("s3://other/acme/");
  });

  it("splits an s3 URL into bucket and key", () => {
    expect(splitS3Url("s3://b/lake/acme/")).toEqual({ bucket: "b", key: "lake/acme/" });
    expect(splitS3Url("s3a://b")).toEqual({ bucket: "b", key: "" });
    expect(splitS3Url("az://b/x")).toBeNull();
  });
});

describe("what the re-encrypt pass does to one file", () => {
  const live = new Set([ARN, OTHER]);
  const none = new Set<string>();

  it("copies a file onto its schema's key, and keeps one already there", () => {
    expect(reEncryptAction({ sse: "AES256", kmsKeyId: null }, ARN, live, none)).toEqual({
      copyTo: ARN,
    });
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: OTHER }, ARN, live, none)).toEqual({
      copyTo: ARN,
    });
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: ARN }, ARN, live, none)).toBe("keep");
  });

  it("moves a file off a customer key its owner left, back to the store's encryption", () => {
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: ARN }, null, live, none)).toEqual({
      copyTo: null,
    });
  });

  it("leaves a file under the bucket's own KMS key, which is no customer's", () => {
    const operator = "arn:aws:kms:eu-west-1:111122223333:key/0000aaaa-12ab-34cd-56ef-1234567890ab";
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: operator }, null, live, none)).toBe("keep");
    expect(reEncryptAction({ sse: "AES256", kmsKeyId: null }, null, live, none)).toBe("keep");
  });

  it("never moves a file off a destroyed customer key, to another key or to the store's", () => {
    const destroyed = new Set([ARN]);
    const liveOnly = new Set([OTHER]);
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: ARN }, null, liveOnly, destroyed)).toBe(
      "keep-destroyed",
    );
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: ARN }, OTHER, liveOnly, destroyed)).toBe(
      "keep-destroyed",
    );
  });

  it("treats a key that is live again under a new customer key as live", () => {
    // The same KMS key named by a destroyed customer key and a live one.
    expect(reEncryptAction({ sse: "aws:kms", kmsKeyId: ARN }, OTHER, live, new Set([ARN]))).toEqual(
      {
        copyTo: OTHER,
      },
    );
  });
});

describe("a refusal of a customer's key, said in words", () => {
  const covered: CoveredPrefix[] = [
    {
      bucket: "lake-bucket",
      keyPrefix: "lake/acme/",
      schema: "acme",
      keyName: "Acme",
      kmsKeyId: ARN,
    },
  ];

  it("names the schema and the key for DuckDB's 403 on an s3 URL", () => {
    const msg =
      "HTTP Error: HTTP GET error reading 's3://lake-bucket/lake/acme/orders/ducklake-01.parquet' in region 'eu-west-1' (HTTP 403 Forbidden)";
    expect(describeCustomerKeyFileError(msg, covered)).toBe(
      `The store refused a file of lakehouse schema "acme" (HTTP 403). Its files are encrypted under the customer key "Acme" (${ARN}): the customer may have disabled or revoked that key, or the lakehouse's storage identity may lack kms:Decrypt and kms:GenerateDataKey on it. Other schemas are unaffected.`,
    );
  });

  it("takes S3's 400, its answer for a key the customer disabled", () => {
    // KMS.DisabledException and KMS.KMSInvalidStateException come back as
    // 400, and DuckDB quotes only the status.
    const msg =
      "HTTP Error: HTTP GET error reading 's3://lake-bucket/lake/acme/t/x.parquet' in region 'eu-west-1' (HTTP 400 Bad Request)";
    expect(describeCustomerKeyFileError(msg, covered)).toMatch(
      /^The store refused a file of lakehouse schema "acme" \(HTTP 400\)\. Its files are encrypted under the customer key "Acme"/,
    );
  });

  it("quotes S3's KMS error code when the message carries it", () => {
    const msg =
      "HTTP Error: Unable to connect to URL https://s3.eu-west-1.amazonaws.com/lake-bucket/lake/acme/t/x.parquet: Bad Request (HTTP code 400) <Code>KMS.DisabledException</Code>";
    expect(describeCustomerKeyFileError(msg, covered)).toMatch(
      /^The store refused a file of lakehouse schema "acme" \(KMS\.DisabledException\)\./,
    );
  });

  it("matches a virtual-hosted URL by bucket and folder", () => {
    const msg =
      "HTTP GET error reading 'https://lake-bucket.s3.eu-west-1.amazonaws.com/lake/acme/t/x.parquet' (HTTP 403 Forbidden)";
    expect(describeCustomerKeyFileError(msg, covered)).toMatch(
      /^The store refused a file of lakehouse schema "acme"/,
    );
  });

  it("takes nothing else for one: a 404, another schema, a lookalike folder", () => {
    expect(
      describeCustomerKeyFileError(
        "HTTP GET error reading 's3://lake-bucket/lake/acme/t/x.parquet' (HTTP 404 Not Found)",
        covered,
      ),
    ).toBeNull();
    expect(
      describeCustomerKeyFileError(
        "HTTP GET error reading 's3://lake-bucket/lake/globex/t/x.parquet' (HTTP 403 Forbidden)",
        covered,
      ),
    ).toBeNull();
    expect(
      describeCustomerKeyFileError(
        "HTTP GET error reading 's3://lake-bucket/lake/acme2/t/x.parquet' (HTTP 403 Forbidden)",
        covered,
      ),
    ).toBeNull();
  });
});

describe("a pass's counts in one line", () => {
  it("says what was checked and what moved, in the right number", () => {
    expect(
      filesPassLine({
        files: 12,
        schemas: 1,
        files_reencrypted: 1,
        files_to_store_key: 2,
        files_already_right: 4,
        files_kept_under_destroyed: 3,
        files_failed: 0,
      }),
    ).toBe(
      "12 files in 1 schema checked · 1 re-encrypted under a customer key · 2 back on the store's own encryption · 4 already under the right key · 3 left under a destroyed customer key",
    );
    expect(filesPassLine({ files: 1, schemas: 2, schemas_conflicted: 1, files_failed: 4 })).toBe(
      "1 file in 2 schemas checked · 1 schema left as is (its owner is in two customer keys) · 4 failed",
    );
  });

  it("says why nothing ran", () => {
    expect(
      filesPassLine({ skipped: "Turned off for this deployment (LAKEHOUSE_SSE_KMS=off)." }),
    ).toBe("Nothing ran: Turned off for this deployment (LAKEHOUSE_SSE_KMS=off).");
  });

  it("names the models and experiment runs a pass checked, and what it left alone (R442)", () => {
    expect(
      filesPassLine({
        files: 9,
        schemas: 2,
        models: 3,
        experiment_runs: 1,
        files_reencrypted: 4,
        models_conflicted: 2,
        files_not_owned: 1,
      }),
    ).toBe(
      "9 files in 2 schemas, 3 models and 1 experiment run checked · 4 re-encrypted under a customer key · 2 models or runs left as is (the owner is in two customer keys) · 1 file of no model or run on record left as is",
    );
    expect(filesPassLine({ files: 2, schemas: 0, models: 1, models_conflicted: 1 })).toBe(
      "2 files in 0 schemas and 1 model checked · 1 model or run left as is (the owner is in two customer keys)",
    );
  });
});

describe("whose a model artifact is, from its key (R442)", () => {
  const M = "40000000-0000-4000-8000-000000000001";
  it("is the model's for a version's file, and the run's for an experiment's", () => {
    expect(artifactFolderOf(`ml-artifacts/${M}/v3/model.joblib`)).toEqual({ kind: "model", id: M });
    expect(
      artifactFolderOf(`ml-artifacts/${M.toUpperCase()}/v1/shard-0-of-2/model.joblib`),
    ).toEqual({
      kind: "model",
      id: M,
    });
    expect(artifactFolderOf(`ml-artifacts/experiments/${M}/model.joblib`)).toEqual({
      kind: "run",
      id: M,
    });
  });

  it("is no one's for anything the app did not write there", () => {
    for (const key of [
      "ml-artifacts/README.txt",
      `ml-artifacts/${M}`,
      `ml-artifacts/${M}/`,
      "ml-artifacts/experiments/",
      `ml-artifacts/experiments/${M}`,
      "ml-artifacts/not-a-uuid/v1/model.joblib",
      `lake/${M}/v1/model.joblib`,
      `xml-artifacts/${M}/v1/model.joblib`,
    ]) {
      expect(artifactFolderOf(key), key).toBeNull();
    }
  });
});

describe("whether a store is AWS's own (R442)", () => {
  it("is for no endpoint, an amazonaws.com host and a VPC endpoint, and nothing else", () => {
    expect(isAwsEndpoint(undefined)).toBe(true);
    expect(isAwsEndpoint("")).toBe(true);
    expect(isAwsEndpoint("https://s3.eu-west-1.amazonaws.com")).toBe(true);
    expect(isAwsEndpoint("bucket.vpce-0a1b2c3d4e5f.s3.eu-west-1.vpce.amazonaws.com:443")).toBe(
      true,
    );
    expect(isAwsEndpoint("minio:9000")).toBe(false);
    expect(isAwsEndpoint("192.168.1.85:19000")).toBe(false);
    // A lookalike that merely ends in the name is not AWS.
    expect(isAwsEndpoint("evilamazonaws.com")).toBe(false);
    expect(isAwsEndpoint("amazonaws.com.example.org")).toBe(false);
  });
});

describe("the card's last pass", () => {
  // R440's round: the pass just run was not shown, because its audit row is
  // written after the answer and the card reloaded first.
  const audit = { at: "2026-11-03T00:31:12.345678+00:00", n: "audit" };

  it("shows a pass run from the page until the audit trail has a later one", () => {
    const here = { at: "2026-11-03T00:40:00.000Z", n: "here" };
    expect(laterPass(audit, here)).toBe(here);
    expect(laterPass(null, here)).toBe(here);
    expect(laterPass(audit, null)).toBe(audit);
  });

  it("compares by time, not by how each side writes it", () => {
    // As text "T01:31…+01:00" sorts after "T00:40…Z"; in time it is earlier.
    const offset = { at: "2026-11-03T01:31:12+01:00", n: "offset" };
    const here = { at: "2026-11-03T00:40:00.000Z", n: "here" };
    expect(laterPass(offset, here)).toBe(here);
    const before = { at: "2026-11-03T00:31:12.100Z", n: "before" };
    expect(laterPass(audit, before)).toBe(audit);
  });
});

describe("a sandbox read's staged copy, in the audit log (R442)", () => {
  it("names the customer's key by the start of its id, and says nothing otherwise", () => {
    expect(stagedUnderKeyBit({ rows: 2000, staged_under_kms_key: ARN })).toBe(
      "staged under the customer's KMS key 1234abcd…",
    );
    for (const d of [{}, { staged_under_kms_key: null }, { staged_under_kms_key: " " }]) {
      expect(stagedUnderKeyBit(d)).toBeNull();
    }
    // R443: a Cloud KMS key by its own name, not the start of its resource name.
    expect(
      stagedUnderKeyBit({
        staged_under_kms_key:
          "projects/acme-prod/locations/europe-west3/keyRings/lake/cryptoKeys/r443-acme",
      }),
    ).toBe("staged under the customer's Cloud KMS key r443-acme");
  });

  it("is on the audit log's line, found in the round where it was recorded and not shown", () => {
    const log = readFileSync("src/components/observability/AuditLog.tsx", "utf8");
    expect(log).toContain("const staged = stagedUnderKeyBit(d);");
    expect(log).toContain("if (staged) bits.push(staged);");
  });
});

describe("a lakehouse on Cloud Storage (R443)", () => {
  const GKEY = "projects/acme-prod/locations/europe-west1/keyRings/lake/cryptoKeys/acme";
  const GCS = "storage.googleapis.com";
  const mode = sseKmsMode(undefined, LAKE, GCS);

  it("is told from its endpoints: global, regional and Private Service Connect", () => {
    for (const ep of [
      "storage.googleapis.com",
      "https://storage.googleapis.com",
      "storage.googleapis.com:443",
      "storage.europe-west1.rep.googleapis.com",
      "storage-lakepsc.p.googleapis.com",
    ]) {
      expect(storeKindOf(ep), ep).toBe("gcs");
    }
    for (const ep of [
      undefined,
      "s3.eu-west-1.amazonaws.com",
      "minio:9000",
      "storage.googleapis.com.attacker.test",
      "evilstorage.googleapis.com",
    ]) {
      expect(storeKindOf(ep), String(ep)).toBe("s3");
    }
  });

  it("is on by default, as AWS S3 is", () => {
    expect(mode).toEqual({
      on: true,
      why: "The lakehouse store is Cloud Storage, which encrypts files under customer-managed Cloud KMS keys.",
    });
    expect(sseKmsMode("off", LAKE, GCS).on).toBe(false);
  });

  it("is covered by a key in Cloud KMS, by its resource name", () => {
    expect(
      fileKeyFor({ provider: "gcp", key_ref: GKEY, destroyed_at: null }, mode, "auto", "gcs"),
    ).toEqual({
      kmsKeyId: GKEY,
    });
    // The full URI form is the same key.
    expect(
      fileKeyFor(
        { provider: "gcp", key_ref: `//cloudkms.googleapis.com/${GKEY}`, destroyed_at: null },
        mode,
        "auto",
        "gcs",
      ),
    ).toEqual({ kmsKeyId: GKEY });
  });

  it("is not covered by a key in AWS KMS, a key's version, or a key held by the app", () => {
    const aws = fileKeyFor(
      { provider: "aws", key_ref: ARN, destroyed_at: null },
      mode,
      "auto",
      "gcs",
    );
    expect(whyNotCovered(aws)).toMatch(
      /^In AWS KMS: the lakehouse store is Cloud Storage, which encrypts only under a Cloud KMS key/,
    );
    const version = fileKeyFor(
      { provider: "gcp", key_ref: `${GKEY}/cryptoKeyVersions/3`, destroyed_at: null },
      mode,
      "auto",
      "gcs",
    );
    expect(whyNotCovered(version)).toMatch(/^Not a key's resource name/);
    expect(
      whyNotCovered(
        fileKeyFor({ provider: "app", key_ref: null, destroyed_at: null }, mode, "auto", "gcs"),
      ),
    ).toMatch(/^Held by the app/);
    // And on S3, a Cloud KMS key still covers nothing.
    expect(
      whyNotCovered(
        fileKeyFor(
          { provider: "gcp", key_ref: GKEY, destroyed_at: null },
          sseKmsMode(undefined, LAKE, undefined),
          "eu-west-1",
        ),
      ),
    ).toMatch(/^In Google Cloud KMS: the lakehouse store is S3/);
  });

  it("names the key with Cloud Storage's header there, and with SSE-KMS on S3", () => {
    expect(keyHeaders("gcs", GKEY)).toEqual({ "x-goog-encryption-kms-key-name": GKEY });
    expect(keyHeaders("s3", ARN)).toEqual({
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": ARN,
    });
  });

  it("reads the key off a stored object without the version Cloud Storage adds", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
    expect(
      objectEncryptionOf(h({ "x-goog-encryption-kms-key-name": `${GKEY}/cryptoKeyVersions/7` })),
    ).toEqual({ sse: "gcp:kms", kmsKeyId: GKEY });
    expect(objectEncryptionOf(h({}))).toEqual({ sse: null, kmsKeyId: null });
    expect(
      objectEncryptionOf(
        h({
          "x-amz-server-side-encryption": "aws:kms",
          "x-amz-server-side-encryption-aws-kms-key-id": ARN,
        }),
      ),
    ).toEqual({ sse: "aws:kms", kmsKeyId: ARN });
    expect(cloudKmsKeyName(` ${GKEY}/cryptoKeyVersions/12 `)).toBe(GKEY);
    expect(cloudKmsKeyName(GKEY)).toBe(GKEY);
  });

  it("explains Cloud Storage's refusal of the key, and names the service agent's role", () => {
    const msg = describeCustomerKeyFileError(
      "HTTP Error: HTTP GET error reading 's3://lake-bucket/lake/acme/t/a.parquet' (HTTP 400 Bad Request) cloudKmsDisabledKey",
      [
        {
          bucket: "lake-bucket",
          keyPrefix: "lake/acme/",
          schema: "acme",
          keyName: "Acme",
          kmsKeyId: GKEY,
          store: "gcs",
        },
      ],
    );
    expect(msg).toMatch(
      /^The store refused a file of lakehouse schema "acme" \(cloudKmsDisabledKey\)\./,
    );
    expect(msg).toContain(
      "Cloud Storage service agent may lack the Cloud KMS CryptoKey Encrypter/Decrypter role",
    );
    expect(msg).not.toContain("kms:GenerateDataKey");
  });
});
