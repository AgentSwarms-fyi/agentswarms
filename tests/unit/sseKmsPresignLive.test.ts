// R442, against a store that checks presigned signatures: a URL signed with a
// customer's KMS key takes the upload under that key, and refuses it without
// the key's headers or with another key's.
//
// presignSignedHeaders.test.ts holds the arithmetic; this is the store's side.
// The stand-in is LocalStack with signature checks on for presigned URLs
// (it checks no header-signed request, and enforces no KMS key policy):
//
//   docker run -d --name r442-localstack -p 127.0.0.1:4568:4566 \
//     -e SERVICES=s3,kms -e S3_SKIP_SIGNATURE_VALIDATION=0 localstack/localstack:4.14.0
//
// Skipped, loudly, when nothing answers there, as objectStoreLakeLive.test.ts
// is: a suite that passes because its subject was absent proves nothing.
import { beforeAll, describe, expect, it } from "vitest";

import {
  presignS3,
  s3DeleteObject,
  s3HeadObject,
  s3PutObject,
  sseKmsHeaders,
  type S3Target,
} from "@/utils/lakehouse/presign.server";

const ENDPOINT = "127.0.0.1:4568";
const REGION = "eu-west-1";
// LocalStack's own published dummy credential.
const TARGET: S3Target = {
  endpoint: ENDPOINT,
  region: REGION,
  useSsl: false,
  urlStyle: "path",
  bucket: "r442-presign-live",
  accessKeyId: "test",
  secretAccessKey: "test",
};
const ROOT = "itest-sse";

const live = await (async () => {
  try {
    const r = await fetch(`http://${ENDPOINT}/_localstack/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const services = ((await r.json()) as { services?: Record<string, string> }).services ?? {};
    return (
      r.ok &&
      /available|running/.test(services.s3 ?? "") &&
      /available|running/.test(services.kms ?? "")
    );
  } catch {
    return false;
  }
})();
if (!live) {
  console.warn(
    `\n[sseKmsPresignLive] no LocalStack with S3 and KMS on ${ENDPOINT}: these tests are SKIPPED, not passed. ` +
      "They are the proof a store holds a presigned upload to the key signed into it.\n",
  );
}
const withStore = (name: string, fn: () => Promise<void>) => it.skipIf(!live)(name, fn, 60_000);

const AUTH = (svc: string) =>
  `AWS4-HMAC-SHA256 Credential=test/20261103/${REGION}/${svc}/aws4_request, SignedHeaders=host, Signature=00`;

async function kmsKey(): Promise<string> {
  const r = await fetch(`http://${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "TrentService.CreateKey",
      authorization: AUTH("kms"),
      "x-amz-date": "20261103T000000Z",
    },
    body: JSON.stringify({ Description: "R442 presign live test (throwaway)" }),
  });
  return ((await r.json()) as { KeyMetadata: { Arn: string } }).KeyMetadata.Arn;
}

let keyA = "";
let keyB = "";
beforeAll(async () => {
  if (!live) return;
  await fetch(`http://${ENDPOINT}/${TARGET.bucket}`, {
    method: "PUT",
    headers: { authorization: AUTH("s3"), "x-amz-date": "20261103T000000Z" },
    body: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${REGION}</LocationConstraint></CreateBucketConfiguration>`,
  });
  keyA = await kmsKey();
  keyB = await kmsKey();
});

const put = (key: string, signedFor: string | null) =>
  presignS3({
    target: TARGET,
    key,
    method: "PUT",
    expiresSeconds: 600,
    which: "app",
    amzHeaders: signedFor ? sseKmsHeaders(signedFor) : undefined,
  });

describe("a presigned PUT signed for a customer's key", () => {
  withStore("is taken with the key's headers, and stored under that key", async () => {
    const key = `${ROOT}/model.joblib`;
    const r = await fetch(put(key, keyA), {
      method: "PUT",
      headers: sseKmsHeaders(keyA),
      body: "model bytes",
    });
    expect(r.status).toBe(200);
    const head = await s3HeadObject(TARGET, key);
    expect(head).toMatchObject({ sse: "aws:kms", kmsKeyId: keyA });
    // And read back whole through a plain presigned GET: the store decrypts.
    const get = await fetch(
      presignS3({ target: TARGET, key, method: "GET", expiresSeconds: 60, which: "app" }),
    );
    expect(await get.text()).toBe("model bytes");
    await s3DeleteObject(TARGET, key);
  });

  withStore("is refused without the headers, and with another key's", async () => {
    const key = `${ROOT}/refused.joblib`;
    const bare = await fetch(put(key, keyA), { method: "PUT", body: "no key" });
    expect(bare.status).toBe(403);
    expect(await bare.text()).toMatch(/SignatureDoesNotMatch/);
    const other = await fetch(put(key, keyA), {
      method: "PUT",
      headers: sseKmsHeaders(keyB),
      body: "another key",
    });
    expect(other.status).toBe(403);
    expect(await s3HeadObject(TARGET, key)).toBeNull();
  });

  withStore("is, unsigned, what it always was: the store's own encryption", async () => {
    const key = `${ROOT}/plain.parquet`;
    const r = await fetch(put(key, null), { method: "PUT", body: "rows" });
    expect(r.status).toBe(200);
    expect((await s3HeadObject(TARGET, key))?.kmsKeyId ?? null).toBeNull();
    await s3DeleteObject(TARGET, key);
  });
});

describe("an object the app writes for its owner", () => {
  withStore("is stored under the key it is given", async () => {
    const key = `${ROOT}/experiment.joblib`;
    const done = await s3PutObject(TARGET, key, Buffer.from("experiment"), { kmsKeyId: keyB });
    expect(done.bytes).toBe(10);
    expect(await s3HeadObject(TARGET, key)).toMatchObject({ sse: "aws:kms", kmsKeyId: keyB });
    await s3DeleteObject(TARGET, key);
  });
});
