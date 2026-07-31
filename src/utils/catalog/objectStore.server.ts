// S3-compatible object storage client for the Data Catalog crawler.
// Implements AWS Signature V4 with Node's crypto — no SDK dependency —
// so one code path covers AWS S3, Cloudflare R2, MinIO, DigitalOcean
// Spaces, Backblaze B2 and any other S3-compatible endpoint.
// Only the two read operations the crawler needs: ListObjectsV2 and
// ranged GetObject (for schema sampling).
import { createHash, createHmac } from "node:crypto";

import Papa from "papaparse";

export type ObjectStoreConfig = {
  /** Display label only — the wire protocol is identical for all of them. */
  provider: "aws" | "gcs" | "r2" | "minio" | "spaces" | "b2" | "custom";
  /** Custom endpoint origin (https://…). Empty = AWS (derived from region). */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Optional key prefix to scope the crawl (e.g. "raw/sales/"). */
  prefix?: string;
  /** Path-style addressing (endpoint/bucket/key). Default: on for custom endpoints. */
  path_style?: boolean;
  access_key_id: string;
  secret_access_key: string;
};

export type StoredObject = { key: string; size: number; last_modified: string };

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** AWS-style URI encoding: like encodeURIComponent but also !'()* and keeps /. */
function awsUriEncode(path: string, encodeSlash: boolean): string {
  const enc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return encodeSlash ? enc(path) : path.split("/").map(enc).join("/");
}

function resolveTarget(cfg: ObjectStoreConfig): { origin: string; host: string; basePath: string } {
  const pathStyle = cfg.path_style ?? Boolean(cfg.endpoint);
  if (cfg.endpoint) {
    const url = new URL(cfg.endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Endpoint must be an http(s) URL");
    }
    if (pathStyle) {
      return { origin: url.origin, host: url.host, basePath: `/${cfg.bucket}` };
    }
    return {
      origin: `${url.protocol}//${cfg.bucket}.${url.host}`,
      host: `${cfg.bucket}.${url.host}`,
      basePath: "",
    };
  }
  const regionHost = `s3.${cfg.region}.amazonaws.com`;
  if (pathStyle) {
    return { origin: `https://${regionHost}`, host: regionHost, basePath: `/${cfg.bucket}` };
  }
  return {
    origin: `https://${cfg.bucket}.${regionHost}`,
    host: `${cfg.bucket}.${regionHost}`,
    basePath: "",
  };
}

/**
 * Pure SigV4 signing core (exported so it can be validated against the
 * official AWS test vectors). `headers` must already contain host,
 * x-amz-date and x-amz-content-sha256 (lowercase keys).
 */
export function signS3Request(args: {
  method: string;
  canonicalUri: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): { authorization: string; canonicalQuery: string } {
  const amzDate = args.headers["x-amz-date"];
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${args.region}/s3/aws4_request`;

  const canonicalQuery = Object.keys(args.query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(args.query[k], true)}`)
    .join("&");

  const signedHeaderNames = Object.keys(args.headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((k) => `${k}:${args.headers[k].trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    args.method,
    args.canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    args.headers["x-amz-content-sha256"],
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${args.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalQuery,
  };
}

/** Signed S3 GET. `keyPath` is the object key ("" for bucket-level ops). */
async function s3Get(
  cfg: ObjectStoreConfig,
  keyPath: string,
  query: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const { origin, host, basePath } = resolveTarget(cfg);
  const canonicalUri = awsUriEncode(`${basePath}/${keyPath}`.replace(/\/{2,}/g, "/"), false) || "/";
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const { authorization, canonicalQuery } = signS3Request({
    method: "GET",
    canonicalUri,
    query,
    headers,
    region: cfg.region || "us-east-1",
    accessKeyId: cfg.access_key_id,
    secretAccessKey: cfg.secret_access_key,
  });

  const url = `${origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const { host: _h, ...sendHeaders } = headers; // fetch sets Host itself
  return fetch(url, {
    method: "GET",
    headers: { ...sendHeaders, Authorization: authorization },
    signal: AbortSignal.timeout(30_000),
  });
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function xmlTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? xmlUnescape(m[1]) : null;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const code = xmlTag(body, "Code");
  const msg = xmlTag(body, "Message");
  return code || msg ? `${code ?? ""}${code && msg ? ": " : ""}${msg ?? ""}` : `HTTP ${res.status}`;
}

/** List objects under the configured prefix (paginated, capped). */
export async function listObjects(cfg: ObjectStoreConfig, cap = 2000): Promise<StoredObject[]> {
  const out: StoredObject[] = [];
  let token: string | undefined;
  while (out.length < cap) {
    const query: Record<string, string> = {
      "list-type": "2",
      "max-keys": String(Math.min(1000, cap - out.length)),
    };
    if (cfg.prefix) query.prefix = cfg.prefix;
    if (token) query["continuation-token"] = token;
    const res = await s3Get(cfg, "", query);
    if (!res.ok) throw new Error(`Bucket listing failed — ${await readError(res)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlTag(m[1], "Key");
      if (!key || key.endsWith("/")) continue; // folder markers
      out.push({
        key,
        size: Number(xmlTag(m[1], "Size") ?? 0),
        last_modified: xmlTag(m[1], "LastModified") ?? "",
      });
    }
    if (xmlTag(xml, "IsTruncated") !== "true") break;
    token = xmlTag(xml, "NextContinuationToken") ?? undefined;
    if (!token) break;
  }
  return out;
}

/** Cheap connectivity + credential check: list a single key. */
export async function testObjectStore(cfg: ObjectStoreConfig): Promise<void> {
  const query: Record<string, string> = { "list-type": "2", "max-keys": "1" };
  if (cfg.prefix) query.prefix = cfg.prefix;
  const res = await s3Get(cfg, "", query);
  if (!res.ok) throw new Error(await readError(res));
}

/** Fetch the first `bytes` of an object for schema sampling. */
export async function sampleObject(
  cfg: ObjectStoreConfig,
  key: string,
  bytes = 128 * 1024,
): Promise<Buffer> {
  const res = await s3Get(cfg, key, {}, { range: `bytes=0-${bytes - 1}` });
  // 206 = partial content; 200 = whole object smaller than the range.
  if (!res.ok && res.status !== 206) {
    throw new Error(`Sampling "${key}" failed — ${await readError(res)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── Schema inference from sampled bytes ──────────────────────────────────

export type InferredColumn = {
  name: string;
  type: string;
  sample?: string;
  /** Sample-based profile stats (percentage 0–100 / counts within the sample). */
  null_pct?: number;
  distinct_count?: number;
  min?: number;
  max?: number;
};

export function fileFormat(key: string): string | null {
  const base = key.toLowerCase();
  if (base.endsWith(".gz") || base.endsWith(".zip") || base.endsWith(".zst")) return "compressed";
  const ext = base.split(".").pop() ?? "";
  if (["csv", "tsv", "txt"].includes(ext)) return "csv";
  if (ext === "json") return "json";
  if (["jsonl", "ndjson"].includes(ext)) return "ndjson";
  if (ext === "parquet") return "parquet";
  if (["orc", "avro"].includes(ext)) return ext;
  return null;
}

function valueType(v: unknown): string {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v instanceof Date) return "date";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) return "date";
    if (v.trim() !== "" && !Number.isNaN(Number(v))) return "number";
  }
  return "string";
}

/**
 * Per-column sample profile: null %, distinct count and numeric min/max
 * computed over the given records. Shared by the bucket schema inference
 * and the warehouse preview-based profiler.
 */
export function computeColumnStats(
  records: Record<string, unknown>[],
  name: string,
): Pick<InferredColumn, "type" | "sample" | "null_pct" | "distinct_count" | "min" | "max"> {
  const raw = records.map((r) => r[name]);
  const values = raw.filter((v) => v !== null && v !== undefined && v !== "");
  const types = new Set(values.slice(0, 100).map(valueType));
  const type = types.size === 1 ? [...types][0] : "string";
  const first = values[0];
  const distinct = new Set(
    values.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))),
  );
  const out: ReturnType<typeof computeColumnStats> = {
    type,
    sample:
      first === undefined
        ? undefined
        : String(typeof first === "object" ? JSON.stringify(first) : first).slice(0, 80),
    null_pct:
      records.length > 0
        ? Math.round(((records.length - values.length) / records.length) * 100)
        : undefined,
    distinct_count: distinct.size,
  };
  if (type === "number") {
    const nums = values.map(Number).filter(Number.isFinite);
    if (nums.length > 0) {
      out.min = Math.min(...nums);
      out.max = Math.max(...nums);
    }
  }
  return out;
}

function columnsFromRecords(records: Record<string, unknown>[]): InferredColumn[] {
  const names: string[] = [];
  for (const r of records) {
    for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
  }
  return names.slice(0, 200).map((name) => ({ name, ...computeColumnStats(records, name) }));
}

/**
 * Infer tabular columns from a truncated head-of-file sample.
 * Returns [] when the format is binary or the sample is unparsable —
 * the asset is still cataloged, just without column metadata.
 */
export function inferColumns(format: string | null, buf: Buffer): InferredColumn[] {
  if (!format || ["parquet", "orc", "avro", "compressed"].includes(format)) return [];
  let text = buf.toString("utf8");
  try {
    if (format === "csv") {
      // Drop the (likely) truncated last line before parsing.
      const cut = text.lastIndexOf("\n");
      if (cut > 0) text = text.slice(0, cut);
      const parsed = Papa.parse<Record<string, unknown>>(text, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        preview: 200,
      });
      return columnsFromRecords(parsed.data ?? []);
    }
    if (format === "ndjson") {
      const rows: Record<string, unknown>[] = [];
      for (const line of text.split("\n").slice(0, 100)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) rows.push(obj);
        } catch {
          break; // truncated tail
        }
      }
      return columnsFromRecords(rows);
    }
    if (format === "json") {
      try {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return columnsFromRecords(rows.filter((r) => r && typeof r === "object").slice(0, 100));
      } catch {
        // Truncated sample: extract the first complete object literal.
        const start = text.indexOf("{");
        if (start === -1) return [];
        let depth = 0;
        let inStr = false;
        for (let i = start; i < text.length; i++) {
          const c = text[i];
          if (inStr) {
            if (c === "\\") i++;
            else if (c === '"') inStr = false;
          } else if (c === '"') inStr = true;
          else if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) {
              return columnsFromRecords([JSON.parse(text.slice(start, i + 1))]);
            }
          }
        }
        return [];
      }
    }
  } catch {
    return [];
  }
  return [];
}
