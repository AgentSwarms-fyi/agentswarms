// Presigned S3 GET URLs (SigV4, query-string authentication) and the two
// small signed calls a share needs beside them: HEAD for an object's size,
// DELETE for a superseded snapshot. Written against the lakehouse's own
// storage configuration, so MinIO in Compose and S3 in production produce
// the same URLs a recipient's client can fetch with no credential of ours.
// Customer keys add three (R440): HEAD for how a file is encrypted, a copy in
// place onto another key, and a PUT under a key for the store's check. R442
// puts the key inside a presigned PUT's signature, so the store refuses the
// upload unless it arrives under that key. R443 names the key the way the
// store does: S3's SSE-KMS headers, or Cloud Storage's
// x-goog-encryption-kms-key-name through its S3-compatible XML API.
import { createHash, createHmac } from "node:crypto";

import { signS3Request } from "@/utils/catalog/objectStore.server";
import {
  keyHeaders,
  objectEncryptionOf,
  storeKindOf,
  type ObjectEncryption,
} from "@/utils/lakehouse/customerKeyFiles";

export type S3Target = {
  /** host[:port], no scheme. Absent means AWS S3 in `region`. */
  endpoint?: string;
  /** The endpoint recipients reach, when it differs from the one the app uses (Compose). */
  publicEndpoint?: string;
  region: string;
  useSsl: boolean;
  urlStyle: "path" | "vhost";
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
function awsUriEncode(s: string, encodeSlash: boolean): string {
  const enc = (x: string) =>
    encodeURIComponent(x).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return encodeSlash ? enc(s) : s.split("/").map(enc).join("/");
}

/** Where a bucket lives for this target: the host to sign for and the path prefix. */
export function s3Location(
  t: S3Target,
  which: "app" | "public" = "app",
): { origin: string; host: string; basePath: string } {
  const endpoint = which === "public" ? (t.publicEndpoint ?? t.endpoint) : t.endpoint;
  const scheme = t.useSsl ? "https" : "http";
  if (endpoint) {
    const bare = endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (t.urlStyle === "vhost") {
      const host = `${t.bucket}.${bare}`;
      return { origin: `${scheme}://${host}`, host, basePath: "" };
    }
    return { origin: `${scheme}://${bare}`, host: bare, basePath: `/${t.bucket}` };
  }
  const host = `${t.bucket}.s3.${t.region}.amazonaws.com`;
  return { origin: `https://${host}`, host, basePath: "" };
}

/**
 * A URL that fetches one object with a plain GET for `expiresSeconds`.
 * Signed for the public host, so what the recipient's client uses is what
 * the signature covers; the payload is unsigned, as S3 requires for GET.
 */
export function presignS3Get(args: {
  target: S3Target;
  key: string;
  expiresSeconds: number;
  now?: Date;
}): string {
  return presignS3({ ...args, method: "GET", which: "public" });
}

/**
 * A URL that performs one request on one object for `expiresSeconds`, and
 * nothing else: the method and the key are inside the signature, so a URL
 * signed to PUT one staging file cannot read it, write another, or list.
 *
 * `which` picks the host the signature covers. A share's recipient fetches
 * from the public endpoint; a sandbox reaches the store as the app does.
 *
 * `amzHeaders` are signed with the host (R442): the request must carry them,
 * with these values, or the store refuses the signature. That is how a PUT is
 * held to a customer's KMS key: S3 takes the key only from headers, never
 * from the query string, so the URL alone cannot say it. Cloud Storage's own
 * x-goog-* headers are signed the same way (R443).
 */
export function presignS3(args: {
  target: S3Target;
  key: string;
  method: "GET" | "PUT" | "DELETE";
  expiresSeconds: number;
  which: "app" | "public";
  amzHeaders?: Record<string, string>;
  now?: Date;
}): string {
  const { target } = args;
  const loc = s3Location(target, args.which);
  const now = args.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const canonicalUri = awsUriEncode(`${loc.basePath}/${args.key}`.replace(/\/+/g, "/"), false);
  const signed: Record<string, string> = { host: loc.host };
  for (const [name, value] of Object.entries(args.amzHeaders ?? {})) {
    const n = name.toLowerCase();
    if (!n.startsWith("x-amz-") && !n.startsWith("x-goog-")) {
      throw new Error(`Only x-amz-* and x-goog-* headers are signed here, not ${n}`);
    }
    signed[n] = value.trim();
  }
  const names = Object.keys(signed).sort();
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${target.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.floor(args.expiresSeconds))),
    "X-Amz-SignedHeaders": names.join(";"),
    ...(target.sessionToken ? { "X-Amz-Security-Token": target.sessionToken } : {}),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k], true)}`)
    .join("&");
  const canonicalRequest = [
    args.method,
    canonicalUri,
    canonicalQuery,
    names.map((n) => `${n}:${signed[n]}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${target.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, target.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return `${loc.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function signedCall(
  t: S3Target,
  method: "GET" | "HEAD" | "DELETE" | "PUT" | "POST",
  key: string,
  body?: Buffer,
  query: Record<string, string> = {},
  /** Lower-case x-amz-* headers, signed with the rest (a copy's source, its encryption). */
  amzHeaders: Record<string, string> = {},
): Promise<Response> {
  const loc = s3Location(t, "app");
  const canonicalUri = awsUriEncode(`${loc.basePath}/${key}`.replace(/\/+/g, "/"), false);
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const headers: Record<string, string> = {
    ...amzHeaders,
    host: loc.host,
    // A PUT signs its payload's digest, so the bytes that land are the bytes
    // that were signed for — S3 refuses a body that hashes differently.
    "x-amz-content-sha256": body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256,
    "x-amz-date": amzDate,
    ...(t.sessionToken ? { "x-amz-security-token": t.sessionToken } : {}),
  };
  const { authorization, canonicalQuery } = signS3Request({
    method,
    canonicalUri,
    query,
    headers,
    region: t.region,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
  });
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  return fetch(`${loc.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
    method,
    headers: {
      ...sendHeaders,
      Authorization: authorization,
      ...(body ? { "Content-Type": "application/octet-stream" } : {}),
    },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

/**
 * Write one object. The app writes on a caller's behalf when the caller must
 * not hold the bucket's credentials — a notebook kernel saving a model — and
 * reports the digest it computed itself, never one it was told. Under a KMS
 * key when one is given: the owner's customer key (R442).
 */
export async function s3PutObject(
  t: S3Target,
  key: string,
  body: Buffer,
  opts: { kmsKeyId?: string | null } = {},
): Promise<{ sha256: string; bytes: number }> {
  const res = await signedCall(
    t,
    "PUT",
    key,
    body,
    {},
    opts.kmsKeyId ? keyHeadersFor(t, opts.kmsKeyId) : {},
  );
  if (!res.ok) throw new Error(`PUT ${key} failed (${res.status})`);
  return { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
}

/** The size of an object, or null when it is not there. */
export async function s3ObjectSize(t: S3Target, key: string): Promise<number | null> {
  const res = await signedCall(t, "HEAD", key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HEAD ${key} failed (${res.status})`);
  const len = res.headers.get("content-length");
  return len ? Number(len) : 0;
}

/**
 * An object's size, type and encryption, or null when it is not there. The
 * key on Cloud Storage is its Cloud KMS key's name, without the version.
 */
export async function s3HeadObject(
  t: S3Target,
  key: string,
): Promise<({ size: number; contentType: string | null } & ObjectEncryption) | null> {
  const res = await signedCall(t, "HEAD", key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HEAD ${key} failed (${res.status})`);
  return {
    size: Number(res.headers.get("content-length") ?? 0),
    contentType: res.headers.get("content-type"),
    ...objectEncryptionOf((n) => res.headers.get(n)),
  };
}

/** S3's error code and message from an error body, when it has one. */
export function s3ErrorOf(xml: string): { code: string; message: string } | null {
  const m =
    /<Error>[\s\S]*?<Code>([\s\S]*?)<\/Code>(?:[\s\S]*?<Message>([\s\S]*?)<\/Message>)?/.exec(xml);
  return m ? { code: xmlUnescape(m[1]), message: xmlUnescape(m[2] ?? "") } : null;
}

/** The headers that make this store write an object under one KMS key. */
export function keyHeadersFor(
  t: Pick<S3Target, "endpoint">,
  keyRef: string,
): Record<string, string> {
  return keyHeaders(storeKindOf(t.endpoint), keyRef);
}

/** The headers that make S3 encrypt an object under one KMS key. */
export function sseKmsHeaders(kmsKeyId: string): Record<string, string> {
  return {
    "x-amz-server-side-encryption": "aws:kms",
    "x-amz-server-side-encryption-aws-kms-key-id": kmsKeyId,
  };
}

/** One copy request is at most 5 GB (S3's limit); larger needs a multipart copy. */
export const S3_COPY_MAX_BYTES = 5 * 1024 ** 3;

/**
 * Copy an object onto itself under another encryption: a KMS key, or (null)
 * the bucket's own default. The bytes never leave the store and the key does
 * not change, so the catalog that names the file is untouched.
 *
 * Going back to the bucket's default sends no encryption at all, which on its
 * own would be "copy to itself without changing anything" (refused): the
 * metadata is REPLACEd instead, keeping the content type. A copy can also fail
 * AFTER S3 answered 200, with the error in the body; that is checked.
 */
export async function s3CopyInPlace(
  t: S3Target,
  key: string,
  to: { kmsKeyId: string | null; contentType: string | null },
): Promise<void> {
  const source = `/${t.bucket}/${awsUriEncode(key, false)}`;
  // Cloud Storage's XML API copies with its own headers, and copies an object
  // onto itself only with the metadata REPLACEd (so the type goes with it); a
  // copy with no key header lands under the bucket's own encryption.
  const headers: Record<string, string> =
    storeKindOf(t.endpoint) === "gcs"
      ? {
          "x-goog-copy-source": source.slice(1),
          "x-goog-metadata-directive": "REPLACE",
          ...(to.contentType ? { "content-type": to.contentType } : {}),
          ...(to.kmsKeyId ? keyHeadersFor(t, to.kmsKeyId) : {}),
        }
      : to.kmsKeyId
        ? {
            "x-amz-copy-source": source,
            "x-amz-metadata-directive": "COPY",
            ...sseKmsHeaders(to.kmsKeyId),
          }
        : {
            "x-amz-copy-source": source,
            "x-amz-metadata-directive": "REPLACE",
            ...(to.contentType ? { "content-type": to.contentType } : {}),
          };
  const res = await signedCall(t, "PUT", key, undefined, {}, headers);
  const body = await res.text();
  const err = s3ErrorOf(body);
  if (!res.ok || err) {
    throw new Error(
      `COPY ${key} failed (${res.status}${err ? ` ${err.code}${err.message ? `: ${err.message}` : ""}` : ""})`,
    );
  }
}

/**
 * Write one small object under a KMS key and report how the store says it
 * stored it: the customer key's check of the lakehouse store.
 */
export async function s3PutObjectUnderKey(
  t: S3Target,
  key: string,
  body: Buffer,
  kmsKeyId: string,
): Promise<{ status: number; sse: string | null; kmsKeyId: string | null; error: string | null }> {
  const res = await signedCall(t, "PUT", key, body, {}, keyHeadersFor(t, kmsKeyId));
  const text = await res.text();
  const err = s3ErrorOf(text);
  return {
    status: res.status,
    ...objectEncryptionOf((n) => res.headers.get(n)),
    error:
      res.ok && !err
        ? null
        : err
          ? `${err.code}${err.message ? `: ${err.message}` : ""}`
          : `HTTP ${res.status}`,
  };
}

/** What a store did with requests that all name a key (R443). */
export type HeaderRoundTrip = {
  ok: boolean;
  /** The request it refused, when it refused one. */
  refused: "PUT" | "MULTIPART" | "HEAD" | "GET" | "LIST" | "DELETE" | null;
  /** The store's error code or status for that request. */
  error: string | null;
  /** How the store says it stored the test object. */
  stored: ObjectEncryption | null;
};

/**
 * Write one small object with `headers`, write another as a multipart upload
 * (initiate, one part, complete), then HEAD the first, read it, list its
 * folder and delete both, naming the same headers on every request: what the
 * engine does through a DuckDB secret that carries them. Measured in R443's
 * probes: DuckDB sends a secret's extra headers on HEADs, reads and listings,
 * and a large write goes up in parts with the headers on every part too.
 * Cloud Storage documents its key header for an upload and a multipart
 * initiate only, so whether it minds the header anywhere else is asked of the
 * store itself, here. A refused step leaves what it made to be removed
 * without the headers.
 */
export async function s3HeaderRoundTrip(
  t: S3Target,
  key: string,
  headers: Record<string, string>,
): Promise<HeaderRoundTrip> {
  const fail = async (
    refused: HeaderRoundTrip["refused"],
    res: Response,
    stored: ObjectEncryption | null,
  ): Promise<HeaderRoundTrip> => {
    const err = s3ErrorOf(await res.text().catch(() => ""));
    return {
      ok: false,
      refused,
      error: err ? `${err.code}${err.message ? `: ${err.message}` : ""}` : `HTTP ${res.status}`,
      stored,
    };
  };
  const put = await signedCall(
    t,
    "PUT",
    key,
    Buffer.from("AgentSwarms: a store check\n"),
    {},
    headers,
  );
  if (!put.ok) return fail("PUT", put, null);
  await put.text().catch(() => "");
  let stored: ObjectEncryption | null = null;
  const parts = `${key}.parts`;
  let uploadId: string | null = null;
  try {
    const init = await signedCall(t, "POST", parts, Buffer.alloc(0), { uploads: "" }, headers);
    if (!init.ok) return await fail("MULTIPART", init, null);
    uploadId = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(await init.text())?.[1] ?? null;
    if (!uploadId) {
      return { ok: false, refused: "MULTIPART", error: "no upload id in the answer", stored: null };
    }
    const part = await signedCall(
      t,
      "PUT",
      parts,
      Buffer.from("AgentSwarms: a store check, in one part\n"),
      { partNumber: "1", uploadId },
      headers,
    );
    if (!part.ok) return await fail("MULTIPART", part, null);
    const etag = part.headers.get("etag") ?? "";
    await part.text().catch(() => "");
    const done = await signedCall(
      t,
      "POST",
      parts,
      Buffer.from(
        `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
      ),
      { uploadId },
      headers,
    );
    const doneText = await done.text().catch(() => "");
    if (!done.ok || s3ErrorOf(doneText)) {
      return await fail(
        "MULTIPART",
        new Response(doneText, { status: done.ok ? 400 : done.status }),
        null,
      );
    }
    uploadId = null;
    const head = await signedCall(t, "HEAD", key, undefined, {}, headers);
    if (!head.ok) return await fail("HEAD", head, null);
    stored = objectEncryptionOf((n) => head.headers.get(n));
    const get = await signedCall(t, "GET", key, undefined, {}, headers);
    if (!get.ok) return await fail("GET", get, stored);
    await get.arrayBuffer();
    const folder = key.slice(0, key.lastIndexOf("/") + 1);
    const list = await signedCall(
      t,
      "GET",
      "",
      undefined,
      { "list-type": "2", prefix: folder },
      headers,
    );
    if (!list.ok) return await fail("LIST", list, stored);
    await list.text();
    const del = await signedCall(t, "DELETE", key, undefined, {}, headers);
    if (!del.ok && del.status !== 404) return await fail("DELETE", del, stored);
    return { ok: true, refused: null, error: null, stored };
  } finally {
    if (uploadId) {
      await signedCall(t, "DELETE", parts, undefined, { uploadId }).catch(() => undefined);
    }
    await s3DeleteObject(t, key).catch(() => undefined);
    await s3DeleteObject(t, parts).catch(() => undefined);
  }
}

/** Delete one object; a missing object is not an error. */
export async function s3DeleteObject(t: S3Target, key: string): Promise<void> {
  const res = await signedCall(t, "DELETE", key);
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key} failed (${res.status})`);
}

const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Every key under `prefix`, with its last-modified time, a page at a time. */
export async function s3ListKeys(
  t: S3Target,
  prefix: string,
): Promise<{ key: string; lastModified: Date }[]> {
  const out: { key: string; lastModified: Date }[] = [];
  let token: string | null = null;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    // The bucket itself: in path style the key part is empty, so the
    // canonical URI is `/bucket/`; in vhost style it is `/`.
    const res = await signedCall(t, "GET", "", undefined, query);
    if (!res.ok) throw new Error(`LIST ${prefix} failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
      const when = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(m[1])?.[1];
      if (key) out.push({ key: xmlUnescape(key), lastModified: new Date(when ?? 0) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
      : null;
    if (token) token = xmlUnescape(token);
  } while (token);
  return out;
}

/** Delete every object under `prefix`. Returns how many were deleted. */
export async function s3DeletePrefix(t: S3Target, prefix: string): Promise<number> {
  // An empty or root prefix would be the whole bucket: never what is meant.
  if (!prefix || !prefix.replace(/\/+/g, "")) throw new Error("Refusing to delete an empty prefix");
  const keys = await s3ListKeys(t, prefix);
  for (const k of keys) await s3DeleteObject(t, k.key);
  return keys.length;
}
