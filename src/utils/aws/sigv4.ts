// AWS Signature Version 4 for the calls the app makes as itself (AWS KMS, STS).
// Pure WebCrypto: no SDK, no network. Checked against the published AWS SigV4
// test suite (tests/unit/awsSigv4.test.ts), which the per-service signers in
// the Bedrock, Redshift and Athena adapters never were.
//
// Every header handed in is signed, along with host and x-amz-date (and the
// session token when there is one). The path is the one sent, encoded once
// more, as every service but S3 expects; the query is sorted and encoded.

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const buf = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const k = await crypto.subtle.importKey("raw", buf, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** RFC 3986 encoding as SigV4 wants it: everything but A–Z a–z 0–9 - _ . ~ */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function canonicalUri(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map((segment) => awsUriEncode(segment))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs = [...params].map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function amzDateOf(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Sign a request. Returns the headers to send: the ones given, x-amz-date,
 * x-amz-security-token when the credentials carry one, and Authorization.
 * Host is signed from the URL and left to fetch to send.
 */
export async function signAwsRequest(req: {
  service: string;
  region: string;
  credentials: AwsCredentials;
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: string;
  /** The signing time; tests pin it to the suite's. */
  now?: Date;
}): Promise<Record<string, string>> {
  const url = typeof req.url === "string" ? new URL(req.url) : req.url;
  const amzDate = amzDateOf(req.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const { accessKeyId, secretAccessKey, sessionToken } = req.credentials;

  const out: Record<string, string> = { ...(req.headers ?? {}), "x-amz-date": amzDate };
  if (sessionToken) out["x-amz-security-token"] = sessionToken;

  const signed: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(out)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "authorization") continue;
    signed[lower] = value.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(req.body ?? ""),
  ].join("\n");

  const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  const kDate = await hmac(enc.encode("AWS4" + secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, req.region);
  const kService = await hmac(kRegion, req.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  out.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
