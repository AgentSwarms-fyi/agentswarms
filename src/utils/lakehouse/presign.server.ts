// Presigned S3 GET URLs (SigV4, query-string authentication) and the two
// small signed calls a share needs beside them: HEAD for an object's size,
// DELETE for a superseded snapshot. Written against the lakehouse's own
// storage configuration, so MinIO in Compose and S3 in production produce
// the same URLs a recipient's client can fetch with no credential of ours.
import { createHash, createHmac } from "node:crypto";

import { signS3Request } from "@/utils/catalog/objectStore.server";

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
  const { target } = args;
  const loc = s3Location(target, "public");
  const now = args.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const canonicalUri = awsUriEncode(`${loc.basePath}/${args.key}`.replace(/\/+/g, "/"), false);
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${target.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.floor(args.expiresSeconds))),
    "X-Amz-SignedHeaders": "host",
    ...(target.sessionToken ? { "X-Amz-Security-Token": target.sessionToken } : {}),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k], true)}`)
    .join("&");
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${loc.host}\n`,
    "host",
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
  method: "HEAD" | "DELETE" | "PUT",
  key: string,
  body?: Buffer,
): Promise<Response> {
  const loc = s3Location(t, "app");
  const canonicalUri = awsUriEncode(`${loc.basePath}/${key}`.replace(/\/+/g, "/"), false);
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const headers: Record<string, string> = {
    host: loc.host,
    // A PUT signs its payload's digest, so the bytes that land are the bytes
    // that were signed for — S3 refuses a body that hashes differently.
    "x-amz-content-sha256": body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256,
    "x-amz-date": amzDate,
    ...(t.sessionToken ? { "x-amz-security-token": t.sessionToken } : {}),
  };
  const { authorization } = signS3Request({
    method,
    canonicalUri,
    query: {},
    headers,
    region: t.region,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
  });
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  return fetch(`${loc.origin}${canonicalUri}`, {
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
 * reports the digest it computed itself, never one it was told.
 */
export async function s3PutObject(
  t: S3Target,
  key: string,
  body: Buffer,
): Promise<{ sha256: string; bytes: number }> {
  const res = await signedCall(t, "PUT", key, body);
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

/** Delete one object; a missing object is not an error. */
export async function s3DeleteObject(t: S3Target, key: string): Promise<void> {
  const res = await signedCall(t, "DELETE", key);
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key} failed (${res.status})`);
}
