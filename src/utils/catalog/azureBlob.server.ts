// Azure Blob Storage / ADLS Gen2 for the Data Catalog crawler and lake mounts.
//
// WHY A SECOND CLIENT. Every other object store the platform reads speaks the
// S3 API, so one SigV4 client covered AWS, GCS, R2, MinIO, Spaces and B2. Azure
// does not: Blob Storage has its own REST surface and its own signature
// scheme (SharedKey), and ADLS Gen2 is the same endpoint with hierarchical
// namespaces on. Every Azure enterprise keeps its lake there, and until now the
// "data platform" could not see it.
//
// Two credential forms, detected rather than configured:
//   - an ACCOUNT KEY (base64) -> requests are signed with SharedKey below;
//   - a SAS TOKEN (contains "sig=") -> appended to the query, no signing.
// A SAS scoped to read+list on one container is what an operator should hand
// over; the account key works but is the keys to the whole account.
//
// Mapped onto ObjectStoreConfig so nothing downstream learns a new shape:
//   bucket            = container
//   access_key_id     = storage account name
//   secret_access_key = account key or SAS token
//   endpoint          = optional override (Azurite, sovereign clouds)
import { createHmac } from "node:crypto";

import type { ObjectStoreConfig, StoredObject } from "./objectStore.server";

/** Blob REST version. Fixed: the signed string's shape depends on it. */
export const AZURE_API_VERSION = "2021-08-06";

export function isSasToken(secret: string): boolean {
  return /(^|[?&])sig=/.test(secret);
}

/** https://<account>.blob.core.windows.net, or the configured override. */
export function azureOrigin(cfg: Pick<ObjectStoreConfig, "endpoint" | "access_key_id">): string {
  if (cfg.endpoint) {
    const u = new URL(cfg.endpoint);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error("Azure endpoint must be an http(s) URL");
    }
    return u.origin;
  }
  return `https://${cfg.access_key_id}.blob.core.windows.net`;
}

/**
 * The DuckDB connection string for this config, for `CREATE SECRET (TYPE
 * azure, CONNECTION_STRING …)`. SAS and key take different forms; both are
 * what the azure extension documents.
 */
export function azureConnectionString(cfg: ObjectStoreConfig): string {
  const account = cfg.access_key_id;
  if (isSasToken(cfg.secret_access_key)) {
    const sas = cfg.secret_access_key.replace(/^\?/, "");
    return `BlobEndpoint=${azureOrigin(cfg)};SharedAccessSignature=${sas}`;
  }
  if (cfg.endpoint) {
    return `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${cfg.secret_access_key};BlobEndpoint=${azureOrigin(cfg)}`;
  }
  return `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${cfg.secret_access_key};EndpointSuffix=core.windows.net`;
}

/**
 * SharedKey string-to-sign for the Blob service (2015-02-21+ semantics: an
 * empty Content-Length is signed as the empty string, not "0").
 *
 * Exported so the canonicalisation can be pinned by tests: this is the part
 * that silently breaks -- a header out of order or a query value not
 * lowercased produces a 403 with no hint which byte was wrong.
 */
export function azureStringToSign(args: {
  method: string;
  account: string;
  /** "/<container>/<blob>" or "/<container>" -- already URL-path form. */
  resourcePath: string;
  query: Record<string, string>;
  /** Only x-ms-* headers are canonicalised; keys any case. */
  headers: Record<string, string>;
  range?: string;
}): string {
  const xms = Object.entries(args.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
    .filter(([k]) => k.startsWith("x-ms-"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${v}\n`)
    .join("");
  const canonicalQuery = Object.keys(args.query)
    .map((k) => [k.toLowerCase(), args.query[k]] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `\n${k}:${v}`)
    .join("");
  const resource = `/${args.account}${args.resourcePath}${canonicalQuery}`;
  // VERB, then the twelve standard headers in fixed order (all empty for our
  // GETs except Range), then canonicalized x-ms headers, then the resource.
  return [
    args.method.toUpperCase(),
    "", // Content-Encoding
    "", // Content-Language
    "", // Content-Length
    "", // Content-MD5
    "", // Content-Type
    "", // Date (we send x-ms-date instead)
    "", // If-Modified-Since
    "", // If-Match
    "", // If-None-Match
    "", // If-Unmodified-Since
    args.range ?? "", // Range
    `${xms}${resource}`,
  ].join("\n");
}

export function azureSharedKeySignature(stringToSign: string, accountKeyBase64: string): string {
  return createHmac("sha256", Buffer.from(accountKeyBase64, "base64"))
    .update(stringToSign, "utf8")
    .digest("base64");
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function azureGet(
  cfg: ObjectStoreConfig,
  blobPath: string,
  query: Record<string, string>,
  range?: string,
): Promise<Response> {
  const origin = azureOrigin(cfg);
  const resourcePath = `/${cfg.bucket}${blobPath ? `/${blobPath}` : ""}`;
  const headers: Record<string, string> = {
    "x-ms-version": AZURE_API_VERSION,
    "x-ms-date": new Date().toUTCString(),
  };
  if (range) headers.Range = range;

  const q = new URLSearchParams(query);
  if (isSasToken(cfg.secret_access_key)) {
    for (const [k, v] of new URLSearchParams(cfg.secret_access_key.replace(/^\?/, ""))) {
      q.set(k, v);
    }
  } else {
    const sts = azureStringToSign({
      method: "GET",
      account: cfg.access_key_id,
      resourcePath,
      query,
      headers,
      range,
    });
    headers.Authorization = `SharedKey ${cfg.access_key_id}:${azureSharedKeySignature(sts, cfg.secret_access_key)}`;
  }

  const url = `${origin}${encodePath(resourcePath)}${q.toString() ? `?${q}` : ""}`;
  return fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m
    ? m[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
    : null;
}

/** Parse a List Blobs response into the crawler's shape. Exported for tests. */
export function parseBlobList(xml: string): { blobs: StoredObject[]; nextMarker: string | null } {
  const blobs: StoredObject[] = [];
  for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const key = tag(m[1], "Name");
    if (!key || key.endsWith("/")) continue; // directory markers on HNS accounts
    blobs.push({
      key,
      size: Number(tag(m[1], "Content-Length") ?? 0),
      last_modified: tag(m[1], "Last-Modified") ?? "",
    });
  }
  const marker = tag(xml, "NextMarker");
  return { blobs, nextMarker: marker && marker.trim() ? marker.trim() : null };
}

async function readAzureError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const code = tag(body, "Code");
  const msg = tag(body, "Message")?.split("\n")[0];
  return code || msg ? `${code ?? ""}${code && msg ? ": " : ""}${msg ?? ""}` : `HTTP ${res.status}`;
}

export async function azureListObjects(
  cfg: ObjectStoreConfig,
  cap = 2000,
): Promise<StoredObject[]> {
  const out: StoredObject[] = [];
  let marker: string | null = null;
  while (out.length < cap) {
    const query: Record<string, string> = {
      restype: "container",
      comp: "list",
      maxresults: String(Math.min(5000, cap - out.length)),
    };
    if (cfg.prefix) query.prefix = cfg.prefix;
    if (marker) query.marker = marker;
    const res = await azureGet(cfg, "", query);
    if (!res.ok) throw new Error(`Container listing failed — ${await readAzureError(res)}`);
    const { blobs, nextMarker } = parseBlobList(await res.text());
    out.push(...blobs);
    if (!nextMarker) break;
    marker = nextMarker;
  }
  return out.slice(0, cap);
}

/** Cheap connectivity + credential check: list one blob. */
export async function azureTestObjectStore(cfg: ObjectStoreConfig): Promise<void> {
  const query: Record<string, string> = { restype: "container", comp: "list", maxresults: "1" };
  if (cfg.prefix) query.prefix = cfg.prefix;
  const res = await azureGet(cfg, "", query);
  if (!res.ok) throw new Error(await readAzureError(res));
}

/** First `bytes` of a blob, for schema sampling. */
export async function azureSampleObject(
  cfg: ObjectStoreConfig,
  key: string,
  bytes = 128 * 1024,
): Promise<Buffer> {
  const res = await azureGet(cfg, key, {}, `bytes=0-${bytes - 1}`);
  if (!res.ok && res.status !== 206) {
    throw new Error(`Sampling "${key}" failed — ${await readAzureError(res)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
