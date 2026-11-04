// R442: a presigned PUT that holds the upload to a customer's KMS key.
//
// S3 takes a KMS key only from headers, never from a URL's query string, so
// the URL cannot carry it by itself. What it can do is SIGN them: with the
// headers in X-Amz-SignedHeaders, a request that leaves them out, or sends
// another key, no longer matches the signature and the store refuses it. The
// arithmetic is checked here against the canonical request written out by
// hand from AWS's SigV4 description; that a store with signature checks on
// takes the one and refuses the others is driven against the stand-in
// (UI_TEST_RESULTS, R442).
import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  keyHeadersFor,
  presignS3,
  s3CopyInPlace,
  s3HeadObject,
  s3HeaderRoundTrip,
  s3PutObject,
  sseKmsHeaders,
  type S3Target,
} from "@/utils/lakehouse/presign.server";

const TARGET: S3Target = {
  region: "eu-west-1",
  useSsl: false,
  urlStyle: "path",
  bucket: "lake",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  endpoint: "store.test:4566",
};
const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const NOW = new Date("2026-11-03T12:00:00Z");
const KEY = "ml-artifacts/40000000-0000-4000-8000-000000000001/v1/model.joblib";

const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

/** The signature SigV4 gives this canonical request, computed here, not by the app. */
function expectedSignature(canonicalRequest: string): string {
  const scope = "20261103/eu-west-1/s3/aws4_request";
  const toSign = [
    "AWS4-HMAC-SHA256",
    "20261103T120000Z",
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  let k = hmac(`AWS4${TARGET.secretAccessKey}`, "20261103");
  for (const part of ["eu-west-1", "s3", "aws4_request"]) k = hmac(k, part);
  return hmac(k, toSign).toString("hex");
}

describe("a presigned PUT under a customer's KMS key", () => {
  it("signs the key's headers with the host, in order, and nothing else", () => {
    const url = new URL(
      presignS3({
        target: TARGET,
        key: KEY,
        method: "PUT",
        expiresSeconds: 3600,
        which: "app",
        amzHeaders: sseKmsHeaders(ARN),
        now: NOW,
      }),
    );
    const signedHeaders =
      "host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id";
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(signedHeaders);
    // Nothing about the key rides in the query string: S3 would not read it there.
    expect(url.search).not.toContain("server-side-encryption%3D");
    expect(url.search).not.toContain(encodeURIComponent(ARN));
    const query = [
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      `X-Amz-Credential=AKIDEXAMPLE%2F20261103%2Feu-west-1%2Fs3%2Faws4_request`,
      "X-Amz-Date=20261103T120000Z",
      "X-Amz-Expires=3600",
      `X-Amz-SignedHeaders=${encodeURIComponent(signedHeaders)}`,
    ].join("&");
    const canonical = [
      "PUT",
      `/lake/${KEY}`,
      query,
      [
        "host:store.test:4566",
        "x-amz-server-side-encryption:aws:kms",
        `x-amz-server-side-encryption-aws-kms-key-id:${ARN}`,
        "",
      ].join("\n"),
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(canonical));
  });

  it("is a different signature from one without the key, and from one under another key", () => {
    const sig = (amzHeaders?: Record<string, string>) =>
      new URL(
        presignS3({
          target: TARGET,
          key: KEY,
          method: "PUT",
          expiresSeconds: 3600,
          which: "app",
          amzHeaders,
          now: NOW,
        }),
      ).searchParams.get("X-Amz-Signature");
    const other = ARN.replace("1234abcd", "9999abcd");
    expect(sig(sseKmsHeaders(ARN))).not.toBe(sig());
    expect(sig(sseKmsHeaders(ARN))).not.toBe(sig(sseKmsHeaders(other)));
  });

  it("is exactly the URL it always was when no header is given", () => {
    // Every GET, DELETE and uncovered PUT the app hands out: the known answer
    // in deltaSharing.test.ts holds the arithmetic, this the sameness.
    const canonical = [
      "GET",
      `/lake/${KEY}`,
      [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        `X-Amz-Credential=AKIDEXAMPLE%2F20261103%2Feu-west-1%2Fs3%2Faws4_request`,
        "X-Amz-Date=20261103T120000Z",
        "X-Amz-Expires=60",
        "X-Amz-SignedHeaders=host",
      ].join("&"),
      "host:store.test:4566\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    for (const amzHeaders of [undefined, {}]) {
      const url = new URL(
        presignS3({
          target: TARGET,
          key: KEY,
          method: "GET",
          expiresSeconds: 60,
          which: "app",
          amzHeaders,
          now: NOW,
        }),
      );
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(canonical));
    }
  });

  it("refuses to sign a header that is not an x-amz one", () => {
    // Content-Type, say, would bind the upload to a value the caller chose
    // for reasons of its own; only the store's own instructions are signed.
    expect(() =>
      presignS3({
        target: TARGET,
        key: KEY,
        method: "PUT",
        expiresSeconds: 60,
        which: "app",
        amzHeaders: { "content-type": "application/octet-stream" },
      }),
    ).toThrow(/Only x-amz-\* and x-goog-\* headers/);
  });

  it("names the headers the sandbox must send, as S3 spells them", () => {
    expect(sseKmsHeaders(ARN)).toEqual({
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": ARN,
    });
  });
});

describe("an object the app writes for its owner (an experiment's file)", () => {
  async function sent(kmsKeyId?: string | null) {
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        calls.push({ headers: init?.headers as Record<string, string> });
        return new Response("", { status: 200 });
      }),
    );
    try {
      await s3PutObject(TARGET, KEY, Buffer.from("model"), { kmsKeyId });
    } finally {
      vi.unstubAllGlobals();
    }
    return calls[0]!.headers;
  }

  it("carries the owner's key, signed with the rest", async () => {
    const h = await sent(ARN);
    expect(h["x-amz-server-side-encryption"]).toBe("aws:kms");
    expect(h["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(ARN);
    expect(h.Authorization).toMatch(
      /SignedHeaders=[^,]*x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id/,
    );
  });

  it("carries no key when its owner has none", async () => {
    for (const k of [undefined, null]) {
      const h = await sent(k);
      expect(Object.keys(h).some((n) => n.includes("server-side-encryption"))).toBe(false);
    }
  });
});

// R443: the same requests against Cloud Storage's XML API, where a Cloud KMS
// key is named by x-goog-encryption-kms-key-name. What Cloud Storage does with
// them is its documentation's word; what is held here is what the app sends.
describe("on Cloud Storage", () => {
  const GCS: S3Target = { ...TARGET, endpoint: "storage.googleapis.com", useSsl: true };
  const GKEY = "projects/acme-prod/locations/europe-west1/keyRings/lake/cryptoKeys/acme";

  type Sent = { method: string; url: string; headers: Record<string, string> };
  /** A store that answers a multipart initiate with an upload id, and everything else with 200. */
  const ok = (r: Sent) =>
    r.method === "POST" && /[?&]uploads=/.test(r.url)
      ? new Response(
          "<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>",
        )
      : new Response("", { status: 200, headers: { etag: '"p1"' } });
  function store(answer: (r: Sent) => Response = ok) {
    const sent: Sent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
        const r = { method: (init?.method ?? "GET").toUpperCase(), url: String(u), headers };
        sent.push(r);
        return answer(r);
      }),
    );
    return sent;
  }

  it("signs the key's name into an upload URL, and the store's header is the one", () => {
    const url = new URL(
      presignS3({
        target: GCS,
        key: KEY,
        method: "PUT",
        expiresSeconds: 3600,
        which: "app",
        amzHeaders: keyHeadersFor(GCS, GKEY),
        now: NOW,
      }),
    );
    expect(url.host).toBe("storage.googleapis.com");
    const signedHeaders = "host;x-goog-encryption-kms-key-name";
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(signedHeaders);
    const canonical = [
      "PUT",
      `/lake/${KEY}`,
      [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        `X-Amz-Credential=AKIDEXAMPLE%2F20261103%2Feu-west-1%2Fs3%2Faws4_request`,
        "X-Amz-Date=20261103T120000Z",
        "X-Amz-Expires=3600",
        `X-Amz-SignedHeaders=${encodeURIComponent(signedHeaders)}`,
      ].join("&"),
      ["host:storage.googleapis.com", `x-goog-encryption-kms-key-name:${GKEY}`, ""].join("\n"),
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(canonical));
  });

  it("writes the app's own object under the key with that header, and never S3's", async () => {
    const sent = store();
    try {
      await s3PutObject(GCS, KEY, Buffer.from("m"), { kmsKeyId: GKEY });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent[0]!.headers["x-goog-encryption-kms-key-name"]).toBe(GKEY);
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith("x-amz-server-side"))).toBe(
      false,
    );
    expect(sent[0]!.headers.authorization).toContain("x-goog-encryption-kms-key-name");
  });

  it("copies in place with Cloud Storage's copy headers, REPLACE and the type, onto the key or off it", async () => {
    const sent = store(() => new Response("<CopyObjectResult><ETag>e</ETag></CopyObjectResult>"));
    try {
      await s3CopyInPlace(GCS, KEY, { kmsKeyId: GKEY, contentType: "application/octet-stream" });
      await s3CopyInPlace(GCS, KEY, {
        kmsKeyId: null,
        contentType: "application/vnd.apache.parquet",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const [onto, off] = sent;
    for (const c of [onto!, off!]) {
      expect(c.method).toBe("PUT");
      expect(c.headers["x-goog-copy-source"]).toBe(`lake/${KEY}`);
      // An object copied onto itself must REPLACE its metadata.
      expect(c.headers["x-goog-metadata-directive"]).toBe("REPLACE");
      expect(c.headers["x-amz-copy-source"]).toBeUndefined();
    }
    expect(onto!.headers["x-goog-encryption-kms-key-name"]).toBe(GKEY);
    expect(onto!.headers["content-type"]).toBe("application/octet-stream");
    expect(off!.headers["x-goog-encryption-kms-key-name"]).toBeUndefined();
    expect(off!.headers["content-type"]).toBe("application/vnd.apache.parquet");
  });

  it("reads a stored object's key as the customer key's own name", async () => {
    store(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-length": "5",
            "x-goog-encryption-kms-key-name": `${GKEY}/cryptoKeyVersions/2`,
          },
        }),
    );
    try {
      expect(await s3HeadObject(GCS, KEY)).toMatchObject({
        sse: "gcp:kms",
        kmsKeyId: GKEY,
        size: 5,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks the store every request the engine makes, each naming the key, and says which it refused", async () => {
    const all = store();
    let r;
    try {
      r = await s3HeaderRoundTrip(
        GCS,
        "_customer_key_check/engine/x.txt",
        keyHeadersFor(GCS, GKEY),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(r).toMatchObject({ ok: true, refused: null });
    const named = all.filter((q) => q.headers["x-goog-encryption-kms-key-name"] === GKEY);
    const kind = (q: Sent) =>
      `${q.method}${q.url.includes("list-type=2") ? " list" : ""}${/[?&]uploads=/.test(q.url) ? " initiate" : ""}${/partNumber=/.test(q.url) ? " part" : ""}${q.method === "POST" && /[?&]uploadId=/.test(q.url) ? " complete" : ""}`;
    expect(named.map(kind)).toEqual([
      "PUT",
      "POST initiate",
      "PUT part",
      "POST complete",
      "HEAD",
      "GET",
      "GET list",
      "DELETE",
    ]);
    // The part's ETag goes back in the complete.
    expect(all.find((q) => kind(q) === "POST complete")).toBeTruthy();

    const refused = store((q) =>
      q.method === "GET" && !q.url.includes("list-type")
        ? new Response(
            "<Error><Code>InvalidArgument</Code><Message>not on a read</Message></Error>",
            {
              status: 400,
            },
          )
        : ok(q),
    );
    try {
      r = await s3HeaderRoundTrip(
        GCS,
        "_customer_key_check/engine/y.txt",
        keyHeadersFor(GCS, GKEY),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(r).toMatchObject({ ok: false, refused: "GET", error: "InvalidArgument: not on a read" });
    // What it made is deleted all the same, without the header.
    const tail = refused.slice(-2);
    expect(tail.map((q) => q.method)).toEqual(["DELETE", "DELETE"]);
    for (const q of tail) expect(q.headers["x-goog-encryption-kms-key-name"]).toBeUndefined();
  });

  it("says a multipart part naming the key was refused, and aborts the upload", async () => {
    const sent = store((q) =>
      /partNumber=/.test(q.url)
        ? new Response(
            "<Error><Code>InvalidArgument</Code><Message>not on a part</Message></Error>",
            {
              status: 400,
            },
          )
        : ok(q),
    );
    let r;
    try {
      r = await s3HeaderRoundTrip(
        GCS,
        "_customer_key_check/engine/z.txt",
        keyHeadersFor(GCS, GKEY),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(r).toMatchObject({
      ok: false,
      refused: "MULTIPART",
      error: "InvalidArgument: not on a part",
    });
    const abort = sent.find((q) => q.method === "DELETE" && /[?&]uploadId=u-1/.test(q.url));
    expect(abort, "the upload is aborted").toBeTruthy();
    expect(abort!.headers["x-goog-encryption-kms-key-name"]).toBeUndefined();
  });
});
